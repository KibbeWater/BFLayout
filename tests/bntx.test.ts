import { describe, expect, it } from 'vitest'

import { FormatParseError, UnsupportedFormatError } from '@shared/binary/errors'
import {
  BntxChannelSource,
  BntxFormat,
  BntxFormatVariant,
  BntxTileMode,
  blockHeightLog2Mip0,
  decodeSurface,
  decodeTexture,
  deswizzle,
  isBntx,
  isFormatSupported,
  mipBlockHeightLog2,
  parseBntx,
  swizzledSurfaceSize
} from '@shared/formats/bntx'
import { buildBntx as buildFixtureBntx, testPattern } from './helpers/bntx-fixture'

/**
 * Every expected value below is derived by hand from the format specs, never by
 * running the decoders. The BCn interpolation constants assume truncating
 * integer division, which is what the reference decoder uses.
 */

const BRTI_OFFSET = 0x60
const CONTAINER_NAME_LENGTH_OFFSET = 0x100
const TEXTURE_NAME_OFFSET = 0x120
const MIP_POINTER_ARRAY_OFFSET = 0x140
const IMAGE_DATA_OFFSET = 0x200

interface BntxFixture {
  format: number
  variant: number
  width: number
  height: number
  data: Uint8Array
  tileMode?: number
  blockHeightLog2?: number
  channelSources?: readonly [number, number, number, number]
  textureName?: string
}

/** Assembles a single-texture, single-mip, little-endian BNTX byte for byte. */
function buildBntx(fixture: BntxFixture): Uint8Array {
  const name = fixture.textureName ?? 'tex0'
  const bytes = new Uint8Array(IMAGE_DATA_OFFSET + fixture.data.length)
  const view = new DataView(bytes.buffer)

  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i)
  }
  const u64 = (offset: number, value: number): void => {
    view.setUint32(offset, value, true)
    view.setUint32(offset + 4, 0, true)
  }

  ascii(0x00, 'BNTX')
  view.setUint8(0x08, 0) // version micro
  view.setUint8(0x09, 0) // version minor
  view.setUint16(0x0a, 4, true) // version major
  view.setUint16(0x0c, 0xfffe, false) // little-endian byte-order mark
  view.setUint8(0x0e, 0x0c) // alignment exponent
  view.setUint8(0x0f, 0x40) // target address size
  view.setUint32(0x10, CONTAINER_NAME_LENGTH_OFFSET + 2, true)
  view.setUint16(0x16, 0x20, true) // first block offset
  view.setUint32(0x1c, bytes.length, true)

  ascii(0x20, 'NX  ')
  view.setUint32(0x24, 1, true) // texture count
  u64(0x28, 0x58) // texture info pointer array
  u64(0x30, IMAGE_DATA_OFFSET)
  u64(0x40, 0x58) // memory pool pointer
  u64(0x58, BRTI_OFFSET)

  view.setUint16(CONTAINER_NAME_LENGTH_OFFSET, 8, true)
  ascii(CONTAINER_NAME_LENGTH_OFFSET + 2, 'textures')
  view.setUint16(TEXTURE_NAME_OFFSET, name.length, true)
  ascii(TEXTURE_NAME_OFFSET + 2, name)

  const sources = fixture.channelSources ?? [
    BntxChannelSource.Red,
    BntxChannelSource.Green,
    BntxChannelSource.Blue,
    BntxChannelSource.Alpha
  ]

  ascii(BRTI_OFFSET, 'BRTI')
  view.setUint32(BRTI_OFFSET + 0x04, 0xa0, true)
  view.setUint8(BRTI_OFFSET + 0x10, 9) // flags: packed + res texture
  view.setUint8(BRTI_OFFSET + 0x11, 2) // storage dimension: 2D
  view.setUint16(BRTI_OFFSET + 0x12, fixture.tileMode ?? BntxTileMode.Optimal, true)
  view.setUint16(BRTI_OFFSET + 0x16, 1, true) // mip count
  view.setUint32(BRTI_OFFSET + 0x18, 1, true) // sample count
  view.setUint32(BRTI_OFFSET + 0x1c, (fixture.format << 8) | fixture.variant, true)
  view.setUint32(BRTI_OFFSET + 0x20, 0x20, true) // gpu access: texture
  view.setUint32(BRTI_OFFSET + 0x24, fixture.width, true)
  view.setUint32(BRTI_OFFSET + 0x28, fixture.height, true)
  view.setUint32(BRTI_OFFSET + 0x2c, 1, true) // depth
  view.setUint32(BRTI_OFFSET + 0x30, 1, true) // array count
  view.setUint32(BRTI_OFFSET + 0x34, fixture.blockHeightLog2 ?? 0, true) // texture layout
  view.setUint32(BRTI_OFFSET + 0x50, fixture.data.length, true) // image size
  view.setUint32(BRTI_OFFSET + 0x54, 512, true) // alignment
  bytes[BRTI_OFFSET + 0x58] = sources[0]
  bytes[BRTI_OFFSET + 0x59] = sources[1]
  bytes[BRTI_OFFSET + 0x5a] = sources[2]
  bytes[BRTI_OFFSET + 0x5b] = sources[3]
  view.setUint32(BRTI_OFFSET + 0x5c, 1, true) // image dimension: 2D
  u64(BRTI_OFFSET + 0x60, TEXTURE_NAME_OFFSET)
  u64(BRTI_OFFSET + 0x68, 0x20) // container pointer
  u64(BRTI_OFFSET + 0x70, MIP_POINTER_ARRAY_OFFSET)

  u64(MIP_POINTER_ARRAY_OFFSET, IMAGE_DATA_OFFSET)
  bytes.set(fixture.data, IMAGE_DATA_OFFSET)

  return bytes
}

