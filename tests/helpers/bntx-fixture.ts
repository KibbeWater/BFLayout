/**
 * Synthesizes a single-texture, single-mip BNTX container so the fixture archive
 * has something the texture pipeline can actually decode.
 *
 * The pixel data is genuinely block-linear tiled, using the same
 * `blockLinearAddress` the decoder reads back with. That makes this a round-trip
 * check of the swizzler rather than a rubber stamp — a bug in the address maths
 * would still cancel out, but the unit tests in tests/bntx.test.ts pin the
 * addresses against hand-computed values, so this only has to agree with them.
 *
 * Header layout is the one documented in src/shared/formats/bntx/container.ts.
 */
import {
  BntxChannelSource,
  BntxFormat,
  BntxFormatVariant,
  BntxTileMode,
  blockHeightLog2Mip0,
  blockLinearAddress,
  divRoundUp,
  swizzledSurfaceSize
} from '@shared/formats/bntx'

const BRTI_OFFSET = 0x60
const CONTAINER_NAME_OFFSET = 0x100
const TEXTURE_NAME_OFFSET = 0x120
const MIP_POINTER_ARRAY_OFFSET = 0x140
const IMAGE_DATA_OFFSET = 0x200

const GOB_WIDTH_IN_BYTES = 64
const BYTES_PER_PIXEL = 4

export interface BntxSource {
  readonly containerName: string
  readonly textureName: string
  readonly width: number
  readonly height: number
  /** Straight RGBA8, `width * height * 4` bytes, top-left origin. */
  readonly rgba: Uint8Array
}

/** Tiles a linear RGBA8 surface into Tegra X1 block-linear order. */
function tile(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const blockHeightLog2 = blockHeightLog2Mip0(height)
  const blockHeight = 1 << blockHeightLog2
  const widthInGobs = divRoundUp(width * BYTES_PER_PIXEL, GOB_WIDTH_IN_BYTES)
  const size = swizzledSurfaceSize(
    width,
    height,
    1,
    1,
    BYTES_PER_PIXEL,
    BntxTileMode.Optimal,
    blockHeightLog2
  )

  const out = new Uint8Array(size)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const to = blockLinearAddress(x, y, widthInGobs, BYTES_PER_PIXEL, blockHeight)
      const from = (y * width + x) * BYTES_PER_PIXEL
      for (let i = 0; i < BYTES_PER_PIXEL; i++) out[to + i] = rgba[from + i]!
    }
  }
  return out
}

