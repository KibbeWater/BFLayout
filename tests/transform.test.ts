import { describe, expect, it } from 'vitest'

import {
  createNullPane,
  createPicturePane
} from '@shared/formats/bflyt/create'
import {
  apply,
  flattenPanes,
  hitTest,
  invert,
  localBounds,
  localTransform,
  multiply,
  worldBounds,
  IDENTITY
} from '@shared/formats/bflyt/transform'
import type { Pane } from '@shared/formats/bflyt'

describe('affine maths', () => {
  it('leaves points untouched under identity', () => {
    expect(apply(IDENTITY, 3, -7)).toEqual([3, -7])
  })

  it('composes translation after scaling in the expected order', () => {
    const scale = [2, 0, 0, 2, 0, 0] as const
    const translate = [1, 0, 0, 1, 10, 5] as const
    // multiply(scale, translate) applies translate first, then scale.
    expect(apply(multiply(scale, translate), 1, 1)).toEqual([22, 12])
  })

  it('inverts a transform back onto the original point', () => {
    const m = multiply([0, 1, -1, 0, 0, 0], [1, 0, 0, 1, 5, -3])
    const inverse = invert(m)!
    const [x, y] = apply(m, 4, 9)
    const [bx, by] = apply(inverse, x, y)
    expect(bx).toBeCloseTo(4)
    expect(by).toBeCloseTo(9)
  })

  it('reports a degenerate transform as non-invertible', () => {
    expect(invert([0, 0, 0, 0, 0, 0])).toBeNull()
  })
})

describe('pane bounds from origin codes', () => {
  function boundsFor(originX: number, originY: number): readonly number[] {
    const pane = createNullPane('P')
    pane.width = 100
    pane.height = 50
    pane.origin.x = originX
    pane.origin.y = originY
    return localBounds(pane)
  }

  it('places the rect right of the origin when anchored left', () => {
    expect(boundsFor(0, 1)).toEqual([0, -25, 100, 25])
  })

  it('centres the rect on the origin when anchored centre', () => {
    expect(boundsFor(1, 1)).toEqual([-50, -25, 50, 25])
  })

  it('places the rect left of the origin when anchored right', () => {
    expect(boundsFor(2, 1)).toEqual([-100, -25, 0, 25])
  })

  it('hangs the rect below the origin when anchored top, since Y is up', () => {
    expect(boundsFor(1, 0)).toEqual([-50, -50, 50, 0])
  })

  it('puts the rect above the origin when anchored bottom', () => {
    expect(boundsFor(1, 2)).toEqual([-50, 0, 50, 50])
  })
})

describe('local transform', () => {
  it('applies translation', () => {
    const pane = createNullPane('P')
    pane.translate = [15, -4, 0]
    expect(apply(localTransform(pane), 0, 0)).toEqual([15, -4])
  })

  it('rotates about Z in degrees', () => {
    const pane = createNullPane('P')
    pane.rotate = [0, 0, 90]
    const [x, y] = apply(localTransform(pane), 1, 0)
    expect(x).toBeCloseTo(0)
    expect(y).toBeCloseTo(1)
  })

  it('scales before translating', () => {
    const pane = createNullPane('P')
    pane.scale = [3, 2]
    pane.translate = [10, 10, 0]
    expect(apply(localTransform(pane), 1, 1)).toEqual([13, 12])
  })
})

