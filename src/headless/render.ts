import {
  apply,
  flattenPanes,
  localBounds,
  multiply,
  type Affine,
  type PaneTransform,
  type PaneValueLookup
} from '@shared/formats/bflyt/transform'
import type { LayoutDocument, Pane, Rgba, Vec2 } from '@shared/formats/bflyt/types'
import { windowFrameSizes, windowPieces } from '@shared/formats/bflyt'
import type { DecodedTexture } from './textures'
import { encodePng } from './png'

/**
 * A software renderer for layouts, so a preview needs no window and no GPU.
 *
 * The editor's canvas is WebGL and lives in a renderer process; neither the CLI
 * nor the MCP server has one. What they need is different anyway: not a faithful
 * frame, but a picture that answers "which box is this pane, and where" — which a
 * flat, colour-coded, correctly-positioned rendering does perfectly well.
 *
 * The positioning is *not* approximate, and deliberately so. It goes through the
 * same `flattenPanes`/`localBounds` the canvas and the hit-testing use, so a
 * preview cannot disagree with the editor about where a pane is. Reimplementing
 * origin codes and parent-relative translation here would have produced a second
 * version of the trickiest arithmetic in the project, and the two would have
 * drifted the first time either was corrected.
 *
 * What it does not draw: textures, nine-slice window frames, and text. Each is
 * real work in the GPU renderer and none changes the answer to the question above,
 * so the result is reported as a diagram rather than dressed up as a screenshot.
 */

export interface RenderedPane {
  readonly name: string
  readonly kind: string
  readonly visible: boolean
  /** Bounding box in canvas space: y down, origin top-left. */
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly alpha: number
}

export interface RenderResult {
  readonly png: Uint8Array
  readonly width: number
  readonly height: number
  readonly panes: readonly RenderedPane[]
  /** What the picture is not showing, so nobody reads more into it than is there. */
  readonly caveats: readonly string[]
}

/** Distinct, stable colours per pane kind — the legend is the kind name. */
const KIND_COLOR: Record<string, readonly [number, number, number]> = {
  pan1: [130, 130, 145],
  pic1: [80, 150, 240],
  txt1: [90, 205, 160],
  wnd1: [235, 175, 70],
  bnd1: [200, 95, 200],
  prt1: [240, 120, 120]
}

export interface RenderOptions {
  /** Longest edge of the output, preserving aspect. */
  readonly maxSize?: number
  /** Draw panes the game would hide, dimmed. Off by default. */
  readonly showInvisible?: boolean
  /** Restrict drawing to one pane and its children. */
  readonly only?: string
  /**
   * Animated values in effect for this frame.
   *
   * The same hook the editor's canvas uses, which is what lets a preview show a
   * layout *as an animation leaves it* rather than only as it was authored — an
   * animation is a list of numbers until you can see what it does.
   */
  readonly lookup?: PaneValueLookup
  /**
   * Decoded textures by the name a layout refers to them by.
   *
   * Supplied rather than fetched, because finding them is filesystem work and
   * this module is the part that only does arithmetic. Absent means the flat
   * diagram — which is still the right answer when nothing can be decoded.
   */
  readonly textures?: ReadonlyMap<string, DecodedTexture>
  /**
   * The layouts part panes instantiate, by the name the part refers to.
   *
   * A `prt1` pane draws another whole layout in its place, and a romfs uses them
   * everywhere — this game's menu is nine part panes and almost nothing else. A
   * renderer that stops at the part draws nine empty boxes and calls it a screen.
   *
   * Each carries its own textures, because a part layout has its own texture list
   * and its indices mean nothing in the parent.
   */
  readonly parts?: ReadonlyMap<string, PartSource>
}

export interface PartSource {
  readonly document: LayoutDocument
  readonly textures: ReadonlyMap<string, DecodedTexture>
}

/** One pane ready to draw, with everything resolved against its own document. */
interface Draw {
  readonly entry: PaneTransform
  readonly world: Affine
  readonly alpha: number
  readonly visible: boolean
  readonly document: LayoutDocument
  readonly textures: ReadonlyMap<string, DecodedTexture> | undefined
  readonly depth: number
}