export function buildBntx(source: BntxSource): Uint8Array {
  const expected = source.width * source.height * BYTES_PER_PIXEL
  if (source.rgba.length !== expected) {
    throw new Error(
      `rgba is ${source.rgba.length} bytes, expected ${expected} for ${source.width}x${source.height}`
    )
  }

  const image = tile(source.width, source.height, source.rgba)
  const bytes = new Uint8Array(IMAGE_DATA_OFFSET + image.length)
  const view = new DataView(bytes.buffer)

  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i)
  }
  /** Every file pointer is 64-bit; the high word is always zero in practice. */
  const u64 = (offset: number, value: number): void => {
    view.setUint32(offset, value, true)
    view.setUint32(offset + 4, 0, true)
  }
  const name = (offset: number, text: string): void => {
    view.setUint16(offset, text.length, true)
    ascii(offset + 2, text)
  }

  ascii(0x00, 'BNTX')
  view.setUint16(0x0a, 4, true) // version major
  view.setUint16(0x0c, 0xfffe, false) // little-endian byte-order mark
  view.setUint8(0x0e, 0x0c) // alignment exponent
  view.setUint8(0x0f, 0x40) // target address size
  // The container name offset points at the characters, not the length field.
  view.setUint32(0x10, CONTAINER_NAME_OFFSET + 2, true)
  view.setUint16(0x16, 0x20, true) // first block offset
  view.setUint32(0x1c, bytes.length, true)

  ascii(0x20, 'NX  ')
  view.setUint32(0x24, 1, true) // texture count
  u64(0x28, 0x58) // texture info pointer array
  u64(0x30, IMAGE_DATA_OFFSET) // texture data pointer
  u64(0x40, 0x58) // memory pool pointer
  u64(0x58, BRTI_OFFSET)

  name(CONTAINER_NAME_OFFSET, source.containerName)
  name(TEXTURE_NAME_OFFSET, source.textureName)

  ascii(BRTI_OFFSET, 'BRTI')
  view.setUint32(BRTI_OFFSET + 0x04, 0xa0, true) // block size
  view.setUint8(BRTI_OFFSET + 0x10, 9) // flags: packed + resource texture
  view.setUint8(BRTI_OFFSET + 0x11, 2) // storage dimension: 2D
  view.setUint16(BRTI_OFFSET + 0x12, BntxTileMode.Optimal, true)
  view.setUint16(BRTI_OFFSET + 0x16, 1, true) // mip count
  view.setUint32(BRTI_OFFSET + 0x18, 1, true) // sample count
  view.setUint32(
    BRTI_OFFSET + 0x1c,
    (BntxFormat.R8G8B8A8 << 8) | BntxFormatVariant.Unorm,
    true
  )
  view.setUint32(BRTI_OFFSET + 0x20, 0x20, true) // gpu access: texture
  view.setUint32(BRTI_OFFSET + 0x24, source.width, true)
  view.setUint32(BRTI_OFFSET + 0x28, source.height, true)
  view.setUint32(BRTI_OFFSET + 0x2c, 1, true) // depth
  view.setUint32(BRTI_OFFSET + 0x30, 1, true) // array count
  view.setUint32(BRTI_OFFSET + 0x34, blockHeightLog2Mip0(source.height), true) // texture layout
  view.setUint32(BRTI_OFFSET + 0x50, image.length, true) // image size
  view.setUint32(BRTI_OFFSET + 0x54, 512, true) // alignment
  // Channel sources are nn::gfx values, where 0 is the constant zero and 1 the
  // constant one — the identity mapping starts at 2.
  bytes[BRTI_OFFSET + 0x58] = BntxChannelSource.Red
  bytes[BRTI_OFFSET + 0x59] = BntxChannelSource.Green
  bytes[BRTI_OFFSET + 0x5a] = BntxChannelSource.Blue
  bytes[BRTI_OFFSET + 0x5b] = BntxChannelSource.Alpha
  view.setUint32(BRTI_OFFSET + 0x5c, 1, true) // image dimension: 2D
  // The texture name pointer points at the length field, unlike the container's.
  u64(BRTI_OFFSET + 0x60, TEXTURE_NAME_OFFSET)
  u64(BRTI_OFFSET + 0x68, 0x20) // container pointer
  u64(BRTI_OFFSET + 0x70, MIP_POINTER_ARRAY_OFFSET)

  u64(MIP_POINTER_ARRAY_OFFSET, IMAGE_DATA_OFFSET)
  bytes.set(image, IMAGE_DATA_OFFSET)

  return bytes
}

/**
 * A window-frame corner: an opaque border along the top and left edges fading to
 * transparent inside. Clamped sampling extends the inner edge along a stretched
 * side, so this reads as a real nine-slice frame rather than a smear.
 */
export function framePattern(size: number): Uint8Array {
  const rgba = new Uint8Array(size * size * 4)
  const border = Math.max(2, Math.round(size / 4))
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const at = (y * size + x) * 4
      const inBorder = x < border || y < border
      rgba[at] = 250
      rgba[at + 1] = inBorder ? 240 : 200
      rgba[at + 2] = inBorder ? 210 : 120
      rgba[at + 3] = inBorder ? 255 : 40
    }
  }
  return rgba
}

/** A recognisable test pattern: colour ramp with a grid and a diagonal. */
export function testPattern(width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4
      const onGrid = x % 32 === 0 || y % 32 === 0
      const onDiagonal = Math.abs(x - y) < 2
      rgba[at] = onDiagonal ? 255 : Math.round((x / (width - 1)) * 255)
      rgba[at + 1] = onDiagonal ? 255 : Math.round((y / (height - 1)) * 255)
      rgba[at + 2] = onGrid ? 255 : 96
      rgba[at + 3] = 255
    }
  }
  return rgba
}
