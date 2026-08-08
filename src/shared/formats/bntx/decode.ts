import { FormatParseError, UnsupportedFormatError } from '@shared/binary/errors'
import { decodeAstc } from './astc'
import type { BntxTexture } from './container'
import {
  BntxChannelSource,
  BntxFormat,
  BntxFormatVariant,
  formatInfo,
  formatName,
  isAstc
} from './format'
import { deswizzle, divRoundUp, mipBlockHeightLog2 } from './swizzle'

/**
 * Format decoders. Output is always straight RGBA8, four bytes per pixel,
 * top-left origin, `width * height * 4` bytes long.
 *
 * sRGB variants decode to the same bytes as their unorm siblings: values stay
 * sRGB-encoded, which is what a display path wants. Nothing is linearised here.
 *
 * The BCn interpolation constants follow the reference decoders in
 * Switch-Toolbox (DDSCompressor.cs), which truncate towards zero. Hardware
 * rounding of the 1/3 and 2/3 endpoints is implementation-defined and differs
 * by a unit or two between vendors.
 *
 * BC6H and BC7 are deliberately absent — see isFormatSupported. ASTC lives in
 * ./astc.ts because it is an order of magnitude more code than everything here.
 */

export interface DecodedImage {
  readonly width: number
  readonly height: number
  readonly rgba: Uint8Array
}

/** Whether decodeTexture can handle this format/variant pair. */
export function isFormatSupported(format: BntxFormat, variant: BntxFormatVariant): boolean {
  // Every 2D ASTC block size decodes; the LDR profile covers both unorm and sRGB.
  if (isAstc(format)) {
    return variant === BntxFormatVariant.Unorm || variant === BntxFormatVariant.Srgb
  }

  switch (format) {
    case BntxFormat.R8:
    case BntxFormat.R8G8:
    case BntxFormat.R5G6B5:
    case BntxFormat.R8G8B8A8:
    case BntxFormat.B8G8R8A8:
    case BntxFormat.BC1:
    case BntxFormat.BC2:
    case BntxFormat.BC3:
      return variant === BntxFormatVariant.Unorm || variant === BntxFormatVariant.Srgb
    case BntxFormat.R11G11B10:
      return variant === BntxFormatVariant.Float
    case BntxFormat.BC4:
    case BntxFormat.BC5:
      return variant === BntxFormatVariant.Unorm || variant === BntxFormatVariant.Snorm
    default:
      return false
  }
}

/**
 * Untiles one mip level of array layer 0 and decodes it to RGBA8, then applies
 * the texture's channel-source mapping.
 */
export function decodeTexture(texture: BntxTexture, mipLevel = 0): DecodedImage {
  if (mipLevel < 0 || mipLevel >= texture.mipCount) {
    throw new FormatParseError({
      format: 'bntx',
      offset: 0,
      section: texture.name,
      message: `mip level ${mipLevel} is outside the texture's ${texture.mipCount} level(s)`
    })
  }

  const info = formatInfo(texture.format)
  if (!info || !isFormatSupported(texture.format, texture.formatVariant)) {
    throw new UnsupportedFormatError({
      detected: formatName(texture.format, texture.formatVariant),
      message: `bntx texture "${texture.name}" uses a format this build cannot decode`
    })
  }

  const width = Math.max(1, texture.width >>> mipLevel)
  const height = Math.max(1, texture.height >>> mipLevel)

  const start = texture.mipOffsets[mipLevel] ?? 0
  const end = texture.mipOffsets[mipLevel + 1] ?? texture.imageData.length
  const tiled = texture.imageData.subarray(start, Math.max(start, end))

  const linear = deswizzle(
    width,
    height,
    info.blockWidth,
    info.blockHeight,
    info.bytesPerBlock,
    texture.tileMode,
    mipBlockHeightLog2(divRoundUp(height, info.blockHeight), texture.blockHeightLog2),
    tiled
  )

  const rgba = decodeSurface(texture.format, texture.formatVariant, width, height, linear)
  applyChannelSources(rgba, texture.channelSources)
  return { width, height, rgba }
}

/**
 * Decodes an already-untiled surface. `data` is row-major and tightly packed,
 * and must hold whole blocks: for compressed formats that is
 * `divRoundUp(w, bw) * divRoundUp(h, bh) * bytesPerBlock`.
 */
