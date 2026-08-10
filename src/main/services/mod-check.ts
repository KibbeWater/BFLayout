import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect } from 'effect'

import type { ModCheckReport, ModCheckedFile } from '@shared/contract'
import { checkBytes, type CheckNote } from '@shared/mod/check'
import { DbError, IoError, NotFoundError } from '@main/errors'
import { walkFiles } from '@main/walk'
import { CompressionService } from './compression'
import { FilesService } from './files'
import { ProjectService } from './projects'

/**
 * Checking a mod before it ships.
 *
 * The failure this exists to prevent is the quiet one: a malformed file deploys,
 * the game crashes or draws nothing, and the mod gets blamed for a bug that is
 * really a corrupt layout. Every file the mod contains is read, decompressed,
 * identified by magic and parsed, and archives are opened and their entries
 * checked too — which is where the interesting problems live, since a layout mod
 * is almost always a layout inside a `.szs`.
 *
 * Scoped to the mod layer rather than the dump. `pnpm validate:romfs` already
 * covers the dump and takes minutes; this covers the handful of files someone
 * actually changed and takes no time at all, which is what makes it something to
 * run before every deploy rather than once.
 */
export class ModCheckService extends Effect.Service<ModCheckService>()('ModCheckService', {
  effect: Effect.gen(function* () {
    const files = yield* FilesService
    const compression = yield* CompressionService
    const projects = yield* ProjectService

    const run: Effect.Effect<ModCheckReport, DbError | IoError | NotFoundError> = Effect.gen(
      function* () {
        const project = yield* projects.active
        if (!project) {
          return yield* Effect.fail(
            new NotFoundError({ kind: 'active mod project', id: 'checking needs one' })
          )
        }

        const layer = yield* walkFiles(project.modPath)
        const checked: ModCheckedFile[] = []
        /**
         * Decompressed sizes, for the resource-size-table check below.
         *
         * Decompressed, not on-disk: the table records how much memory a resource
         * needs once expanded, and comparing compressed sizes would fire on almost
         * every re-save — recompression changes the byte count even when the
         * content is identical. A check that cries wolf is one people turn off.
         */
        const expandedSizes = new Map<string, number>()

        for (const file of layer) {
          const notes: CheckNote[] = []

          /*
           * A file that cannot be read at all is reported as a finding rather than
           * failing the whole run. One unreadable file must not hide the state of
           * every other file in the mod — the report is most useful precisely when
           * something is wrong.
           */
          const raw = yield* Effect.either(files.read(file.absolutePath))
          if (raw._tag === 'Left') {
            checked.push({
              relativePath: file.relativePath,
              format: 'unreadable',
              compression: 'none',
              replacesPristine: false,
              notes: [
                {
                  level: 'error',
                  message: `${file.relativePath} could not be read from your mod folder. It may have been deleted or moved since it was saved.`
                }
              ]
            })
            continue
          }

          const decompressed = yield* Effect.orElseSucceed(compression.decompress(raw.right), () => ({
            data: raw.right,
            kind: 'none' as const
          }))

          const result = checkBytes(file.relativePath, decompressed.data)
          notes.push(...result.notes)
          expandedSizes.set(file.relativePath, decompressed.data.length)

          const replacesPristine = yield* Effect.tryPromise({
            try: async () => (await stat(join(project.dumpPath, file.relativePath))).isFile(),
            catch: () => new IoError({ detail: 'stat failed' })
          }).pipe(Effect.orElseSucceed(() => false))

          /*
           * An addition is worth a word. A replacement applies the moment it is
           * deployed, because the game already asks for that path; a file the game
           * has never heard of is loaded only if something else references it, and
           * a mod whose new file is simply never read looks exactly like a mod that
           * does not work.
           */
          if (!replacesPristine) {
            /*
             * A near-miss is worth much more than the general note.
             *
             * LayeredFS matches by exact path, so a mod file whose name differs
             * from a real one only by a compression suffix is never loaded at all
             * — the game asks for `Foo.blarc.zs` and the mod offers `Foo.blarc`.
             * Nothing reports it: the mod installs, the deploy succeeds, and the
             * game simply uses its own file. This is the shape that mistake takes
             * every time, and it comes from saving a decompressed copy.
             */
            const nearby = project.settings.checkCompressionSuffix
              ? yield* nearMiss(project.dumpPath, file.relativePath)
              : null
            notes.push(
              nearby
                ? {
                    level: 'warning',
                    message: `${file.relativePath} does not match any file in the dump, but ${nearby} does — the names differ only by a compression suffix. The game asks for the exact path, so this file will never be loaded. Rename it to ${nearby.split('/').pop()} (and compress it to match) if it is meant to replace that one.`
                  }
                : {
                    level: 'info',
                    message: `${file.relativePath} is new — the dump has no file at this path, so the game will only load it if something already references that name.`
                  }
            )
          }

          checked.push({
            relativePath: file.relativePath,
            format: result.format,
            compression: decompressed.kind,
            replacesPristine,
            notes
          })
        }

        checked.sort((a, b) => a.relativePath.localeCompare(b.relativePath))

        const notes = project.settings.checkResourceSizeTable
          ? yield* wholeModNotes(project, expandedSizes)
          : []
        const all = [...checked.flatMap((file) => file.notes), ...notes]
        return {
          modPath: project.modPath,
          files: checked,
          notes,
          errors: all.filter((found) => found.level === 'error').length,
          warnings: all.filter((found) => found.level === 'warning').length
        }
      }
    )

    /**
     * The resource size table, which is the hazard a per-file check cannot see.
     *
     * These titles ship a table of how much memory each romfs resource needs, and
     * the loader trusts it: make a file bigger than its entry says and the game
     * does not fail politely, it fails to load the resource — or crashes — with
     * nothing pointing at the file that grew. It is the single most common way a
     * mod that is *more* than swapping same-sized assets goes wrong, and the
     * symptom looks nothing like the cause.
     *
     * BFLayout does not model the table, so this cannot fix it and does not
     * pretend to. What it can do is notice the combination that is dangerous —
     * a file whose size changed, and no table shipped alongside it to say so.
     */
    const nearMiss = (
      dumpPath: string,
      relativePath: string
    ): Effect.Effect<string | null, never> =>
      Effect.gen(function* () {
        for (const candidate of nearMissCandidates(relativePath)) {
          const exists = yield* Effect.tryPromise({
            try: async () => (await stat(join(dumpPath, candidate))).isFile(),
            catch: () => new IoError({ detail: 'stat failed' })
          }).pipe(Effect.orElseSucceed(() => false))
          if (exists) return candidate
        }
        return null
      })

    const wholeModNotes = (
      project: { dumpPath: string; modPath: string },
      expandedSizes: ReadonlyMap<string, number>
    ): Effect.Effect<CheckNote[], never> =>
      Effect.gen(function* () {
        const shipsTable = [...expandedSizes.keys()].some(isResourceSizeTable)

        const grown: string[] = []
        for (const [relativePath, modSize] of expandedSizes) {
          if (isResourceSizeTable(relativePath)) continue

          // The dump's copy is expanded the same way, so the two numbers mean the
          // same thing. A file the dump does not have is an addition, which the
          // per-file check already reports.
          const original = yield* Effect.either(files.read(join(project.dumpPath, relativePath)))
          if (original._tag === 'Left') continue

          const expanded = yield* Effect.orElseSucceed(
            compression.decompress(original.right),
            () => ({ data: original.right, kind: 'none' as const })
          )
          if (expanded.data.length !== modSize) grown.push(relativePath)
        }

        if (grown.length === 0 || shipsTable) return []
        return [
          {
            level: 'warning' as const,
            message:
              `${grown.length} file${grown.length === 1 ? ' has' : 's have'} a different size to the dump's copy ` +
              `(${grown.slice(0, 3).join(', ')}${grown.length > 3 ? ', …' : ''}), and this mod ships no resource size table. ` +
              'These titles record how much memory each romfs resource needs, and a file larger than its entry allows ' +
              'fails to load — usually as a crash that points nowhere near the file. BFLayout cannot edit that table; ' +
              'patch it with an RSTB tool and add it to the mod.'
          }
        ]
      })

    return { run } as const
  })
}) {}

/** Compression suffixes a romfs path may carry. */
const COMPRESSION_SUFFIXES = ['.zs', '.szs', '.zst']

/**
 * A dump file whose path differs from this one only by a compression suffix.
 *
 * Both directions: the mod may have dropped the suffix (saved decompressed) or
 * added one the original does not have.
 */
function nearMissCandidates(relativePath: string): string[] {
  const candidates: string[] = []
  for (const suffix of COMPRESSION_SUFFIXES) {
    if (relativePath.toLowerCase().endsWith(suffix)) {
      candidates.push(relativePath.slice(0, -suffix.length))
    } else {
      candidates.push(`${relativePath}${suffix}`)
    }
  }
  return candidates
}

/**
 * Recognised by name, because the table's own format is not modelled here.
 *
 * Covers what these titles ship: `ResourceSizeTable.Product.100.Nin_NX_NVN.rsizetable.zs`
 * and the older `.srsizetable`/`.rsizetable` spellings.
 */
function isResourceSizeTable(relativePath: string): boolean {
  const name = relativePath.toLowerCase()
  return name.includes('resourcesizetable') || /\.s?rsizetable(\.[a-z0-9]+)?$/.test(name)
}
