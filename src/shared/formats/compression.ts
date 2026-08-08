export type CompressionKind = 'none' | 'yaz0' | 'zstd' | 'zlib' | 'lz4' | 'mio0'

function magicIs(data: Uint8Array, ...bytes: number[]): boolean {
  if (data.length < bytes.length) return false
  return bytes.every((byte, index) => data[index] === byte)
}

/**
 * Identifies a container's compression from its leading bytes. Switch layout
 * archives ship as Yaz0 or ZSTD in practice; the rest are recognised so an
 * unsupported file produces a precise message instead of a parse failure deep
 * inside the SARC reader.
 */
export function detectCompression(data: Uint8Array): CompressionKind {
  if (magicIs(data, 0x59, 0x61, 0x7a, 0x30)) return 'yaz0'
  if (magicIs(data, 0x28, 0xb5, 0x2f, 0xfd)) return 'zstd'
  if (magicIs(data, 0x4d, 0x49, 0x4f, 0x30)) return 'mio0'
  if (magicIs(data, 0x04, 0x22, 0x4d, 0x18)) return 'lz4'
  // zlib: CMF 0x78 with any of the common FLEVEL bytes.
  if (data.length >= 2 && data[0] === 0x78) {
    const flg = data[1]!
    if (flg === 0x01 || flg === 0x5e || flg === 0x9c || flg === 0xda) return 'zlib'
  }
  return 'none'
}

/** The kinds this app can both read and write. */
export type SupportedCompression = Extract<CompressionKind, 'none' | 'yaz0' | 'zstd'>

/** Type predicate, so a guarded branch narrows the kind for callers. */
export function isSupportedCompression(
  kind: CompressionKind
): kind is SupportedCompression {
  return kind === 'none' || kind === 'yaz0' || kind === 'zstd'
}