export function decodeSurface(
  format: BntxFormat,
  variant: BntxFormatVariant,
  width: number,
  height: number,
  data: Uint8Array
): Uint8Array {
  const info = formatInfo(format)
  if (!info || !isFormatSupported(format, variant)) {
    throw new UnsupportedFormatError({
      detected: formatName(format, variant),
      message: 'no decoder for this bntx format'
    })
  }

  const needed =
    divRoundUp(width, info.blockWidth) * divRoundUp(height, info.blockHeight) * info.bytesPerBlock
  if (data.length < needed) {
    throw new FormatParseError({
      format: 'bntx',
      offset: 0,
      section: formatName(format, variant),
      message: `surface needs ${needed} bytes but only ${data.length} were given`
    })
  }

  if (isAstc(format)) {
    const result = decodeAstc(width, height, info.blockWidth, info.blockHeight, data)

    /**
     * A few undecodable blocks in an otherwise good image are worth showing, but
     * an image where nothing decoded is not an image — saying so beats handing
     * back a fully transparent surface that looks like a legitimately empty
     * texture.
     */
    if (result.failedBlocks === result.totalBlocks && result.totalBlocks > 0) {
      throw new UnsupportedFormatError({
        detected: formatName(format, variant),
        message: result.firstError ?? 'no ASTC block in this surface could be decoded'
      })
    }

    return result.rgba
  }

  switch (format) {
    case BntxFormat.R8:
      return decodeUncompressed(width, height, 1, data, readR8)
    case BntxFormat.R8G8:
      return decodeUncompressed(width, height, 2, data, readR8G8)
    case BntxFormat.R5G6B5:
      return decodeUncompressed(width, height, 2, data, readR5G6B5)
    case BntxFormat.R8G8B8A8:
      return decodeUncompressed(width, height, 4, data, readR8G8B8A8)
    case BntxFormat.B8G8R8A8:
      return decodeUncompressed(width, height, 4, data, readB8G8R8A8)
    case BntxFormat.R11G11B10:
      return decodeUncompressed(width, height, 4, data, readR11G11B10F)
    case BntxFormat.BC1:
      return decodeBlocks(width, height, 8, data, decodeBc1Block)
    case BntxFormat.BC2:
      return decodeBlocks(width, height, 16, data, decodeBc2Block)
    case BntxFormat.BC3:
      return decodeBlocks(width, height, 16, data, decodeBc3Block)
    case BntxFormat.BC4:
      return decodeBlocks(
        width,
        height,
        8,
        data,
        variant === BntxFormatVariant.Snorm ? decodeBc4SnormBlock : decodeBc4Block
      )
    case BntxFormat.BC5:
      return decodeBlocks(
        width,
        height,
        16,
        data,
        variant === BntxFormatVariant.Snorm ? decodeBc5SnormBlock : decodeBc5Block
      )
    default:
      throw new UnsupportedFormatError({
        detected: formatName(format, variant),
        message: 'no decoder for this bntx format'
      })
  }
}

/**
 * Rewires the decoded channels through the texture's channel sources. A
 * default-configured texture maps R->R, G->G, B->B, A->A, so this is usually a
 * no-op; single-channel textures use it to broadcast red across RGB.
 */
export function applyChannelSources(
  rgba: Uint8Array,
  sources: readonly [number, number, number, number]
): void {
  if (
    sources[0] === BntxChannelSource.Red &&
    sources[1] === BntxChannelSource.Green &&
    sources[2] === BntxChannelSource.Blue &&
    sources[3] === BntxChannelSource.Alpha
  ) {
    return
  }

  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i]
    const g = rgba[i + 1]
    const b = rgba[i + 2]
    const a = rgba[i + 3]
    for (let channel = 0; channel < 4; channel++) {
      rgba[i + channel] = selectChannel(sources[channel], r, g, b, a)
    }
  }
}

function selectChannel(source: number, r: number, g: number, b: number, a: number): number {
  switch (source) {
    case BntxChannelSource.One:
      return 255
    case BntxChannelSource.Red:
      return r
    case BntxChannelSource.Green:
      return g
    case BntxChannelSource.Blue:
      return b
    case BntxChannelSource.Alpha:
      return a
    default:
      return 0
  }
}

/* ---------------------------------------------------------------- uncompressed */

