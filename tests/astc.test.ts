import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { decodeAstc, decodeAstcBlock } from '@shared/formats/bntx/astc'
import { BntxFormat, BntxFormatVariant } from '@shared/formats/bntx/format'
import { decodeSurface, isFormatSupported } from '@shared/formats/bntx/decode'

/**
 * The decoder is checked against Arm's astcenc, which is the reference
 * implementation of this format. Each vector in the fixture is a real compressed
 * stream paired with what astcenc's own decoder produces from it, so these are
 * not self-consistency tests — a bug in our port cannot make them pass.
 *
 * Byte-exactness is the bar rather than a tolerance. ASTC decoding is specified in
 * exact integer arithmetic, so any difference at all is a defect.
 *
 * The fixture is a deliberately small slice. `pnpm validate:astc` runs the same
 * comparison over 180 vectors (ten block sizes, three quality presets, six kinds
 * of image content) against a directory of astcenc output; see that script for
 * how to regenerate.
 */

interface Vector {
  readonly name: string
  readonly note: string
  readonly blockWidth: number
  readonly blockHeight: number
  readonly width: number
  readonly height: number
  readonly astc: string
  readonly rgba: string
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/astc-vectors.json'), 'utf8')
) as { source: string; vectors: Vector[] }

function bytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'))
}

describe('astc reference vectors', () => {
  it('has vectors covering every decoder path worth covering', () => {
    expect(fixture.vectors.length).toBeGreaterThanOrEqual(8)
    // Block sizes must vary, or the weight-infill maths goes untested.
    const shapes = new Set(fixture.vectors.map((v) => `${v.blockWidth}x${v.blockHeight}`))
    expect(shapes.size).toBeGreaterThanOrEqual(6)
  })

  for (const vector of fixture.vectors) {
    it(`decodes ${vector.name} exactly (${vector.note})`, () => {
      const result = decodeAstc(
        vector.width,
        vector.height,
        vector.blockWidth,
        vector.blockHeight,
        bytes(vector.astc)
      )

      expect(result.firstError).toBeNull()
      expect(result.failedBlocks).toBe(0)
      expect(result.totalBlocks).toBe(
        Math.ceil(vector.width / vector.blockWidth) *
          Math.ceil(vector.height / vector.blockHeight)
      )

      const expected = bytes(vector.rgba)
      expect(result.rgba.length).toBe(expected.length)

      // Compared as a whole rather than per byte so a failure reports the first
      // differing index instead of 4096 separate assertions.
      let firstDifference = -1
      for (let i = 0; i < expected.length; i++) {
        if (result.rgba[i] !== expected[i]) {
          firstDifference = i
          break
        }
      }
      expect(
        firstDifference === -1
          ? 'identical'
          : `byte ${firstDifference} (pixel ${firstDifference >> 2}, channel ${firstDifference & 3}): got ${result.rgba[firstDifference]}, expected ${expected[firstDifference]}`
      ).toBe('identical')
    })
  }
})

describe('astc void extent blocks', () => {
  /**
   * Builds a void-extent block by hand: block mode 0b110111111100 marks LDR void
   * extent, then four 13-bit extent coordinates, then four UNORM16 channels.
   * Constant-colour blocks are the one case ASTC encodes losslessly, so the
   * output must be the exact colour asked for.
   */
  function voidExtentBlock(r: number, g: number, b: number, a: number): Uint8Array {
    const block = new Uint8Array(16)
    let pos = 0
    const write = (value: number, count: number): void => {
      for (let i = 0; i < count; i++) {
        if (((value >> i) & 1) !== 0) block[(pos + i) >> 3] |= 1 << ((pos + i) & 7)
      }
      pos += count
    }

    // Bits 0-8 = 111111100 identifies a void extent; bit 9 low selects LDR; bits
    // 10 and 11 are reserved and must be set.
    write(0x1fc, 9)
    write(0, 1)
    write(3, 2)
    // All-ones extent coordinates mean "the extent is unknown", which is legal.
    for (let i = 0; i < 4; i++) write(0x1fff, 13)
    for (const channel of [r, g, b, a]) write(channel * 257, 16)

    return block
  }

  it('reproduces the stored colour exactly', () => {
    const { tile, error } = decodeAstcBlock(voidExtentBlock(17, 200, 99, 128), 4, 4)
    expect(error).toBeNull()
    for (let i = 0; i < 16; i++) {
      expect([...tile.subarray(i * 4, i * 4 + 4)]).toEqual([17, 200, 99, 128])
    }
  })

  it('fills a whole surface from void extent blocks', () => {
    const block = voidExtentBlock(255, 0, 255, 255)
    const surface = new Uint8Array(16 * 4)
    for (let i = 0; i < 4; i++) surface.set(block, i * 16)

    const result = decodeAstc(8, 8, 4, 4, surface)
    expect(result.failedBlocks).toBe(0)
    for (let i = 0; i < 64; i++) {
      expect([...result.rgba.subarray(i * 4, i * 4 + 4)]).toEqual([255, 0, 255, 255])
    }
  })
})

