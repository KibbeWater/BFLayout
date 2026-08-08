import { describe, expect, it } from 'vitest'

import {
  createLayoutDocument,
  createMaterial,
  createPicturePane,
  createTextPane
} from '@shared/formats/bflyt/create'
import type { LayoutDocument, TextPane } from '@shared/formats/bflyt'
import {
  composeCommands,
  deletePane,
  setMaterialSnapshot,
  setPaneSnapshot,
  snapshotPane
} from '@renderer/editor/commands'

/**
 * Undo coverage for property edits.
 *
 * These exist because the properties panel, the materials panel and the hierarchy's
 * visibility toggle all wrote straight to the document, so none of their edits could
 * be undone — and, worse, the history then described the *previous* command as the
 * thing Cmd+Z would reverse. The snapshot commands below are what those panels now
 * go through.
 */

function documentWith(pane: ReturnType<typeof createPicturePane>): LayoutDocument {
  const document = createLayoutDocument()
  document.rootPane!.children.push(pane)
  return document
}

describe('setPaneSnapshot', () => {
  it('reverses an edit to any field, not just the transform ones', () => {
    const pane = createPicturePane('Button')
    const document = documentWith(pane)

    const before = snapshotPane(pane)
    pane.name = 'Renamed'
    pane.alpha = 128
    pane.width = 400
    pane.visible = false
    const after = snapshotPane(pane)

    const command = setPaneSnapshot(pane.id, 'Edit Button', before, after)

    command.invert(document)
    expect(pane.name).toBe('Button')
    expect(pane.alpha).toBe(255)
    expect(pane.width).not.toBe(400)
    expect(pane.visible).toBe(true)

    command.apply(document)
    expect(pane.name).toBe('Renamed')
    expect(pane.alpha).toBe(128)
    expect(pane.width).toBe(400)
    expect(pane.visible).toBe(false)
  })

  it('reverses a kind-specific field like a text pane string', () => {
    // The field-list command could never do this: `text` is not one of the ten
    // fields the canvas drags, so text edits were silently outside undo.
    const pane = createTextPane('Caption')
    const document = createLayoutDocument()
    document.rootPane!.children.push(pane)

    const before = snapshotPane(pane)
    pane.text = 'Continue'
    const after = snapshotPane(pane)

    const command = setPaneSnapshot(pane.id, 'Edit Caption', before, after)
    command.invert(document)
    expect((document.rootPane!.children[0] as TextPane).text).not.toBe('Continue')
    command.apply(document)
    expect((document.rootPane!.children[0] as TextPane).text).toBe('Continue')
  })

  it('deep-clones, so mutating the pane afterwards cannot corrupt the snapshot', () => {
    // A shallow copy would alias `translate`, and an in-place edit would leave
    // before and after identical — undo would appear to do nothing.
    const pane = createPicturePane('Nested')
    const document = documentWith(pane)

    const before = snapshotPane(pane)
    pane.translate[0] = 123
    const after = snapshotPane(pane)

    expect((before['translate'] as number[])[0]).toBe(0)
    expect((after['translate'] as number[])[0]).toBe(123)

    const command = setPaneSnapshot(pane.id, 'Edit', before, after)
    command.invert(document)
    expect(pane.translate[0]).toBe(0)
    command.apply(document)
    expect(pane.translate[0]).toBe(123)
  })

  it('leaves children alone', () => {
    // Snapshots describe a property edit; reparenting and deletion are separate
    // commands that own the tree structure.
    const parent = createPicturePane('Parent')
    const child = createPicturePane('Child')
    parent.children.push(child)
    const document = documentWith(parent)

    const before = snapshotPane(parent)
    parent.name = 'Changed'
    const after = snapshotPane(parent)

    setPaneSnapshot(parent.id, 'Edit', before, after).invert(document)
    expect(parent.children).toHaveLength(1)
    expect(parent.children[0]).toBe(child)
  })

  it('marks the pane dirty in both directions', () => {
    // Dirty decides whether the writer re-encodes the section or replays original
    // bytes, so undoing to the original *model* still needs a re-encode.
    const pane = createPicturePane('Button')
    const document = documentWith(pane)

    const before = snapshotPane(pane)
    pane.name = 'X'
    const after = snapshotPane(pane)
    const command = setPaneSnapshot(pane.id, 'Edit', before, after)

    pane.dirty = false
    command.invert(document)
    expect(pane.dirty).toBe(true)

    pane.dirty = false
    command.apply(document)
    expect(pane.dirty).toBe(true)
  })

  it('does nothing when the pane is gone rather than throwing', () => {
    const pane = createPicturePane('Button')
    const document = createLayoutDocument()
    const command = setPaneSnapshot(pane.id, 'Edit', snapshotPane(pane), snapshotPane(pane))
    expect(() => command.apply(document)).not.toThrow()
  })
})

