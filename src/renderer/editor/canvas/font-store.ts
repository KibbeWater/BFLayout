import type { LayoutSource } from '@shared/contract'
import { getClient } from '@renderer/lib/orpc'

/**
 * Registers the game's own typefaces with the document, so text panes are drawn in the
 * font the game uses rather than in whatever sans-serif the OS provides.
 *
 * A layout's font list names `.bfcpx` complexes; each resolves to several scalable faces in
 * fallback order. Registering them as `FontFace`s and joining their families with commas
 * hands the per-glyph fallback to the browser, which is both less code and more correct than
 * picking one face and hoping every character is in it.
 *
 * Three properties matter and each is deliberate:
 *
 *   - **Fetched once per font name, ever.** A face is megabytes and registration is global
 *     to the document, so there is nothing to gain from doing it per layout or per pane.
 *   - **Never throws.** A dump with no `Font` directory is perfectly normal, and so is a
 *     face this build cannot decode. Callers get whatever families did register — possibly
 *     none — and the rasteriser appends `sans-serif` regardless.
 *   - **Reports when it becomes ready**, because the raster cache is keyed on content and
 *     would otherwise keep serving text drawn with the fallback font forever.
 */

/** Family names in fallback order, or an empty list while nothing has resolved. */
export type FontFamilies = readonly string[]

interface Entry {
  state: 'pending' | 'ready' | 'missing'
  families: string[]
  detail: string | null
}

/**
 * Keyed by font name alone rather than by source.
 *
 * Two layouts naming `System_00.fcpx` mean the same typeface — the name identifies a face
 * within the dump, not within a layout — and the family names are registered globally
 * anyway, so keying by source would just fetch the same megabytes again.
 */
const entries = new Map<string, Entry>()

/** Prefix, so a game face can never collide with a font the user has installed. */
const FAMILY_PREFIX = 'bflayout-'

export class FontStore {
  private readonly onChanged: () => void
  private source: LayoutSource | null = null

  constructor(onChanged: () => void) {
    this.onChanged = onChanged
  }

  setSource(source: LayoutSource | null): void {
    this.source = source
  }

  /**
   * The families to draw `name` with, fetching them on first ask.
   *
   * Returns an empty list until the faces have loaded, which the caller treats as "use the
   * fallback" rather than as an error — the first frame after opening a layout draws in
   * sans-serif and then redraws once the real faces arrive.
   */
  familiesFor(name: string): FontFamilies {
    if (!name || !this.source) return []

    const existing = entries.get(name)
    if (existing) return existing.state === 'ready' ? existing.families : []

    entries.set(name, { state: 'pending', families: [], detail: null })
    void this.load(name, this.source)
    return []
  }

  /** Why a font could not be loaded, for the diagnostics the canvas already surfaces. */
  static failureFor(name: string): string | null {
    const entry = entries.get(name)
    return entry?.state === 'missing' ? entry.detail : null
  }

  private async load(name: string, source: LayoutSource): Promise<void> {
    try {
      const chain = await getClient().fonts.chain({ source, name })
      const families: string[] = []

      for (const face of chain.faces) {
        const family = `${FAMILY_PREFIX}${face.name}`
        // Already registered by another layout, or another pane a moment ago.
        if (registered.has(family)) {
          families.push(family)
          continue
        }
        const bytes = await face.sfnt.arrayBuffer()
        const font = new FontFace(family, bytes)
        await font.load()
        document.fonts.add(font)
        registered.add(family)
        families.push(family)
      }

      entries.set(name, {
        state: families.length > 0 ? 'ready' : 'missing',
        families,
        detail:
          families.length > 0
            ? null
            : `no usable faces in ${chain.archive || 'the font archive'}${
                chain.missing.length > 0 ? ` (missing ${chain.missing.join(', ')})` : ''
              }`
      })
      this.onChanged()
    } catch (cause) {
      /*
       * Recorded, not raised. Nine times in ten this is a dump with no Font directory,
       * which is not a problem with the layout and not something the user can act on — the
       * canvas simply draws text in the fallback font, as it did before any of this existed.
       */
      entries.set(name, {
        state: 'missing',
        families: [],
        detail: cause instanceof Error ? cause.message : String(cause)
      })
      this.onChanged()
    }
  }
}

/** Families already added to the document; registration is global and not undoable. */
const registered = new Set<string>()
