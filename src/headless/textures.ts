import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { decodeTexture, isBntx, isFormatSupported, parseBntx } from '@shared/formats/bntx'
import { parseSarc } from '@shared/formats/sarc'
import { CANONICAL_TEXTURE_CONTAINER } from '@shared/mod/check'
import { decompress } from './compression'

/**
 * Decoding the textures a layout draws with, outside the app.
 *
 * The BNTX decoder is pure — it handles BC1–BC5, BC7, every ASTC block size and
 * the uncompressed formats, and it is the same code that decodes 74,571 textures
 * in the app. There was never a reason the headless renderer had to draw flat
 * boxes; it simply had not been asked to find the textures.
 *
 * Finding them is the actual work, and it mirrors what the app does: a layout's
 * texture name is a *search*, not a lookup. Look in the archive's own `timg/`
 * first, then the rest of that archive, then any sibling archive in the same
 * folder — because layouts routinely name a texture that lives in a shared
 * container next door.
 */

export interface DecodedTexture {
  readonly width: number
  readonly height: number
  /** Straight RGBA8, row-major, top row first. */
  readonly rgba: Uint8Array
}

/** Layouts and containers disagree about case and about the extension. */
function key(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name
  return base.toLowerCase().replace(/\.bntx$/, '')
}

export class TextureLibrary {
  private readonly decoded = new Map<string, DecodedTexture | null>()
  private readonly containers: { name: string; data: Uint8Array }[] = []
  private loaded = false

  constructor(private readonly sourcePath: string) {}

  /**
   * Collects every BNTX reachable from the layout's own file.
   *
   * Loaded once and kept: a layout with thirty picture panes names a handful of
   * textures between them, and decoding is the expensive half.
   */
  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true

    const fromArchive = async (path: string): Promise<void> => {
      const raw = await readFile(path).catch(() => null)
      if (!raw) return

      const expanded = await decompress(new Uint8Array(raw)).catch(() => null)
      if (!expanded) return

      if (isBntx(expanded.data)) {
        this.containers.push({ name: path, data: expanded.data })
        return
      }

      try {
        const archive = parseSarc(expanded.data)

        /*
         * One container per archive, the same one the game opens.
         *
         * nn::ui2d resolves textures through the hardcoded path
         * `timg/__Combined.bntx` by exact path; it does not scan an archive's
         * entries. Taking every BNTX here would make the preview strictly more
         * capable than the engine — and a preview that resolves textures the
         * game cannot is worse than no preview, because it certifies archives
         * that crash on boot. That is not hypothetical: it is how a second
         * container shipped, previewed perfectly, and killed the game inside
         * nn::ui2d::ResourceTextureInfo.
         *
         * Other containers are deliberately ignored rather than used as a
         * fallback, so an unreachable texture shows up here as an untextured
         * pane — which is exactly what it will be in game.
         */
        const canonical = archive.entries.find(
          (entry) =>
            entry.name !== null &&
            entry.name.toLowerCase() === CANONICAL_TEXTURE_CONTAINER.toLowerCase() &&
            isBntx(entry.data)
        )
        if (canonical?.name != null) {
          this.containers.push({ name: canonical.name, data: canonical.data })
        }
      } catch {
        // Not an archive, or one this build cannot read. Either way there are no
        // textures to take from it.
      }
    }

    await fromArchive(this.sourcePath)

    /*
     * Then the neighbours. A shared texture archive beside the layout is the norm
     * rather than the exception, and a preview missing every shared texture would
     * be exactly as unhelpful as the boxes this replaces.
     */
    const folder = dirname(this.sourcePath)
    const siblings = await readdir(folder).catch(() => [] as string[])
    for (const name of siblings) {
      const path = join(folder, name)
      if (path === this.sourcePath) continue
      if (!/\.(bntx|szs|sarc|arc|zs|blarc|lyarc|pack)$/i.test(name)) continue
      // Bounded: a romfs folder can hold thousands of archives, and a preview is
      // not worth reading all of them.
      if (this.containers.length > 64) break
      await fromArchive(path)
    }
  }

  /** A decoded texture by the name a layout uses, or null when it cannot be had. */
  async get(name: string): Promise<DecodedTexture | null> {
    const wanted = key(name)
    const cached = this.decoded.get(wanted)
    if (cached !== undefined) return cached

    await this.load()

    for (const container of this.containers) {
      let parsed
      try {
        parsed = parseBntx(container.data)
      } catch {
        continue
      }

      const texture = parsed.textures.find((candidate) => key(candidate.name) === wanted)
      if (!texture) continue

      if (!isFormatSupported(texture.format, texture.formatVariant)) {
        // BC6H is the one this build does not decode. Recorded as a miss so the
        // renderer falls back rather than retrying it per pane.
        this.decoded.set(wanted, null)
        return null
      }

      try {
        /*
         * The smallest mip at least 256px wide, which is plenty for a preview and
         * far cheaper than a 4096² base level — some of these containers hold ten
         * megabytes of texture.
         */
        let level = 0
        for (let candidate = texture.mipCount - 1; candidate >= 0; candidate--) {
          if (Math.max(1, texture.width >>> candidate) >= 256 || candidate === 0) {
            level = candidate
            break
          }
        }

        const image = decodeTexture(texture, level)
        const result: DecodedTexture = {
          width: image.width,
          height: image.height,
          rgba: image.rgba
        }
        this.decoded.set(wanted, result)
        return result
      } catch {
        this.decoded.set(wanted, null)
        return null
      }
    }

    this.decoded.set(wanted, null)
    return null
  }
}
