import { Effect } from 'effect'

import { UnsupportedFormatError } from '@shared/binary/errors'
import {
  detectCompression,
  isSupportedCompression,
  type SupportedCompression
} from '@shared/formats/compression'
import { yaz0Compress, yaz0Decompress } from '@shared/formats/yaz0'
import { IoError } from '@main/errors'
import { zstd } from '@main/zstd'
import { zstdLevel } from '@main/compression-level'

/**
 * Compression sits in main rather than shared because ZSTD is a WASM module
 * that needs host loading; Yaz0 is pure and lives in shared.
 *
 * The WASM module is initialised on first use and reused, so opening one
 * uncompressed archive never pays for it.
 */
export class CompressionService extends Effect.Service<CompressionService>()(
  'CompressionService',
  {
    effect: Effect.gen(function* () {
      /*
       * Through the shared loader rather than a private one. Two initialisers in
       * one process each instantiate the WASM module, and the second replaces the
       * first's memory — see `main/zstd.ts`.
       */
      const loadZstd = Effect.tryPromise({
        try: () => zstd(),
        catch: (cause) =>
          new IoError({
            detail: `could not initialise the ZSTD decoder: ${
              cause instanceof Error ? cause.message : String(cause)
            }`
          })
      })

      const decompress = (
        data: Uint8Array
      ): Effect.Effect<
        { data: Uint8Array; kind: SupportedCompression },
        IoError | UnsupportedFormatError
      > =>
        Effect.gen(function* () {
          const kind = detectCompression(data)

          if (!isSupportedCompression(kind)) {
            return yield* Effect.fail(
              new UnsupportedFormatError({
                detected: kind,
                message: `${kind} compression is not supported yet`
              })
            )
          }

          if (kind === 'none') return { data, kind }

          if (kind === 'yaz0') {
            const out = yield* Effect.try({
              try: () => yaz0Decompress(data),
              catch: (cause) =>
                new IoError({
                  detail: `Yaz0 decompression failed: ${
                    cause instanceof Error ? cause.message : String(cause)
                  }`
                })
            })
            return { data: out, kind }
          }

          const mod = yield* loadZstd
          const out = yield* Effect.try({
            try: () => new Uint8Array(mod.decompress(data)),
            catch: (cause) =>
              new IoError({
                detail: `ZSTD decompression failed: ${
                  cause instanceof Error ? cause.message : String(cause)
                }`
              })
          })
          return { data: out, kind }
        })

      /** Re-applies the compression a file originally used, so saves match. */
      const compress = (
        data: Uint8Array,
        kind: SupportedCompression
      ): Effect.Effect<Uint8Array, IoError | UnsupportedFormatError> =>
        Effect.gen(function* () {
          if (kind === 'none') return data

          if (kind === 'yaz0') {
            return yield* Effect.try({
              try: () => yaz0Compress(data),
              catch: (cause) =>
                new IoError({
                  detail: `Yaz0 compression failed: ${
                    cause instanceof Error ? cause.message : String(cause)
                  }`
                })
            })
          }

          if (kind === 'zstd') {
            const mod = yield* loadZstd
            return yield* Effect.try({
              try: () => new Uint8Array(mod.compress(data, zstdLevel())),
              catch: (cause) =>
                new IoError({
                  detail: `ZSTD compression failed: ${
                    cause instanceof Error ? cause.message : String(cause)
                  }`
                })
            })
          }

          return yield* Effect.fail(
            new UnsupportedFormatError({
              detected: kind,
              message: `cannot write ${kind} compression`
            })
          )
        })

      return { decompress, compress, detect: detectCompression } as const
    })
  }
) {}
