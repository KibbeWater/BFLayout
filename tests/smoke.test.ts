import { describe, expect, it } from 'vitest'

import { classifyEntry } from '@shared/formats/entry-kind'

import { FormatParseError } from '@shared/binary/errors'

describe('format errors', () => {
  it('are discriminable and behave as real Errors', () => {
    const err = new FormatParseError({
      format: 'bflyt',
      offset: 0x1c,
      section: 'mat1',
      message: 'material count exceeds section size'
    })

    expect(err).toBeInstanceOf(Error)
    expect(err._tag).toBe('FormatParseError')
    expect(err.offset).toBe(0x1c)
  })
})

describe('entry classification', () => {
  it('recognises plain layout and archive names', () => {
    expect(classifyEntry('blyt/MainMenu.bflyt')).toBe('layout')
    expect(classifyEntry('anim/MainMenu_In.bflan')).toBe('animation')
    expect(classifyEntry('timg/Common.bntx')).toBe('texture')
    expect(classifyEntry('MainMenu.szs')).toBe('archive')
  })

  /**
   * A romfs stacks suffixes. Reading only the last extension classified these as
   * "zs" and reported a perfectly openable archive as an unknown file.
   */
  it('sees through a compression suffix', () => {
    expect(classifyEntry('Accident_HandPick_00.Nin_NX_NVN.blarc.zs')).toBe('archive')
    expect(classifyEntry('Font.Nin_NX_NVN.bfarc.zs')).toBe('archive')
    expect(classifyEntry('MainMenu.szs')).toBe('archive')
    expect(classifyEntry('Loose.bflyt.zs')).toBe('layout')
  })

  it('ignores directories in the path', () => {
    expect(classifyEntry('/games/romfs/Layout/Thing.blarc.zs')).toBe('archive')
  })

  it('returns other for anything unrecognised', () => {
    expect(classifyEntry('Actor.bgyml')).toBe('other')
    expect(classifyEntry('noextension')).toBe('other')
  })
})