function tint(pane: Pane): readonly [number, number, number] {
  const base = KIND_COLOR[pane.kind] ?? [150, 150, 150]
  if (pane.kind !== 'pic1') return base

  const corners: Rgba[] = [
    pane.colorTopLeft,
    pane.colorTopRight,
    pane.colorBottomLeft,
    pane.colorBottomRight
  ]
  const average = [0, 1, 2].map(
    (channel) => corners.reduce((sum, corner) => sum + corner[channel]!, 0) / corners.length
  )
  // A flat white tint means "no tint" and is overwhelmingly the common case;
  // honouring it would render every picture pane as the same white box.
  if (average.every((value) => value > 240)) return base
  return [average[0]!, average[1]!, average[2]!]
}

const IDENTITY_AFFINE: Affine = [1, 0, 0, 1, 0, 0]

/** The four world-space corners of a pane's quad, under a given transform. */
function quadWith(
  entry: PaneTransform,
  world: Affine
): readonly (readonly [number, number])[] {
  const [left, bottom, right, top] = localBounds(entry.pane, entry.values)
  return [
    apply(world, left, top),
    apply(world, right, top),
    apply(world, right, bottom),
    apply(world, left, bottom)
  ]
}

export function renderLayout(
  document: LayoutDocument,
  options: RenderOptions = {}
): RenderResult {
  const canvasWidth = Math.max(1, Math.round(document.info.width))
  const canvasHeight = Math.max(1, Math.round(document.info.height))

  const maxSize = options.maxSize ?? 1024
  const scale = Math.min(1, maxSize / Math.max(canvasWidth, canvasHeight))
  const width = Math.max(1, Math.round(canvasWidth * scale))
  const height = Math.max(1, Math.round(canvasHeight * scale))

  const pixels = new Uint8Array(width * height * 4)
  // Mid-grey: game UI is drawn in both light and dark colours, and either white
  // or black as a ground would hide half of it.
  for (let at = 0; at < pixels.length; at += 4) {
    pixels[at] = 43
    pixels[at + 1] = 43
    pixels[at + 2] = 48
    pixels[at + 3] = 255
  }

  const blend = (
    x: number,
    y: number,
    color: readonly [number, number, number],
    alpha: number
  ): void => {
    if (x < 0 || y < 0 || x >= width || y >= height || alpha <= 0) return
    const at = (y * width + x) * 4
    const a = Math.min(1, alpha)
    pixels[at] = Math.round(pixels[at]! * (1 - a) + color[0] * a)
    pixels[at + 1] = Math.round(pixels[at + 1]! * (1 - a) + color[1] * a)
    pixels[at + 2] = Math.round(pixels[at + 2]! * (1 - a) + color[2] * a)
  }

  /*
   * Layout space has y up with the origin at the canvas centre; the image has y
   * down with the origin at the top left.
   */
  const toCanvas = (point: readonly [number, number]): readonly [number, number] => [
    (point[0] + canvasWidth / 2) * scale,
    (canvasHeight / 2 - point[1]) * scale
  ]

  /**
   * Every pane to draw, following part panes into the layouts they instantiate.
   *
   * Depth-bounded: a part that instantiates itself, directly or through a chain,
   * would otherwise recurse until the stack gives out — and a malformed layout is
   * exactly the sort of thing a preview gets pointed at.
   */
  const collectDraws = (
    source: LayoutDocument,
    textures: ReadonlyMap<string, DecodedTexture> | undefined,
    base: Affine,
    baseAlpha: number,
    baseVisible: boolean,
    depth: number,
    seen: ReadonlySet<string>
  ): Draw[] => {
    const out: Draw[] = []
    for (const entry of flattenPanes(source.rootPane, options.lookup)) {
      const world = depth === 0 ? entry.world : multiply(base, entry.world)
      const alpha = entry.effectiveAlpha * baseAlpha
      const visible = entry.visible && baseVisible

      out.push({ entry, world, alpha, visible, document: source, textures, depth })

      if (entry.pane.kind !== 'prt1' || depth >= 4) continue
      const part = options.parts?.get(entry.pane.externalLayoutName.toLowerCase())
      if (!part || seen.has(entry.pane.externalLayoutName.toLowerCase())) continue

      /*
       * The part's own transform is already in `world`; the instantiated layout
       * additionally carries the pane's magnify factor. Leaving it out misplaces
       * and missizes every part's contents — which is worse than not drawing them,
       * because it looks like art rather than like a gap.
       *
       * This matches what the editor's canvas does in `buildPart`.
       */
      const [magnifyX, magnifyY] = entry.pane.magnify
      const magnified = multiply(world, [magnifyX || 1, 0, 0, magnifyY || 1, 0, 0])

      out.push(
        ...collectDraws(
          part.document,
          part.textures,
          magnified,
          alpha,
          visible,
          depth + 1,
          new Set([...seen, entry.pane.externalLayoutName.toLowerCase()])
        )
      )
    }
    return out
  }

  const flattened = collectDraws(document, options.textures, IDENTITY_AFFINE, 1, true, 0, new Set())
  const selected = options.only
    ? (() => {
        const wanted = new Set<Pane>()
        const collect = (pane: Pane): void => {
          wanted.add(pane)
          for (const child of pane.children) collect(child)
        }
        const found = flattened.find((draw) => draw.entry.pane.name === options.only)
        if (found) collect(found.entry.pane)
        return wanted.size > 0 ? flattened.filter((draw) => wanted.has(draw.entry.pane)) : flattened
      })()
    : flattened

  let rotated = 0
  let textured = 0
  const panes: RenderedPane[] = []

  /**
   * The texture a material samples, resolved against the pane's *own* document.
   *
   * A part layout has its own texture list, and its indices mean nothing in the
   * parent — looking them up in the wrong document is how a part ends up drawn
   * with the host's art.
   */
  const textureFor = (draw: Draw, materialIndex: number): DecodedTexture | null => {
    const material = draw.document.materials[materialIndex]
    const map = material?.textureMaps[0]
    if (!map || map.textureIndex < 0) return null
    const name = draw.document.textures[map.textureIndex]
    if (name === undefined) return null
    return draw.textures?.get(name.toLowerCase().replace(/\.bntx$/, '')) ?? null
  }

  for (const draw of selected) {
    const entry = draw.entry
    const corners = quadWith(entry, draw.world).map(toCanvas)
    const xs = corners.map((corner) => corner[0])
    const ys = corners.map((corner) => corner[1])
    const box = {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys)
    }

    panes.push({
      name: entry.pane.name,
      kind: entry.pane.kind,
      visible: draw.visible,
      alpha: Math.round(draw.alpha * 255),
      x: Math.round(box.x * 100) / 100,
      y: Math.round(box.y * 100) / 100,
      width: Math.round(box.width * 100) / 100,
      height: Math.round(box.height * 100) / 100
    })

    if (!draw.visible && !options.showInvisible) continue
    if (entry.pane.rotate[2] !== 0) rotated += 1

    const opacity = draw.alpha * (draw.visible ? 1 : 0.35)

    /*
     * A window pane is nine quads, not one. Drawing it as a single rectangle
     * stretches a corner across the whole pane, which is worse than a flat box —
     * it looks like a texture that is simply wrong.
     */
    if (entry.pane.kind === 'wnd1') {
      // The frame ring is exactly as thick as its art, which is why the real
      // texture size matters here rather than the pane's frameElem fields.
      const sizes = windowFrameSizes(entry.pane, (materialIndex) => {
        const texture = textureFor(draw, materialIndex)
        return texture ? ([texture.width, texture.height] as const) : undefined
      })
      const local = localBounds(entry.pane, entry.values)
      const geometry = windowPieces(entry.pane, local, sizes)

      let drew = false
      for (const piece of [geometry.content, ...geometry.frames]) {
        if (!piece) continue
        const texture = textureFor(draw, piece.materialIndex)
        const quad = [
          apply(draw.world, piece.rect[0], piece.rect[3]),
          apply(draw.world, piece.rect[2], piece.rect[3]),
          apply(draw.world, piece.rect[2], piece.rect[1]),
          apply(draw.world, piece.rect[0], piece.rect[1])
        ].map(toCanvas)

        if (texture) {
          // The piece's UVs come in BL, BR, TR, TL order; the quad above is
          // TL, TR, BR, BL, so the corners are matched rather than assumed.
          drawTextured(
            quad,
            texture,
            [piece.uv[3], piece.uv[2], piece.uv[1], piece.uv[0]],
            opacity,
            blend
          )
          drew = true
        }
      }
      if (drew) {
        textured += 1
        panes[panes.length - 1] = panes[panes.length - 1]!
        continue
      }
    }

    const materialIndex =
      entry.pane.kind === 'pic1' || entry.pane.kind === 'txt1'
        ? entry.pane.materialIndex
        : -1
    const texture = materialIndex >= 0 ? textureFor(draw, materialIndex) : null

    if (texture && entry.pane.kind === 'pic1') {
      const set = entry.pane.texCoords[0]
      const uv: readonly [Vec2, Vec2, Vec2, Vec2] = set
        ? [set.topLeft, set.topRight, set.bottomRight, set.bottomLeft]
        : [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1]
          ]
      drawTextured(corners, texture, uv, opacity, blend, entry.pane.colorTopLeft)
      textured += 1
      continue
    }

    const color = tint(entry.pane)
    const alpha = opacity * (draw.visible ? 0.42 : 0.12)

    fillQuad(corners, (x, y) => blend(x, y, color, alpha))
    strokeQuad(corners, (x, y) => blend(x, y, color, draw.visible ? 0.95 : 0.35))
  }

  const caveats = [
    textured > 0
      ? `${textured} pane${textured === 1 ? '' : 's'} drawn with their real textures; the rest are flat colour by kind. Text is not drawn — a text pane shows as a coloured box.`
      : 'Flat colour by pane kind — no textures could be decoded for this layout. Text is never drawn.',
    ...(rotated > 0
      ? [`${rotated} rotated pane${rotated === 1 ? '' : 's'} drawn as rotated quads.`]
      : [])
  ]

  return { png: encodePng(pixels, width, height), width, height, panes, caveats }
}

