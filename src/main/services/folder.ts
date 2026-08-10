import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { Effect } from 'effect'

import { isBflan } from '@shared/formats/bflan'
import { isBflyt } from '@shared/formats/bflyt'
import { isBntx } from '@shared/formats/bntx'
import { isSarc } from '@shared/formats/sarc'
import { detectCompression } from '@shared/formats/compression'
import type { FolderEntry, FolderEntryKind, FolderListing } from '@shared/contract'
import { FileNotFoundError, IoError } from '@main/errors'
import { getActiveLayer, relativeUnder, type ModLayer } from '@main/mod-layer'
import { CompressionService } from './compression'
import { FilesService } from './files'

/**
 * Browses a folder on disk — a dumped romfs, in practice.
 *
 * Listings are per-directory. A romfs dump is tens of thousands of files across a
 * deep tree, and walking it up front would stall the app before showing anything;
 * one `readdir` per directory keeps navigation instant however large the dump is.
 *
 * Sizes come from `stat` per entry, which is the one unavoidable cost. Directories
 * are reported with size 0 rather than being measured, because summing a subtree
 * means walking it — exactly what this avoids.
 */

/**
 * Extension to kind. Modern titles double up extensions (`.blarc.zs`), so the
 * outer compression suffix is stripped before matching.
 */
function classify(name: string, isDirectory: boolean): FolderEntryKind {
  if (isDirectory) return 'directory'

  const lower = name.toLowerCase()
  // Modern titles stack suffixes: Foo.Nin_NX_NVN.blarc.zs. Strip the compression
  // suffix and read the extension left of it; the platform tag in the middle is
  // irrelevant because extname only looks at the last dot.
  const withoutCompression = lower.endsWith('.zs') ? lower.slice(0, -3) : lower
  const extension = extname(withoutCompression)

  switch (extension) {
    case '.bflyt':
      return 'layout'
    case '.bflan':
      return 'animation'
    case '.bntx':
      return 'texture'
    case '.bffnt':
      return 'font'
    // Layout and font archives are called out separately: in a romfs they are the
    // difference between "this is what I came here for" and "this is 60,000 other
    // files", and one icon for every container hides that.
    case '.blarc':
    case '.lyarc':
      return 'layoutArchive'
    case '.bfarc':
      return 'fontArchive'
    case '.szs':
    case '.sarc':
    case '.arc':
    case '.pack':
    case '.zs':
      return 'archive'
    case '.byml':
    case '.bgyml':
      return 'byml'
    case '.bfres':
    case '.bnsh':
    case '.bushvt':
      return 'model'
    case '.bwav':
    case '.bars':
    case '.bfsar':
      return 'audio'
    case '.txt':
    case '.csv':
    case '.json':
      return 'text'
    default:
      return 'other'
  }
}

/**
 * Merges a directory's pristine contents with the mod layer's, by name.
 *
 * Pure, and exported, because this is the rule the whole overlay rests on and it
 * is worth pinning down without a filesystem: the mod's copy wins, the dump's is
 * carried along for reverting and diffing, and a name only the mod has is an
 * addition.
 *
 * `below` is the directory's path relative to either root, which is what makes
 * the per-row `relativePath` — the key a revert needs — computable here rather
 * than being reconstructed by the caller.
 */
export function mergeOverlay(
  pristine: readonly FolderEntry[],
  modded: readonly FolderEntry[],
  below: string
): FolderEntry[] {
  const byName = new Map<string, FolderEntry>()
  for (const entry of pristine) byName.set(entry.name, entry)

  for (const entry of modded) {
    const relative = below === '' ? entry.name : `${below.split(/[\\/]/).join('/')}/${entry.name}`
    const original = byName.get(entry.name)
    if (!original) {
      byName.set(entry.name, { ...entry, origin: 'added', relativePath: relative })
      continue
    }
    byName.set(entry.name, {
      ...entry,
      origin: 'modified',
      relativePath: relative,
      pristinePath: original.path
    })
  }

  return [...byName.values()]
}

/** True when the name carries an outer compression suffix. */
function isCompressed(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.zs') || lower.endsWith('.szs')
}

