import { describe, expect, it } from 'vitest'

import {
  BntxTileMode,
  deswizzle,
  swizzle,
  swizzledSurfaceSize
} from '@shared/formats/bntx/swizzle'

/**
 * The forward swizzle, checked against the reverse one that decodes 74,571 real
 * textures correctly.
 *
 * This is the only leverage available without a GPU. A tiling function that
 * disagrees with the hardware produces a texture that looks perfect in this app —
 * it round-trips through our own code — and is shredded on screen. Pinning it to
 * the *proven* direction is what makes it trustworthy: `deswizzle` is validated
 * against a real dump, so anything that survives `deswizzle(swizzle(x)) === x` for
 * every shape is laying bytes out where the reader expects to find them.
 */

function pattern(length: number): Uint8Array {
  const out = new Uint8Array(length)
  // Deliberately not constant and not a simple ramp: a byte-order or stride bug
  // often survives both.
  for (let at = 0; at < length; at++) out[at] = (at * 37 + (at >> 5) * 11) & 0xff
  return out
}

/** Shapes chosen to straddle the GOB (64×8) and block boundaries. */
const SHAPES = [
  { width: 64, height: 64, bpp: 4, blockHeightLog2: 0 },
  { width: 64, height: 64, bpp: 4, blockHeightLog2: 4 },
  // Not a multiple of a GOB in either direction — the padding case.
  { width: 40, height: 20, bpp: 4, blockHeightLog2: 2 },
  { width: 1, height: 1, bpp: 4, blockHeightLog2: 0 },
  { width: 256, height: 128, bpp: 4, blockHeightLog2: 3 },
  // Single-channel, where bpp no longer divides the GOB width evenly.
  { width: 37, height: 13, bpp: 1, blockHeightLog2: 1 }
]

describe('swizzle', () => {
  for (const shape of SHAPES) {
    it(`round-trips ${shape.width}x${shape.height} bpp=${shape.bpp} blockHeight=2^${shape.blockHeightLog2}`, () => {
      const linear = pattern(shape.width * shape.height * shape.bpp)

      const tiled = swizzle(
        shape.width,
        shape.height,
        1,
        1,
        shape.bpp,
        BntxTileMode.Optimal,
        shape.blockHeightLog2,
        linear
      )
      const back = deswizzle(
        shape.width,
        shape.height,
        1,
        1,
        shape.bpp,
        BntxTileMode.Optimal,
        shape.blockHeightLog2,
        tiled
      )

      expect([...back]).toEqual([...linear])
    })
  }

  it('produces exactly the surface size the container will declare', () => {
    const tiled = swizzle(40, 20, 1, 1, 4, BntxTileMode.Optimal, 2, pattern(40 * 20 * 4))
    expect(tiled.length).toBe(swizzledSurfaceSize(40, 20, 1, 1, 4, BntxTileMode.Optimal, 2))
  })

  /**
   * Compressed formats are swizzled in units of blocks, which is what lets the
   * same code serve BCn. Nothing here compresses, but a replacement that keeps the
   * original's format has to tile the same way.
   */
  it('works in units of blocks, as BCn needs', () => {
    // BC7: 4x4 pixel blocks, 16 bytes each.
    const width = 64
    const height = 32
    const linear = pattern((width / 4) * (height / 4) * 16)

    const tiled = swizzle(width, height, 4, 4, 16, BntxTileMode.Optimal, 2, linear)
    const back = deswizzle(width, height, 4, 4, 16, BntxTileMode.Optimal, 2, tiled)
    expect([...back]).toEqual([...linear])
  })

  it('round-trips a pitch-linear surface too', () => {
    const linear = pattern(40 * 20 * 4)
    const tiled = swizzle(40, 20, 1, 1, 4, BntxTileMode.Linear, 0, linear)
    const back = deswizzle(40, 20, 1, 1, 4, BntxTileMode.Linear, 0, tiled)
    expect([...back]).toEqual([...linear])
  })
})