type PixelReader = (data: Uint8Array, offset: number, out: Uint8Array, at: number) => void

function decodeUncompressed(
  width: number,
  height: number,
  stride: number,
  data: Uint8Array,
  read: PixelReader
): Uint8Array {
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) read(data, i * stride, rgba, i * 4)
  return rgba
}

function readR8(data: Uint8Array, offset: number, out: Uint8Array, at: number): void {
  out[at] = data[offset]
  out[at + 1] = 0
  out[at + 2] = 0
  out[at + 3] = 255
}

function readR8G8(data: Uint8Array, offset: number, out: Uint8Array, at: number): void {
  out[at] = data[offset]
  out[at + 1] = data[offset + 1]
  out[at + 2] = 0
  out[at + 3] = 255
}

/** 5- and 6-bit channels expand by replicating their own high bits, so 0x1f -> 255. */
function expand5(value: number): number {
  return (value << 3) | (value >> 2)
}

function expand6(value: number): number {
  return (value << 2) | (value >> 4)
}

function readR5G6B5(data: Uint8Array, offset: number, out: Uint8Array, at: number): void {
  const value = data[offset] | (data[offset + 1] << 8)
  out[at] = expand5((value >> 11) & 0x1f)
  out[at + 1] = expand6((value >> 5) & 0x3f)
  out[at + 2] = expand5(value & 0x1f)
  out[at + 3] = 255
}

function readR8G8B8A8(data: Uint8Array, offset: number, out: Uint8Array, at: number): void {
  out[at] = data[offset]
  out[at + 1] = data[offset + 1]
  out[at + 2] = data[offset + 2]
  out[at + 3] = data[offset + 3]
}

function readB8G8R8A8(data: Uint8Array, offset: number, out: Uint8Array, at: number): void {
  out[at] = data[offset + 2]
  out[at + 1] = data[offset + 1]
  out[at + 2] = data[offset]
  out[at + 3] = data[offset + 3]
}

/**
 * Unpacks a small unsigned float: `mantissaBits` of mantissa, 5-bit exponent
 * with bias 15, no sign bit. Denormals and infinities follow IEEE 754.
 */
function smallFloat(bits: number, mantissaBits: number): number {
  const mantissaMax = 1 << mantissaBits
  const exponent = bits >> mantissaBits
  const mantissa = bits & (mantissaMax - 1)
  if (exponent === 0) return (mantissa / mantissaMax) * 2 ** -14
  if (exponent === 31) return mantissa === 0 ? Infinity : NaN
  return (1 + mantissa / mantissaMax) * 2 ** (exponent - 15)
}

/** Clamps to [0, 1] before scaling; NaN falls to 0, infinity saturates. */
function toUnorm8(value: number): number {
  if (!(value > 0)) return 0
  if (value >= 1) return 255
  return Math.round(value * 255)
}

function readR11G11B10F(data: Uint8Array, offset: number, out: Uint8Array, at: number): void {
  const value =
    (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>>
    0
  out[at] = toUnorm8(smallFloat(value & 0x7ff, 6))
  out[at + 1] = toUnorm8(smallFloat((value >>> 11) & 0x7ff, 6))
  out[at + 2] = toUnorm8(smallFloat((value >>> 22) & 0x3ff, 5))
  out[at + 3] = 255
}

/* -------------------------------------------------------------- block compressed */

/** Reusable per-call working buffers, so the decoders stay reentrant. */
interface BlockScratch {
  /** Four RGBA colour-block palette entries. */
  readonly colours: Uint8Array
  /** Eight-entry palettes for the BC3/BC4/BC5 single-channel blocks. */
  readonly first: Uint8Array
  readonly second: Uint8Array
}

/** Fills `out` with a 4x4 RGBA tile (64 bytes, row-major). */
type BlockDecoder = (
  data: Uint8Array,
  offset: number,
  out: Uint8Array,
  scratch: BlockScratch
) => void

function decodeBlocks(
  width: number,
  height: number,
  bytesPerBlock: number,
  data: Uint8Array,
  decodeBlock: BlockDecoder
): Uint8Array {
  const rgba = new Uint8Array(width * height * 4)
  const blocksX = divRoundUp(width, 4)
  const blocksY = divRoundUp(height, 4)
  const tile = new Uint8Array(64)
  const scratch: BlockScratch = {
    colours: new Uint8Array(16),
    first: new Uint8Array(8),
    second: new Uint8Array(8)
  }

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      decodeBlock(data, (by * blocksX + bx) * bytesPerBlock, tile, scratch)
      for (let ty = 0; ty < 4; ty++) {
        const y = by * 4 + ty
        if (y >= height) break
        for (let tx = 0; tx < 4; tx++) {
          const x = bx * 4 + tx
          if (x >= width) break
          const to = (y * width + x) * 4
          const from = (ty * 4 + tx) * 4
          rgba[to] = tile[from]
          rgba[to + 1] = tile[from + 1]
          rgba[to + 2] = tile[from + 2]
          rgba[to + 3] = tile[from + 3]
        }
      }
    }
  }

  return rgba
}

