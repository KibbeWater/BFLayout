import type { Vec2, WindowPane } from './types'

/**
 * Window-pane (wnd1) nine-slice geometry.
 *
 * A window pane is a content quad surrounded by a frame ring. The number of
 * frames decides how the ring is cut up, and it is not a free choice — the
 * format only allows 1, 2, 4 and 8:
 *
 *   1  one material for the whole ring, laid out as a pinwheel
 *   2  two materials, left and right (horizontal kinds only)
 *   4  a pinwheel: four L-shaped pieces, each a corner plus one edge
 *   8  a true nine-slice ring: four corners then four edges
 *
 * The pinwheel is the part that surprises people. With four frames Nintendo does
 * *not* cut four corners and stretch four edges; each piece spans a full side and
 * stops short of the next corner, so the four pieces interlock rotationally. The
 * ordering is fixed: 0 top-left, 1 top-right, 2 bottom-left, 3 bottom-right,
 * then for eight frames 4 top, 5 bottom, 6 left, 7 right.
 *
 * ## What is verified and what is not
 *
 * The rectangles here are geometry and are unit-tested: every piece's extent,
 * the interlocking of the pinwheel, and the content inset.
 *
 * The **UV mapping is an approximation.** A stretched axis maps 0 to
 * `length / frameSize`, which with clamped sampling renders the frame texture at
 * its natural size and then extends its last row or column along the rest of the
 * side. That is what Switch Toolbox's preview does and it looks right for the
 * usual rounded-corner frame, but it is not derived from Nintendo's runtime and
 * has not been checked against a real game frame. Corners are also not
 * auto-mirrored: real layouts set `textureFlip` per frame for that, and guessing
 * on top of it would double-flip the files that do it properly.
 */

/** `nn::ui2d` window kind, from bits 2-3 of the pane's flag byte. */
export type WindowKind = 'around' | 'horizontal' | 'horizontalNoContent'

export function windowKind(flag: number): WindowKind {
  switch ((flag >> 2) & 0x3) {
    case 1:
      return 'horizontal'
    case 2:
      return 'horizontalNoContent'
    default:
      return 'around'
  }
}

/** Bit 0: every frame shares frame 0's material. */
export function usesOneMaterialForAll(flag: number): boolean {
  return (flag & 0x1) !== 0
}

/** Bit 1: frames take the content's vertex colours instead of plain white. */
export function usesVertexColorForAll(flag: number): boolean {
  return (flag & 0x2) !== 0
}

/** How thick the ring is on each side. */
export interface WindowFrameSizes {
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
}

export type WindowPieceRole =
  | 'content'
  | 'topLeft'
  | 'topRight'
  | 'bottomLeft'
  | 'bottomRight'
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'

export interface WindowPiece {
  readonly role: WindowPieceRole
  /** Local-space rect as [left, bottom, right, top], Y up. */
  readonly rect: readonly [number, number, number, number]
  /** UVs in BL, BR, TR, TL order, matching the renderer's quad winding. */
  readonly uv: readonly [Vec2, Vec2, Vec2, Vec2]
  readonly materialIndex: number
  readonly textureFlip: number
}

export interface WindowGeometry {
  readonly kind: WindowKind
  /** Null when the kind draws no content quad. */
  readonly content: WindowPiece | null
  readonly frames: readonly WindowPiece[]
}

/**
 * Frame thickness, preferring the size of each frame's own texture and falling
 * back to the pane's frameElem fields.
 *
 * Real layouts leave frameElem at zero and rely on the texture's dimensions,
 * because the ring is exactly as thick as the art. `textureSize` looks up a
 * frame's texture; returning undefined just means the fallback is used, which is
 * what happens while a texture is still loading.
 */
