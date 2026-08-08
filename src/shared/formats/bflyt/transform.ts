import type { Pane, Vec2 } from './types'

/**
 * 2D affine transform, same convention as canvas: [a, b, c, d, e, f] maps
 * (x, y) to (a·x + c·y + e, b·x + d·y + f).
 */
export type Affine = readonly [number, number, number, number, number, number]

export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0]

export function multiply(m: Affine, n: Affine): Affine {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5]
  ]
}

export function apply(m: Affine, x: number, y: number): Vec2 {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

export function invert(m: Affine): Affine | null {
  const det = m[0] * m[3] - m[1] * m[2]
  if (det === 0) return null
  const inv = 1 / det
  return [
    m[3] * inv,
    -m[1] * inv,
    -m[2] * inv,
    m[0] * inv,
    (m[2] * m[5] - m[3] * m[4]) * inv,
    (m[1] * m[4] - m[0] * m[5]) * inv
  ]
}

/**
 * A pane's own transform: translate, then rotate about Z, then scale.
 *
 * Only Z rotation is applied. X and Y rotation exist in the format but the
 * editor's view is orthographic and flat, matching how these layouts are
 * authored and how Switch-Toolbox previews them.
 */
export function localTransform(pane: Pane, override?: PaneValues): Affine {
  const rotation = override?.rotate?.[2] ?? pane.rotate[2]
  const radians = (rotation * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const sx = override?.scale?.[0] ?? pane.scale[0]
  const sy = override?.scale?.[1] ?? pane.scale[1]
  const tx = override?.translate?.[0] ?? pane.translate[0]
  const ty = override?.translate?.[1] ?? pane.translate[1]
  return [cos * sx, sin * sx, -sin * sy, cos * sy, tx, ty]
}

/**
 * The pane's quad in its own coordinate space, as [left, bottom, right, top].
 *
 * Origin codes place the pane's (0, 0) at an edge or the centre: 0 is left/top,
 * 1 centre, 2 right/bottom. Y is up, so an origin of "top" puts the rect below
 * the origin.
 */
export function localBounds(
  pane: Pane,
  override?: PaneValues
): readonly [number, number, number, number] {
  const { origin } = pane
  const w = override?.width ?? pane.width
  const h = override?.height ?? pane.height

  const left = origin.x === 0 ? 0 : origin.x === 1 ? -w / 2 : -w
  const top = origin.y === 0 ? 0 : origin.y === 1 ? h / 2 : h

  return [left, top - h, left + w, top]
}

/**
 * Animated values that replace a pane's authored ones for this frame.
 *
 * A structural subset of `PaneOverride` from the BFLAN override layer, declared
 * here so the transform maths does not depend on the animation format — the two
 * are independent and the layout side should stay usable without it.
 */
export interface PaneValues {
  readonly translate?: readonly (number | undefined)[]
  readonly rotate?: readonly (number | undefined)[]
  readonly scale?: readonly (number | undefined)[]
  readonly width?: number
  readonly height?: number
  readonly visible?: boolean
  readonly alpha?: number
}

/** Resolves the animated values for a pane, or undefined when unanimated. */
export type PaneValueLookup = (pane: Pane) => PaneValues | undefined

export interface PaneTransform {
  readonly pane: Pane
  /** Animated values in effect for this frame, if any. */
  readonly values: PaneValues | undefined
  readonly world: Affine
  /** Alpha after multiplying through influencing ancestors, 0..1. */
  readonly effectiveAlpha: number
  /** False when this pane or any ancestor is hidden. */
  readonly visible: boolean
  /** Painter's order index; later draws on top. */
  readonly order: number
}

/**
 * Flattens the pane tree into draw order with world transforms resolved.
 *
 * Alpha inherits only through panes with influenceAlpha set, which is how the
 * format expresses "fade this subtree together" versus "fade just this pane".
 */
export function flattenPanes(root: Pane | null, lookup?: PaneValueLookup): PaneTransform[] {
  const out: PaneTransform[] = []
  if (!root) return out

  const walk = (pane: Pane, parentWorld: Affine, parentAlpha: number, parentVisible: boolean): void => {
    // Animated values are resolved once per pane and reused for the transform,
    // the bounds and the alpha, so a frame can never be half-animated.
    const values = lookup?.(pane)
    const world = multiply(parentWorld, localTransform(pane, values))
    const own = (values?.alpha ?? pane.alpha) / 255
    const effectiveAlpha = pane.influenceAlpha ? parentAlpha * own : own
    const visible = parentVisible && (values?.visible ?? pane.visible)

    out.push({ pane, values, world, effectiveAlpha, visible, order: out.length })

    // Children inherit the parent's alpha only when it influences them.
    const childAlpha = pane.influenceAlpha ? effectiveAlpha : parentAlpha
    for (const child of pane.children) walk(child, world, childAlpha, visible)
  }

  walk(root, IDENTITY, 1, true)
  return out
}

/**
 * Topmost pane containing the point, in layout coordinates. Draw order is
 * back-to-front, so the search runs backwards.
 */
/**
 * Every pane under a point, topmost first.
 *
 * Needed as well as `hitTest` because shipped layouts routinely put a full-screen
 * `bnd1` or `pan1` last in the tree, and painter's order makes that the topmost hit
 * — so "the pane you clicked" is often not the one you meant, and everything beneath
 * it is unreachable on the canvas without a way to look past it.
 */
export function hitTestAll(
  panes: readonly PaneTransform[],
  x: number,
  y: number,
  options?: { includeHidden?: boolean }
): PaneTransform[] {
  const hits: PaneTransform[] = []
  for (let i = panes.length - 1; i >= 0; i--) {
    const entry = panes[i]!
    if (!entry.visible && !options?.includeHidden) continue

    const inverse = invert(entry.world)
    if (!inverse) continue

    const [localX, localY] = apply(inverse, x, y)
    const [left, bottom, right, top] = localBounds(entry.pane, entry.values)
    if (localX >= left && localX <= right && localY >= bottom && localY <= top) hits.push(entry)
  }
  return hits
}

export function hitTest(
  panes: readonly PaneTransform[],
  x: number,
  y: number,
  options?: { includeHidden?: boolean }
): PaneTransform | null {
  return hitTestAll(panes, x, y, options)[0] ?? null
}

/** Axis-aligned bounds of a pane's quad in layout coordinates. */
export function worldBounds(
  entry: PaneTransform
): readonly [number, number, number, number] {
  const [left, bottom, right, top] = localBounds(entry.pane, entry.values)
  const corners = [
    apply(entry.world, left, bottom),
    apply(entry.world, right, bottom),
    apply(entry.world, right, top),
    apply(entry.world, left, top)
  ]
  const xs = corners.map((c) => c[0])
  const ys = corners.map((c) => c[1])
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}
