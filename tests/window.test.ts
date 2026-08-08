import { describe, expect, it } from 'vitest'

import { createWindowPane } from '@shared/formats/bflyt/create'
import {
  applyTextureFlip,
  usesOneMaterialForAll,
  usesVertexColorForAll,
  windowFrameSizes,
  windowKind,
  windowPieces
} from '@shared/formats/bflyt/window'
import type { Vec2, WindowPane } from '@shared/formats/bflyt'

/**
 * Every expectation here is on geometry — rect extents, interlocking and insets —
 * which is derived from the format rather than from running the code. The UV
 * mapping for stretched frame edges is an approximation (see the module header),
 * so it is only checked for self-consistency: spans, order and flips.
 */

/** A 400x200 window centred on the origin: bounds are [-200, -100, 200, 100]. */
const BOUNDS = [-200, -100, 200, 100] as const

const SIZES = { left: 16, right: 16, top: 12, bottom: 12 }

function pane(options: {
  frames?: number
  flag?: number
  stretch?: number
} = {}): WindowPane {
  const result = createWindowPane('Wnd_Test', 0)
  result.width = 400
  result.height = 200
  result.flag = options.flag ?? 0
  result.frames = Array.from({ length: options.frames ?? 8 }, (_, index) => ({
    materialIndex: index,
    textureFlip: 0
  }))
  const stretch = options.stretch ?? 0
  result.stretchLeft = stretch
  result.stretchRight = stretch
  result.stretchTop = stretch
  result.stretchBottom = stretch
  return result
}

function byRole(geometry: ReturnType<typeof windowPieces>, role: string) {
  const found = geometry.frames.find((piece) => piece.role === role)
  if (!found) throw new Error(`no ${role} piece`)
  return found
}

describe('window kind and flags', () => {
  it('reads the kind out of bits 2-3', () => {
    expect(windowKind(0b0000)).toBe('around')
    expect(windowKind(0b0100)).toBe('horizontal')
    expect(windowKind(0b1000)).toBe('horizontalNoContent')
    // Bits 0-1 belong to the material and colour flags and must not leak in.
    expect(windowKind(0b0011)).toBe('around')
  })

  it('reads the material and vertex-colour flags out of bits 0-1', () => {
    expect(usesOneMaterialForAll(0b01)).toBe(true)
    expect(usesOneMaterialForAll(0b10)).toBe(false)
    expect(usesVertexColorForAll(0b10)).toBe(true)
    expect(usesVertexColorForAll(0b01)).toBe(false)
  })
})

describe('frame sizes', () => {
  it('prefers the frame texture size over frameElem', () => {
    const target = pane({ frames: 8 })
    target.frameElemLeft = 3
    target.frameElemTop = 3
    target.frameElemRight = 3
    target.frameElemBottom = 3

    // Frame 0 is the top-left corner, frame 7 the bottom-right.
    const sizes = windowFrameSizes(target, (index) =>
      index === 0 ? [20, 10] : index === 7 ? [30, 40] : undefined
    )
    expect(sizes).toEqual({ left: 20, top: 10, right: 30, bottom: 40 })
  })

  it('falls back to frameElem when the texture is not loaded yet', () => {
    const target = pane({ frames: 8 })
    target.frameElemLeft = 5
    target.frameElemRight = 6
    target.frameElemTop = 7
    target.frameElemBottom = 8

    expect(windowFrameSizes(target, () => undefined)).toEqual({
      left: 5,
      right: 6,
      top: 7,
      bottom: 8
    })
  })

  it('takes both axes from the single frame when there is only one', () => {
    const target = pane({ frames: 1 })
    const sizes = windowFrameSizes(target, () => [24, 18])
    expect(sizes).toEqual({ left: 24, right: 24, top: 18, bottom: 18 })
  })
})