/**
 * Scanline fill of a convex quad.
 *
 * A quad rather than a rectangle because rotation is part of the format and
 * drawing a rotated pane as its bounding box would misreport where it is — which
 * is the one thing this picture is for.
 */
function fillQuad(
  corners: readonly (readonly [number, number])[],
  plot: (x: number, y: number) => void
): void {
  const ys = corners.map((corner) => corner[1])
  const top = Math.floor(Math.min(...ys))
  const bottom = Math.ceil(Math.max(...ys))

  for (let y = top; y <= bottom; y++) {
    // Sample at the pixel centre so a half-covered edge row is not filled twice.
    const sample = y + 0.5
    const crossings: number[] = []

    for (let at = 0; at < corners.length; at++) {
      const a = corners[at]!
      const b = corners[(at + 1) % corners.length]!
      if (a[1] === b[1]) continue
      const [lower, upper] = a[1] < b[1] ? [a, b] : [b, a]
      if (sample < lower[1] || sample >= upper[1]) continue
      crossings.push(lower[0] + ((sample - lower[1]) / (upper[1] - lower[1])) * (upper[0] - lower[0]))
    }

    if (crossings.length < 2) continue
    crossings.sort((first, second) => first - second)
    for (let x = Math.round(crossings[0]!); x < Math.round(crossings[crossings.length - 1]!); x++) {
      plot(x, y)
    }
  }
}