export function windowFrameSizes(
  pane: WindowPane,
  textureSize: (materialIndex: number) => readonly [number, number] | undefined
): WindowFrameSizes {
  const first = pane.frames[0]
  const last = pane.frames[pane.frames.length - 1]

  let left = 0
  let right = 0
  let top = 0
  let bottom = 0

  if (pane.frames.length === 1 && first) {
    const size = textureSize(first.materialIndex)
    if (size) {
      left = right = size[0]
      top = bottom = size[1]
    }
  } else if (first && last) {
    // The first frame is a top-left corner and the last a bottom-right one, so
    // between them they give all four thicknesses.
    const start = textureSize(first.materialIndex)
    const end = textureSize(last.materialIndex)
    if (start) {
      left = start[0]
      top = start[1]
    }
    if (end) {
      right = end[0]
      bottom = end[1]
    }
  }

  return {
    left: left || pane.frameElemLeft,
    right: right || pane.frameElemRight,
    top: top || pane.frameElemTop,
    bottom: bottom || pane.frameElemBottom
  }
}

/** UVs for a rect that shows the texture once, optionally stretched past 1. */
function stretchedUv(uSpan: number, vSpan: number): [Vec2, Vec2, Vec2, Vec2] {
  // BL, BR, TR, TL — v grows downward in texture space, so the bottom row is 1.
  return [
    [0, vSpan],
    [uSpan, vSpan],
    [uSpan, 0],
    [0, 0]
  ]
}

/**
 * Rewrites UVs for a frame's `textureFlip`.
 *
 * Values are `nn::ui2d::WindowFrameTexFlip`: 0 none, 1 horizontal, 2 vertical,
 * 3/4/5 rotate 90/180/270. Rotations permute the corners; flips mirror them.
 */
export function applyTextureFlip(
  uv: readonly [Vec2, Vec2, Vec2, Vec2],
  flip: number
): [Vec2, Vec2, Vec2, Vec2] {
  const [bl, br, tr, tl] = uv
  switch (flip) {
    case 1: // horizontal: swap left and right
      return [br, bl, tl, tr]
    case 2: // vertical: swap top and bottom
      return [tl, tr, br, bl]
    case 3: // rotate 90 degrees
      return [br, tr, tl, bl]
    case 4: // rotate 180 degrees
      return [tr, tl, bl, br]
    case 5: // rotate 270 degrees
      return [tl, bl, br, tr]
    default:
      return [bl, br, tr, tl]
  }
}

/** Ratio of a side's length to the frame texture's size along that axis. */
function span(length: number, frameSize: number): number {
  return frameSize > 0 ? length / frameSize : 1
}

/**
 * Cuts a window pane into drawable pieces.
 *
 * `bounds` is the pane's local rect from `localBounds`, so the origin code has
 * already been applied and everything here is plain rectangle arithmetic.
 */
