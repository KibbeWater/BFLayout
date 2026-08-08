import { describe, expect, it } from 'vitest'

import {
  createLayoutDocument,
  createMaterial,
  createPicturePane,
  createTextPane
} from '@shared/formats/bflyt/create'
import type { LayoutDocument, TextPane } from '@shared/formats/bflyt'
import {
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
