import type { Pane } from './types'
import { localBounds, worldBounds, type PaneTransform } from './transform'

/**
 * Geometry for direct manipulation on the canvas: resizing, marquee selection and
 * alignment guides.
 *
 * All of it is pure so it can be tested without a GL context or a DOM. The canvas
 * only has to turn pointer events into deltas and draw what comes back.
 */

export type ResizeHandle =
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'
  | 'topLeft'
  | 'topRight'
  | 'bottomLeft'
  | 'bottomRight'

export const RESIZE_HANDLES: readonly ResizeHandle[] = [
  'topLeft',
  'top',
  'topRight',
  'right',
  'bottomRight',
  'bottom',
  'bottomLeft',
  'left'
]

/**
 * Where the pane's origin sits inside its own rect, as a fraction from the left
 * and from the bottom.
 *
 * This is the whole reason resizing needs more than "add to width": the origin
 * code decides which edge stays put when the size changes. A left-origin pane
 * grows rightwards, a centre-origin pane grows both ways.
 */
function originFractions(pane: Pane): { fx: number; fy: number } {
  // localBounds puts left at 0 / -w/2 / -w for origin.x 0 / 1 / 2.
  const fx = pane.origin.x === 0 ? 0 : pane.origin.x === 1 ? 0.5 : 1
  // Y is up and origin.y 0 / 1 / 2 means top / centre / bottom, so the fraction
  // measured from the bottom runs the other way.
  const fy = pane.origin.y === 0 ? 1 : pane.origin.y === 1 ? 0.5 : 0
  return { fx, fy }
}

export interface ResizeResult {
  readonly width: number
  readonly height: number
  /** Translation the pane needs so the untouched edges stay where they were. */
  readonly translateDx: number
  readonly translateDy: number
}

/**
 * New size and position after dragging a resize handle by (dx, dy) in the pane's
 * own space.
 *
 * The edges the handle does not touch stay fixed, which is what makes resizing
 * feel right. Sizes are clamped at `minSize` rather than allowed to invert:
 * a negative width is representable in the format but nothing sensible reads it.
 */
export function resizePane(
  pane: Pane,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  options?: { minSize?: number }
): ResizeResult {
  const minSize = options?.minSize ?? 1
  const { fx, fy } = originFractions(pane)

  const movesLeft = handle === 'left' || handle === 'topLeft' || handle === 'bottomLeft'
  const movesRight = handle === 'right' || handle === 'topRight' || handle === 'bottomRight'
  const movesTop = handle === 'top' || handle === 'topLeft' || handle === 'topRight'
  const movesBottom = handle === 'bottom' || handle === 'bottomLeft' || handle === 'bottomRight'

  let width = pane.width
  let translateDx = 0
  if (movesLeft) {
    // Dragging the left edge right shrinks the pane; the right edge holds.
    const clamped = Math.min(dx, pane.width - minSize)
    width = pane.width - clamped
    translateDx = clamped * (1 - fx)
  } else if (movesRight) {
    const clamped = Math.max(dx, minSize - pane.width)
    width = pane.width + clamped
    translateDx = clamped * fx
  }

  let height = pane.height
  let translateDy = 0
  if (movesBottom) {
    const clamped = Math.min(dy, pane.height - minSize)
    height = pane.height - clamped
    translateDy = clamped * (1 - fy)
  } else if (movesTop) {
    const clamped = Math.max(dy, minSize - pane.height)
    height = pane.height + clamped
    translateDy = clamped * fy
  }

  return { width, height, translateDx, translateDy }
}

/** Handle positions in the pane's own space, for drawing and hit-testing. */
export function handlePosition(
  pane: Pane,
  handle: ResizeHandle
): readonly [number, number] {
  const [left, bottom, right, top] = localBounds(pane)
  const midX = (left + right) / 2
  const midY = (bottom + top) / 2

  switch (handle) {
    case 'left':
      return [left, midY]
    case 'right':
      return [right, midY]
    case 'top':
      return [midX, top]
    case 'bottom':
      return [midX, bottom]
    case 'topLeft':
      return [left, top]
    case 'topRight':
      return [right, top]
    case 'bottomLeft':
      return [left, bottom]
    default:
      return [right, bottom]
  }
}

