import { isBflan, parseBflan } from '@shared/formats/bflan'
import { isBflyt, parseBflyt } from '@shared/formats/bflyt'
import type { Pane } from '@shared/formats/bflyt/types'
import { isBntx, parseBntx } from '@shared/formats/bntx'
import { isByml, parseByml } from '@shared/formats/byml'
import type { BymlNode } from '@shared/formats/byml/types'
import { isMsbt, parseMsbt } from '@shared/formats/msbt'
import { isSarc, parseSarc } from '@shared/formats/sarc'

/**
 * Everything nameable in a game file, pulled out so it can be searched.
 *
 * The hardest part of modding a game this size is not editing — it is *finding*:
 * which of 544 layouts draws the screen you are looking at, which archive holds
 * the texture a pane names, where a string you saw in-game actually lives. Every
 * one of those questions is a lookup against names that already exist inside the
 * files, and none of them is answerable by browsing.
 *
 * Extraction is pure and shared so the app, the CLI and the MCP server index the
 * same way. The caller has already decompressed.
 */

export type SymbolKind =
  | 'pane'
  | 'material'
  | 'texture'
  | 'font'
  /** A layout instantiated by a prt1 part pane; the edge that makes parts findable. */
  | 'part'
  | 'animation'
  /** An animated target inside a BFLAN — the pane or material it drives. */
  | 'animationTarget'
  | 'message'
  | 'bymlKey'

export interface ExtractedSymbol {
  readonly kind: SymbolKind
  readonly name: string
  /**
   * Free text carried alongside the name and searched with it. Holds a message's
   * body, a pane's kind, a texture's dimensions — whatever makes the row
   * recognisable in a result list without opening the file.
   */
  readonly detail?: string
}

export interface ExtractedFile {
  /** Path inside the container, for a file that came out of an archive. */
  readonly entryName?: string
  readonly format: string
  readonly symbols: readonly ExtractedSymbol[]
}

/**
 * One file's symbols, and — for an archive — one entry per member.
 *
 * Archives are flattened rather than summarised because that is how a romfs is
 * actually shaped: the 544 layouts in this game are not 544 files, they are
 * entries inside 567 archives, and an index that stopped at the container would
 * be an index of container names.
 */
export function extractFile(name: string, data: Uint8Array): ExtractedFile[] {
  if (isSarc(data)) {
    const found: ExtractedFile[] = []
    let archive
    try {
      archive = parseSarc(data)
    } catch {
      return [{ format: 'SARC', symbols: [] }]
    }

    found.push({ format: 'SARC', symbols: [] })
    for (const entry of archive.entries) {
      if (entry.name === null) continue
      // One level deep. Nested archives exist but are rare, and recursing without a
      // bound is how an indexer meets a zip bomb.
      const inner = extractOne(entry.name, entry.data)
      found.push({ entryName: entry.name, format: inner.format, symbols: inner.symbols })
    }
    return found
  }

  const single = extractOne(name, data)
  return [{ format: single.format, symbols: single.symbols }]
}

function extractOne(
  name: string,
  data: Uint8Array
): { format: string; symbols: ExtractedSymbol[] } {
  try {
    if (isBflyt(data)) return { format: 'BFLYT', symbols: fromLayout(data) }
    if (isBflan(data)) return { format: 'BFLAN', symbols: fromAnimation(name, data) }
    if (isBntx(data)) return { format: 'BNTX', symbols: fromTextures(data) }
    if (isMsbt(data)) return { format: 'MSBT', symbols: fromMessages(data) }
    if (isByml(data)) return { format: 'BYML', symbols: fromByml(data) }
  } catch {
    /*
     * A file that will not parse is indexed as itself with no symbols, never
     * dropped. Its *path* is still worth finding, and an indexer that silently
     * omits what it choked on makes "not in the index" mean two different things.
     */
    return { format: 'unreadable', symbols: [] }
  }
  return { format: 'other', symbols: [] }
}