describe('flattening the tree', () => {
  function tree(): Pane {
    const root = createNullPane('Root')
    root.translate = [100, 50, 0]

    const child = createPicturePane('Child')
    child.translate = [10, 5, 0]

    const grandchild = createPicturePane('Grandchild')
    grandchild.translate = [1, 1, 0]

    child.children.push(grandchild)
    root.children.push(child)
    return root
  }

  it('accumulates parent transforms down the tree', () => {
    const flat = flattenPanes(tree())
    expect(flat.map((entry) => entry.pane.name)).toEqual(['Root', 'Child', 'Grandchild'])
    expect(apply(flat[2]!.world, 0, 0)).toEqual([111, 56])
  })

  it('records draw order back to front', () => {
    const flat = flattenPanes(tree())
    expect(flat.map((entry) => entry.order)).toEqual([0, 1, 2])
  })

  it('inherits alpha only through panes that influence it', () => {
    const root = createNullPane('Root')
    root.alpha = 128
    root.influenceAlpha = true

    const influenced = createPicturePane('Influenced')
    influenced.alpha = 255
    influenced.influenceAlpha = true

    const independent = createPicturePane('Independent')
    independent.alpha = 255
    independent.influenceAlpha = false

    root.children.push(influenced, independent)

    const flat = flattenPanes(root)
    const byName = new Map(flat.map((entry) => [entry.pane.name, entry]))
    expect(byName.get('Influenced')!.effectiveAlpha).toBeCloseTo(128 / 255)
    expect(byName.get('Independent')!.effectiveAlpha).toBeCloseTo(1)
  })

  it('marks descendants of a hidden pane as not visible', () => {
    const root = createNullPane('Root')
    root.visible = false
    const child = createPicturePane('Child')
    root.children.push(child)

    const flat = flattenPanes(root)
    expect(flat.every((entry) => !entry.visible)).toBe(true)
    // The pane's own flag is untouched; only the resolved value differs.
    expect(child.visible).toBe(true)
  })
})

describe('hit testing', () => {
  function overlapping(): Pane {
    const root = createNullPane('Root')
    root.width = 0
    root.height = 0

    const back = createPicturePane('Back')
    back.width = 200
    back.height = 200

    const front = createPicturePane('Front')
    front.width = 100
    front.height = 100

    root.children.push(back, front)
    return root
  }

  it('returns the topmost pane when panes overlap', () => {
    const flat = flattenPanes(overlapping())
    expect(hitTest(flat, 0, 0)?.pane.name).toBe('Front')
  })

  it('falls through to the pane underneath outside the top one', () => {
    const flat = flattenPanes(overlapping())
    expect(hitTest(flat, 80, 80)?.pane.name).toBe('Back')
  })

  it('misses entirely outside every pane', () => {
    const flat = flattenPanes(overlapping())
    expect(hitTest(flat, 500, 500)).toBeNull()
  })

  it('skips hidden panes unless asked to include them', () => {
    const root = overlapping()
    root.children[1]!.visible = false
    const flat = flattenPanes(root)

    expect(hitTest(flat, 0, 0)?.pane.name).toBe('Back')
    expect(hitTest(flat, 0, 0, { includeHidden: true })?.pane.name).toBe('Front')
  })

  it('accounts for rotation when testing a point', () => {
    const root = createNullPane('Root')
    root.width = 0
    root.height = 0
    const bar = createPicturePane('Bar')
    bar.width = 200
    bar.height = 20
    bar.rotate = [0, 0, 90]
    root.children.push(bar)

    const flat = flattenPanes(root)
    // Rotated upright: tall and thin, so a point far up the Y axis is inside.
    expect(hitTest(flat, 0, 80)?.pane.name).toBe('Bar')
    expect(hitTest(flat, 80, 0)).toBeNull()
  })
})

describe('world bounds', () => {
  it('expands to contain a rotated pane', () => {
    const pane = createPicturePane('P')
    pane.width = 100
    pane.height = 20
    pane.rotate = [0, 0, 45]

    const flat = flattenPanes(pane)
    const [minX, minY, maxX, maxY] = worldBounds(flat[0]!)
    const expected = (100 / 2) * Math.SQRT1_2 + (20 / 2) * Math.SQRT1_2
    expect(maxX).toBeCloseTo(expected)
    expect(maxY).toBeCloseTo(expected)
    expect(minX).toBeCloseTo(-expected)
    expect(minY).toBeCloseTo(-expected)
  })
})