function pixel(rgba: Uint8Array, width: number, x: number, y: number): number[] {
  const at = (y * width + x) * 4
  return [rgba[at]!, rgba[at + 1]!, rgba[at + 2]!, rgba[at + 3]!]
}

/** Pads a block out to a whole surface so decodeSurface's size check passes. */
function surface(block: readonly number[], totalBytes: number): Uint8Array {
  const out = new Uint8Array(totalBytes)
  out.set(Uint8Array.from(block))
  return out
}

describe('bntx container', () => {
  const data = Uint8Array.from({ length: 8 * 8 * 4 }, (_, i) => i & 0xff)

  it('recognises the signature', () => {
    expect(isBntx(buildBntx({ format: BntxFormat.R8G8B8A8, variant: 1, width: 8, height: 8, data })))
      .toBe(true)
    expect(isBntx(Uint8Array.from([0x53, 0x41, 0x52, 0x43, 0, 0, 0, 0]))).toBe(false)
  })

  it('reads the header, the texture info block and the image data', () => {
    const container = parseBntx(
      buildBntx({
        format: BntxFormat.BC3,
        variant: BntxFormatVariant.Srgb,
        width: 64,
        height: 32,
        blockHeightLog2: 2,
        textureName: 'button_base',
        data: new Uint8Array(2048)
      })
    )

    expect(container.name).toBe('textures')
    expect(container.littleEndian).toBe(true)
    expect(container.target).toBe('NX  ')
    expect(container.version).toEqual({ major: 4, minor: 0, micro: 0 })
    expect(container.alignment).toBe(0x1000)
    expect(container.textures).toHaveLength(1)

    const texture = container.textures[0]!
    expect(texture.name).toBe('button_base')
    expect(texture.width).toBe(64)
    expect(texture.height).toBe(32)
    expect(texture.depth).toBe(1)
    expect(texture.mipCount).toBe(1)
    expect(texture.arrayCount).toBe(1)
    expect(texture.format).toBe(BntxFormat.BC3)
    expect(texture.formatVariant).toBe(BntxFormatVariant.Srgb)
    expect(texture.tileMode).toBe(BntxTileMode.Optimal)
    expect(texture.blockHeightLog2).toBe(2)
    expect(texture.mipOffsets).toEqual([0])
    expect(texture.imageData).toHaveLength(2048)
    expect(texture.channelSources).toEqual([2, 3, 4, 5])
  })

  it('rejects a buffer that is not a BNTX', () => {
    expect(() => parseBntx(new Uint8Array(0x40))).toThrow(FormatParseError)
    expect(() => parseBntx(Uint8Array.from([0x42, 0x4e, 0x54, 0x58]))).toThrow(FormatParseError)
  })

  it('rejects an unrecognised byte-order mark', () => {
    const bytes = buildBntx({ format: BntxFormat.R8G8B8A8, variant: 1, width: 8, height: 8, data })
    bytes[0x0c] = 0x12
    bytes[0x0d] = 0x34
    expect(() => parseBntx(bytes)).toThrow(FormatParseError)
  })

  it('rejects a header whose file size exceeds the buffer', () => {
    const bytes = buildBntx({ format: BntxFormat.R8G8B8A8, variant: 1, width: 8, height: 8, data })
    new DataView(bytes.buffer).setUint32(0x1c, bytes.length + 0x1000, true)
    expect(() => parseBntx(bytes)).toThrow(FormatParseError)
  })

  it('rejects a texture info block without the BRTI signature', () => {
    const bytes = buildBntx({ format: BntxFormat.R8G8B8A8, variant: 1, width: 8, height: 8, data })
    bytes[BRTI_OFFSET] = 0x00
    expect(() => parseBntx(bytes)).toThrow(FormatParseError)
  })
})