describe('astc failure handling', () => {
  it('reports a bad block instead of throwing', () => {
    // All-zero is not a legal block: the low four bits of the mode being zero is
    // the reserved encoding.
    const { error } = decodeAstcBlock(new Uint8Array(16), 4, 4)
    expect(error).toBe('invalid block mode')
  })

  it('keeps the good blocks when only some fail', () => {
    const good = decodeAstcBlock(new Uint8Array(16), 4, 4)
    expect(good.error).not.toBeNull()

    const vector = fixture.vectors.find((v) => v.blockWidth === 4 && v.blockHeight === 4)!
    const surface = bytes(vector.astc).slice()
    // Corrupt exactly one block's mode bits.
    surface.fill(0, 0, 16)

    const result = decodeAstc(vector.width, vector.height, 4, 4, surface)
    expect(result.failedBlocks).toBe(1)
    expect(result.totalBlocks).toBeGreaterThan(1)
    expect(result.firstError).toBe('invalid block mode')

    // The rest of the image still decoded: the surface is not all zero.
    expect(result.rgba.some((byte) => byte !== 0)).toBe(true)
  })

  it('rejects block sizes that are not 2D ASTC', () => {
    const result = decodeAstc(4, 4, 3, 4, new Uint8Array(16))
    expect(result.firstError).toContain('not a 2D ASTC block size')
    expect(result.totalBlocks).toBe(0)
  })

  it('throws from decodeSurface only when nothing at all decoded', () => {
    // Two 4x4 blocks of zeroes: every block fails, so there is no image to show.
    expect(() =>
      decodeSurface(BntxFormat.Astc4x4, BntxFormatVariant.Srgb, 8, 4, new Uint8Array(32))
    ).toThrow(/invalid block mode/)
  })
})

describe('astc format wiring', () => {
  it('advertises support for every 2D ASTC block size, unorm and sRGB', () => {
    const formats = [
      BntxFormat.Astc4x4,
      BntxFormat.Astc5x4,
      BntxFormat.Astc5x5,
      BntxFormat.Astc6x5,
      BntxFormat.Astc6x6,
      BntxFormat.Astc8x5,
      BntxFormat.Astc8x6,
      BntxFormat.Astc8x8,
      BntxFormat.Astc10x5,
      BntxFormat.Astc10x6,
      BntxFormat.Astc10x8,
      BntxFormat.Astc10x10,
      BntxFormat.Astc12x10,
      BntxFormat.Astc12x12
    ]

    for (const format of formats) {
      expect(isFormatSupported(format, BntxFormatVariant.Unorm)).toBe(true)
      expect(isFormatSupported(format, BntxFormatVariant.Srgb)).toBe(true)
      // Float ASTC is the HDR profile, which this decoder does not implement.
      expect(isFormatSupported(format, BntxFormatVariant.Float)).toBe(false)
    }
  })

  it('decodes through decodeSurface with the same result as decodeAstc', () => {
    const vector = fixture.vectors.find((v) => v.blockWidth === 4 && v.blockHeight === 4)!
    const data = bytes(vector.astc)

    const direct = decodeAstc(vector.width, vector.height, 4, 4, data)
    const viaSurface = decodeSurface(
      BntxFormat.Astc4x4,
      BntxFormatVariant.Srgb,
      vector.width,
      vector.height,
      data
    )

    expect([...viaSurface]).toEqual([...direct.rgba])
  })
})
