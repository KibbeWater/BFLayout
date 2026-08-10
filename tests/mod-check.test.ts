import { describe, expect, it } from 'vitest'

import { writeBflyt } from '@shared/formats/bflyt'
import { createLayoutDocument } from '@shared/formats/bflyt/create'
import { sarcHash, writeSarc, type SarcArchive } from '@shared/formats/sarc'
import { checkBytes } from '@shared/mod/check'
import { buildBntx, testPattern } from './helpers/bntx-fixture'

/**
 * What the pre-deploy check is actually able to catch.
 *
 * The point of these is the *shape* of the verdicts as much as the verdicts
 * themselves: a corrupt file has to be an error, an unreadable-but-legitimate
 * file must not be, and a container has to be opened rather than taken at its
 * word — a layout mod is almost always a layout inside a `.szs`, so a checker
 * that stops at the archive checks nothing that matters.
 */

const encoder = new TextEncoder()

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

const layoutBytes = (name = 'Menu'): Uint8Array =>
  writeBflyt(createLayoutDocument({ name }), new Map())

const levels = (result: { notes: readonly { level: string }[] }): string[] =>
  result.notes.map((note) => note.level)

describe('checkBytes', () => {
  it('passes a layout it can read and re-encode', () => {
    const result = checkBytes('Menu.bflyt', layoutBytes())
    expect(result.format).toBe('BFLYT')
    expect(levels(result)).toEqual([])
  })

  it('calls an empty file an error', () => {
    const result = checkBytes('Menu.bflyt', new Uint8Array(0))
    expect(result.format).toBe('empty')
    expect(levels(result)).toEqual(['error'])
  })

  /**
   * Truncation is the realistic corruption: an interrupted copy, a bad extract.
   * The magic still says FLYT, so only actually parsing it finds the problem.
   */
  it('reports a truncated layout as an error rather than trusting its magic', () => {
    const truncated = layoutBytes().slice(0, 40)
    const result = checkBytes('Menu.bflyt', truncated)
    expect(result.format).toBe('BFLYT')
    expect(levels(result)).toContain('error')
  })

  /**
   * A romfs is full of formats this build has never modelled, and a mod is
   * entitled to ship one. Refusing would be the tool overreaching — but saying
   * nothing would make "I replaced a file and nothing checked it" invisible.
   */
  it('treats an unrecognised file as information, not a failure', () => {
    const result = checkBytes('Shader.bnsh', encoder.encode('nothing recognisable here'))
    expect(result.format).toBe('unknown')
    expect(levels(result)).toEqual(['info'])
  })

  it('opens an archive and checks what is inside it', () => {
    const bytes = archiveOf([
      { name: 'blyt/Good.bflyt', data: layoutBytes('Good') },
      { name: 'blyt/Broken.bflyt', data: layoutBytes('Broken').slice(0, 40) }
    ])

    const result = checkBytes('Menu.szs', bytes)
    expect(result.format).toBe('SARC')
    // The archive itself is fine; the entry inside it is not.
    const errors = result.notes.filter((note) => note.level === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]!.message).toContain('Broken.bflyt')
  })

  /*
   * The hash-only-archive warning is not exercised here on purpose: `writeSarc`
   * refuses to produce one (it needs every name), so there is no way to build the
   * fixture without hand-assembling a SARC — which would be testing the fixture
   * rather than the check. That path is covered where it bites, in ArchiveService.
   */

  /**
   * A texture that resolved before an edit and does not after shows up in-game as
   * an untextured pane and nowhere else — but referencing a shared texture archive
   * elsewhere in the romfs is completely normal, so this can only ever be a
   * warning.
   */
  it('warns about a texture the archive does not contain', () => {
    const document = createLayoutDocument({ name: 'Menu' })
    document.textures = ['Missing.bntx']
    const bytes = archiveOf([
      { name: 'blyt/Menu.bflyt', data: writeBflyt(document, new Map()) }
    ])

    const result = checkBytes('Menu.szs', bytes)
    const warnings = result.notes.filter((note) => note.level === 'warning')
    expect(warnings.some((note) => note.message.includes('Missing.bntx'))).toBe(true)
  })

  /**
   * The check compares against the texture names *inside* each container, not the
   * container's filename. These games ship one `timg/__Combined.bntx` holding
   * dozens of named textures and layouts name those — matching on the filename
   * reported every layout in such an archive as missing every texture it used.
   */
  it('finds a texture by its name inside the container', () => {
    const document = createLayoutDocument({ name: 'Menu' })
    document.textures = ['Header']

    const bytes = archiveOf([
      { name: 'blyt/Menu.bflyt', data: writeBflyt(document, new Map()) },
      {
        // Note the container is called something else entirely, as the real ones are.
        name: 'timg/__Combined.bntx',
        data: buildBntx({
          containerName: '__Combined',
          textureName: 'Header',
          width: 8,
          height: 8,
          rgba: testPattern(8, 8)
        })
      }
    ])

    const result = checkBytes('Menu.szs', bytes)
    expect(result.notes.filter((note) => note.message.includes('not in this archive'))).toHaveLength(
      0
    )
  })

  it('still warns about a texture no container holds', () => {
    const document = createLayoutDocument({ name: 'Menu' })
    document.textures = ['Absent']

    const bytes = archiveOf([
      { name: 'blyt/Menu.bflyt', data: writeBflyt(document, new Map()) },
      {
        name: 'timg/__Combined.bntx',
        data: buildBntx({
          containerName: '__Combined',
          textureName: 'Header',
          width: 8,
          height: 8,
          rgba: testPattern(8, 8)
        })
      }
    ])

    const warnings = checkBytes('Menu.szs', bytes).notes.filter(
      (note) => note.level === 'warning'
    )
    expect(warnings.some((note) => note.message.includes('Absent'))).toBe(true)
  })

  /**
   * A second texture container is an error, not a detail.
   *
   * nn::ui2d resolves textures through the hardcoded path `timg/__Combined.bntx`
   * by exact path and never enumerates an archive's entries, so a container under
   * any other name is never opened. An archive like this parses, previews and
   * deploys cleanly, then kills the game inside nn::ui2d::ResourceTextureInfo the
   * moment the layout is built — a null dereference nowhere near the packing that
   * caused it.
   */
  it('rejects a texture container the engine will never open', () => {
    const bytes = archiveOf([
      { name: 'blyt/Menu.bflyt', data: layoutBytes() },
      {
        name: 'timg/__Combined.bntx',
        data: buildBntx({
          containerName: '__Combined',
          textureName: 'Header',
          width: 8,
          height: 8,
          rgba: testPattern(8, 8)
        })
      },
      {
        name: 'timg/__From_Buttons.bntx',
        data: buildBntx({
          containerName: '__From_Buttons',
          textureName: 'Extra',
          width: 8,
          height: 8,
          rgba: testPattern(8, 8)
        })
      }
    ])

    const errors = checkBytes('Menu.szs', bytes).notes.filter((note) => note.level === 'error')
    expect(errors.some((note) => note.message.includes('timg/__From_Buttons.bntx'))).toBe(true)
  })

  /**
   * The precise failure: present in the archive, unreachable at runtime.
   *
   * This must not be reported as "not in this archive" — it *is* in the archive,
   * which is exactly why it is confusing. It is also the one texture state that
   * is definitely a bug rather than possibly fine, so it outranks the shared
   * texture-archive warning instead of being buried beside it.
   */
  it('errors when a layout uses a texture only a stray container holds', () => {
    const document = createLayoutDocument({ name: 'Menu' })
    document.textures = ['Stranded']

    const bytes = archiveOf([
      { name: 'blyt/Menu.bflyt', data: writeBflyt(document, new Map()) },
      {
        name: 'timg/__Combined.bntx',
        data: buildBntx({
          containerName: '__Combined',
          textureName: 'Header',
          width: 8,
          height: 8,
          rgba: testPattern(8, 8)
        })
      },
      {
        name: 'timg/__From_Buttons.bntx',
        data: buildBntx({
          containerName: '__From_Buttons',
          textureName: 'Stranded',
          width: 8,
          height: 8,
          rgba: testPattern(8, 8)
        })
      }
    ])

    const stranded = checkBytes('Menu.szs', bytes).notes.filter((note) =>
      note.message.includes('Stranded')
    )
    expect(stranded).toHaveLength(1)
    expect(stranded[0]?.level).toBe('error')
    // The misleading phrasing is reserved for textures that genuinely are absent.
    expect(stranded[0]?.message).not.toContain('not in this archive')
  })

  /** The stock shape has to stay silent, or the check is worse than useless. */
  it('says nothing about a single canonically named container', () => {
    const document = createLayoutDocument({ name: 'Menu' })
    document.textures = ['Header']

    const bytes = archiveOf([
      { name: 'blyt/Menu.bflyt', data: writeBflyt(document, new Map()) },
      {
        name: 'timg/__Combined.bntx',
        data: buildBntx({
          containerName: '__Combined',
          textureName: 'Header',
          width: 8,
          height: 8,
          rgba: testPattern(8, 8)
        })
      }
    ])

    /*
     * Scoped to texture reachability on purpose: `archiveOf` packs everything at
     * alignment 4, so the unrelated (and correct) GPU page-alignment error fires
     * for every container fixture in this file.
     */
    const notes = checkBytes('Menu.szs', bytes).notes.filter(
      (note) =>
        note.message.includes('never open') ||
        note.message.includes('not in this archive') ||
        note.message.includes('Header')
    )
    expect(notes).toEqual([])
  })
})
