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
 *   - **Fetched once per dump and font name.** A face is megabytes and registration is global
 *     to the document, so refetching per layout or per pane would be waste — but the key has
 *     to include the dump, because `System_00.fcpx` is a conventional name rather than a
 *     unique one. See `entries` below.
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
  /** When a failure was recorded, so it can expire; null for pending and ready. */
  failedAt: number | null
}

/**
 * Keyed by *dump* and font name, not by name alone.
 *
 * Two layouts in one dump naming `System_00.fcpx` really do mean the same typeface, and the
 * families are registered globally, so keying by layout would refetch the same megabytes.
 * But `System_00.fcpx` is a conventional name, not a unique one — open a layout from one game
 * and then from another and a name-only key served the first game's typefaces to the second
 * one's text forever, with the second dump's own font archive never consulted.
 *
 * The dump is identified by the directory the fonts were searched from, which is what the
 * main-side lookup already reports back as `archive`. Failures key on the same thing and
 * expire, so a loose `.bflyt` with no `Font` directory beside it does not poison the name for
 * the rest of the session.
 */
const entries = new Map<string, Entry>()

/** How long a failure is remembered before another lookup is allowed. */
const FAILURE_TTL_MS = 30_000

/**
 * The font archive each layout source resolved to, learned from the first lookup.
 *
 * This is what makes the cache key the *dump* rather than the layout. Before the first
 * lookup the archive is unknown, so the source stands in; afterwards every other layout in
 * the same dump resolves to the same font archive and shares its entries instead of
 * refetching multi-megabyte typefaces per layout archive.
 */
const originToArchive = new Map<string, string>()

function originOf(source: LayoutSource): string {
  return source.kind === 'file' ? source.path : source.archiveId
}

function cacheKey(source: LayoutSource, name: string): string {
  const origin = originOf(source)
  return `${originToArchive.get(origin) ?? origin}\u0000${name}`
}

/** Prefix, so a game face can never collide with a font the user has installed. */
const FAMILY_PREFIX = 'bflayout-'

/**
 * A family name, scoped to the archive the face came from.
 *
 * Scoping the *cache* by dump is not enough on its own: face names inside a complex
 * (`ninP_SeuratCapie-EB_003`) are exactly as conventional as the `.fcpx` name that points at
 * them, so a registry keyed on the bare face name meant the second game's face was found
 * already registered, never fetched, and its panes drew in the first game's typeface — the
 * same bug one level down.
 *
 * A short hash keeps the family readable and stable; collisions between two archive paths
 * would only cost the same confusion at astronomically lower odds, and paths are stable within
 * a session.
 */
function familyFor(archive: string, face: string): string {
  let hash = 2166136261
  for (let at = 0; at < archive.length; at++) {
    hash = ((hash ^ archive.charCodeAt(at)) * 16777619) >>> 0
  }
  return `${FAMILY_PREFIX}${hash.toString(36)}-${face}`
}

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

    const key = cacheKey(this.source, name)
    const existing = entries.get(key)
    if (existing) {
      if (existing.state === 'ready') return existing.families
      // A stale failure gets one more chance; a fresh one or a pending fetch does not, so
      // N panes asking in one frame still produce exactly one request.
      const stale =
        existing.state === 'missing' &&
        existing.failedAt !== null &&
        Date.now() - existing.failedAt > FAILURE_TTL_MS
      if (!stale) return []
    }

    entries.set(key, { state: 'pending', families: [], detail: null, failedAt: null })
    void this.load(name, this.source)
    return []
  }

  /** Why a font could not be loaded, for the diagnostics the canvas already surfaces. */
  failureFor(name: string): string | null {
    if (!this.source) return null
    const entry = entries.get(cacheKey(this.source, name))
    return entry?.state === 'missing' ? entry.detail : null
  }

  private async load(name: string, source: LayoutSource): Promise<void> {
    /*
     * The key the pending marker went under, which is not necessarily the key the result
     * belongs under: learning the font archive changes what `cacheKey` returns for this
     * source. Without removing the old one a stale `pending` entry would sit there forever
     * and every later ask for this name would return the fallback and never refetch.
     */
    const pendingKey = cacheKey(source, name)
    const settle = (entry: Entry): void => {
      const key = cacheKey(source, name)
      if (key !== pendingKey) entries.delete(pendingKey)
      entries.set(key, entry)
    }

    try {
      const chain = await getClient().fonts.chain({ source, name })
      // Learned now, so every other layout in this dump shares these entries.
      if (chain.archive) originToArchive.set(originOf(source), chain.archive)

      const families: string[] = []
      for (const face of chain.faces) {
        const family = familyFor(chain.archive, face.name)
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

      const usable = families.length > 0
      settle({
        state: usable ? 'ready' : 'missing',
        families,
        detail: usable
          ? null
          : `no usable faces in ${chain.archive || 'the font archive'}${
              chain.missing.length > 0 ? ` (missing ${chain.missing.join(', ')})` : ''
            }`,
        failedAt: usable ? null : Date.now()
      })
      this.onChanged()
    } catch (cause) {
      /*
       * Recorded, not raised. Nine times in ten this is a dump with no Font directory,
       * which is not a problem with the layout and not something the user can act on — the
       * canvas simply draws text in the fallback font, as it did before any of this existed.
       */
      settle({
        state: 'missing',
        families: [],
        detail: cause instanceof Error ? cause.message : String(cause),
        failedAt: Date.now()
      })
      this.onChanged()
    }
  }
}

/** Families already added to the document; registration is global and not undoable. */
const registered = new Set<string>()
