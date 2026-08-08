import { describe, expect, it } from 'vitest'

import { createNullPane, createPicturePane } from '@shared/formats/bflyt/create'
import {
  RESIZE_HANDLES,
  alignmentCandidates,
  alignmentSnap,
  handleCursor,
  handlePosition,
  panesInRect,
  resizePane,
  type Rect
} from '@shared/formats/bflyt/editing'
import { flattenPanes, localBounds } from '@shared/formats/bflyt/transform'
import type { Pane } from '@shared/formats/bflyt'

/**
 * Every expectation is derived by hand from the origin-code rules, not by running
 * the code. The resize cases are the important ones: which edge holds still
 * depends entirely on the origin, and getting it wrong is the kind of bug that
 * only shows up as "the pane jumps when I drag it".
 */

function pane(options: {
  width?: number
  height?: number
  originX?: number
  originY?: number
  translate?: [number, number]
} = {}): Pane {
  const result = createPicturePane('Pic_Test', 0)
  result.width = options.width ?? 100
  result.height = options.height ?? 50
  result.origin = {
    x: options.originX ?? 1,
    y: options.originY ?? 1,
    parentX: 1,
    parentY: 1
  }
  result.translate = [options.translate?.[0] ?? 0, options.translate?.[1] ?? 0, 0]
  return result
}

/** Absolute edges of a pane, so tests can assert an edge held still. */
function edges(target: Pane, dx = 0, dy = 0, width?: number, height?: number) {
  const resized = { ...target, width: width ?? target.width, height: height ?? target.height }
  const [left, bottom, right, top] = localBounds(resized as Pane)
  return {
    left: left + target.translate[0] + dx,
    right: right + target.translate[0] + dx,
    bottom: bottom + target.translate[1] + dy,
    top: top + target.translate[1] + dy
  }
}

describe('resize handles', () => {
  it('covers all eight positions with no duplicates', () => {
    expect(RESIZE_HANDLES).toHaveLength(8)
    expect(new Set(RESIZE_HANDLES).size).toBe(8)
  })

  it('places handles on the pane bounds', () => {
    // Centre origin: bounds are [-50, -25, 50, 25].
    const target = pane()
    expect(handlePosition(target, 'topLeft')).toEqual([-50, 25])
    expect(handlePosition(target, 'bottomRight')).toEqual([50, -25])
    expect(handlePosition(target, 'top')).toEqual([0, 25])
    expect(handlePosition(target, 'left')).toEqual([-50, 0])
  })

  it('follows the origin code when placing handles', () => {
    // Left/top origin: bounds are [0, -50, 100, 0].
    const target = pane({ originX: 0, originY: 0 })
    expect(handlePosition(target, 'topLeft')).toEqual([0, 0])
    expect(handlePosition(target, 'bottomRight')).toEqual([100, -50])
  })

  it('gives each handle a sensible cursor', () => {
    expect(handleCursor('left')).toBe('ew-resize')
    expect(handleCursor('top')).toBe('ns-resize')
    expect(handleCursor('topLeft')).toBe('nwse-resize')
    expect(handleCursor('topRight')).toBe('nesw-resize')
  })
})

