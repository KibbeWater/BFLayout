import { describe, expect, it } from 'vitest'

import { parseBflyt, writeBflyt } from '@shared/formats/bflyt'
import { createLayoutDocument, createTextPane, createWindowPane } from '@shared/formats/bflyt/create'
import { localSegment, referencedPanes } from '@shared/formats/bflyt/userdata'
import type { LayoutDocument, Pane, UserDataEntry } from '@shared/formats/bflyt/types'
import { checkBytes } from '@shared/mod/check'
import { duplicatePane, editUserData, paneUserData } from '@headless/edit'
import { summarizePane } from '@headless/engine'

/**
 * Pane user data: the wiring that is not in a pane's own fields.
 *
 * `AdjustToTextOn` makes a pane resize itself, every frame, to fit the text panes
 * it names. Nothing about a pane carrying it looks different, so duplicating one
 * silently produces a copy that drives itself from the original's text pane — the
 * copy and the pane it now depends on can be in different halves of the screen,
 * and the layout still parses, still deploys and still renders in the editor.
 *
 * The values here are shaped like the shipped ones: `Balloon_Message_00` points a
 * single window at three text panes, newline-separated.
 */

const stringEntry = (name: string, value: string): UserDataEntry => ({
  name,
  kind: 'string',
  stringValue: value,
  numberValues: [],
  structValue: null,
  itemCount: value.length + 1,
  unknown: 0
})

const floatEntry = (name: string, value: number): UserDataEntry => ({
  name,
  kind: 'float',
  stringValue: null,
  numberValues: [value],
  structValue: null,
  itemCount: 1,
  unknown: 0
})

/** A balloon shaped like the donor: a window that sizes itself to its own text. */
function balloon(): { document: LayoutDocument; window: Pane } {
  const document = createLayoutDocument({ name: 'Balloon' })
  const window = createWindowPane('W_Base_00', 0)
  const text = createTextPane('T_Text_00', 0)

  window.userData = {
    entries: [
      stringEntry('AdjustToTextOn', 'T_Text_00\nT_Big_00\nT_Small_00'),
      floatEntry('AdjustToTextMinSize', 440),
      floatEntry('AdjustToTextMargin', 100)
    ],
    raw: [],
    dirty: false
  }

  window.children.push(text, createTextPane('T_Big_00', 0), createTextPane('T_Small_00', 0))
  document.rootPane!.children.push(window)
  return { document, window }
}

describe('reading references out of user data', () => {
  /**
   * The first version of this read the whole string as one pane name, which
   * reported every multi-target entry in the shipped game as broken.
   */
  it('splits a value naming several panes', () => {
    const entry = stringEntry('AdjustToTextOn', 'T_Text_00\nT_Big_00\nT_Small_00')
    expect(referencedPanes(entry)).toEqual(['T_Text_00', 'T_Big_00', 'T_Small_00'])
  })

  it('ignores keys that are not references', () => {
    expect(referencedPanes(stringEntry('AutoShrinkOnWordwrap', 'Middium'))).toEqual([])
    expect(referencedPanes(floatEntry('AdjustToTextMargin', 100))).toEqual([])
  })

  /** `L_Key_00/T_KeyTxt_00` reaches into a part pane's own layout, a different file. */
  it('keeps only the segment the holding layout owns', () => {
    expect(localSegment('L_Key_00/T_KeyTxt_00')).toBe('L_Key_00')
    expect(localSegment('T_Text_00')).toBe('T_Text_00')
  })

  /**
   * A rooted reference names a pane in whichever layout embeds this one, so this
   * layout cannot resolve it and must not claim it is missing. Two shipped
   * layouts do this, and they were the last false positives the rule produced.
   */
  it('declines to resolve a rooted reference', () => {
    expect(localSegment('/N_Capture_00')).toBeNull()
  })

  it('says whether each named pane is actually here', () => {
    const { document } = balloon()
    const view = paneUserData(document, 'W_Base_00')
    const adjust = view.find((entry) => entry.name === 'AdjustToTextOn')!

    expect(adjust.references).toEqual([
      { pane: 'T_Text_00', present: true },
      { pane: 'T_Big_00', present: true },
      { pane: 'T_Small_00', present: true }
    ])
  })

  /** Structural reads are where people look first, so the wiring shows up there. */
  it('surfaces references in the pane tree', () => {
    const { document, window } = balloon()
    expect(summarizePane(window).references).toEqual({
      AdjustToTextOn: ['T_Text_00', 'T_Big_00', 'T_Small_00']
    })
    expect(summarizePane(document.rootPane!).references).toBeUndefined()
  })
})