export function windowPieces(
  pane: WindowPane,
  bounds: readonly [number, number, number, number],
  sizes: WindowFrameSizes
): WindowGeometry {
  const [left, bottom, right, top] = bounds
  const width = right - left
  const height = top - bottom
  const kind = windowKind(pane.flag)

  const frameFor = (index: number): { materialIndex: number; textureFlip: number } => {
    const frames = pane.frames
    const source = usesOneMaterialForAll(pane.flag)
      ? frames[0]
      : (frames[index] ?? frames[0])
    return {
      materialIndex: source?.materialIndex ?? pane.content.materialIndex,
      textureFlip: frames[index]?.textureFlip ?? 0
    }
  }

  const piece = (
    role: WindowPieceRole,
    rect: readonly [number, number, number, number],
    uSpan: number,
    vSpan: number,
    frameIndex: number
  ): WindowPiece => {
    const { materialIndex, textureFlip } = frameFor(frameIndex)
    return {
      role,
      rect,
      uv: applyTextureFlip(stretchedUv(uSpan, vSpan), textureFlip),
      materialIndex,
      textureFlip
    }
  }

  const content = buildContent(pane, bounds, sizes, kind)
  const frames: WindowPiece[] = []

  if (kind === 'around') {
    if (pane.frames.length >= 8) {
      // Four corners at natural size, then four edges stretched between them.
      const innerWidth = Math.max(0, width - sizes.left - sizes.right)
      const innerHeight = Math.max(0, height - sizes.top - sizes.bottom)

      frames.push(
        piece('topLeft', [left, top - sizes.top, left + sizes.left, top], 1, 1, 0),
        piece('topRight', [right - sizes.right, top - sizes.top, right, top], 1, 1, 1),
        piece('bottomLeft', [left, bottom, left + sizes.left, bottom + sizes.bottom], 1, 1, 2),
        piece(
          'bottomRight',
          [right - sizes.right, bottom, right, bottom + sizes.bottom],
          1,
          1,
          3
        ),
        piece(
          'top',
          [left + sizes.left, top - sizes.top, right - sizes.right, top],
          span(innerWidth, sizes.left),
          1,
          4
        ),
        piece(
          'bottom',
          [left + sizes.left, bottom, right - sizes.right, bottom + sizes.bottom],
          span(innerWidth, sizes.left),
          1,
          5
        ),
        piece(
          'left',
          [left, bottom + sizes.bottom, left + sizes.left, top - sizes.top],
          1,
          span(innerHeight, sizes.top),
          6
        ),
        piece(
          'right',
          [right - sizes.right, bottom + sizes.bottom, right, top - sizes.top],
          1,
          span(innerHeight, sizes.top),
          7
        )
      )
    } else {
      // Pinwheel: each piece runs the full length of one side and stops before
      // the next corner, so the four interlock without overlapping.
      frames.push(
        piece(
          'topLeft',
          [left, top - sizes.top, right - sizes.right, top],
          span(width - sizes.right, sizes.left),
          1,
          0
        ),
        piece(
          'topRight',
          [right - sizes.right, bottom + sizes.bottom, right, top],
          1,
          span(height - sizes.bottom, sizes.top),
          1
        ),
        piece(
          'bottomLeft',
          [left, bottom, left + sizes.left, top - sizes.top],
          1,
          span(height - sizes.top, sizes.bottom),
          2
        ),
        piece(
          'bottomRight',
          [left + sizes.left, bottom, right, bottom + sizes.bottom],
          span(width - sizes.left, sizes.right),
          1,
          3
        )
      )
    }
  } else {
    // Horizontal kinds have no corners: two full-height pieces at the sides. With
    // no content, they meet in the middle instead of framing anything.
    const meeting = kind === 'horizontalNoContent' ? width / 2 : sizes.left
    frames.push(
      piece(
        'left',
        [left, bottom, left + meeting, top],
        span(meeting, sizes.left),
        1,
        0
      ),
      piece(
        'right',
        [right - (kind === 'horizontalNoContent' ? width - meeting : sizes.right), bottom, right, top],
        span(kind === 'horizontalNoContent' ? width - meeting : sizes.right, sizes.right),
        1,
        1
      )
    )
  }

  return { kind, content, frames }
}

function buildContent(
  pane: WindowPane,
  bounds: readonly [number, number, number, number],
  sizes: WindowFrameSizes,
  kind: WindowKind
): WindowPiece | null {
  if (kind === 'horizontalNoContent') return null

  const [left, bottom, right, top] = bounds

  // Stretch values push the content back out under the frame, which is how
  // layouts hide a seam between a translucent frame and its fill.
  const contentLeft = left + sizes.left - pane.stretchLeft
  const contentRight = right - sizes.right + pane.stretchRight
  const contentTop = kind === 'horizontal' ? top : top - sizes.top + pane.stretchTop
  const contentBottom =
    kind === 'horizontal' ? bottom : bottom + sizes.bottom - pane.stretchBottom

  const coords = pane.content.texCoords[0]
  const uv: [Vec2, Vec2, Vec2, Vec2] = coords
    ? [
        [coords.bottomLeft[0], coords.bottomLeft[1]],
        [coords.bottomRight[0], coords.bottomRight[1]],
        [coords.topRight[0], coords.topRight[1]],
        [coords.topLeft[0], coords.topLeft[1]]
      ]
    : stretchedUv(1, 1)

  return {
    role: 'content',
    rect: [contentLeft, contentBottom, contentRight, contentTop],
    uv,
    materialIndex: pane.content.materialIndex,
    textureFlip: 0
  }
}