function strokeQuad(
  corners: readonly (readonly [number, number])[],
  plot: (x: number, y: number) => void
): void {
  for (let at = 0; at < corners.length; at++) {
    line(corners[at]!, corners[(at + 1) % corners.length]!, plot)
  }
}

/** Bresenham, in the plainest form that handles every octant. */
function line(
  from: readonly [number, number],
  to: readonly [number, number],
  plot: (x: number, y: number) => void
): void {
  let x = Math.round(from[0])
  let y = Math.round(from[1])
  const targetX = Math.round(to[0])
  const targetY = Math.round(to[1])

  const dx = Math.abs(targetX - x)
  const dy = -Math.abs(targetY - y)
  const stepX = x < targetX ? 1 : -1
  const stepY = y < targetY ? 1 : -1
  let error = dx + dy

  // Bounded rather than trusting the loop to terminate: a NaN coordinate from a
  // degenerate transform would otherwise spin forever inside a render.
  for (let guard = 0; guard < 100_000; guard++) {
    plot(x, y)
    if (x === targetX && y === targetY) return
    const doubled = error * 2
    if (doubled >= dy) {
      error += dy
      x += stepX
    }
    if (doubled <= dx) {
      error += dx
      y += stepY
    }
  }
}

/**
 * Fills a quad by sampling a texture across it.
 *
 * The UVs are interpolated bilinearly over the quad rather than affinely over two
 * triangles: layout quads are axis-aligned rectangles almost all of the time, and
 * where they are not, the seam a two-triangle split produces is more misleading
 * than the slight difference in projection.
 *
 * Sampling is nearest-neighbour. A preview is being scaled down, the textures are
 * UI art with hard edges, and a bilinear tap costs four reads per pixel to make
 * button borders blurrier.
 */