/**
 * Expands the two RGB565 endpoints of a colour block into a 4-entry RGBA
 * palette. `punchThrough` enables BC1's second mode: when c0 <= c1 the third
 * entry is a plain midpoint and the fourth is transparent black. BC2 and BC3
 * always use the 4-colour interpolation regardless of endpoint order.
 */
function colourPalette(
  data: Uint8Array,
  offset: number,
  punchThrough: boolean,
  palette: Uint8Array
): void {
  const c0 = data[offset] | (data[offset + 1] << 8)
  const c1 = data[offset + 2] | (data[offset + 3] << 8)

  palette[0] = expand5((c0 >> 11) & 0x1f)
  palette[1] = expand6((c0 >> 5) & 0x3f)
  palette[2] = expand5(c0 & 0x1f)
  palette[3] = 255
  palette[4] = expand5((c1 >> 11) & 0x1f)
  palette[5] = expand6((c1 >> 5) & 0x3f)
  palette[6] = expand5(c1 & 0x1f)
  palette[7] = 255
  palette[11] = 255

  if (!punchThrough || c0 > c1) {
    for (let i = 0; i < 3; i++) {
      palette[8 + i] = Math.floor((2 * palette[i] + palette[4 + i]) / 3)
      palette[12 + i] = Math.floor((2 * palette[4 + i] + palette[i]) / 3)
    }
    palette[15] = 255
    return
  }

  for (let i = 0; i < 3; i++) {
    palette[8 + i] = Math.floor((palette[i] + palette[4 + i]) / 2)
    palette[12 + i] = 0
  }
  palette[15] = 0
}

function decodeColourBlock(
  data: Uint8Array,
  offset: number,
  punchThrough: boolean,
  out: Uint8Array,
  palette: Uint8Array
): void {
  colourPalette(data, offset, punchThrough, palette)
  const indices =
    (data[offset + 4] |
      (data[offset + 5] << 8) |
      (data[offset + 6] << 16) |
      (data[offset + 7] << 24)) >>>
    0

  for (let i = 0; i < 16; i++) {
    const entry = ((indices >>> (i * 2)) & 3) * 4
    const at = i * 4
    out[at] = palette[entry]
    out[at + 1] = palette[entry + 1]
    out[at + 2] = palette[entry + 2]
    out[at + 3] = palette[entry + 3]
  }
}

function decodeBc1Block(
  data: Uint8Array,
  offset: number,
  out: Uint8Array,
  scratch: BlockScratch
): void {
  decodeColourBlock(data, offset, true, out, scratch.colours)
}

function decodeBc2Block(
  data: Uint8Array,
  offset: number,
  out: Uint8Array,
  scratch: BlockScratch
): void {
  decodeColourBlock(data, offset + 8, false, out, scratch.colours)
  // 16 explicit 4-bit alphas, low nibble of each byte first.
  for (let i = 0; i < 16; i++) {
    const byte = data[offset + (i >> 1)]
    const nibble = i % 2 === 0 ? byte & 0x0f : byte >> 4
    out[i * 4 + 3] = (nibble << 4) | nibble
  }
}

function decodeBc3Block(
  data: Uint8Array,
  offset: number,
  out: Uint8Array,
  scratch: BlockScratch
): void {
  decodeColourBlock(data, offset + 8, false, out, scratch.colours)
  buildChannelPalette(data[offset], data[offset + 1], false, scratch.first)
  for (let i = 0; i < 16; i++) {
    out[i * 4 + 3] = scratch.first[channelIndex(data, offset + 2, i)]
  }
}

