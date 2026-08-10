import { join } from 'node:path'
import { Effect } from 'effect'

import { isBflyt, parseBflyt } from '@shared/formats/bflyt'
import { isSarc, parseSarc, type SarcArchive } from '@shared/formats/sarc'
import { diffLayouts, summarizeChanges, type LayoutChange } from '@shared/mod/diff'
import type { ModDiffReport, ModFileDiff } from '@shared/contract'
import { DbError, IoError, NotFoundError } from '@main/errors'
import { walkFiles } from '@main/walk'
import { CompressionService } from './compression'
import { FilesService } from './files'
import { ProjectService } from './projects'

/**
 * What the mod actually changes, file by file.
 *
 * Every other view of a mod is a list of *files* — which says a layout was
 * touched, and nothing about what was done to it. This is the view that answers
 * the questions people actually have: is this ready to ship, what did I do
 * yesterday, and what goes in the release notes.
 *
 * It works because the mod layer keeps the dump's own copy sitting next to it at
 * the same relative path. There is always a "before".
 */
export class ModDiffService extends Effect.Service<ModDiffService>()('ModDiffService', {
  effect: Effect.gen(function* () {
    const files = yield* FilesService
    const compression = yield* CompressionService
    const projects = yield* ProjectService

    const load = (
      path: string
    ): Effect.Effect<Uint8Array | null> =>
      Effect.orElseSucceed(
        Effect.flatMap(files.read(path), (raw) =>
          Effect.map(
            Effect.orElseSucceed(compression.decompress(raw), () => ({
              data: raw,
              kind: 'none' as const
            })),
            (result): Uint8Array | null => result.data
          )
        ),
        () => null
      )

    /**
     * Compares two archives entry by entry.
     *
     * A layout mod is almost always a layout inside a `.szs`, so stopping at the
     * container would mean reporting "the archive changed" for every mod there is.
     * Recompression also moves every byte, which is why comparing the containers
     * themselves would be worthless even if it were interesting.
     */
    const diffArchives = (
      before: SarcArchive,
      after: SarcArchive
    ): { changes: LayoutChange[]; entries: string[] } => {
      const changes: LayoutChange[] = []
      const entries: string[] = []

      const byName = new Map(
        before.entries.filter((entry) => entry.name !== null).map((entry) => [entry.name!, entry])
      )

      for (const entry of after.entries) {
        if (entry.name === null) continue
        const original = byName.get(entry.name)
        if (!original) {
          entries.push(`${entry.name} (added)`)
          continue
        }
        if (sameBytes(original.data, entry.data)) continue
        entries.push(entry.name)

        if (!isBflyt(entry.data) || !isBflyt(original.data)) continue
        try {
          changes.push(
            ...diffLayouts(parseBflyt(original.data).document, parseBflyt(entry.data).document)
          )
        } catch {
          // A layout that will not parse is already reported by the mod check; here
          // it just means there is no structural diff to show for it.
        }
      }

      for (const [name] of byName) {
        if (!after.entries.some((entry) => entry.name === name)) entries.push(`${name} (removed)`)
      }

      return { changes, entries }
    }

    const run: Effect.Effect<ModDiffReport, DbError | IoError | NotFoundError> = Effect.gen(
      function* () {
        const project = yield* projects.active
        if (!project) {
          return yield* Effect.fail(
            new NotFoundError({ kind: 'active mod project', id: 'a diff needs one' })
          )
        }

        const layer = yield* walkFiles(project.modPath)
        const results: ModFileDiff[] = []

        for (const file of layer) {
          const after = yield* load(file.absolutePath)
          const before = yield* load(join(project.dumpPath, file.relativePath))

          if (after === null) continue
          if (before === null) {
            results.push({
              relativePath: file.relativePath,
              isNew: true,
              summary: 'new file — the dump has nothing at this path',
              changes: [],
              entries: []
            })
            continue
          }

          if (sameBytes(before, after)) {
            /*
             * Worth reporting rather than skipping. A file in the mod that is
             * byte-identical to the dump's still *shadows* it, and will go on
             * shadowing it after a game update changes the original — so it is
             * usually something to revert, and it is invisible everywhere else.
             */
            results.push({
              relativePath: file.relativePath,
              isNew: false,
              summary: 'identical to the dump — this file shadows the original for no reason',
              changes: [],
              entries: []
            })
            continue
          }

          if (isSarc(before) && isSarc(after)) {
            const parsed = yield* Effect.either(
              Effect.try(() => diffArchives(parseSarc(before), parseSarc(after)))
            )
            if (parsed._tag === 'Right') {
              results.push({
                relativePath: file.relativePath,
                isNew: false,
                summary:
                  parsed.right.changes.length > 0
                    ? summarizeChanges(parsed.right.changes)
                    : `${parsed.right.entries.length} entr${parsed.right.entries.length === 1 ? 'y' : 'ies'} changed`,
                changes: parsed.right.changes,
                entries: parsed.right.entries
              })
              continue
            }
          }

          if (isBflyt(before) && isBflyt(after)) {
            const parsed = yield* Effect.either(
              Effect.try(() =>
                diffLayouts(parseBflyt(before).document, parseBflyt(after).document)
              )
            )
            if (parsed._tag === 'Right') {
              results.push({
                relativePath: file.relativePath,
                isNew: false,
                summary: summarizeChanges(parsed.right),
                changes: parsed.right,
                entries: []
              })
              continue
            }
          }

          results.push({
            relativePath: file.relativePath,
            isNew: false,
            summary: `changed (${before.length} → ${after.length} bytes)`,
            changes: [],
            entries: []
          })
        }

        results.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
        return {
          modPath: project.modPath,
          dumpPath: project.dumpPath,
          files: results,
          totalChanges: results.reduce((sum, file) => sum + file.changes.length, 0)
        }
      }
    )

    return { run } as const
  })
}) {}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let at = 0; at < a.length; at++) if (a[at] !== b[at]) return false
  return true
}