export class FolderService extends Effect.Service<FolderService>()('FolderService', {
  effect: Effect.gen(function* () {
    const files = yield* FilesService
    const compression = yield* CompressionService

    /** One directory's own contents, with no overlay applied. */
    const readOne = (
      path: string,
      origin: 'pristine' | 'added'
    ): Effect.Effect<FolderEntry[], FileNotFoundError | IoError> =>
      Effect.gen(function* () {
        const entries = yield* Effect.tryPromise({
          try: () => readdir(path, { withFileTypes: true }),
          catch: (cause) =>
            (cause as { code?: string }).code === 'ENOENT'
              ? new FileNotFoundError({ path })
              : new IoError({
                  path,
                  detail: cause instanceof Error ? cause.message : String(cause)
                })
        })

        const described: FolderEntry[] = []
        for (const entry of entries) {
          // Dotfiles are noise in a game dump and hide nothing useful.
          if (entry.name.startsWith('.')) continue
          const full = join(path, entry.name)
          const directory = entry.isDirectory()

          // A file that cannot be stat'd (a broken symlink, say) is still listed;
          // dropping it silently would make the folder look emptier than it is.
          const size = directory
            ? 0
            : yield* Effect.orElseSucceed(
                Effect.tryPromise({
                  try: () => stat(full),
                  catch: () => new IoError({ path: full, detail: 'stat failed' })
                }),
                () => ({ size: 0 })
              ).pipe(Effect.map((info) => info.size))

          described.push({
            name: entry.name,
            path: full,
            kind: classify(entry.name, directory),
            size,
            compressed: !directory && isCompressed(entry.name),
            origin
          })
        }
        return described
      })

    /**
     * The dump's copy of a directory and the mod's, merged by name.
     *
     * A file present in both is a *replacement*: the mod's copy is what the game
     * loads, so that is the path the row opens, and the dump's is carried along
     * for diffing and reverting. A file only the mod has is an addition.
     *
     * A *directory* present in both is reported as modified, which is exact rather
     * than a guess: nothing creates a directory in the mod layer except a write
     * landing inside it, so its existence means the mod has content below. That is
     * what lets a badge appear on the way down to a changed file instead of only
     * on the file itself.
     */
    const overlay = (
      layer: ModLayer,
      below: string
    ): Effect.Effect<FolderEntry[], FileNotFoundError | IoError> =>
      Effect.gen(function* () {
        const pristineDir = below === '' ? layer.dumpPath : join(layer.dumpPath, below)
        const modDir = below === '' ? layer.modPath : join(layer.modPath, below)

        // Either side may be absent — a dump folder the mod has never touched, or
        // a folder the mod invented — and neither is a failure.
        const pristine = yield* Effect.orElseSucceed(
          readOne(pristineDir, 'pristine'),
          (): FolderEntry[] => []
        )
        const modded = yield* Effect.orElseSucceed(
          readOne(modDir, 'added'),
          (): FolderEntry[] => []
        )

        return mergeOverlay(pristine, modded, below)
      })

    /**
     * A directory as the *game* would see it: the dump's contents, with the mod
     * layer laid over the top.
     *
     * This is the same composition the emulator's LayeredFS does at load time, and
     * doing it here is what stops the browser lying. Without it, opening a file
     * you had already modified would reopen the dump's original — the edit would
     * look lost, and saving again would write a second copy from stale bytes.
     *
     * Only directories inside the dump are overlaid. Browsing anywhere else, or
     * with no project open, is the plain listing it always was.
     */
    const list = (
      path: string
    ): Effect.Effect<FolderListing, FileNotFoundError | IoError> =>
      Effect.gen(function* () {
        /*
         * The directory's position within the project, reached from either side.
         * Navigating into a folder the mod added lands on a path under the *mod*
         * root, and it still has to be overlaid — otherwise stepping into an added
         * folder would quietly drop back to an un-badged plain listing.
         */
        const layer = getActiveLayer()
        const below = layer
          ? (relativeUnder(layer.dumpPath, path) ?? relativeUnder(layer.modPath, path))
          : null

        const described =
          layer && below !== null ? yield* overlay(layer, below) : yield* readOne(path, 'pristine')

        // Directories first, then by name — the ordering people expect from a
        // file browser, and it keeps deep dumps navigable.
        described.sort((a, b) => {
          if (a.kind === 'directory' !== (b.kind === 'directory')) {
            return a.kind === 'directory' ? -1 : 1
          }
          return a.name.localeCompare(b.name, undefined, { numeric: true })
        })

        const parent = dirname(path)
        return { path, parent: parent === path ? null : parent, entries: described }
      })

    /**
     * Sniffs what a file actually is, decompressing first when needed.
     *
     * Extensions in a romfs are only a hint — `.blarc.zs` is a ZSTD-compressed
     * SARC, and plenty of files carry names this build has never seen. Reading the
     * magic is the only reliable answer, and it is what decides whether the editor
     * offers to open the file.
     */
    const identify = (
      path: string
    ): Effect.Effect<
      {
        path: string
        format: string
        compression: 'none' | 'yaz0' | 'zstd'
        opensAs: 'archive' | 'layout' | 'animation' | 'texture' | 'byml' | 'none'
        detail: string
      },
      FileNotFoundError | IoError
    > =>
      Effect.gen(function* () {
        const raw = yield* files.read(path)
        const outer = detectCompression(raw)

        /*
         * A failed decompression is reported, not swallowed.
         *
         * Falling back to the raw bytes means the sniffer reads the *compressed*
         * header and calls the file unrecognised — so a broken decoder presents
         * as "this build does not know this format", naming the compression magic
         * as though it were the file's own. That sent a real investigation in
         * entirely the wrong direction, and the fix is to say which of the two
         * actually failed.
         */
        const expanded = yield* Effect.either(compression.decompress(raw))
        if (expanded._tag === 'Left' && outer !== 'none') {
          const reason =
            '_tag' in expanded.left && expanded.left._tag === 'IoError'
              ? expanded.left.detail
              : `this build cannot expand ${outer}`
          return {
            path,
            format: outer.toUpperCase(),
            compression: outerKind(outer),
            opensAs: 'none' as const,
            detail: `${basename(path)} is ${outer}-compressed and could not be expanded: ${reason}`
          }
        }

        const decompressed =
          expanded._tag === 'Right' ? expanded.right : { data: raw, kind: 'none' as const }
        const data = decompressed.data

        const name = basename(path)
        type Identified = {
          path: string
          format: string
          compression: 'none' | 'yaz0' | 'zstd'
          opensAs: 'archive' | 'layout' | 'animation' | 'texture' | 'byml' | 'none'
          detail: string
        }
        const label = (
          format: string,
          opensAs: Identified['opensAs'],
          detail: string
        ): Identified => ({ path, format, compression: decompressed.kind, opensAs, detail })
        let result: Identified

        if (isSarc(data)) {
          result = label('SARC', 'archive', `${name} is a SARC archive`)
        } else if (isBflyt(data)) {
          result = label('BFLYT', 'layout', `${name} is a layout`)
        } else if (isBflan(data)) {
          result = label('BFLAN', 'animation', `${name} is an animation`)
        } else if (isBntx(data)) {
          result = label('BNTX', 'texture', `${name} is a texture container`)
        } else if (isByml(data)) {
          result = label('BYML', 'byml', `${name} is a BYML document`)
        } else {
          const magic = [...data.slice(0, 4)]
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join(' ')
          result = label(
            'unknown',
            'none',
            `${name} starts with ${magic}, which this build does not recognise`
          )
        }

        // Report the outer compression even when decompression failed, so the UI
        // can say "ZSTD, but unreadable" rather than just "unknown".
        return { ...result, compression: decompressed.kind === 'none' ? outerKind(outer) : decompressed.kind }
      })

    return { list, identify } as const
  })
}) {}

function outerKind(kind: string): 'none' | 'yaz0' | 'zstd' {
  return kind === 'yaz0' || kind === 'zstd' ? kind : 'none'
}

/** BYML magic: "BY" or "YB", then a 16-bit version. */
function isByml(data: Uint8Array): boolean {
  if (data.length < 4) return false
  const big = data[0] === 0x42 && data[1] === 0x59
  const little = data[0] === 0x59 && data[1] === 0x42
  return big || little
}
