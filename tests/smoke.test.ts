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

  it('classifies the formats the browser can now open', () => {
    /*
     * `bgyml` used to be expected to classify as `other`, and that expectation was the bug: it is
     * ordinary BYML, it accounts for 38,265 entries in one title's archives — more than every
     * layout, animation and texture combined — and every one of them parses with the existing
     * reader. Presenting them as unrecognised files made the most common thing in a romfs
     * unopenable.
     */
    expect(classifyEntry('Actor.bgyml')).toBe('data')
    expect(classifyEntry('Params.byml')).toBe('data')
    expect(classifyEntry('Talk.msbt')).toBe('message')
    // The scalable fonts the canvas draws real text with were unclassified too.
    expect(classifyEntry('scft/Font.bfttf')).toBe('font')
    expect(classifyEntry('fcpx/System_00.bfcpx')).toBe('font')
    expect(classifyEntry('Model.bfres')).toBe('model')
  })

  it('returns other for anything genuinely unrecognised', () => {
    expect(classifyEntry('noextension')).toBe('other')
    expect(classifyEntry('Thing.qqq')).toBe('other')
  })
})
