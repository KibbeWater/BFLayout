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

/**
 * How many source-scoped caches to keep.
 *
 * Cached across sources rather than dropped on every switch: alternating between two
 * layouts used to refetch and re-upload every texture each time, which for an archive
 * with a couple of dozen is a visible stall on a tab click. Bounded because each entry
 * holds GPU memory — the least recently used source is released when a new one arrives.
 */
const CACHED_SOURCES = 4

/** Stable identity for a layout source, used as the cache key. */
function sourceKey(source: LayoutSource): string {
  return source.kind === 'file'
    ? `file:${source.path}`
    : `archive:${source.archiveId}:${source.entryKey}`
}

/** A 2x2 magenta/black checker, the traditional "this texture is wrong" marker. */
const PLACEHOLDER_PIXELS = new Uint8Array([
  255, 0, 255, 255, 40, 0, 40, 255, 40, 0, 40, 255, 255, 0, 255, 255
])

export class TextureStore {
  /** Set by dispose, so in-flight fetches stop touching a dead GL context. */
  private disposed = false
  private readonly gl: WebGL2RenderingContext
  private readonly onChanged: () => void
  /**
   * Per-source caches, most recently used last. Insertion order is the LRU order,
   * which Map preserves and re-establishes on delete-then-set.
   */
  private readonly bySource = new Map<string, Map<string, Entry>>()

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
   * Points the store at the layout whose textures should be resolved.
   *
   * Each source keeps its own cache — the same texture name in a different archive is a
   * different texture — and switching between them is free until the bound is reached.
   */
  setSource(source: LayoutSource | null): void {
    if (sameSource(this.source, source)) return
    this.source = source
    if (!source) return

    const key = sourceKey(source)
    const existing = this.bySource.get(key)
    // Re-inserting moves it to the most-recent end of the LRU order.
    if (existing) {
      this.bySource.delete(key)
      this.bySource.set(key, existing)
      return
    }

    this.bySource.set(key, new Map())
    while (this.bySource.size > CACHED_SOURCES) {
      const oldest = this.bySource.keys().next()
      if (oldest.done) break
      const dropped = this.bySource.get(oldest.value)
      if (dropped) this.release(dropped)
      this.bySource.delete(oldest.value)
    }
  }

  /** The cache for the current source, or an empty one when there is none. */
  private get entries(): Map<string, Entry> {
    const key = this.source ? sourceKey(this.source) : null
    if (key === null) return EMPTY_ENTRIES
    let store = this.bySource.get(key)
    if (!store) {
      store = new Map()
      this.bySource.set(key, store)
    }
    return store
  }

  private release(entries: Map<string, Entry>): void {
    for (const entry of entries.values()) {
      if (entry.texture) this.gl.deleteTexture(entry.texture)
    }
    entries.clear()
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
      /*
       * Two things can have happened across the await, and both used to be
       * mishandled in one direction or the other:
       *
       *   - the source changed, so a late arrival for the previous layout must not
       *     be uploaded against the current one;
       *   - the store was disposed, in which case the GL context is gone. Uploading
       *     into it and then calling `onChanged` meant WebGL calls against a dead
       *     context and a state update into an unmounted component.
       */
      if (this.disposed || !sameSource(this.source, source)) return

      const rgba = new Uint8Array(await decoded.rgba.arrayBuffer())
      if (this.disposed || !sameSource(this.source, source)) return

      const texture = this.upload(rgba, decoded.width, decoded.height)
      this.entries.set(name, {
        state: 'ready',
        texture,
        size: [decoded.width, decoded.height],
        detail: null
      })
    } catch (cause) {
      if (this.disposed || !sameSource(this.source, source)) return
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
    for (const entries of this.bySource.values()) this.release(entries)
    this.bySource.clear()
  }

  dispose(): void {
    // Set before anything is deleted, so a fetch resuming mid-teardown stops.
    this.disposed = true
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

/** Shared empty map, returned when there is no source to key a cache by. */
const EMPTY_ENTRIES = new Map<string, Entry>()