/**
 * The 8-entry palette shared by BC3's alpha block, BC4 and both BC5 channels.
 *
 * Two stored endpoints, then six interpolated values when e0 > e1, or four
 * interpolated values plus both extremes when e0 <= e1. The expression matches
 * the reference decoder including its truncation towards zero, which matters
 * because the interpolation term is negative in the six-value mode.
 */
function buildChannelPalette(
  a0: number,
  a1: number,
  signed: boolean,
  palette: Uint8Array
): void {
  const e0 = signed ? (a0 << 24) >> 24 : a0
  const e1 = signed ? (a1 << 24) >> 24 : a1
  palette[0] = a0
  palette[1] = a1

  if (e0 > e1) {
    for (let i = 2; i < 8; i++) {
      palette[i] = a0 + Math.trunc(((e1 - e0) * (i - 1)) / 7)
    }
    return
  }

  for (let i = 2; i < 6; i++) {
    palette[i] = a0 + Math.trunc(((e1 - e0) * (i - 1)) / 5)
  }
  palette[6] = signed ? 0x80 : 0x00
  palette[7] = signed ? 0x7f : 0xff
}

/** Three bits per pixel, LSB-first across the six index bytes at `offset`. */
function channelIndex(data: Uint8Array, offset: number, pixel: number): number {
  const bit = pixel * 3
  const at = offset + (bit >> 3)
  // A 3-bit field never spans more than two bytes, and the top group's high
  // byte contributes nothing, so reading past the block cannot change the result.
  const window = data[at] | ((at + 1 < data.length ? data[at + 1] : 0) << 8)
  return (window >> (bit & 7)) & 7
}

/** Signed channels are remapped so -128 lands on 0 and 127 on 255. */
function snormToUnorm(value: number): number {
  return (value + 0x80) & 0xff
}

function decodeBc4Block(
  data: Uint8Array,
  offset: number,
  out: Uint8Array,
  scratch: BlockScratch
): void {
  buildChannelPalette(data[offset], data[offset + 1], false, scratch.first)
  for (let i = 0; i < 16; i++) {
    const value = scratch.first[channelIndex(data, offset + 2, i)]
    const at = i * 4
    out[at] = value
    out[at + 1] = value
    out[at + 2] = value
    out[at + 3] = 255
  }
}

function decodeBc4SnormBlock(
  data: Uint8Array,
  offset: number,
  out: Uint8Array,
  scratch: BlockScratch
): void {
  buildChannelPalette(data[offset], data[offset + 1], true, scratch.first)
  for (let i = 0; i < 16; i++) {
    const value = snormToUnorm(scratch.first[channelIndex(data, offset + 2, i)])
    const at = i * 4
    out[at] = value
    out[at + 1] = value
    out[at + 2] = value
    out[at + 3] = 255
  }
}

/**
 * BC5 is two independent BC4 blocks, red then green. Blue is left at zero
 * rather than reconstructing a normal map's Z, which is the consumer's call.
 */
function decodeBc5Block(
  data: Uint8Array,
  offset: number,
  out: Uint8Array,
  scratch: BlockScratch
): void {
  buildChannelPalette(data[offset], data[offset + 1], false, scratch.first)
  buildChannelPalette(data[offset + 8], data[offset + 9], false, scratch.second)
  for (let i = 0; i < 16; i++) {
    const at = i * 4
    out[at] = scratch.first[channelIndex(data, offset + 2, i)]
    out[at + 1] = scratch.second[channelIndex(data, offset + 10, i)]
    out[at + 2] = 0
    out[at + 3] = 255
  }
}

function decodeBc5SnormBlock(
  data: Uint8Array,
  offset: number,
  out: Uint8Array,
  scratch: BlockScratch
): void {
  buildChannelPalette(data[offset], data[offset + 1], true, scratch.first)
  buildChannelPalette(data[offset + 8], data[offset + 9], true, scratch.second)
  for (let i = 0; i < 16; i++) {
    const at = i * 4
    out[at] = snormToUnorm(scratch.first[channelIndex(data, offset + 2, i)])
    out[at + 1] = snormToUnorm(scratch.second[channelIndex(data, offset + 10, i)])
    out[at + 2] = 0
    out[at + 3] = 255
  }
}
