import { dirname, join } from 'node:path'
import { Effect } from 'effect'

import { FormatParseError } from '@shared/binary/errors'
import { decodeBfttf, isBfcpx, isBfttf, parseBfcpx } from '@shared/formats/font'
import { detectCompression } from '@shared/formats/compression'
import { isSarc, parseSarc } from '@shared/formats/sarc'
import type { FontChain, LayoutSource } from '@shared/contract'
import { IoError, NotFoundError } from '@main/errors'
import { ArchiveService } from './archive'
import { CompressionService } from './compression'
import { FilesService } from './files'

/**
 * Resolves the typefaces a layout's text panes are drawn with.
 *
 * A layout's `fnl1` list names `.bfcpx` font complexes, not typefaces. Each complex names
 * several obfuscated `.bfttf`/`.bfotf` faces in fallback order, and all of them live in a
 * *different* archive from the layout — `Font/Font.Nin_NX_NVN.bfarc.zs` at the root of the
 * dump. So resolving a font means finding that archive, which is what most of this does.
 *
 * The search walks up from the layout towards the filesystem root looking for a `Font`
 * directory, the same shape as the texture provider chain: layouts sit in `Layout/` and
 * fonts in `Font/`, siblings under the romfs root. Walking up rather than requiring a fixed
 * layout means it works whether someone opened the archive, its folder, or the dump root.
 *
 * Everything here degrades rather than fails. A dump with no `Font` directory, a complex
 * naming a face that was not shipped, a face this build cannot decode — each yields fewer
 * typefaces, never an error, because the canvas has a perfectly serviceable fallback and a
 * missing font is not a reason to refuse to draw a layout.
 */

/** Where Nintendo puts font archives, relative to the romfs root. */
const FONT_DIRECTORY = 'Font'

/** How far up to walk looking for the romfs root. Deep enough for any real dump. */
const MAX_ASCENT = 8

interface FontArchive {
  readonly path: string
  /** Entry basename to bytes, so `System_00.fcpx` finds `fcpx/System_00.bfcpx`. */
  readonly entries: Map<string, Uint8Array>
}