function fromLayout(data: Uint8Array): ExtractedSymbol[] {
  const { document } = parseBflyt(data)
  const symbols: ExtractedSymbol[] = []

  const visit = (pane: Pane): void => {
    if (pane.name !== '') symbols.push({ kind: 'pane', name: pane.name, detail: pane.kind })
    if (pane.kind === 'prt1' && pane.externalLayoutName !== '') {
      symbols.push({ kind: 'part', name: pane.externalLayoutName, detail: `used by ${pane.name}` })
    }
    for (const child of pane.children) visit(child)
  }
  if (document.rootPane) visit(document.rootPane)

  for (const material of document.materials) {
    if (material.name !== '') symbols.push({ kind: 'material', name: material.name })
  }
  for (const texture of document.textures) symbols.push({ kind: 'texture', name: texture })
  for (const font of document.fonts) symbols.push({ kind: 'font', name: font })

  return symbols
}

function fromAnimation(name: string, data: Uint8Array): ExtractedSymbol[] {
  const { document } = parseBflan(data)
  const symbols: ExtractedSymbol[] = [{ kind: 'animation', name }]

  // The tag name is what a layout binds to, and it is not always the file name.
  if (document.tag && document.tag.name !== '') {
    symbols.push({ kind: 'animation', name: document.tag.name, detail: 'tag' })
  }

  for (const entry of document.info?.entries ?? []) {
    if (entry.name !== '') {
      symbols.push({ kind: 'animationTarget', name: entry.name, detail: entry.target })
    }
  }
  // Pattern animations swap textures by name, which is a reference like any other.
  for (const texture of document.info?.textures ?? []) {
    symbols.push({ kind: 'texture', name: texture, detail: 'pattern frame' })
  }
  return symbols
}

function fromTextures(data: Uint8Array): ExtractedSymbol[] {
  const container = parseBntx(data)
  return container.textures.map((texture) => ({
    kind: 'texture' as const,
    name: texture.name,
    detail: `${texture.width}×${texture.height}`
  }))
}

/**
 * Every message, label and body together.
 *
 * This is the largest single contribution to the index — 333,671 messages across
 * one title — and it is also the one that changes what the tool can do: finding
 * a string you saw on screen is the only reliable way into a game's text, and
 * without it a translation mod starts by grepping 61 MB of binary.
 */
function fromMessages(data: Uint8Array): ExtractedSymbol[] {
  const document = parseMsbt(data)
  return document.messages.map((message) => ({
    kind: 'message' as const,
    name: message.label === '' ? `#${message.index}` : message.label,
    detail: message.text
  }))
}

/**
 * Distinct map keys, not values.
 *
 * A BYML document is configuration, and what someone looks for in one is the
 * *field* — "which files mention `ResidentParam`" — not the numbers under it.
 * Indexing every scalar would multiply the index by an order of magnitude to
 * answer a question nobody asks.
 */
function fromByml(data: Uint8Array): ExtractedSymbol[] {
  const document = parseByml(data)
  const keys = new Set<string>()

  const visit = (node: BymlNode | null, depth: number): void => {
    // Bounded rather than trusting the tree: an indexer with no depth limit is one
    // malformed file away from a stack overflow that takes the whole build down.
    if (node === null || depth > 32) return
    if (node.kind === 'map') {
      for (const entry of node.entries) {
        keys.add(entry.key)
        visit(entry.value, depth + 1)
      }
      return
    }
    if (node.kind === 'array') {
      for (const item of node.items) visit(item, depth + 1)
      return
    }
    if (node.kind === 'hashmap') {
      // Keys here are 32-bit hashes; the strings they came from are not in the
      // file, so there is nothing nameable to index.
      for (const entry of node.entries) visit(entry.value, depth + 1)
    }
  }

  visit(document.root, 0)
  return [...keys].map((key) => ({ kind: 'bymlKey' as const, name: key }))
}