describe('setMaterialSnapshot', () => {
  it('reverses a material edit and marks it dirty', () => {
    const document = createLayoutDocument()
    document.materials.push(createMaterial('Base'))
    const material = document.materials[0]
    expect(material).toBeDefined()

    const before = structuredClone({ ...material! })
    material!.name = 'Recoloured'
    material!.blackColor = [1, 2, 3, 4]
    const after = structuredClone({ ...material! })

    const command = setMaterialSnapshot(0, 'Edit material', before, after)

    command.invert(document)
    expect(document.materials[0]!.name).not.toBe('Recoloured')
    expect(document.materials[0]!.dirty).toBe(true)

    command.apply(document)
    expect(document.materials[0]!.name).toBe('Recoloured')
    expect(document.materials[0]!.blackColor).toEqual([1, 2, 3, 4])
  })

  it('does nothing for an index the layout does not have', () => {
    const document = createLayoutDocument()
    const command = setMaterialSnapshot(99, 'Edit', {}, {})
    expect(() => command.apply(document)).not.toThrow()
  })
})

describe('composeCommands', () => {
  it('applies in order and inverts in reverse', () => {
    // Reverse inversion is the whole point: two deletions from one parent only
    // restore to the right indices if the later one is reinserted first.
    const first = createPicturePane('First')
    const second = createPicturePane('Second')
    const third = createPicturePane('Third')
    const document = createLayoutDocument()
    document.rootPane!.children.push(first, second, third)

    // Built the way callers must: apply each before creating the next, so the
    // recorded indices match the array each will be inverted into.
    const commands = []
    for (const target of [first, second]) {
      const command = deletePane(document, target.id)
      expect(command).not.toBeNull()
      command!.apply(document)
      commands.push(command!)
    }

    const composed = composeCommands('Delete 2 panes', commands)
    expect(document.rootPane!.children.map((pane) => pane.name)).toEqual(['Third'])

    // Re-applying is a no-op, which is what lets runCommand take the composite.
    composed.apply(document)
    expect(document.rootPane!.children.map((pane) => pane.name)).toEqual(['Third'])

    composed.invert(document)
    expect(document.rootPane!.children.map((pane) => pane.name)).toEqual([
      'First',
      'Second',
      'Third'
    ])
  })

  it('is a single entry however many panes it moves', () => {
    const panes = ['A', 'B', 'C'].map((name) => createPicturePane(name))
    const document = createLayoutDocument()
    document.rootPane!.children.push(...panes)

    const moves = panes.map((pane) => {
      const before = snapshotPane(pane)
      pane.translate[0] = 40
      return setPaneSnapshot(pane.id, 'Nudge', before, snapshotPane(pane))
    })

    const composed = composeCommands('Nudge 3 panes', moves)
    composed.invert(document)
    expect(document.rootPane!.children.map((pane) => pane.translate[0])).toEqual([0, 0, 0])
    composed.apply(document)
    expect(document.rootPane!.children.map((pane) => pane.translate[0])).toEqual([40, 40, 40])
  })

  it('does nothing for an empty list rather than failing', () => {
    const document = createLayoutDocument()
    const composed = composeCommands('Nothing', [])
    expect(() => composed.apply(document)).not.toThrow()
    expect(() => composed.invert(document)).not.toThrow()
  })
})
