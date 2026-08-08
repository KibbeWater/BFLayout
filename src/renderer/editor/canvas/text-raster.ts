import type { TextPane } from '@shared/formats/bflyt'

/**
 * Rasterises text panes.
 *
 * **Still an approximation, but now in the game's own typeface.** This title ships no BFFNT
 * bitmap fonts — its layouts name `.bfcpx` complexes, which resolve to obfuscated scalable
 * faces in the font archive — and those are decoded and registered, so the families passed
 * in are the real thing. What remains approximate is the *layout* of the glyphs: Canvas2D
 * does its own shaping and kerning, so character positions will not match the game
 * exactly, and per-character transforms are not modelled at all. Close enough to judge how
 * a label looks; not a pixel reference.
 *
 * A font that could not be found leaves the families empty and the text draws in
 * `sans-serif`, exactly as it did before any font decoding existed.
 *
 * Rasters are cached by content, so panning and dragging never re-rasterise; a
 * text pane only re-renders when something that affects its pixels changes.
 */

/** Supersampling factor, so text stays legible when zoomed in. */
const SCALE = 2

/** Canvas dimension ceiling, to stay well inside any GL texture limit. */
const MAX_DIMENSION = 2048

/** Alignment values are Center = 0, Left/Top = 1, Right/Bottom = 2. */
function horizontalAlignment(value: number): 'center' | 'left' | 'right' {
  switch (value & 0x3) {
    case 1:
      return 'left'
    case 2:
      return 'right'
    default:
      return 'center'
  }
}

function verticalAlignment(value: number): 'center' | 'top' | 'bottom' {
  switch ((value >> 2) & 0x3) {
    case 1:
      return 'top'
    case 2:
      return 'bottom'
    default:
      return 'center'
  }
}

