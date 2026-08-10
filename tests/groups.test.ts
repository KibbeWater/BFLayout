import { describe, expect, it } from 'vitest'

import { parseBflyt, writeBflyt } from '@shared/formats/bflyt'
import {
  createLayoutDocument,
  createMaterial,
  createPicturePane
} from '@shared/formats/bflyt/create'
import type { LayoutDocument } from '@shared/formats/bflyt/types'
import { addGroup, deleteGroup, editGroup, groupList } from '@headless/edit'

/**
 * Pane groups — the binding a BFLAN's `pat1` resolves through.
 *
 * These looked like an optional organisational nicety and are nothing of the
 * sort. An animation binds to a group, and that binding is what decides which
 * panes it applies to: bound to a group the layout does not have, an animation
 * loads, keeps every one of its tracks, and moves nothing. In a shipped romfs
 * **2183 of 2187** animations bind to a group and every binding resolves, so a
 * layout without groups cannot be animated by a stock animation at all.
 *
 * That is the failure that cost a real afternoon — a wave animation whose tracks
 * were all correct, ported into an archive with no groups, which would have
 * shipped as a perfect no-op and read as "the shader isn't working".
 */

function screen(panes: string[] = ['P_Fluid_01', 'P_FluidBack_01']): LayoutDocument {
  const document = createLayoutDocument({ name: 'Screen' })
  document.materials = [createMaterial('M_Fluid')]
  for (const pane of panes) document.rootPane!.children.push(createPicturePane(pane, 0))
  return document
}

describe('reading groups', () => {
  /** A fresh layout has a root group, which is a container and not a binding target. */
  it('does not report the root group as bindable', () => {
    expect(groupList(screen())).toEqual([])
  })

  it('lists a group and what is in it', () => {
    const document = screen()
    addGroup(document, 'G_InOut_00', ['P_Fluid_01'])
    expect(groupList(document)).toEqual([{ name: 'G_InOut_00', panes: ['P_Fluid_01'] }])
  })
})

describe('adding a group', () => {
  it('survives a round trip through the file', () => {
    const document = screen()
    addGroup(document, 'G_InOut_00', ['P_Fluid_01', 'P_FluidBack_01'])

    const reread = parseBflyt(writeBflyt(document, new Map())).document
    expect(groupList(reread)).toEqual([
      { name: 'G_InOut_00', panes: ['P_Fluid_01', 'P_FluidBack_01'] }
    ])
  })

  it('adds a second group beside the first', () => {
    const document = screen()
    addGroup(document, 'G_InOut_00', ['P_Fluid_01'])
    addGroup(document, 'G_Expand_00', ['P_FluidBack_01'])

    const reread = parseBflyt(writeBflyt(document, new Map())).document
    expect(groupList(reread).map((group) => group.name)).toEqual(['G_InOut_00', 'G_Expand_00'])
  })

  /**
   * A group naming a pane that is not there binds to nothing — the same silent
   * failure one level down, so it is refused rather than written.
   */
  it('refuses a pane the layout does not have', () => {
    expect(() => addGroup(screen(), 'G_InOut_00', ['P_Nope'])).toThrow(/no pane called P_Nope/)
  })

  it('refuses a duplicate name', () => {
    const document = screen()
    addGroup(document, 'G_InOut_00', ['P_Fluid_01'])
    expect(() => addGroup(document, 'G_InOut_00', ['P_FluidBack_01'])).toThrow(/already has a group/)
  })

  it('refuses an empty name', () => {
    expect(() => addGroup(screen(), '  ', [])).toThrow(/needs a name/)
  })

  /**
   * Names go into fixed-width fields. A truncated group name is a binding that
   * silently stops matching, which is exactly what these tools exist to prevent.
   */
  it('refuses a name too long for the field it is written into', () => {
    expect(() => addGroup(screen(), 'G_'.padEnd(40, 'x'), [])).toThrow(/truncated/)
  })

  it('refuses a pane name too long for a group slot', () => {
    const document = screen(['P_'.padEnd(30, 'y')])
    expect(() => addGroup(document, 'G_InOut_00', ['P_'.padEnd(30, 'y')])).toThrow(/truncated/)
  })

  it('allows an empty group, which is what an animation with no targets yet needs', () => {
    const document = screen()
    addGroup(document, 'G_InOut_00', [])
    expect(groupList(document)).toEqual([{ name: 'G_InOut_00', panes: [] }])
  })
})

describe('editing a group', () => {
  const withGroup = (): LayoutDocument => {
    const document = screen()
    addGroup(document, 'G_InOut_00', ['P_Fluid_01'])
    return document
  }

  it('adds panes without disturbing the ones there', () => {
    const document = withGroup()
    editGroup(document, 'G_InOut_00', { add: ['P_FluidBack_01'] })
    expect(groupList(document)[0]!.panes).toEqual(['P_Fluid_01', 'P_FluidBack_01'])
  })

  it('does not add the same pane twice', () => {
    const document = withGroup()
    editGroup(document, 'G_InOut_00', { add: ['P_Fluid_01', 'P_FluidBack_01'] })
    expect(groupList(document)[0]!.panes).toEqual(['P_Fluid_01', 'P_FluidBack_01'])
  })

  it('removes a pane', () => {
    const document = withGroup()
    editGroup(document, 'G_InOut_00', { add: ['P_FluidBack_01'] })
    editGroup(document, 'G_InOut_00', { remove: ['P_Fluid_01'] })
    expect(groupList(document)[0]!.panes).toEqual(['P_FluidBack_01'])
  })

  it('replaces the whole list', () => {
    const document = withGroup()
    editGroup(document, 'G_InOut_00', { set: ['P_FluidBack_01'] })
    expect(groupList(document)[0]!.panes).toEqual(['P_FluidBack_01'])
  })

  it('survives a round trip', () => {
    const document = withGroup()
    editGroup(document, 'G_InOut_00', { add: ['P_FluidBack_01'] })

    const reread = parseBflyt(writeBflyt(document, new Map())).document
    expect(groupList(reread)[0]!.panes).toEqual(['P_Fluid_01', 'P_FluidBack_01'])
  })

  it('names what is there when the group is not', () => {
    expect(() => editGroup(withGroup(), 'G_Nope', { add: [] })).toThrow(/G_InOut_00/)
  })

  it('refuses adding a pane the layout does not have', () => {
    expect(() => editGroup(withGroup(), 'G_InOut_00', { add: ['P_Nope'] })).toThrow(/no pane called/)
  })

  it('refuses an edit that changes nothing', () => {
    expect(() => editGroup(withGroup(), 'G_InOut_00', {})).toThrow(/nothing to change/)
  })
})

describe('deleting a group', () => {
  it('removes it and leaves the others', () => {
    const document = screen()
    addGroup(document, 'G_InOut_00', ['P_Fluid_01'])
    addGroup(document, 'G_Expand_00', ['P_FluidBack_01'])

    deleteGroup(document, 'G_InOut_00')
    const reread = parseBflyt(writeBflyt(document, new Map())).document
    expect(groupList(reread).map((group) => group.name)).toEqual(['G_Expand_00'])
  })

  it('says what is there when the group is not', () => {
    const document = screen()
    addGroup(document, 'G_InOut_00', [])
    expect(() => deleteGroup(document, 'G_Nope')).toThrow(/G_InOut_00/)
  })

  it('says so when there are no groups at all', () => {
    expect(() => deleteGroup(screen(), 'G_Nope')).toThrow(/no groups at all/)
  })
})