describe('eight-frame nine-slice ring', () => {
  const geometry = windowPieces(pane({ frames: 8 }), BOUNDS, SIZES)

  it('places four corners at exactly the frame thickness', () => {
    expect(byRole(geometry, 'topLeft').rect).toEqual([-200, 88, -184, 100])
    expect(byRole(geometry, 'topRight').rect).toEqual([184, 88, 200, 100])
    expect(byRole(geometry, 'bottomLeft').rect).toEqual([-200, -100, -184, -88])
    expect(byRole(geometry, 'bottomRight').rect).toEqual([184, -100, 200, -88])
  })

  it('runs the edges between the corners without overlapping them', () => {
    expect(byRole(geometry, 'top').rect).toEqual([-184, 88, 184, 100])
    expect(byRole(geometry, 'bottom').rect).toEqual([-184, -100, 184, -88])
    expect(byRole(geometry, 'left').rect).toEqual([-200, -88, -184, 88])
    expect(byRole(geometry, 'right').rect).toEqual([184, -88, 200, 88])
  })

  it('covers the ring exactly once', () => {
    const area = geometry.frames.reduce((total, frame) => {
      const [l, b, r, t] = frame.rect
      return total + (r - l) * (t - b)
    }, 0)
    // 400x200 outer minus the 368x176 hole the content fills.
    expect(area).toBe(400 * 200 - 368 * 176)
  })

  it('stretches only the long axis of each edge', () => {
    const top = byRole(geometry, 'top')
    // 368 of inner width across a 16-wide corner texture.
    expect(top.uv[1]![0]).toBeCloseTo(368 / 16)
    expect(top.uv[0]![1]).toBe(1)

    const left = byRole(geometry, 'left')
    expect(left.uv[1]![0]).toBe(1)
    expect(left.uv[0]![1]).toBeCloseTo(176 / 12)
  })

  it('gives each frame its own material', () => {
    expect(geometry.frames.map((frame) => frame.materialIndex)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7
    ])
  })
})

describe('four-frame pinwheel', () => {
  const geometry = windowPieces(pane({ frames: 4 }), BOUNDS, SIZES)

  it('gives each piece a full side that stops before the next corner', () => {
    // Top piece spans from the left edge to the start of the right frame.
    expect(byRole(geometry, 'topLeft').rect).toEqual([-200, 88, 184, 100])
    // Right piece runs from above the bottom frame to the very top.
    expect(byRole(geometry, 'topRight').rect).toEqual([184, -88, 200, 100])
    // Left piece runs from the bottom to just under the top frame.
    expect(byRole(geometry, 'bottomLeft').rect).toEqual([-200, -100, -184, 88])
    // Bottom piece runs from the left frame to the right edge.
    expect(byRole(geometry, 'bottomRight').rect).toEqual([-184, -100, 200, -88])
  })

  it('interlocks: the four pieces tile the ring without overlap', () => {
    const area = geometry.frames.reduce((total, frame) => {
      const [l, b, r, t] = frame.rect
      return total + (r - l) * (t - b)
    }, 0)
    expect(area).toBe(400 * 200 - 368 * 176)
  })

  it('reaches every outer corner exactly once', () => {
    const corners = [
      [-200, 100],
      [200, 100],
      [-200, -100],
      [200, -100]
    ]
    for (const [x, y] of corners) {
      const covering = geometry.frames.filter((frame) => {
        const [l, b, r, t] = frame.rect
        return x! >= l && x! <= r && y! >= b && y! <= t
      })
      expect(covering).toHaveLength(1)
    }
  })
})

describe('one-frame windows', () => {
  it('use the pinwheel with frame 0 everywhere', () => {
    const geometry = windowPieces(pane({ frames: 1 }), BOUNDS, SIZES)
    expect(geometry.frames).toHaveLength(4)
    expect(geometry.frames.every((frame) => frame.materialIndex === 0)).toBe(true)
  })
})

describe('one material for all', () => {
  it('overrides every frame with frame 0 when the flag is set', () => {
    const geometry = windowPieces(pane({ frames: 8, flag: 0b01 }), BOUNDS, SIZES)
    expect(geometry.frames.every((frame) => frame.materialIndex === 0)).toBe(true)
  })

  it('keeps per-frame flips even when the material is shared', () => {
    const target = pane({ frames: 8, flag: 0b01 })
    target.frames[1] = { materialIndex: 1, textureFlip: 1 }
    const geometry = windowPieces(target, BOUNDS, SIZES)
    expect(byRole(geometry, 'topRight').textureFlip).toBe(1)
    expect(byRole(geometry, 'topRight').materialIndex).toBe(0)
  })
})