describe('bntx deswizzle', () => {
  it('is the identity for linear tiling when the row stride is already aligned', () => {
    // 8 pixels x 4 bytes is exactly the 32-byte pitch alignment, so no padding.
    const data = Uint8Array.from({ length: 8 * 4 * 4 }, (_, i) => (i * 7 + 3) & 0xff)
    const out = deswizzle(8, 4, 1, 1, 4, BntxTileMode.Linear, 0, data)
    expect(out).toHaveLength(128)
    expect([...out]).toEqual([...data])
  })

  it('drops the linear pitch padding when the row stride is not aligned', () => {
    // 5 px x 4 bytes = 20, rounded up to a 32-byte pitch, so row 1 starts at 32.
    const data = Uint8Array.from({ length: 64 }, (_, i) => i)
    const out = deswizzle(5, 2, 1, 1, 4, BntxTileMode.Linear, 0, data)
    expect(out).toHaveLength(40)
    expect([...out.subarray(0, 20)]).toEqual([...data.subarray(0, 20)])
    expect([...out.subarray(20, 40)]).toEqual([...data.subarray(32, 52)])
  })

  it('maps a single GOB according to the Tegra X1 interleave', () => {
    // One 64x8 byte GOB holding 32x8 two-byte elements. Element k is stored with
    // the value k, so the untiled value at (x, y) is the GOB offset of the byte
    // at 2x, y divided by two. The offsets below come from the TRM's formula:
    //   ((x % 64) / 32) * 256 + ((y % 8) / 2) * 64
    //     + ((x % 32) / 16) * 32 + (y % 2) * 16 + (x % 16)
    const data = new Uint8Array(512)
    for (let k = 0; k < 256; k++) data[k * 2] = k

    const out = deswizzle(32, 8, 1, 1, 2, BntxTileMode.Optimal, 0, data)
    expect(out).toHaveLength(512)

    const elementAt = (x: number, y: number): number => out[(y * 32 + x) * 2]!
    expect(elementAt(0, 0)).toBe(0)
    expect(elementAt(1, 0)).toBe(1) // byte 2
    expect(elementAt(8, 0)).toBe(16) // byte 32
    expect(elementAt(16, 0)).toBe(128) // byte 256
    expect(elementAt(24, 0)).toBe(144) // byte 288
    expect(elementAt(0, 1)).toBe(8) // byte 16
    expect(elementAt(0, 2)).toBe(32) // byte 64
    expect(elementAt(0, 3)).toBe(40) // byte 80
    expect(elementAt(0, 4)).toBe(64) // byte 128
    expect(elementAt(0, 7)).toBe(104) // byte 208
    expect(elementAt(31, 7)).toBe(255) // byte 510

    // A complete GOB is a permutation: every element must appear exactly once.
    const seen = new Set<number>()
    for (let y = 0; y < 8; y++) for (let x = 0; x < 32; x++) seen.add(elementAt(x, y))
    expect(seen.size).toBe(256)
  })

  it('sizes a block-compressed surface in blocks, not pixels', () => {
    // 64x64 BC7-shaped surface: 16x16 blocks of 16 bytes each.
    const tiledSize = swizzledSurfaceSize(64, 64, 4, 4, 16, BntxTileMode.Optimal, 2)
    expect(tiledSize).toBe(8192) // roundUp(256, 64) * roundUp(16, 32)

    // No zero bytes in the input, so a zero in the output would mean an element
    // was never written.
    const data = Uint8Array.from({ length: tiledSize }, (_, i) => (i % 255) + 1)
    const out = deswizzle(64, 64, 4, 4, 16, BntxTileMode.Optimal, 2, data)
    expect(out).toHaveLength(16 * 16 * 16)
    expect(out.indexOf(0)).toBe(-1)
  })

  it('picks mip-0 block heights the way the driver does', () => {
    // Reference values from tegra_swizzle's block_heights_mip0_bcn test data.
    expect(blockHeightLog2Mip0(9)).toBe(0)
    expect(blockHeightLog2Mip0(10)).toBe(0)
    expect(blockHeightLog2Mip0(12)).toBe(1)
    expect(blockHeightLog2Mip0(21)).toBe(1)
    expect(blockHeightLog2Mip0(24)).toBe(2)
    expect(blockHeightLog2Mip0(42)).toBe(2)
    expect(blockHeightLog2Mip0(64)).toBe(3)
    expect(blockHeightLog2Mip0(128)).toBe(4)
  })

  it('halves the block height as a mip level shrinks', () => {
    expect(mipBlockHeightLog2(128, 4)).toBe(4)
    expect(mipBlockHeightLog2(64, 4)).toBe(3)
    expect(mipBlockHeightLog2(33, 4)).toBe(3)
    expect(mipBlockHeightLog2(32, 4)).toBe(2)
    expect(mipBlockHeightLog2(1, 4)).toBe(0)
    expect(mipBlockHeightLog2(1, 0)).toBe(0)
  })
})