describe('editing user data', () => {
  it('removes an entry, which is how a copy stops resizing itself', () => {
    const { document } = balloon()
    editUserData(document, 'W_Base_00', { remove: ['AdjustToTextOn'] })

    const names = paneUserData(document, 'W_Base_00').map((entry) => entry.name)
    expect(names).toEqual(['AdjustToTextMinSize', 'AdjustToTextMargin'])
  })

  it('repoints one at a different pane', () => {
    const { document } = balloon()
    editUserData(document, 'W_Base_00', {
      set: [{ name: 'AdjustToTextOn', value: 'T_Mine_00' }]
    })

    const adjust = paneUserData(document, 'W_Base_00').find((e) => e.name === 'AdjustToTextOn')!
    expect(adjust.value).toBe('T_Mine_00')
  })

  it('adds one that was not there', () => {
    const { document } = balloon()
    editUserData(document, 'W_Base_00', { set: [{ name: 'RubyOff', value: [1] }] })

    const added = paneUserData(document, 'W_Base_00').find((entry) => entry.name === 'RubyOff')!
    expect(added.kind).toBe('int')
    expect(added.value).toEqual([1])
  })

  /**
   * The edit is only real if it reaches the bytes. User data is replayed verbatim
   * until it is marked dirty, so an edit that forgot the flag would report success
   * and write the original value back.
   */
  it('survives a round trip through the file', () => {
    const { document } = balloon()
    editUserData(document, 'W_Base_00', { remove: ['AdjustToTextOn'] })

    const reread = parseBflyt(writeBflyt(document, new Map())).document
    const names = paneUserData(reread, 'W_Base_00').map((entry) => entry.name)
    expect(names).not.toContain('AdjustToTextOn')
    expect(names).toContain('AdjustToTextMargin')
  })

  it('keeps the other entries intact through that round trip', () => {
    const { document } = balloon()
    editUserData(document, 'W_Base_00', {
      set: [{ name: 'AdjustToTextOn', value: 'T_Only_00' }]
    })

    const reread = parseBflyt(writeBflyt(document, new Map())).document
    const view = paneUserData(reread, 'W_Base_00')
    expect(view.find((entry) => entry.name === 'AdjustToTextOn')!.value).toBe('T_Only_00')
    expect(view.find((entry) => entry.name === 'AdjustToTextMinSize')!.value).toEqual([440])
  })

  it('drops the section when the last entry goes', () => {
    const { document, window } = balloon()
    editUserData(document, 'W_Base_00', {
      remove: ['AdjustToTextOn', 'AdjustToTextMinSize', 'AdjustToTextMargin']
    })
    expect(window.userData).toBeNull()
  })

  it('names what is there when asked to remove something that is not', () => {
    const { document } = balloon()
    expect(() => editUserData(document, 'W_Base_00', { remove: ['Nope'] })).toThrow(
      /AdjustToTextOn/
    )
  })

  /** A struct's payload survives by being copied verbatim; it cannot be rebuilt. */
  it('refuses to overwrite a struct entry', () => {
    const { document, window } = balloon()
    window.userData!.entries.push({
      name: 'ui2dsys',
      kind: 'struct',
      stringValue: null,
      numberValues: [],
      structValue: new Array(132).fill(0),
      itemCount: 1,
      unknown: 0
    })

    expect(() => editUserData(document, 'W_Base_00', { set: [{ name: 'ui2dsys', value: 'x' }] })).toThrow(
      /struct/
    )
  })
})