export class FontService extends Effect.Service<FontService>()('FontService', {
  effect: Effect.gen(function* () {
    const files = yield* FilesService
    const archives = yield* ArchiveService
    const compression = yield* CompressionService

    /**
     * Parsed font archives by path.
     *
     * A font archive is 16 MB compressed and holds tens of megabytes of typefaces, so
     * decompressing and re-parsing it per text pane is out of the question. Cached for the
     * process lifetime: font archives are not something the editor writes.
     */
    const cache = new Map<string, FontArchive>()

    /** Directories to search for a font archive, nearest first. */
    const searchRoots = (source: LayoutSource): Effect.Effect<string[], never> =>
      Effect.gen(function* () {
        /*
         * The archive's path is checked *before* dirname, not after: `dirname('')` is `'.'`,
         * which is truthy, so the guard never fired and a closed archive sent the walk up
         * from the main process's working directory instead of bailing.
         */
        const origin =
          source.kind === 'file'
            ? source.path
            : yield* Effect.orElseSucceed(
                Effect.map(archives.describeOne(source.archiveId), (found) => found.path),
                () => ''
              )
        if (!origin) return []
        const start = dirname(origin)

        const roots: string[] = []
        let at = start
        for (let step = 0; step < MAX_ASCENT; step++) {
          roots.push(join(at, FONT_DIRECTORY))
          const up = dirname(at)
          if (up === at) break
          at = up
        }
        return roots
      })

    /**
     * The first font archive found, parsed.
     *
     * Font archives come in per-language variants — `Font.`, `Font_CNzh.`, `Font_KRko.` —
     * and the unsuffixed one carries the Latin and Japanese faces the layouts reference, so
     * it sorts first. Picking one rather than merging keeps the fallback chain honest: a
     * chain names faces from one archive, and pulling a same-named face out of a different
     * language pack would silently change the typeface.
     */
    const findArchive = (source: LayoutSource): Effect.Effect<FontArchive | null, never> =>
      Effect.gen(function* () {
        for (const directory of yield* searchRoots(source)) {
          const names = (yield* files.listDir(directory))
            .filter((name) => name.includes('.bfarc'))
            .sort()
          if (names.length === 0) continue

          for (const name of names) {
            const path = join(directory, name)
            const cached = cache.get(path)
            if (cached) return cached

            const parsed = yield* Effect.orElseSucceed(load(path), () => null)
            if (!parsed) continue
            cache.set(path, parsed)
            return parsed
          }
        }
        return null
      })

    const load = (path: string): Effect.Effect<FontArchive, IoError | FormatParseError> =>
      Effect.gen(function* () {
        const raw = yield* Effect.mapError(
          files.read(path),
          (cause) => new IoError({ path, detail: `could not read the font archive: ${cause._tag}` })
        )

        // The compression service sniffs the container itself, so plain, Yaz0 and ZSTD
        // font archives all arrive the same way.
        const data =
          detectCompression(raw) === 'none'
            ? raw
            : (yield* Effect.mapError(
                compression.decompress(raw),
                () => new IoError({ path, detail: 'the font archive would not decompress' })
              )).data

        if (!isSarc(data)) {
          return yield* Effect.fail(
            new FormatParseError({
              format: 'bfarc',
              offset: 0,
              message: 'the font archive is not a SARC'
            })
          )
        }

        const parsed = yield* Effect.try({
          try: () => parseSarc(data),
          catch: (cause) =>
            cause instanceof FormatParseError
              ? cause
              : new FormatParseError({
                  format: 'bfarc',
                  offset: 0,
                  message: cause instanceof Error ? cause.message : String(cause)
                })
        })

        const entries = new Map<string, Uint8Array>()
        for (const entry of parsed.entries) {
          const name = (entry.name ?? '').split('/').pop()
          if (name) entries.set(name.toLowerCase(), entry.data)
        }
        return { path, entries }
      })

    /**
     * Looks an entry up by name, ignoring the extension.
     *
     * A layout names `System_00.fcpx` while the archive holds `fcpx/System_00.bfcpx` — the
     * same stem with a different extension — and the faces a complex names carry their own
     * extensions which may or may not match what is shipped. Matching on the stem is what
     * bridges both, and it is why this cannot just be a map lookup.
     */
    const find = (
      archive: FontArchive,
      name: string,
      accept?: (bytes: Uint8Array) => boolean
    ): Uint8Array | null => {
      const wanted = stem(name)
      const direct = archive.entries.get(name.toLowerCase())
      if (direct && (!accept || accept(direct))) return direct

      /*
       * Keeps scanning past a stem match of the wrong kind.
       *
       * Returning the first match meant an archive holding both `System_00.bfttf` and
       * `fcpx/System_00.bfcpx` could answer a descriptor lookup with the typeface — whichever
       * came first in entry order — and the caller would then reject it and report the whole
       * chain missing, even though the descriptor was sitting there further along.
       */
      for (const [key, value] of archive.entries) {
        if (stem(key) !== wanted) continue
        if (!accept || accept(value)) return value
      }
      return null
    }

    /**
     * The typefaces one named font resolves to, in fallback order.
     *
     * Faces that cannot be found or decoded are skipped and counted, not raised: a chain
     * missing its gaiji face still draws every ordinary character correctly, and refusing
     * the whole chain over one absent file would trade a perfect render for none.
     */
    const chain = (
      source: LayoutSource,
      name: string
    ): Effect.Effect<FontChain, NotFoundError> =>
      Effect.gen(function* () {
        const archive = yield* findArchive(source)
        if (!archive) {
          return yield* Effect.fail(
            new NotFoundError({
              kind: 'font archive',
              id: `no Font directory above ${name}`
            })
          )
        }

        const descriptor = find(archive, name, isBfcpx)
        if (!descriptor) {
          return yield* Effect.fail(
            new NotFoundError({ kind: 'font complex', id: `${name} in ${archive.path}` })
          )
        }

        const wanted = yield* Effect.try({
          try: () => parseBfcpx(descriptor).faces,
          catch: () => new NotFoundError({ kind: 'font complex', id: name })
        })

        const faces: FontChain['faces'] = []
        const missing: string[] = []
        for (const face of wanted) {
          const bytes = find(archive, face, isBfttf)
          if (!bytes) {
            missing.push(face)
            continue
          }
          const decoded = yield* Effect.orElseSucceed(
            Effect.try(() => decodeBfttf(bytes)),
            () => null
          )
          if (!decoded) {
            missing.push(face)
            continue
          }
          /*
           * A Blob, not the Uint8Array. oRPC's serializer has no case for typed arrays
           * and would JSON-expand a multi-megabyte typeface into an object of numbered
           * keys; Blob is the one binary type it moves natively.
           */
          faces.push({
            name: stem(face),
            kind: decoded.kind,
            sfnt: new Blob([decoded.sfnt])
          })
        }

        return { name, archive: archive.path, faces, missing }
      })

    return { chain } as const
  }),
  dependencies: []
}) {}

function stem(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name
  return base.replace(/\.[^.]*$/, '').toLowerCase()
}