describe('bntx uncompressed decoding', () => {
  it('passes R8G8B8A8 straight through', () => {
    const rgba = decodeSurface(
      BntxFormat.R8G8B8A8,
      BntxFormatVariant.Unorm,
      2,
      1,
      Uint8Array.from([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0])
    )
    expect([...rgba]).toEqual([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0])
  })

  it('swaps red and blue for B8G8R8A8', () => {
    const rgba = decodeSurface(
      BntxFormat.B8G8R8A8,
      BntxFormatVariant.Unorm,
      1,
      1,
      Uint8Array.from([0x12, 0x34, 0x56, 0x78])
    )
    expect([...rgba]).toEqual([0x56, 0x34, 0x12, 0x78])
  })

  it('expands R5G6B5 by replicating high bits, so 0x1f becomes 255', () => {
    const rgba = decodeSurface(
      BntxFormat.R5G6B5,
      BntxFormatVariant.Unorm,
      3,
      1,
      // 0xffff (all ones), 0x0000, 0x0821 (r5 = g6 = b5 = 1)
      Uint8Array.from([0xff, 0xff, 0x00, 0x00, 0x21, 0x08])
    )
    expect(pixel(rgba, 3, 0, 0)).toEqual([255, 255, 255, 255])
    expect(pixel(rgba, 3, 1, 0)).toEqual([0, 0, 0, 255])
    // 1 << 3 | 1 >> 2 == 8 for the 5-bit channels; 1 << 2 | 1 >> 4 == 4 for green.
    expect(pixel(rgba, 3, 2, 0)).toEqual([8, 4, 8, 255])
  })

  it('leaves the unused channels of R8 and R8G8 at zero', () => {
    expect([
      ...decodeSurface(BntxFormat.R8, BntxFormatVariant.Unorm, 1, 1, Uint8Array.from([0x7f]))
    ]).toEqual([0x7f, 0, 0, 255])
    expect([
      ...decodeSurface(BntxFormat.R8G8, BntxFormatVariant.Unorm, 1, 1, Uint8Array.from([0x10, 0x20]))
    ]).toEqual([0x10, 0x20, 0, 255])
  })

  it('unpacks the small floats of R11G11B10', () => {
    // R = 1.0 (exp 15, mantissa 0), G = 0.5 (exp 14), B = 1.0 (exp 15).
    // Packed: 0x781c03c0, little-endian.
    const rgba = decodeSurface(
      BntxFormat.R11G11B10,
      BntxFormatVariant.Float,
      1,
      1,
      Uint8Array.from([0xc0, 0x03, 0x1c, 0x78])
    )
    expect([...rgba]).toEqual([255, 128, 255, 255])
  })
})

