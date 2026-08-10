import { zstdLevel } from '@main/compression-level'
import { zstd as loadZstd } from '@main/zstd'
import { detectCompression } from '@shared/formats/compression'
import { yaz0Compress, yaz0Decompress } from '@shared/formats/yaz0'

/**
 * Compression for the headless tools — Yaz0 and ZSTD both.
 *
 * An earlier version of this refused ZSTD, on the reasoning that the decoder is a
 * WASM module the app loads. That was simply wrong: `@bokuweb/zstd-wasm` is an
 * ordinary npm package that initialises in any Node process, and the headless
 * tools *are* Node. The mistake was not academic — the game these tools were built
 * for ships its entire romfs as `.zs`, so the CLI and the MCP server could not read
 * a single real file.
 *
 * The module is loaded once, on first use, so a run that only touches uncompressed
 * files never pays for it.
 */

export type Compression = 'none' | 'yaz0' | 'zstd'

export async function decompress(
  data: Uint8Array
): Promise<{ data: Uint8Array; compression: Compression }> {
  const kind = detectCompression(data)

  if (kind === 'yaz0') return { data: yaz0Decompress(data), compression: 'yaz0' }
  if (kind === 'zstd') {
    const module_ = await loadZstd()
    try {
      return { data: new Uint8Array(module_.decompress(data)), compression: 'zstd' }
    } catch (cause) {
      throw new Error(
        `ZSTD decompression failed: ${cause instanceof Error ? cause.message : String(cause)}`
      )
    }
  }
  return { data, compression: 'none' }
}

/**
 * Re-applies the compression a file arrived with, so a save matches what the
 * game's loader expects to find.
 *
 * The level comes from the same place the app's does, so a file written by the
 * CLI or an agent is the same size as one written by the editor — two tools
 * disagreeing about it would show up as a diff on every file either touched.
 */
export async function compress(data: Uint8Array, kind: Compression): Promise<Uint8Array> {
  if (kind === 'none') return data
  if (kind === 'yaz0') return yaz0Compress(data)

  const module_ = await loadZstd()
  try {
    return new Uint8Array(module_.compress(data, zstdLevel()))
  } catch (cause) {
    throw new Error(
      `ZSTD compression failed: ${cause instanceof Error ? cause.message : String(cause)}`
    )
  }
}