/** CSS cursor for a handle, so the pointer says what the drag will do. */
export function handleCursor(handle: ResizeHandle): string {
  switch (handle) {
    case 'left':
    case 'right':
      return 'ew-resize'
    case 'top':
    case 'bottom':
      return 'ns-resize'
    case 'topLeft':
    case 'bottomRight':
      return 'nwse-resize'
    default:
      return 'nesw-resize'
  }
}

export type Rect = readonly [number, number, number, number]

function normalizeRect(rect: Rect): Rect {
  const [x0, y0, x1, y1] = rect
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)]
}

/**
 * Panes whose world bounds intersect a marquee.
 *
 * Intersection rather than containment: dragging a box over part of a pane is
 * what people expect to select it, and requiring full containment makes selecting
 * anything large impossible without zooming out.
 *
 * The root pane is skipped — it covers everything, so including it would make
 * every marquee select the whole layout.
 */
export function panesInRect(
  panes: readonly PaneTransform[],
  rect: Rect,
  options?: { includeHidden?: boolean }
): PaneTransform[] {
  const [left, bottom, right, top] = normalizeRect(rect)
  const rootId = panes[0]?.pane.id

  return panes.filter((entry) => {
    if (entry.pane.id === rootId) return false
    if (!entry.visible && !options?.includeHidden) return false
    const [l, b, r, t] = worldBounds(entry)
    return l <= right && r >= left && b <= top && t >= bottom
  })
}

export interface Guide {
  readonly axis: 'x' | 'y'
  /** Layout-space coordinate of the guide line. */
  readonly position: number
}

export interface AlignmentSnap {
  /** Offset to add to the moving rect so it lines up. */
  readonly dx: number
  readonly dy: number
  readonly guides: readonly Guide[]
}

/**
 * Snaps a moving rect to nearby edges and centres of other rects.
 *
 * Each axis is considered independently and only the closest candidate within
 * `threshold` wins, so a pane cannot be pulled two ways at once. `threshold` is
 * in layout units, so callers should divide by the zoom to keep the pull feeling
 * the same at any magnification.
 */
export function alignmentSnap(
  moving: Rect,
  others: readonly Rect[],
  threshold: number
): AlignmentSnap {
  const [left, bottom, right, top] = normalizeRect(moving)
  const movingX = [left, (left + right) / 2, right]
  const movingY = [bottom, (bottom + top) / 2, top]

  let bestX: { delta: number; position: number } | null = null
  let bestY: { delta: number; position: number } | null = null

  for (const other of others) {
    const [ol, ob, or, ot] = normalizeRect(other)
    const otherX = [ol, (ol + or) / 2, or]
    const otherY = [ob, (ob + ot) / 2, ot]

    for (const mine of movingX) {
      for (const theirs of otherX) {
        const delta = theirs - mine
        if (Math.abs(delta) > threshold) continue
        if (!bestX || Math.abs(delta) < Math.abs(bestX.delta)) {
          bestX = { delta, position: theirs }
        }
      }
    }

    for (const mine of movingY) {
      for (const theirs of otherY) {
        const delta = theirs - mine
        if (Math.abs(delta) > threshold) continue
        if (!bestY || Math.abs(delta) < Math.abs(bestY.delta)) {
          bestY = { delta, position: theirs }
        }
      }
    }
  }

  const guides: Guide[] = []
  if (bestX) guides.push({ axis: 'x', position: bestX.position })
  if (bestY) guides.push({ axis: 'y', position: bestY.position })

  return { dx: bestX?.delta ?? 0, dy: bestY?.delta ?? 0, guides }
}

/**
 * World bounds of every pane except the ones being moved and their descendants.
 *
 * Descendants are excluded because they move with their parent: snapping a pane
 * to its own child would make it impossible to drag at all.
 */
export function alignmentCandidates(
  panes: readonly PaneTransform[],
  movingIds: readonly string[]
): Rect[] {
  const excluded = new Set<string>(movingIds)

  // One forward pass is enough: flattenPanes emits parents before children.
  for (const entry of panes) {
    if (excluded.has(entry.pane.id)) {
      for (const child of entry.pane.children) excluded.add(child.id)
    }
  }

  const rootId = panes[0]?.pane.id
  return panes
    .filter((entry) => !excluded.has(entry.pane.id) && entry.pane.id !== rootId)
    .map((entry) => worldBounds(entry))
}
