import { basename, dirname, join } from 'node:path'
import { Effect } from 'effect'

import { FormatParseError, UnsupportedFormatError } from '@shared/binary/errors'
import { isBflan, parseBflan, type AnimationDocument } from '@shared/formats/bflan'
import type { AnimationCandidate, LayoutSource, OpenAnimationResult } from '@shared/contract'
import { FileNotFoundError, IoError, NotFoundError } from '@main/errors'
import { ArchiveService } from './archive'
import { FilesService } from './files'

/**
 * Loads BFLAN animations for the layout being edited.
 *
 * Read-only. Animations are played back and inspected, not edited: the timeline
 * scrubs and the renderer resolves `override ?? static`, so nothing here writes.
 * That is also why there is no dirty tracking — an animation session holds a
 * parsed document and the original bytes, nothing more.
 */

const ANIMATION_EXTENSION = '.bflan'
const ANIMATION_FOLDER = 'anim/'

interface OpenAnimation {
  readonly id: string
  readonly source: LayoutSource
  readonly key: string
  readonly displayName: string
  readonly document: AnimationDocument
}

export class AnimationService extends Effect.Service<AnimationService>()('AnimationService', {
  effect: Effect.gen(function* () {
    const files = yield* FilesService
    const archives = yield* ArchiveService

    const open = new Map<string, OpenAnimation>()
    let sequence = 0

    /**
     * Animations that could animate this layout. Ordered with the archive's
     * anim/ folder first, matching how a layout archive is laid out.
     */
    const list = (
      source: LayoutSource
    ): Effect.Effect<AnimationCandidate[], IoError | NotFoundError> =>
      Effect.gen(function* () {
        if (source.kind === 'file') {
          const directory = dirname(source.path)
          const candidates: AnimationCandidate[] = []
          for (const folder of [directory, join(directory, 'anim')]) {
            const names = yield* files.listDir(folder)
            for (const name of names) {
              if (!name.toLowerCase().endsWith(ANIMATION_EXTENSION)) continue
              const path = join(folder, name)
              const size = yield* Effect.orElseSucceed(files.size(path), () => 0)
              candidates.push({ key: path, displayName: name, size })
            }
          }
          return candidates
        }

        const descriptor = yield* archives.describeOne(source.archiveId)
        const matching = descriptor.entries.filter(
          (entry) =>
            entry.kind === 'animation' ||
            entry.displayName.toLowerCase().endsWith(ANIMATION_EXTENSION)
        )
        const inFolder = matching.filter((entry) =>
          entry.displayName.toLowerCase().startsWith(ANIMATION_FOLDER)
        )
        const elsewhere = matching.filter(
          (entry) => !entry.displayName.toLowerCase().startsWith(ANIMATION_FOLDER)
        )

        return [...inFolder, ...elsewhere].map((entry) => ({
          key: entry.key,
          displayName: entry.displayName,
          size: entry.size
        }))
      })

    const openAnimation = (
      source: LayoutSource,
      key: string
    ): Effect.Effect<
      OpenAnimationResult,
      FileNotFoundError | IoError | NotFoundError | UnsupportedFormatError | FormatParseError
    > =>
      Effect.gen(function* () {
        // Reusing an already-open animation keeps the renderer's timeline stable
        // when the same one is selected twice.
        for (const entry of open.values()) {
          if (entry.key === key && sameSource(entry.source, source)) {
            return {
              animationId: entry.id,
              displayName: entry.displayName,
              source: entry.source,
              document: entry.document
            }
          }
        }

        const bytes =
          source.kind === 'file'
            ? yield* files.read(key)
            : yield* archives.readEntry(source.archiveId, key)

        const displayName = basename(key.split('/').pop() ?? key)

        if (!isBflan(bytes)) {
          return yield* Effect.fail(
            new UnsupportedFormatError({
              detected: 'unknown',
              message: `${displayName} is not a BFLAN animation`
            })
          )
        }

        const parsed = yield* Effect.try({
          try: () => parseBflan(bytes),
          catch: (cause) =>
            cause instanceof FormatParseError
              ? cause
              : new FormatParseError({
                  format: 'bflan',
                  offset: 0,
                  section: displayName,
                  message: cause instanceof Error ? cause.message : String(cause)
                })
        })

        const id = `anim_${++sequence}`
        open.set(id, { id, source, key, displayName, document: parsed.document })

        return { animationId: id, displayName, source, document: parsed.document }
      })

    const close = (animationId: string): Effect.Effect<void> =>
      Effect.sync(() => {
        open.delete(animationId)
      })

    return { list, openAnimation, close } as const
  })
}) {}

function sameSource(a: LayoutSource, b: LayoutSource): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'file' && b.kind === 'file') return a.path === b.path
  if (a.kind === 'archive' && b.kind === 'archive') return a.archiveId === b.archiveId
  return false
}