describe('bntx BC1', () => {
  it('yields a flat colour when both endpoints are equal', () => {
    // c0 = c1 = 0xf800: r5 = 31 -> 255, g6 = 0, b5 = 0.
    const rgba = decodeSurface(
      BntxFormat.BC1,
      BntxFormatVariant.Unorm,
      4,
      4,
      surface([0x00, 0xf8, 0x00, 0xf8, 0x00, 0x00, 0x00, 0x00], 8)
    )
    for (let i = 0; i < 16; i++) {
      expect(pixel(rgba, 4, i % 4, Math.floor(i / 4))).toEqual([255, 0, 0, 255])
    }
  })

  it('interpolates the thirds when c0 > c1', () => {
    // c0 = 0xffff (255,255,255), c1 = 0x0000 (0,0,0), indices 0,1,2,3.
    // c2 = (2*255 + 0) / 3 = 170, c3 = (2*0 + 255) / 3 = 85.
    const rgba = decodeSurface(
      BntxFormat.BC1,
      BntxFormatVariant.Unorm,
      4,
      4,
      surface([0xff, 0xff, 0x00, 0x00, 0xe4, 0x00, 0x00, 0x00], 8)
    )
    expect(pixel(rgba, 4, 0, 0)).toEqual([255, 255, 255, 255])
    expect(pixel(rgba, 4, 1, 0)).toEqual([0, 0, 0, 255])
    expect(pixel(rgba, 4, 2, 0)).toEqual([170, 170, 170, 255])
    expect(pixel(rgba, 4, 3, 0)).toEqual([85, 85, 85, 255])
  })

  it('uses the midpoint and a transparent index when c0 <= c1', () => {
    // c0 = 0x0000, c1 = 0xffff: c2 = (0 + 255) / 2 = 127, c3 = transparent black.
    const rgba = decodeSurface(
      BntxFormat.BC1,
      BntxFormatVariant.Unorm,
      4,
      4,
      surface([0x00, 0x00, 0xff, 0xff, 0xe4, 0x00, 0x00, 0x00], 8)
    )
    expect(pixel(rgba, 4, 0, 0)).toEqual([0, 0, 0, 255])
    expect(pixel(rgba, 4, 1, 0)).toEqual([255, 255, 255, 255])
    expect(pixel(rgba, 4, 2, 0)).toEqual([127, 127, 127, 255])
    expect(pixel(rgba, 4, 3, 0)).toEqual([0, 0, 0, 0])
  })
})

describe('bntx BC2', () => {
  it('reads explicit 4-bit alphas, low nibble first', () => {
    const rgba = decodeSurface(
      BntxFormat.BC2,
      BntxFormatVariant.Unorm,
      4,
      4,
      surface(
        [
          // alpha: pixel 0 = 0xf, pixel 1 = 0x0, pixel 2 = 0x8, pixel 3 = 0x0
          0x0f, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
          // colour: white / black, every index 0
          0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
        ],
        16
      )
    )
    expect(pixel(rgba, 4, 0, 0)).toEqual([255, 255, 255, 255])
    expect(pixel(rgba, 4, 1, 0)).toEqual([255, 255, 255, 0])
    // 0x8 replicated into a byte is 0x88 = 136.
    expect(pixel(rgba, 4, 2, 0)).toEqual([255, 255, 255, 136])
    expect(pixel(rgba, 4, 3, 0)).toEqual([255, 255, 255, 0])
  })
})