function drawTextured(
  corners: readonly (readonly [number, number])[],
  texture: DecodedTexture,
  uv: readonly [Vec2, Vec2, Vec2, Vec2],
  opacity: number,
  blend: (x: number, y: number, color: readonly [number, number, number], alpha: number) => void,
  tintColor?: Rgba
): void {
  const xs = corners.map((corner) => corner[0])
  const ys = corners.map((corner) => corner[1])
  const left = Math.floor(Math.min(...xs))
  const right = Math.ceil(Math.max(...xs))
  const top = Math.floor(Math.min(...ys))
  const bottom = Math.ceil(Math.max(...ys))

  const width = Math.max(1e-6, Math.max(...xs) - Math.min(...xs))
  const height = Math.max(1e-6, Math.max(...ys) - Math.min(...ys))

  // A flat white tint means "no tint", which is the overwhelmingly common case.
  const tinted =
    tintColor && !(tintColor[0] > 250 && tintColor[1] > 250 && tintColor[2] > 250)
      ? tintColor
      : null

  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      // Normalised position within the quad's bounding box, which is the quad
      // itself for every axis-aligned pane.
      const u = (x + 0.5 - Math.min(...xs)) / width
      const v = (y + 0.5 - Math.min(...ys)) / height
      if (u < 0 || u > 1 || v < 0 || v > 1) continue

      // Bilinear over the four corner UVs.
      const s =
        uv[0][0] * (1 - u) * (1 - v) +
        uv[1][0] * u * (1 - v) +
        uv[2][0] * u * v +
        uv[3][0] * (1 - u) * v
      const t =
        uv[0][1] * (1 - u) * (1 - v) +
        uv[1][1] * u * (1 - v) +
        uv[2][1] * u * v +
        uv[3][1] * (1 - u) * v

      // Wrapped, which is what the sampler does and what tiled backgrounds need.
      const wrappedS = s - Math.floor(s)
      const wrappedT = t - Math.floor(t)
      const px = Math.min(texture.width - 1, Math.max(0, Math.floor(wrappedS * texture.width)))
      const py = Math.min(texture.height - 1, Math.max(0, Math.floor(wrappedT * texture.height)))

      const at = (py * texture.width + px) * 4
      const alpha = ((texture.rgba[at + 3] ?? 255) / 255) * opacity
      if (alpha <= 0.004) continue

      const red = texture.rgba[at] ?? 0
      const green = texture.rgba[at + 1] ?? 0
      const blue = texture.rgba[at + 2] ?? 0

      blend(
        x,
        y,
        tinted
          ? [(red * tinted[0]) / 255, (green * tinted[1]) / 255, (blue * tinted[2]) / 255]
          : [red, green, blue],
        alpha
      )
    }
  }
}
