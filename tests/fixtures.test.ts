import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { isBflyt, isDocumentDirty, parseBflyt, writeBflyt } from '@shared/formats/bflyt'
import { detectCompression } from '@shared/formats/compression'
import { isSarc, parseSarc, writeSarc } from '@shared/formats/sarc'
import { isYaz0, yaz0Decompress } from '@shared/formats/yaz0'

/**
 * Golden-file suite over real game assets, which cannot be committed.
 *
 * Point BFLAYOUT_FIXTURES at a directory of real .bflyt / .szs / .arc files and
 * these run; without it they skip. This is the only test that proves the codecs
 * agree with Nintendo's own files rather than merely with themselves.
 */
const fixturesDir = process.env['BFLAYOUT_FIXTURES']

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const files = fixturesDir ? walk(fixturesDir) : []

const layoutFiles = files.filter((file) => extname(file).toLowerCase() === '.bflyt')
const archiveFiles = files.filter((file) =>
  ['.szs', '.sarc', '.arc', '.lyarc', '.pack'].includes(extname(file).toLowerCase())
)

describe.skipIf(!fixturesDir)('real-file fixtures', () => {
  it('found something to test', () => {
    expect(files.length, `no files under ${fixturesDir}`).toBeGreaterThan(0)
    console.log(
      `[fixtures] ${layoutFiles.length} layouts, ${archiveFiles.length} archives under ${fixturesDir}`
    )
  })

  describe.skipIf(layoutFiles.length === 0)('BFLYT', () => {
    it.each(layoutFiles)('parses and rewrites %s byte-for-byte', (file) => {
      const bytes = new Uint8Array(readFileSync(file))
      expect(isBflyt(bytes), `${file} is not a BFLYT`).toBe(true)

      const parsed = parseBflyt(bytes)
      expect(isDocumentDirty(parsed.document), 'a freshly parsed document must be clean').toBe(
        false
      )
      expect(parsed.document.rootPane, 'every layout has a root pane').not.toBeNull()

      const rewritten = writeBflyt(parsed.document, parsed.sources)
      expect(rewritten.length).toBe(bytes.length)
      expect([...rewritten]).toEqual([...bytes])
    })

    it.each(layoutFiles)('re-encodes %s from scratch into a re-parseable file', (file) => {
      const bytes = new Uint8Array(readFileSync(file))
      const parsed = parseBflyt(bytes)

      // Force the full encoder rather than the byte-preservation path, so the
      // writer is exercised against real structures.
      const forced = parsed.document
      forced.materials.forEach((material) => (material.dirty = true))
      const stack = forced.rootPane ? [forced.rootPane] : []
      while (stack.length > 0) {
        const pane = stack.pop()!
        pane.dirty = true
        if (pane.userData) pane.userData.dirty = true
        stack.push(...pane.children)
      }

      const rewritten = writeBflyt(forced, parsed.sources)
      const reparsed = parseBflyt(rewritten)

      // Structure must survive a full re-encode even if bytes shift.
      const names = (doc: typeof reparsed.document): string[] => {
        const out: string[] = []
        const walkTree = (pane: typeof doc.rootPane): void => {
          if (!pane) return
          out.push(pane.name)
          pane.children.forEach(walkTree)
        }
        walkTree(doc.rootPane)
        return out
      }
      expect(names(reparsed.document)).toEqual(names(parsed.document))
      expect(reparsed.document.textures).toEqual(parsed.document.textures)
      expect(reparsed.document.materials.map((m) => m.name)).toEqual(
        parsed.document.materials.map((m) => m.name)
      )
    })
  })

  describe.skipIf(archiveFiles.length === 0)('SARC archives', () => {
    it.each(archiveFiles)('opens %s and round-trips its entries', (file) => {
      const raw = new Uint8Array(readFileSync(file))
      const kind = detectCompression(raw)
      const data = isYaz0(raw) ? yaz0Decompress(raw) : raw

      if (kind === 'zstd') {
        // ZSTD needs the WASM decoder, which lives in the main process.
        return
      }

      expect(isSarc(data), `${file} did not contain a SARC`).toBe(true)
      const archive = parseSarc(data)
      expect(archive.entries.length).toBeGreaterThan(0)

      if (archive.entries.every((entry) => entry.name !== null)) {
        expect([...writeSarc(archive)]).toEqual([...data])
      }
    })

    it.each(archiveFiles)('parses every layout inside %s', (file) => {
      const raw = new Uint8Array(readFileSync(file))
      if (detectCompression(raw) === 'zstd') return
      const data = isYaz0(raw) ? yaz0Decompress(raw) : raw
      if (!isSarc(data)) return

      const archive = parseSarc(data)
      const layouts = archive.entries.filter((entry) => entry.name?.endsWith('.bflyt'))

      for (const entry of layouts) {
        const parsed = parseBflyt(entry.data)
        expect(parsed.document.rootPane, `${entry.name} has no root pane`).not.toBeNull()
        expect(
          [...writeBflyt(parsed.document, parsed.sources)],
          `${entry.name} did not round-trip`
        ).toEqual([...entry.data])
      }
    })
  })
})
