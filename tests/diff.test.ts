import { describe, expect, it } from 'vitest'

import {
  createLayoutDocument,
  createMaterial,
  createPicturePane
} from '@shared/formats/bflyt/create'
import type { LayoutDocument } from '@shared/formats/bflyt/types'
import { diffLayouts, summarizeChanges } from '@shared/mod/diff'

/**
 * The structural diff, which is what makes a mod reviewable.
 *
 * Two properties matter more than the individual cases. An unchanged layout must
 * produce *nothing* — a diff that reports noise is one nobody reads — and a change
 * has to be attributed to a pane by name, because that is the only identity that
 * survives two separate parses.
 */

function sample(): LayoutDocument {
  const document = createLayoutDocument({ name: 'Menu' })
  document.materials = [createMaterial('BtnMaterial')]
  document.textures = ['Header.bntx']

  const button = createPicturePane('BtnOk', 0)
  button.translate = [0, 0, 0]
  button.width = 100
  button.height = 40
  document.rootPane!.children.push(button)
  return document
}

const clone = (document: LayoutDocument): LayoutDocument =>
  JSON.parse(JSON.stringify(document)) as LayoutDocument

describe('diffLayouts', () => {
  it('reports nothing for an unchanged layout', () => {
    expect(diffLayouts(sample(), clone(sample()))).toEqual([])
  })

  it('reports a move, and says where from and to', () => {
    const after = clone(sample())
    after.rootPane!.children[0]!.translate = [12, -30, 0]

    const changes = diffLayouts(sample(), after)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ kind: 'pane-moved', target: 'BtnOk' })
    expect(changes[0]!.detail).toContain('12, -30, 0')
  })

  it('reports a resize separately from a move', () => {
    const after = clone(sample())
    after.rootPane!.children[0]!.width = 200

    const changes = diffLayouts(sample(), after)
    expect(changes.map((change) => change.kind)).toEqual(['pane-resized'])
  })

  it('reports visibility as what it now is', () => {
    const after = clone(sample())
    after.rootPane!.children[0]!.visible = false
    expect(diffLayouts(sample(), after)[0]).toMatchObject({
      kind: 'pane-visibility',
      detail: 'hidden'
    })
  })

  it('reports added and removed panes', () => {
    const after = clone(sample())
    after.rootPane!.children.push(createPicturePane('BtnCancel', 0))
    expect(diffLayouts(sample(), after)[0]).toMatchObject({
      kind: 'pane-added',
      target: 'BtnCancel'
    })

    const fewer = clone(sample())
    fewer.rootPane!.children = []
    expect(diffLayouts(sample(), fewer)[0]).toMatchObject({
      kind: 'pane-removed',
      target: 'BtnOk'
    })
  })

  /**
   * A material is a dense pile of blend state, tev stages and texture references.
   * Comparing a hand-picked subset would make every field nobody thought of
   * silently exempt — which is exactly where a real change hides.
   */
  it('notices a material change anywhere in the material', () => {
    const after = clone(sample())
    after.materials[0]!.blackColor = [255, 0, 0, 255]
    expect(diffLayouts(sample(), after)).toEqual([
      { kind: 'material-changed', target: 'BtnMaterial', detail: 'material changed' }
    ])

    const deeper = clone(sample())
    deeper.materials[0]!.trailing = [1, 2, 3]
    expect(diffLayouts(sample(), deeper).map((change) => change.kind)).toEqual([
      'material-changed'
    ])
  })

  /** The editor's dirty flag is bookkeeping, not a change to the file. */
  it('does not report a material as changed just because it was touched', () => {
    const after = clone(sample())
    after.materials[0]!.dirty = true
    expect(diffLayouts(sample(), after)).toEqual([])
  })

  it('reports a texture list change with what came and went', () => {
    const after = clone(sample())
    after.textures = ['Header.bntx', 'Extra.bntx']
    expect(diffLayouts(sample(), after)[0]!.detail).toContain('+Extra.bntx')
  })

  it('reports a reparent rather than an add and a remove', () => {
    const before = sample()
    const group = createPicturePane('Group', 0)
    before.rootPane!.children.push(group)

    const after = clone(before)
    const moved = after.rootPane!.children.shift()!
    after.rootPane!.children[0]!.children.push(moved)

    const changes = diffLayouts(before, after)
    expect(changes.map((change) => change.kind)).toEqual(['pane-reparented'])
    expect(changes[0]!.detail).toContain('Group')
  })
})

describe('summarizeChanges', () => {
  it('says so when there is nothing', () => {
    expect(summarizeChanges([])).toBe('no changes')
  })

  it('groups rather than lists', () => {
    const summary = summarizeChanges([
      { kind: 'pane-moved', target: 'A', detail: '' },
      { kind: 'pane-moved', target: 'B', detail: '' },
      { kind: 'material-changed', target: 'M', detail: '' }
    ])
    expect(summary).toBe('2 panes moved, material changed')
  })
})