describe('bntx BC3', () => {
  it('always interpolates thirds, even when c0 <= c1', () => {
    // A BC1 block with these endpoints would punch through; BC3 must not.
    // c0 = 0x0000, c1 = 0xffff -> c2 = 255/3 = 85, c3 = 510/3 = 170.
    const rgba = decodeSurface(
      BntxFormat.BC3,
      BntxFormatVariant.Unorm,
      4,
      4,
      surface(
        [
          // alpha: a0 = 255, a1 = 0, every index 0
          0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
          0x00, 0x00, 0xff, 0xff, 0xe4, 0x00, 0x00, 0x00
        ],
        16
      )
    )
    expect(pixel(rgba, 4, 0, 0)).toEqual([0, 0, 0, 255])
    expect(pixel(rgba, 4, 1, 0)).toEqual([255, 255, 255, 255])
    expect(pixel(rgba, 4, 2, 0)).toEqual([85, 85, 85, 255])
    expect(pixel(rgba, 4, 3, 0)).toEqual([170, 170, 170, 255])
  })
})

/**
 * Index bytes 0x88 0xc6 0xfa encode the 3-bit indices 0..7 for pixels 0..7 and
 * 0 for the rest: 0*1 + 1*8 + 2*64 + 3*512 + 4*4096 + 5*32768 + 6*262144 +
 * 7*2097152 = 0xfac688.
 */
const RAMP_INDICES = [0x88, 0xc6, 0xfa, 0x00, 0x00, 0x00]

/**
 * a0 = 255, a1 = 0 selects the six-interpolant mode, giving
 * a[i] = 255 + trunc(-255 * (i - 1) / 7) for i in 2..7.
 */
const DESCENDING_RAMP = [255, 0, 219, 183, 146, 110, 73, 37]

describe('bntx BC4', () => {
  it('builds the six-interpolant palette when a0 > a1', () => {
    const rgba = decodeSurface(
      BntxFormat.BC4,
      BntxFormatVariant.Unorm,
      4,
      4,
      surface([0xff, 0x00, ...RAMP_INDICES], 8)
    )
    for (let i = 0; i < 8; i++) {
      const value = DESCENDING_RAMP[i]!
      expect(pixel(rgba, 4, i % 4, Math.floor(i / 4))).toEqual([value, value, value, 255])
    }
    // Pixels 8..15 keep index 0.
    expect(pixel(rgba, 4, 0, 2)).toEqual([255, 255, 255, 255])
  })

  it('builds the four-interpolant palette plus both extremes when a0 <= a1', () => {
    // a[i] = trunc(255 * (i - 1) / 5) for i in 2..5; a[6] = 0, a[7] = 255.
    const expected = [0, 255, 51, 102, 153, 204, 0, 255]
    const rgba = decodeSurface(
      BntxFormat.BC4,
      BntxFormatVariant.Unorm,
      4,
      4,
      surface([0x00, 0xff, ...RAMP_INDICES], 8)
    )
    for (let i = 0; i < 8; i++) {
      const value = expected[i]!
      expect(pixel(rgba, 4, i % 4, Math.floor(i / 4))).toEqual([value, value, value, 255])
    }
  })

  it('remaps signed endpoints so -128 becomes 0 and 127 becomes 255', () => {
    // a0 = 0x7f (127), a1 = 0x80 (-128): the signed ramp lands on exactly the
    // same unorm bytes as the 255 -> 0 unsigned ramp.
    const rgba = decodeSurface(
      BntxFormat.BC4,
      BntxFormatVariant.Snorm,
      4,
      4,
      surface([0x7f, 0x80, ...RAMP_INDICES], 8)
    )
    for (let i = 0; i < 8; i++) {
      const value = DESCENDING_RAMP[i]!
      expect(pixel(rgba, 4, i % 4, Math.floor(i / 4))).toEqual([value, value, value, 255])
    }
  })
})

