import type { LayoutSource } from '@shared/contract'

import { getClient } from '@renderer/lib/orpc'

/**
 * GPU-side texture cache for the layout canvas.
 *
 * The renderer draws synchronously, but textures arrive asynchronously, so
 * `lookup` never waits: it returns whatever is ready now and starts a fetch for
 * anything that is not. When a fetch lands it calls `onChanged`, which triggers
 * a redraw — so a layout paints immediately in flat colour and fills in.
 *
 * A texture that cannot be decoded (BC7, ASTC) or cannot be found is *not*
 * treated as an error to report; it resolves to a magenta checker so the pane
 * still draws and the problem is visible on the canvas. The texture panel is
 * where the reason gets spelled out.
 */

export type TextureState = 'pending' | 'ready' | 'missing'

interface Entry {
  state: TextureState
  texture: WebGLTexture | null
  size: readonly [number, number] | null
  detail: string | null
}

/** A 2x2 magenta/black checker, the traditional "this texture is wrong" marker. */
const PLACEHOLDER_PIXELS = new Uint8Array([
  255, 0, 255, 255, 40, 0, 40, 255, 40, 0, 40, 255, 255, 0, 255, 255
])

export class TextureStore {
  private readonly gl: WebGL2RenderingContext
  private readonly onChanged: () => void
  private readonly entries = new Map<string, Entry>()

  /** Bound wherever a draw call has no texture of its own. */
  readonly white: WebGLTexture
  readonly placeholder: WebGLTexture

  private source: LayoutSource | null = null

  constructor(gl: WebGL2RenderingContext, onChanged: () => void) {
    this.gl = gl
    this.onChanged = onChanged
    this.white = this.upload(new Uint8Array([255, 255, 255, 255]), 1, 1)
    // Nearest keeps the checker readable; linear would blur 2x2 into flat grey.
    this.placeholder = this.upload(PLACEHOLDER_PIXELS, 2, 2, gl.NEAREST)
  }

  /**
   * Points the store at the layout whose textures should be resolved. Changing
   * source drops everything: the same texture name in a different archive is a
   * different texture.
   */
  setSource(source: LayoutSource | null): void {
    if (sameSource(this.source, source)) return
    this.source = source
    this.clearEntries()
  }

  /**
   * The texture for `name`, or null when nothing can be drawn yet. Starts a
   * fetch on first miss. Callers must treat null as "draw untextured", not as
   * an error.
   */
  lookup(name: string): WebGLTexture | null {
    if (!name || !this.source) return null

    const existing = this.entries.get(name)
    if (existing) {
      if (existing.state === 'missing') return this.placeholder
      return existing.texture
    }

    this.entries.set(name, { state: 'pending', texture: null, size: null, detail: null })
    void this.fetch(name)
    return null
  }

  stateOf(name: string): Entry | undefined {
    return this.entries.get(name)
  }

  /**
   * Textures that could not be loaded, with the reason.
   *
   * The canvas shows a magenta checker for these, which says something is wrong but
   * not what. Surfacing the reasons turns "the panes look wrong for some reason"
   * into "14 textures are ASTC and this build has no decoder".
   */
  failures(): { name: string; detail: string }[] {
    const out: { name: string; detail: string }[] = []
    for (const [name, entry] of this.entries) {
      if (entry.state === 'missing') out.push({ name, detail: entry.detail ?? 'unknown reason' })
    }
    return out
  }

  /**
   * Pixel dimensions of a loaded texture, or undefined until it arrives. Window
   * frames need this: a ring's thickness comes from its art, not from the layout.
   */
  sizeOf(name: string): readonly [number, number] | undefined {
    return this.entries.get(name)?.size ?? undefined
  }

  private async fetch(name: string): Promise<void> {
    const source = this.source
    if (!source) return

    try {
      const decoded = await getClient().textures.get({ source, name })
      // The source can change while a fetch is in flight; a late arrival for the
      // previous layout must not be uploaded against the current one.
      if (!sameSource(this.source, source)) return

      const rgba = new Uint8Array(await decoded.rgba.arrayBuffer())
      if (!sameSource(this.source, source)) return

      const texture = this.upload(rgba, decoded.width, decoded.height)
      this.entries.set(name, {
        state: 'ready',
        texture,
        size: [decoded.width, decoded.height],
        detail: null
      })
    } catch (cause) {
      if (!sameSource(this.source, source)) return
      this.entries.set(name, {
        state: 'missing',
        texture: null,
        size: null,
        detail: cause instanceof Error ? cause.message : String(cause)
      })
    }
    this.onChanged()
  }

  private upload(
    rgba: Uint8Array,
    width: number,
    height: number,
    filter?: number
  ): WebGLTexture {
    const { gl } = this
    const sampling = filter ?? gl.LINEAR
    const texture = gl.createTexture()
    if (!texture) throw new Error('could not allocate a WebGL texture')

    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      rgba
    )
    // Layout textures are authored for exact pixel sizes and rely on clamping at
    // the edges; wrapping would bleed the opposite side into nine-slice frames.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, sampling)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, sampling)
    gl.bindTexture(gl.TEXTURE_2D, null)
    return texture
  }

  private clearEntries(): void {
    for (const entry of this.entries.values()) {
      if (entry.texture) this.gl.deleteTexture(entry.texture)
    }
    this.entries.clear()
  }

  dispose(): void {
    this.clearEntries()
    this.gl.deleteTexture(this.white)
    this.gl.deleteTexture(this.placeholder)
  }
}

function sameSource(a: LayoutSource | null, b: LayoutSource | null): boolean {
  if (a === b) return true
  if (!a || !b || a.kind !== b.kind) return false
  if (a.kind === 'file' && b.kind === 'file') return a.path === b.path
  if (a.kind === 'archive' && b.kind === 'archive') {
    return a.archiveId === b.archiveId && a.entryKey === b.entryKey
  }
  return false
}