describe('duplicating a pane that carries references', () => {
  /**
   * The copy's text panes were copied with it, so "my text pane" means the copy's
   * own — leaving it pointing at the original's is the trap this exists to close.
   */
  it('repoints references at the panes copied alongside them', () => {
    const { document } = balloon()
    const report = duplicatePane(document, 'W_Base_00')

    const adjust = paneUserData(document, report.name).find((e) => e.name === 'AdjustToTextOn')!
    expect(adjust.value).toBe('T_Text_00_copy\nT_Big_00_copy\nT_Small_00_copy')
    expect(adjust.references?.every((reference) => reference.present)).toBe(true)
    expect(report.warnings).toEqual([])
    expect(report.remapped).toHaveLength(3)
  })

  /**
   * The failure as it actually happened: the text pane lived elsewhere, so 34
   * copies all kept resizing themselves to one pane belonging to something else.
   */
  it('warns when a reference still points outside the copy', () => {
    const document = createLayoutDocument({ name: 'Screen' })
    const window = createWindowPane('W_Base_00', 0)
    window.userData = { entries: [stringEntry('AdjustToTextOn', 'T_Footer_00')], raw: [], dirty: false }
    document.rootPane!.children.push(window, createTextPane('T_Footer_00', 0))

    const report = duplicatePane(document, 'W_Base_00')
    expect(report.warnings).toEqual(['W_Base_00_copy.AdjustToTextOn still points at T_Footer_00'])
    expect(report.message).toContain('1 reference(s) still point outside the copy')
  })

  it('leaves the original alone', () => {
    const { document } = balloon()
    duplicatePane(document, 'W_Base_00')

    const original = paneUserData(document, 'W_Base_00').find((e) => e.name === 'AdjustToTextOn')!
    expect(original.value).toBe('T_Text_00\nT_Big_00\nT_Small_00')
  })

  /**
   * A clean pane is written from its original bytes, keyed by id. A copy that kept
   * the donor's id would be written out *as the donor* — new name and all.
   */
  it('gives the copy its own identity', () => {
    const { document, window } = balloon()
    const report = duplicatePane(document, 'W_Base_00')
    const copy = document.rootPane!.children.find((pane) => pane.name === report.name)!

    expect(copy.id).not.toBe(window.id)
  })
})

describe('checking references', () => {
  it('reports one naming a pane the layout does not have', () => {
    const document = createLayoutDocument({ name: 'Screen' })
    const window = createWindowPane('W_Base_00', 0)
    window.userData = { entries: [stringEntry('AdjustToTextOn', 'T_Gone_00')], raw: [], dirty: false }
    document.rootPane!.children.push(window)

    const result = checkBytes('screen.bflyt', writeBflyt(document, new Map()))
    const warnings = result.notes.filter((note) => note.level === 'warning')
    expect(warnings.some((note) => note.message.includes('T_Gone_00'))).toBe(true)
  })

  /**
   * 268 references across the 544 layouts of a shipped romfs resolve, so anything
   * this fires on in stock content is a bug in the rule, not in the game.
   */
  it('stays quiet on a layout whose references all resolve', () => {
    const { document } = balloon()
    const result = checkBytes('balloon.bflyt', writeBflyt(document, new Map()))
    expect(result.notes.filter((note) => note.message.includes('AdjustToTextOn'))).toEqual([])
  })

  it('does not judge a rooted reference', () => {
    const document = createLayoutDocument({ name: 'Screen' })
    const holder = createWindowPane('P_CaptureUse_00', 0)
    holder.userData = {
      entries: [stringEntry('CaptureUseName', '/N_Capture_00')],
      raw: [],
      dirty: false
    }
    document.rootPane!.children.push(holder)

    const result = checkBytes('screen.bflyt', writeBflyt(document, new Map()))
    expect(result.notes.filter((note) => note.message.includes('N_Capture_00'))).toEqual([])
  })

  it('does not judge the part-pane half of a path', () => {
    const document = createLayoutDocument({ name: 'Screen' })
    const holder = createWindowPane('N_Adjust_00', 0)
    holder.userData = {
      entries: [stringEntry('AdjustToTextOn', 'L_Key_00/T_KeyTxt_00')],
      raw: [],
      dirty: false
    }
    document.rootPane!.children.push(holder, createTextPane('L_Key_00', 0))

    const result = checkBytes('screen.bflyt', writeBflyt(document, new Map()))
    expect(result.notes.filter((note) => note.message.includes('T_KeyTxt_00'))).toEqual([])
  })
})