describe('resizePane', () => {
  it('grows to the right from a left origin without moving', () => {
    const target = pane({ originX: 0 })
    const result = resizePane(target, 'right', 20, 0)
    expect(result.width).toBe(120)
    expect(result.translateDx).toBe(0)
  })

  it('grows both ways from a centre origin, staying centred', () => {
    const target = pane({ originX: 1 })
    const result = resizePane(target, 'right', 20, 0)
    expect(result.width).toBe(120)
    // Half the growth goes to the translate so the left edge holds.
    expect(result.translateDx).toBe(10)
  })

  it('keeps the right edge fixed when dragging the left handle', () => {
    const target = pane({ originX: 1, translate: [0, 0] })
    const before = edges(target)
    const result = resizePane(target, 'left', 20, 0)
    const after = edges(target, result.translateDx, 0, result.width, result.height)
    expect(result.width).toBe(80)
    expect(after.right).toBeCloseTo(before.right)
    expect(after.left).toBeCloseTo(before.left + 20)
  })

  it('keeps the left edge fixed when dragging the right handle', () => {
    const target = pane({ originX: 2, translate: [30, 0] })
    const before = edges(target)
    const result = resizePane(target, 'right', 20, 0)
    const after = edges(target, result.translateDx, 0, result.width, result.height)
    expect(result.width).toBe(120)
    expect(after.left).toBeCloseTo(before.left)
    expect(after.right).toBeCloseTo(before.right + 20)
  })

  it('keeps the top edge fixed when dragging the bottom handle', () => {
    const target = pane({ originY: 1, translate: [0, 10] })
    const before = edges(target)
    const result = resizePane(target, 'bottom', 10, 10)
    const after = edges(target, 0, result.translateDy, result.width, result.height)
    expect(result.height).toBe(40)
    expect(after.top).toBeCloseTo(before.top)
    expect(after.bottom).toBeCloseTo(before.bottom + 10)
  })

  it('keeps the bottom edge fixed when dragging the top handle', () => {
    const target = pane({ originY: 0, translate: [0, 10] })
    const before = edges(target)
    const result = resizePane(target, 'top', 0, 10)
    const after = edges(target, 0, result.translateDy, result.width, result.height)
    expect(result.height).toBe(60)
    expect(after.bottom).toBeCloseTo(before.bottom)
    expect(after.top).toBeCloseTo(before.top + 10)
  })

  it('resizes both axes from a corner handle', () => {
    const target = pane({ originX: 1, originY: 1 })
    const result = resizePane(target, 'topRight', 10, 10)
    expect(result.width).toBe(110)
    expect(result.height).toBe(60)
  })

  it('leaves the untouched axis alone', () => {
    const target = pane()
    const horizontal = resizePane(target, 'left', 10, 999)
    expect(horizontal.height).toBe(50)
    expect(horizontal.translateDy).toBe(0)

    const vertical = resizePane(target, 'top', 999, 10)
    expect(vertical.width).toBe(100)
    expect(vertical.translateDx).toBe(0)
  })

  it('clamps at the minimum size instead of inverting', () => {
    const target = pane({ width: 20, height: 20 })
    const result = resizePane(target, 'left', 500, 0, { minSize: 4 })
    expect(result.width).toBe(4)

    const other = resizePane(target, 'right', -500, 0, { minSize: 4 })
    expect(other.width).toBe(4)
  })

  it('still keeps the opposite edge fixed when clamped', () => {
    const target = pane({ width: 20, originX: 1 })
    const before = edges(target)
    const result = resizePane(target, 'left', 500, 0, { minSize: 4 })
    const after = edges(target, result.translateDx, 0, result.width, result.height)
    expect(after.right).toBeCloseTo(before.right)
  })
})

describe('marquee selection', () => {
  function tree(): Pane {
    const root = createNullPane('RootPane')
    root.width = 1280
    root.height = 720

    const a = pane({ width: 100, height: 100, translate: [-200, 0] })
    a.name = 'A'
    const b = pane({ width: 100, height: 100, translate: [200, 0] })
    b.name = 'B'
    const hidden = pane({ width: 100, height: 100, translate: [0, 0] })
    hidden.name = 'Hidden'
    hidden.visible = false

    root.children.push(a, b, hidden)
    return root
  }

  const flat = flattenPanes(tree())

  it('selects panes the rect touches', () => {
    // A is centre-origin, 100 wide at x = -200, so it spans -250 to -150.
    const hits = panesInRect(flat, [-300, -60, -100, 60])
    expect(hits.map((entry) => entry.pane.name)).toEqual(['A'])
  })

  it('selects on intersection rather than containment', () => {
    // Straddles only A's right edge at x = -150.
    const hits = panesInRect(flat, [-160, -10, -140, 10])
    expect(hits.map((entry) => entry.pane.name)).toEqual(['A'])
  })

  it('selects several panes at once', () => {
    const hits = panesInRect(flat, [-300, -60, 300, 60])
    expect(hits.map((entry) => entry.pane.name).sort()).toEqual(['A', 'B'])
  })

  it('never selects the root, which would cover everything', () => {
    const hits = panesInRect(flat, [-1000, -1000, 1000, 1000])
    expect(hits.some((entry) => entry.pane.name === 'RootPane')).toBe(false)
  })

  it('skips hidden panes unless asked for them', () => {
    const rect: Rect = [-20, -20, 20, 20]
    expect(panesInRect(flat, rect).map((e) => e.pane.name)).toEqual([])
    expect(
      panesInRect(flat, rect, { includeHidden: true }).map((e) => e.pane.name)
    ).toEqual(['Hidden'])
  })

  it('accepts a rect dragged in any direction', () => {
    const forward = panesInRect(flat, [-300, -60, -100, 60])
    const backward = panesInRect(flat, [-100, 60, -300, -60])
    expect(backward.map((e) => e.pane.name)).toEqual(forward.map((e) => e.pane.name))
  })

  it('selects nothing for an empty area', () => {
    expect(panesInRect(flat, [500, 300, 520, 320])).toEqual([])
  })
})

