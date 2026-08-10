import { describe, expect, it } from 'vitest'

import { writeBflyt } from '@shared/formats/bflyt'
import {
  createLayoutDocument,
  createMaterial,
  createPartPane,
  createPicturePane
} from '@shared/formats/bflyt/create'
import { sarcHash, writeSarc, type SarcArchive } from '@shared/formats/sarc'
import { extractFile } from '@shared/mod/symbols'
import { toMatchQuery } from '@main/services/index-service'

/**
 * What the index can be asked, expressed as what gets extracted.
 *
 * Every search the tool offers is a lookup against these rows, so a name that is
 * not extracted here is a question the tool cannot answer however good the query
 * layer is.
 */

function archiveOf(files: ReadonlyArray<{ name: string; data: Uint8Array }>): Uint8Array {
  const archive: SarcArchive = {
    littleEndian: true,
    version: 0x0100,
    hashKey: 0x65,
    hasNames: true,
    originalDataOffset: 0,
    entries: files.map((file) => ({
      nameHash: sarcHash(file.name, 0x65),
      name: file.name,
      data: file.data,
      originalOffset: 0,
      originalLength: -1,
      alignment: 4
    }))
  }
  return writeSarc(archive)
}

function sampleLayout(): Uint8Array {
  const document = createLayoutDocument({ name: 'MenuMain' })
  document.textures = ['Header.bntx']
  document.fonts = ['Standard.bfcpx']
  document.materials = [createMaterial('BtnMaterial')]

  const button = createPicturePane('BtnOk', 0)
  const part = createPartPane('PartFooter', 'Footer.bflyt')
  document.rootPane!.children.push(button, part)

  return writeBflyt(document, new Map())
}

describe('extractFile', () => {
  it('pulls panes, materials, textures, fonts and part references out of a layout', () => {
    const [file] = extractFile('MenuMain.bflyt', sampleLayout())
    expect(file!.format).toBe('BFLYT')

    const byKind = (kind: string): string[] =>
      file!.symbols.filter((symbol) => symbol.kind === kind).map((symbol) => symbol.name)

    expect(byKind('pane')).toContain('BtnOk')
    expect(byKind('pane')).toContain('PartFooter')
    expect(byKind('material')).toContain('BtnMaterial')
    expect(byKind('texture')).toContain('Header.bntx')
    expect(byKind('font')).toContain('Standard.bfcpx')
    // The edge that makes "what instantiates this layout" answerable at all.
    expect(byKind('part')).toContain('Footer.bflyt')
  })

  /**
   * A romfs's layouts are entries inside archives, not files. An index that
   * stopped at the container would be an index of container names.
   */
  it('flattens an archive into its entries', () => {
    const bytes = archiveOf([{ name: 'blyt/MenuMain.bflyt', data: sampleLayout() }])
    const found = extractFile('Menu.szs', bytes)

    expect(found[0]).toMatchObject({ format: 'SARC' })
    const layout = found.find((entry) => entry.entryName === 'blyt/MenuMain.bflyt')
    expect(layout).toBeDefined()
    expect(layout!.format).toBe('BFLYT')
    expect(layout!.symbols.some((symbol) => symbol.name === 'BtnOk')).toBe(true)
  })

  /**
   * A file that will not parse is still worth finding by path. Dropping it would
   * make "not in the index" mean two different things.
   */
  it('keeps an unreadable file in the index with no symbols', () => {
    const truncated = sampleLayout().slice(0, 32)
    const [file] = extractFile('Broken.bflyt', truncated)
    expect(file!.format).toBe('unreadable')
    expect(file!.symbols).toHaveLength(0)
  })
})

/**
 * FTS5's MATCH argument is a query language, so an ordinary search string is a
 * syntax error waiting to happen — which would turn the search box itself into a
 * source of failures.
 */
describe('toMatchQuery', () => {
  it('is empty for a blank query', () => {
    expect(toMatchQuery('   ')).toBeNull()
  })

  it('quotes a term and makes the last one a prefix, so results narrow as you type', () => {
    expect(toMatchQuery('Btn')).toBe('"Btn"*')
    expect(toMatchQuery('main menu')).toBe('"main" "menu"*')
  })

  it('survives characters FTS5 would otherwise read as syntax', () => {
    expect(toMatchQuery('AND')).toBe('"AND"*')
    expect(toMatchQuery('a-b')).toBe('"a-b"*')
    expect(toMatchQuery('say "hi"')).toBe('"say" """hi"""*')
  })
})