describe('content quad', () => {
  it('sits inside the ring', () => {
    const geometry = windowPieces(pane({ frames: 8 }), BOUNDS, SIZES)
    expect(geometry.content?.rect).toEqual([-184, -88, 184, 88])
  })

  it('grows back under the frame by the stretch values', () => {
    const geometry = windowPieces(pane({ frames: 8, stretch: 4 }), BOUNDS, SIZES)
    expect(geometry.content?.rect).toEqual([-188, -92, 188, 92])
  })

  it('spans the full height for horizontal windows', () => {
    const geometry = windowPieces(pane({ frames: 2, flag: 0b0100 }), BOUNDS, SIZES)
    expect(geometry.kind).toBe('horizontal')
    expect(geometry.content?.rect).toEqual([-184, -100, 184, 100])
    expect(geometry.frames).toHaveLength(2)
    expect(byRole(geometry, 'left').rect).toEqual([-200, -100, -184, 100])
    expect(byRole(geometry, 'right').rect).toEqual([184, -100, 200, 100])
  })

  it('is absent for the no-content kind, whose sides meet in the middle', () => {
    const geometry = windowPieces(pane({ frames: 2, flag: 0b1000 }), BOUNDS, SIZES)
    expect(geometry.kind).toBe('horizontalNoContent')
    expect(geometry.content).toBeNull()
    expect(byRole(geometry, 'left').rect).toEqual([-200, -100, 0, 100])
    expect(byRole(geometry, 'right').rect).toEqual([0, -100, 200, 100])
  })

  it('uses the content pane texture coordinates when it has them', () => {
    const target = pane({ frames: 8 })
    target.content.texCoords = [
      {
        topLeft: [0.25, 0.5],
        topRight: [0.75, 0.5],
        bottomLeft: [0.25, 1],
        bottomRight: [0.75, 1]
      }
    ]
    const geometry = windowPieces(target, BOUNDS, SIZES)
    // BL, BR, TR, TL.
    expect(geometry.content?.uv).toEqual([
      [0.25, 1],
      [0.75, 1],
      [0.75, 0.5],
      [0.25, 0.5]
    ])
  })
})

describe('texture flip', () => {
  const uv: [Vec2, Vec2, Vec2, Vec2] = [
    [0, 1],
    [1, 1],
    [1, 0],
    [0, 0]
  ]

  it('leaves UVs alone for None', () => {
    expect(applyTextureFlip(uv, 0)).toEqual(uv)
  })

  it('swaps left and right for FlipH', () => {
    expect(applyTextureFlip(uv, 1)).toEqual([
      [1, 1],
      [0, 1],
      [0, 0],
      [1, 0]
    ])
  })

  it('swaps top and bottom for FlipV', () => {
    expect(applyTextureFlip(uv, 2)).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1]
    ])
  })

  it('returns to the start after four 90-degree rotations', () => {
    let rotated = uv
    for (let i = 0; i < 4; i++) rotated = applyTextureFlip(rotated, 3)
    expect(rotated).toEqual(uv)
  })

  it('agrees that two 90-degree rotations make a 180', () => {
    expect(applyTextureFlip(applyTextureFlip(uv, 3), 3)).toEqual(applyTextureFlip(uv, 4))
  })

  it('agrees that 270 undoes 90', () => {
    expect(applyTextureFlip(applyTextureFlip(uv, 3), 5)).toEqual(uv)
  })
})

describe('degenerate input', () => {
  it('does not divide by zero when a frame has no thickness', () => {
    const geometry = windowPieces(pane({ frames: 8 }), BOUNDS, {
      left: 0,
      right: 0,
      top: 0,
      bottom: 0
    })
    for (const frame of geometry.frames) {
      for (const [u, v] of frame.uv) {
        expect(Number.isFinite(u)).toBe(true)
        expect(Number.isFinite(v)).toBe(true)
      }
    }
  })

  it('clamps the inner region rather than producing a negative edge', () => {
    // A frame thicker than the pane itself: edges collapse instead of inverting.
    const geometry = windowPieces(pane({ frames: 8 }), BOUNDS, {
      left: 500,
      right: 500,
      top: 500,
      bottom: 500
    })
    const top = byRole(geometry, 'top')
    expect(top.uv.every(([u, v]) => Number.isFinite(u) && Number.isFinite(v))).toBe(true)
  })
})