describe('bntx BC5', () => {
  it('decodes red and green from the two halves of the block', () => {
    const rgba = decodeSurface(
      BntxFormat.BC5,
      BntxFormatVariant.Unorm,
      4,
      4,
      surface(
        [
          // red: a0 = 255, a1 = 0, every index 0
          0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
          // green: the descending ramp
          0xff, 0x00, ...RAMP_INDICES
        ],
        16
      )
    )
    for (let i = 0; i < 8; i++) {
      expect(pixel(rgba, 4, i % 4, Math.floor(i / 4))).toEqual([255, DESCENDING_RAMP[i]!, 0, 255])
    }
  })

  it('remaps both signed channels', () => {
    const rgba = decodeSurface(
      BntxFormat.BC5,
      BntxFormatVariant.Snorm,
      4,
      4,
      surface(
        [0x7f, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x7f, 0x80, ...RAMP_INDICES],
        16
      )
    )
    for (let i = 0; i < 8; i++) {
      expect(pixel(rgba, 4, i % 4, Math.floor(i / 4))).toEqual([255, DESCENDING_RAMP[i]!, 0, 255])
    }
  })
})

describe('bntx format support', () => {
  it('accepts the formats it decodes', () => {
    expect(isFormatSupported(BntxFormat.BC1, BntxFormatVariant.Srgb)).toBe(true)
    expect(isFormatSupported(BntxFormat.BC5, BntxFormatVariant.Snorm)).toBe(true)
    expect(isFormatSupported(BntxFormat.R8G8B8A8, BntxFormatVariant.Unorm)).toBe(true)
    // ASTC arrived with the LDR decoder; tests/astc.test.ts covers it properly.
    expect(isFormatSupported(BntxFormat.Astc4x4, BntxFormatVariant.Srgb)).toBe(true)
    expect(isFormatSupported(BntxFormat.Astc12x12, BntxFormatVariant.Unorm)).toBe(true)
  })

  it('rejects the formats it defers', () => {
    expect(isFormatSupported(BntxFormat.BC6H, BntxFormatVariant.UFloat)).toBe(false)
    expect(isFormatSupported(BntxFormat.BC7, BntxFormatVariant.Unorm)).toBe(false)
    // ASTC read as a float is the HDR profile, which the decoder does not cover.
    expect(isFormatSupported(BntxFormat.Astc4x4, BntxFormatVariant.Float)).toBe(false)
    // A known channel layout read as an unsupported type is still unsupported.
    expect(isFormatSupported(BntxFormat.R8G8B8A8, BntxFormatVariant.SInt)).toBe(false)
  })

  it('throws UnsupportedFormatError rather than guessing', () => {
    expect(() =>
      decodeSurface(BntxFormat.BC7, BntxFormatVariant.Unorm, 4, 4, new Uint8Array(16))
    ).toThrow(UnsupportedFormatError)

    const astc = parseBntx(
      buildBntx({
        format: BntxFormat.Astc4x4,
        variant: BntxFormatVariant.Unorm,
        width: 4,
        height: 4,
        data: new Uint8Array(16)
      })
    )
    expect(() => decodeTexture(astc.textures[0]!)).toThrow(UnsupportedFormatError)
  })

  it('refuses a surface that is too small for its dimensions', () => {
    expect(() =>
      decodeSurface(BntxFormat.BC1, BntxFormatVariant.Unorm, 8, 8, new Uint8Array(8))
    ).toThrow(FormatParseError)
  })
})