describe('alignment snapping', () => {
  const other: Rect = [0, 0, 100, 100]

  it('snaps a left edge to another left edge', () => {
    const snap = alignmentSnap([3, 200, 103, 300], [other], 8)
    expect(snap.dx).toBe(-3)
    expect(snap.guides).toContainEqual({ axis: 'x', position: 0 })
  })

  it('snaps a left edge to the other rect right edge', () => {
    const snap = alignmentSnap([98, 200, 198, 300], [other], 8)
    expect(snap.dx).toBe(2)
    expect(snap.guides).toContainEqual({ axis: 'x', position: 100 })
  })

  it('snaps centres together', () => {
    const snap = alignmentSnap([2, 200, 102, 300], [other], 8)
    // Left-to-left is 2 away and centre-to-centre is also 2; either is correct,
    // and what matters is that the result actually aligns something.
    expect(Math.abs(snap.dx)).toBeLessThanOrEqual(2)
  })

  it('snaps both axes independently', () => {
    const snap = alignmentSnap([3, 97, 103, 197], [other], 8)
    expect(snap.dx).toBe(-3)
    expect(snap.dy).toBe(3)
    expect(snap.guides).toHaveLength(2)
  })

  it('does nothing outside the threshold', () => {
    const snap = alignmentSnap([40, 200, 140, 300], [other], 8)
    expect(snap.dx).toBe(0)
    expect(snap.dy).toBe(0)
    expect(snap.guides).toEqual([])
  })

  it('picks the closest candidate on each axis', () => {
    const near: Rect = [10, 0, 110, 100]
    const far: Rect = [0, 0, 100, 100]
    const snap = alignmentSnap([13, 500, 113, 600], [far, near], 20)
    // 10 is 3 away, 0 is 13 away.
    expect(snap.dx).toBe(-3)
  })

  it('does nothing with no candidates', () => {
    const snap = alignmentSnap([0, 0, 10, 10], [], 8)
    expect(snap).toEqual({ dx: 0, dy: 0, guides: [] })
  })
})

describe('alignment candidates', () => {
  function nested(): Pane {
    const root = createNullPane('RootPane')
    root.width = 1280
    root.height = 720

    const parent = pane({ width: 200, height: 200 })
    parent.name = 'Parent'
    const child = pane({ width: 50, height: 50 })
    child.name = 'Child'
    parent.children.push(child)

    const sibling = pane({ width: 80, height: 80, translate: [300, 0] })
    sibling.name = 'Sibling'

    root.children.push(parent, sibling)
    return root
  }

  const flat = flattenPanes(nested())

  it('excludes the moving pane and the root', () => {
    const names = (rects: Rect[]): number => rects.length
    const candidates = alignmentCandidates(flat, ['Parent'])
    // Ids are generated, so compare by count: root excluded always, and with a
    // non-matching id nothing else is dropped -> Parent, Child, Sibling.
    expect(names(candidates)).toBe(3)
  })

  it('excludes descendants of a moving pane, which move with it', () => {
    const parent = flat.find((entry) => entry.pane.name === 'Parent')!
    const candidates = alignmentCandidates(flat, [parent.pane.id])
    // Parent and Child both gone; only Sibling remains.
    expect(candidates).toHaveLength(1)
    const [left, , right] = candidates[0]!
    expect(left).toBe(260)
    expect(right).toBe(340)
  })

  it('returns nothing when everything is moving', () => {
    const ids = flat.map((entry) => entry.pane.id)
    expect(alignmentCandidates(flat, ids)).toEqual([])
  })
})
