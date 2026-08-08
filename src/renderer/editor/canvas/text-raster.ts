import type { TextPane } from '@shared/formats/bflyt'

/**
 * Rasterises text panes with a system font.
 *
 * **This is a preview approximation, not what the game shows.** Real layouts
 * draw text with a BFFNT bitmap font whose glyphs, metrics and kerning are
 * baked into the archive; decoding those is out of scope for v1. What you get
 * here is the right string, at roughly the right size, colour, alignment and
 * spacing, in whatever sans-serif the OS provides — enough to identify and
 * position a label, not enough to judge how it will look.
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
function signature(pane: TextPane): string {
  return [
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
  lookup(pane: TextPane): WebGLTexture | null {
    if (pane.text.length === 0) return null
    if (pane.width <= 0 || pane.height <= 0) return null

    const key = pane.id
    const wanted = signature(pane)
    const cached = this.rasters.get(key)
    if (cached && cached.signature === wanted) return cached.texture

    const drawn = this.draw(pane)
    if (!drawn) return null

    // Replacing a pane's raster frees the old one; a long editing session must
    // not leak a texture per keystroke.
    if (cached) this.gl.deleteTexture(cached.texture)
    this.rasters.set(key, { texture: drawn, signature: wanted })
    return drawn
  }

  private draw(pane: TextPane): WebGLTexture | null {
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
    context.font = `${italic}${fontSize}px sans-serif`
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
