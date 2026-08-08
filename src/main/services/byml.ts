import { Effect } from 'effect'

import { countNodes, isByml, parseByml, toBymlView } from '@shared/formats/byml'
import type { BymlDocumentView } from '@shared/contract'
import { FormatParseError, UnsupportedFormatError } from '@shared/binary/errors'
import { FileNotFoundError, IoError } from '@main/errors'
import { CompressionService } from './compression'
import { FilesService } from './files'

/**
 * Reads BYML configuration documents for the viewer.
 *
 * Stateless, unlike layouts: the whole tree is parsed and handed over in one call
 * and nothing is retained. These documents are small — the largest in this game is
 * 19,369 nodes — and read-only, so there is no working copy to keep and no save
 * path to keep it consistent with.
 *
 * The bytes are decompressed first because `.bgyml` files ship inside archives and
 * as bare `.zs` in a romfs dump.
 */
export class BymlService extends Effect.Service<BymlService>()('BymlService', {
  effect: Effect.gen(function* () {
    const files = yield* FilesService
    const compression = yield* CompressionService

    const open = (
      path: string
    ): Effect.Effect<
      BymlDocumentView,
      FileNotFoundError | IoError | FormatParseError | UnsupportedFormatError
    > =>
      Effect.gen(function* () {
        const raw = yield* files.read(path)

        // A file that is not compressed is not an error, so a failed decompress
        // falls back to the original bytes rather than failing the open.
        const decompressed = yield* Effect.orElseSucceed(compression.decompress(raw), () => ({
          data: raw,
          kind: 'none' as const
        }))
        const data = decompressed.data

        if (!isByml(data)) {
          return yield* Effect.fail(
            new UnsupportedFormatError({
              detected: 'unknown',
              message: `${path} is not a BYML document`
            })
          )
        }

        const document = yield* Effect.try({
          try: () => parseByml(data),
          catch: (cause) =>
            cause instanceof FormatParseError || cause instanceof UnsupportedFormatError
              ? cause
              : new FormatParseError({
                  format: 'byml',
                  offset: 0,
                  message: cause instanceof Error ? cause.message : String(cause)
                })
        })

        return toBymlView(document, document.root === null ? 0 : countNodes(document.root))
      })

    return { open } as const
  })
}) {}