function rgbaCss(color: readonly [number, number, number, number]): string {
  return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${color[3] / 255})`
}

/** Everything that changes the pixels; anything else must not bust the cache. */
function signature(pane: TextPane, families: readonly string[]): string {
  return [
    // The families are part of the signature, so text drawn in the fallback font is
    // redrawn once the real faces finish loading rather than staying wrong forever.
    families.join(','),
    pane.text,
    pane.width,
    pane.height,
    pane.fontSize[0],
    pane.fontSize[1],
    pane.charSpace,
    pane.lineSpace,
    pane.textAlignment,
    pane.italicTilt,
    pane.flags,
    pane.fontTopColor.join(','),
    pane.fontBottomColor.join(','),
    pane.shadowPosition.join(','),
    pane.shadowForeColor.join(','),
    pane.shadowBackColor.join(',')
  ].join('|')
}

interface Raster {
  readonly texture: WebGLTexture
  readonly signature: string
}

export class TextRasterizer {
  private readonly gl: WebGL2RenderingContext
  private readonly canvas: HTMLCanvasElement
  private readonly rasters = new Map<string, Raster>()

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl
    // One scratch canvas reused for every pane; the GPU copy is what persists.
    this.canvas = document.createElement('canvas')
  }

  /**
   * A texture holding this pane's text, mapped 0..1 across the pane rect. Null
   * when there is nothing to draw or the 2D context is unavailable.
   */
  lookup(pane: TextPane, families: readonly string[] = []): WebGLTexture | null {
    if (pane.text.length === 0) return null
    if (pane.width <= 0 || pane.height <= 0) return null

    const key = pane.id
    const wanted = signature(pane, families)
    const cached = this.rasters.get(key)
    if (cached && cached.signature === wanted) return cached.texture

    const drawn = this.draw(pane, families)
    if (!drawn) return null

    // Replacing a pane's raster frees the old one; a long editing session must
    // not leak a texture per keystroke.
    if (cached) this.gl.deleteTexture(cached.texture)
    this.rasters.set(key, { texture: drawn, signature: wanted })
    return drawn
  }

  private draw(pane: TextPane, families: readonly string[]): WebGLTexture | null {
    const scale = Math.min(
      SCALE,
      MAX_DIMENSION / Math.max(pane.width, pane.height, 1)
    )
    const width = Math.max(1, Math.round(pane.width * scale))
    const height = Math.max(1, Math.round(pane.height * scale))

    this.canvas.width = width
    this.canvas.height = height
    const context = this.canvas.getContext('2d')
    if (!context) return null

    context.clearRect(0, 0, width, height)
    context.scale(scale, scale)

    const fontSize = pane.fontSize[1] || pane.fontSize[0] || 16
    const italic = pane.italicTilt !== 0 ? 'italic ' : ''
    /*
     * The chain verbatim, with `sans-serif` last. The order is the game's own — specialised
     * faces first, main typeface last — which is also the order the browser resolves
     * `font-family` in, so per-glyph fallback comes for free. Family names are quoted
     * because they carry hyphens and digits.
     */
    const stack = [...families.map((family) => `"${family}"`), 'sans-serif'].join(', ')
    context.font = `${italic}${fontSize}px ${stack}`
    context.textBaseline = 'alphabetic'
    // charSpace is extra advance per character, which maps onto letterSpacing.
    context.letterSpacing = `${pane.charSpace}px`

    // The horizontal font size is applied as a transform, since a system font
    // has no independent width axis the way a bitmap font does.
    const stretch = pane.fontSize[0] && pane.fontSize[1] ? pane.fontSize[0] / pane.fontSize[1] : 1

    const lines = pane.text.replace(/\0+$/, '').split(/\r?\n/)
    const lineHeight = fontSize + pane.lineSpace
    const blockHeight = lineHeight * lines.length

    const vertical = verticalAlignment(pane.textAlignment)
    const horizontal = horizontalAlignment(pane.textAlignment)

    let top: number
    switch (vertical) {
      case 'top':
        top = 0
        break
      case 'bottom':
        top = pane.height - blockHeight
        break
      default:
        top = (pane.height - blockHeight) / 2
        break
    }

    // A vertical gradient across the text block reproduces the two font colours
    // layouts use for a cheap bevel.
    const gradient = context.createLinearGradient(0, top, 0, top + blockHeight)
    gradient.addColorStop(0, rgbaCss(pane.fontTopColor))
    gradient.addColorStop(1, rgbaCss(pane.fontBottomColor))

    const hasShadow = (pane.flags & 0x1) !== 0

    for (const [index, line] of lines.entries()) {
      const baseline = top + lineHeight * index + fontSize * 0.8
      const measured = context.measureText(line).width * stretch

      let x: number
      switch (horizontal) {
        case 'left':
          x = 0
          break
        case 'right':
          x = pane.width - measured
          break
        default:
          x = (pane.width - measured) / 2
          break
      }

      const drawLine = (
        offsetX: number,
        offsetY: number,
        fill: string | CanvasGradient
      ): void => {
        context.save()
        context.translate(x + offsetX, baseline + offsetY)
        if (stretch !== 1) context.scale(stretch, 1)
        context.fillStyle = fill
        context.fillText(line, 0, 0)
        context.restore()
      }

      if (hasShadow) {
        drawLine(pane.shadowPosition[0], -pane.shadowPosition[1], rgbaCss(pane.shadowForeColor))
      }
      drawLine(0, 0, gradient)
    }

    return this.upload(this.canvas)
  }

  private upload(source: HTMLCanvasElement): WebGLTexture | null {
    const { gl } = this
    const texture = gl.createTexture()
    if (!texture) return null

    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.bindTexture(gl.TEXTURE_2D, null)
    return texture
  }

  /** Drops rasters for panes that no longer exist. */
  retain(liveIds: ReadonlySet<string>): void {
    for (const [id, raster] of this.rasters) {
      if (liveIds.has(id)) continue
      this.gl.deleteTexture(raster.texture)
      this.rasters.delete(id)
    }
  }

  dispose(): void {
    for (const raster of this.rasters.values()) this.gl.deleteTexture(raster.texture)
    this.rasters.clear()
  }
}
