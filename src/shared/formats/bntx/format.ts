/**
 * BNTX image formats. The BRTI header stores one u32 whose high 8 bits are the
 * channel layout (`nn::gfx::ChannelFormat`) and whose low 8 bits are the data
 * interpretation (`nn::gfx::TypeFormat`), e.g. 0x1a06 is BC1 read as sRGB.
 */

export type BntxFormat = number

export const BntxFormat = {
  None: 0x01,
  R8: 0x02,
  R4G4B4A4: 0x03,
  R5G5B5A1: 0x05,
  A1B5G5R5: 0x06,
  R5G6B5: 0x07,
  B5G6R5: 0x08,
  R8G8: 0x09,
  R16: 0x0a,
  R8G8B8A8: 0x0b,
  B8G8R8A8: 0x0c,
  R9G9B9E5: 0x0d,
  R10G10B10A2: 0x0e,
  R11G11B10: 0x0f,
  R16G16: 0x12,
  D24S8: 0x13,
  R32: 0x14,
  R16G16B16A16: 0x15,
  D32FS8: 0x16,
  R32G32: 0x17,
  R32G32B32: 0x18,
  R32G32B32A32: 0x19,
  BC1: 0x1a,
  BC2: 0x1b,
  BC3: 0x1c,
  BC4: 0x1d,
  BC5: 0x1e,
  BC6H: 0x1f,
  BC7: 0x20,
  Astc4x4: 0x2d,
  Astc5x4: 0x2e,
  Astc5x5: 0x2f,
  Astc6x5: 0x30,
  Astc6x6: 0x31,
  Astc8x5: 0x32,
  Astc8x6: 0x33,
  Astc8x8: 0x34,
  Astc10x5: 0x35,
  Astc10x6: 0x36,
  Astc10x8: 0x37,
  Astc10x10: 0x38,
  Astc12x10: 0x39,
  Astc12x12: 0x3a,
  B5G5R5A1: 0x3b
} as const

export type BntxFormatVariant = number

export const BntxFormatVariant = {
  Unorm: 0x01,
  Snorm: 0x02,
  UInt: 0x03,
  SInt: 0x04,
  Float: 0x05,
  Srgb: 0x06,
  Depth: 0x07,
  UScaled: 0x08,
  SScaled: 0x09,
  UFloat: 0x0a
} as const

/** Where a channel of the decoded output takes its value from. */
export const BntxChannelSource = {
  Zero: 0,
  One: 1,
  Red: 2,
  Green: 3,
  Blue: 4,
  Alpha: 5
} as const

export interface BntxFormatInfo {
  /** Pixels per compressed block along x; 1 for uncompressed formats. */
  readonly blockWidth: number
  readonly blockHeight: number
  /**
   * Bytes per block — the swizzler's "bytes per pixel", since it works in
   * units of blocks for compressed formats.
   */
  readonly bytesPerBlock: number
}

const UNCOMPRESSED_SIZES: Record<number, number> = {
  [BntxFormat.R8]: 1,
  [BntxFormat.R4G4B4A4]: 2,
  [BntxFormat.R5G5B5A1]: 2,
  [BntxFormat.A1B5G5R5]: 2,
  [BntxFormat.R5G6B5]: 2,
  [BntxFormat.B5G6R5]: 2,
  [BntxFormat.R8G8]: 2,
  [BntxFormat.R16]: 2,
  [BntxFormat.B5G5R5A1]: 2,
  [BntxFormat.R8G8B8A8]: 4,
  [BntxFormat.B8G8R8A8]: 4,
  [BntxFormat.R9G9B9E5]: 4,
  [BntxFormat.R10G10B10A2]: 4,
  [BntxFormat.R11G11B10]: 4,
  [BntxFormat.R16G16]: 4,
  [BntxFormat.D24S8]: 4,
  [BntxFormat.R32]: 4,
  [BntxFormat.R16G16B16A16]: 8,
  [BntxFormat.D32FS8]: 8,
  [BntxFormat.R32G32]: 8,
  [BntxFormat.R32G32B32]: 12,
  [BntxFormat.R32G32B32A32]: 16
}

/** BC1 and BC4 pack a 4x4 block into 8 bytes; every other BCn/ASTC uses 16. */
const EIGHT_BYTE_BLOCKS = new Set<number>([BntxFormat.BC1, BntxFormat.BC4])

const ASTC_BLOCK_DIMENSIONS: Record<number, readonly [number, number]> = {
  [BntxFormat.Astc4x4]: [4, 4],
  [BntxFormat.Astc5x4]: [5, 4],
  [BntxFormat.Astc5x5]: [5, 5],
  [BntxFormat.Astc6x5]: [6, 5],
  [BntxFormat.Astc6x6]: [6, 6],
  [BntxFormat.Astc8x5]: [8, 5],
  [BntxFormat.Astc8x6]: [8, 6],
  [BntxFormat.Astc8x8]: [8, 8],
  [BntxFormat.Astc10x5]: [10, 5],
  [BntxFormat.Astc10x6]: [10, 6],
  [BntxFormat.Astc10x8]: [10, 8],
  [BntxFormat.Astc10x10]: [10, 10],
  [BntxFormat.Astc12x10]: [12, 10],
  [BntxFormat.Astc12x12]: [12, 12]
}

export function isBlockCompressed(format: BntxFormat): boolean {
  return format >= BntxFormat.BC1 && format <= BntxFormat.BC7
}

export function isAstc(format: BntxFormat): boolean {
  return format in ASTC_BLOCK_DIMENSIONS
}

/**
 * Block dimensions and stride for a channel format, or undefined when the
 * format is not one this module knows how to lay out in memory.
 */
export function formatInfo(format: BntxFormat): BntxFormatInfo | undefined {
  if (isBlockCompressed(format)) {
    return {
      blockWidth: 4,
      blockHeight: 4,
      bytesPerBlock: EIGHT_BYTE_BLOCKS.has(format) ? 8 : 16
    }
  }

  const astc = ASTC_BLOCK_DIMENSIONS[format]
  if (astc) {
    return { blockWidth: astc[0], blockHeight: astc[1], bytesPerBlock: 16 }
  }

  const size = UNCOMPRESSED_SIZES[format]
  if (size === undefined) return undefined
  return { blockWidth: 1, blockHeight: 1, bytesPerBlock: size }
}

/** Human-readable name, for error messages. */
export function formatName(format: BntxFormat, variant: BntxFormatVariant): string {
  const channel = Object.keys(BntxFormat).find(
    (key) => BntxFormat[key as keyof typeof BntxFormat] === format
  )
  const type = Object.keys(BntxFormatVariant).find(
    (key) => BntxFormatVariant[key as keyof typeof BntxFormatVariant] === variant
  )
  return `${channel ?? `0x${format.toString(16)}`}_${type ?? `0x${variant.toString(16)}`}`
}