describe('bntx decodeTexture', () => {
  it('untiles a linear texture and hands back the original pixels', () => {
    const data = Uint8Array.from({ length: 8 * 8 * 4 }, (_, i) => (i * 3 + 1) & 0xff)
    const container = parseBntx(
      buildBntx({
        format: BntxFormat.R8G8B8A8,
        variant: BntxFormatVariant.Unorm,
        width: 8,
        height: 8,
        tileMode: BntxTileMode.Linear,
        data
      })
    )

    const decoded = decodeTexture(container.textures[0]!)
    expect(decoded.width).toBe(8)
    expect(decoded.height).toBe(8)
    expect([...decoded.rgba]).toEqual([...data])
  })

  it('untiles a block-linear texture through the GOB interleave', () => {
    // 8x8 RGBA8 with block height 1: one GOB wide (8 px x 4 bytes = 32 bytes)
    // and one GOB tall. Pixel (0,0) sits at byte 0 and pixel (4,0) at byte 32,
    // because the GOB pattern jumps 32 bytes at the 16-byte-run boundary.
    const data = new Uint8Array(swizzledSurfaceSize(8, 8, 1, 1, 4, BntxTileMode.Optimal, 0))
    expect(data).toHaveLength(512)
    data.set([1, 2, 3, 4], 0)
    data.set([5, 6, 7, 8], 32)

    const container = parseBntx(
      buildBntx({
        format: BntxFormat.R8G8B8A8,
        variant: BntxFormatVariant.Unorm,
        width: 8,
        height: 8,
        blockHeightLog2: 0,
        data
      })
    )

    const decoded = decodeTexture(container.textures[0]!)
    expect(pixel(decoded.rgba, 8, 0, 0)).toEqual([1, 2, 3, 4])
    expect(pixel(decoded.rgba, 8, 4, 0)).toEqual([5, 6, 7, 8])
  })

  it('applies the channel sources', () => {
    // Broadcast red across RGB and force alpha to one, the usual setup for a
    // single-channel mask.
    const container = parseBntx(
      buildBntx({
        format: BntxFormat.R8,
        variant: BntxFormatVariant.Unorm,
        // One byte per pixel, so 32 wide is exactly the linear pitch alignment.
        width: 32,
        height: 4,
        tileMode: BntxTileMode.Linear,
        channelSources: [
          BntxChannelSource.Red,
          BntxChannelSource.Red,
          BntxChannelSource.Red,
          BntxChannelSource.One
        ],
        data: Uint8Array.from({ length: 32 * 4 }, () => 0x40)
      })
    )

    const decoded = decodeTexture(container.textures[0]!)
    expect(pixel(decoded.rgba, 32, 0, 0)).toEqual([0x40, 0x40, 0x40, 255])
    expect(pixel(decoded.rgba, 32, 31, 3)).toEqual([0x40, 0x40, 0x40, 255])
  })

  it('rejects a mip level the texture does not have', () => {
    const container = parseBntx(
      buildBntx({
        format: BntxFormat.R8G8B8A8,
        variant: BntxFormatVariant.Unorm,
        width: 8,
        height: 8,
        tileMode: BntxTileMode.Linear,
        data: new Uint8Array(8 * 8 * 4)
      })
    )
    expect(() => decodeTexture(container.textures[0]!, 1)).toThrow(FormatParseError)
  })
})

/**
 * The fixture generator tiles pixels with the same address function the decoder
 * untiles them with, so this is a round-trip rather than an independent check of
 * the swizzle maths — the hand-computed GOB assertions above are what pin that.
 * What it does prove is that the header the generator writes is one the parser
 * accepts, and that a surface tall enough to need multiple GOB blocks survives.
 */
describe('fixture generator', () => {
  it('round-trips a block-linear surface through parse and decode', () => {
    const width = 256
    const height = 128
    const source = testPattern(width, height)

    const container = parseBntx(
      buildFixtureBntx({
        containerName: 'MainMenu',
        textureName: 'MainMenu',
        width,
        height,
        rgba: source
      })
    )

    expect(container.name).toBe('MainMenu')
    expect(container.textures).toHaveLength(1)

    const texture = container.textures[0]!
    expect(texture.name).toBe('MainMenu')
    expect(texture.width).toBe(width)
    expect(texture.height).toBe(height)
    // 128 rows needs 8 GOB rows, which is the largest block height the mip-0
    // heuristic will choose.
    expect(texture.blockHeightLog2).toBe(4)

    const decoded = decodeTexture(texture)
    expect(decoded.width).toBe(width)
    expect(decoded.height).toBe(height)
    expect(decoded.rgba).toEqual(source)
  })
})
