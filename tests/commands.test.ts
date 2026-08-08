import { describe, expect, it } from 'vitest'

import {
  createLayoutDocument,
  createMaterial,
  createPicturePane,
  createTextPane
} from '@shared/formats/bflyt/create'
import type { LayoutDocument, TextPane } from '@shared/formats/bflyt'
import {
  addPane,
  composeCommands,
  contains,
  deletePane,
  duplicatePane,
  movePane,
  placementOf,
  resolveMove,
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

describe('duplicatePane', () => {
  it('copies the subtree in beside the original with fresh ids', () => {
    const parent = createPicturePane('Btn')
    const child = createTextPane('Caption')
    parent.children.push(child)
    const document = createLayoutDocument()
    document.rootPane!.children.push(parent)

    const command = duplicatePane(document, parent.id)
    expect(command).not.toBeNull()
    command!.apply(document)

    const siblings = document.rootPane!.children
    expect(siblings).toHaveLength(2)
    const copy = siblings[1]!
    // Placed directly after the original, not appended at the end.
    expect(siblings[0]).toBe(parent)
    expect(copy.id).not.toBe(parent.id)
    expect(copy.children).toHaveLength(1)
    expect(copy.children[0]!.id).not.toBe(child.id)
    // Copies are new content, so they must be encoded rather than replayed.
    expect(copy.dirty).toBe(true)
  })

  it('gives every copied pane a name nothing else is using', () => {
    // Animations and groups address panes by name, so a duplicate name would make
    // one animation drive two panes.
    const parent = createPicturePane('Btn')
    parent.children.push(createTextPane('Caption'))
    const document = createLayoutDocument()
    document.rootPane!.children.push(parent)

    duplicatePane(document, parent.id)!.apply(document)
    duplicatePane(document, parent.id)!.apply(document)

    const names: string[] = []
    const collect = (pane: { name: string; children: { name: string }[] }): void => {
      names.push(pane.name)
      for (const child of pane.children) collect(child as typeof pane)
    }
    collect(document.rootPane! as unknown as Parameters<typeof collect>[0])
    expect(new Set(names).size).toBe(names.length)
  })

  it('strips an existing counter rather than stacking them', () => {
    const pane = createPicturePane('Btn_1')
    const document = createLayoutDocument()
    document.rootPane!.children.push(pane)

    duplicatePane(document, pane.id)!.apply(document)
    expect(document.rootPane!.children[1]!.name).toBe('Btn_2')
  })

  it('undoes as a single removal', () => {
    const pane = createPicturePane('Btn')
    const document = createLayoutDocument()
    document.rootPane!.children.push(pane)

    const command = duplicatePane(document, pane.id)!
    command.apply(document)
    expect(document.rootPane!.children).toHaveLength(2)
    command.invert(document)
    expect(document.rootPane!.children).toHaveLength(1)
    expect(document.rootPane!.children[0]).toBe(pane)
  })

  it('keeps copies unique within the 24 bytes the writer stores', () => {
    /*
     * Pane names are a fixed 24-byte field and the writer truncates silently, so a
     * name unique in memory but not in its first 24 characters becomes a duplicate
     * on disk — two panes one animation would drive at once.
     */
    const long = 'ButtonWithAVeryLongName1'
    expect(long).toHaveLength(24)

    const pane = createPicturePane(long)
    const document = createLayoutDocument()
    document.rootPane!.children.push(pane)

    duplicatePane(document, pane.id)!.apply(document)
    duplicatePane(document, pane.id)!.apply(document)

    const names = document.rootPane!.children.map((child) => child.name.slice(0, 24))
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) expect(name.length).toBeLessThanOrEqual(24)
  })

  it('returns null for the root, which has no parent to copy into', () => {
    const document = createLayoutDocument()
    expect(duplicatePane(document, document.rootPane!.id)).toBeNull()
  })
})

describe('addPane', () => {
  it('is idempotent, so composing several inserts cannot double-insert', () => {
    // duplicateSelection applies each command as it builds, then hands the
    // composite to runCommand which applies it again.
    const document = createLayoutDocument()
    const pane = createPicturePane('New')
    const command = addPane(document.rootPane!.id, pane)

    command.apply(document)
    command.apply(document)
    expect(document.rootPane!.children).toHaveLength(1)

    command.invert(document)
    expect(document.rootPane!.children).toHaveLength(0)
  })
})

/**
 * Reordering and reparenting.
 *
 * Draw order *is* tree order, so moving a pane later among its siblings is the only
 * way to bring it forward. Before this the only route was delete-and-recreate, which
 * lost every property.
 */
describe('movePane', () => {
  function threeSiblings(): {
    document: LayoutDocument
    a: ReturnType<typeof createPicturePane>
    b: ReturnType<typeof createPicturePane>
    c: ReturnType<typeof createPicturePane>
  } {
    const document = createLayoutDocument()
    const a = createPicturePane('A')
    const b = createPicturePane('B')
    const c = createPicturePane('C')
    document.rootPane!.children.push(a, b, c)
    return { document, a, b, c }
  }

  const order = (document: LayoutDocument): string[] =>
    document.rootPane!.children.map((pane) => pane.name)

  it('reorders among siblings and undoes exactly', () => {
    const { document, a } = threeSiblings()
    const command = movePane(document, a.id, { parentId: document.rootPane!.id, index: 2 })!

    command.apply(document)
    expect(order(document)).toEqual(['B', 'C', 'A'])
    command.invert(document)
    expect(order(document)).toEqual(['A', 'B', 'C'])
  })

  it('reparents and undoes exactly', () => {
    const { document, a, b } = threeSiblings()
    const command = movePane(document, a.id, { parentId: b.id, index: 0 })!

    command.apply(document)
    expect(order(document)).toEqual(['B', 'C'])
    expect(b.children.map((pane) => pane.name)).toEqual(['A'])

    command.invert(document)
    expect(order(document)).toEqual(['A', 'B', 'C'])
    expect(b.children).toHaveLength(0)
  })

  it('refuses to move a pane inside its own subtree', () => {
    // Allowing this would splice the pane into a child of itself and detach the whole
    // subtree from the document.
    const parent = createPicturePane('Parent')
    const child = createPicturePane('Child')
    parent.children.push(child)
    const document = createLayoutDocument()
    document.rootPane!.children.push(parent)

    expect(movePane(document, parent.id, { parentId: child.id, index: 0 })).toBeNull()
    expect(movePane(document, parent.id, { parentId: parent.id, index: 0 })).toBeNull()
  })

  it('refuses to move the root, which has no parent', () => {
    const document = createLayoutDocument()
    expect(movePane(document, document.rootPane!.id, { parentId: 'x', index: 0 })).toBeNull()
  })

  it('dirties both parents as well as the pane', () => {
    // A pane's position in the stream encodes the tree, so the parents have to be
    // re-emitted rather than replayed from their original bytes.
    const { document, a, b } = threeSiblings()
    const root = document.rootPane!
    root.dirty = false
    b.dirty = false
    a.dirty = false

    movePane(document, a.id, { parentId: b.id, index: 0 })!.apply(document)
    expect(a.dirty).toBe(true)
    expect(b.dirty).toBe(true)
    expect(root.dirty).toBe(true)
  })

  it('clamps an out-of-range index rather than leaving a hole', () => {
    const { document, a } = threeSiblings()
    movePane(document, a.id, { parentId: document.rootPane!.id, index: 99 })!.apply(document)
    expect(order(document)).toEqual(['B', 'C', 'A'])
  })
})

describe('resolveMove', () => {
  function nested(): { document: LayoutDocument; ids: Record<string, string> } {
    const document = createLayoutDocument()
    const a = createPicturePane('A')
    const b = createPicturePane('B')
    const inner = createPicturePane('Inner')
    b.children.push(inner)
    document.rootPane!.children.push(a, b)
    return { document, ids: { a: a.id, b: b.id, inner: inner.id, root: document.rootPane!.id } }
  }

  it('raise moves later among siblings, because later draws on top', () => {
    const { document, ids } = nested()
    expect(resolveMove(document, ids['a']!, 'raise')).toEqual({ parentId: ids['root'], index: 1 })
  })

  it('lower moves earlier, and stops at the bottom', () => {
    const { document, ids } = nested()
    expect(resolveMove(document, ids['b']!, 'lower')).toEqual({ parentId: ids['root'], index: 0 })
    expect(resolveMove(document, ids['a']!, 'lower')).toBeNull()
  })

  it('raise stops at the top', () => {
    const { document, ids } = nested()
    expect(resolveMove(document, ids['b']!, 'raise')).toBeNull()
  })

  it('indent makes a pane the last child of the sibling before it', () => {
    const { document, ids } = nested()
    // B moves under A, which has no children yet, so it lands at index 0.
    expect(resolveMove(document, ids['b']!, 'indent')).toEqual({ parentId: ids['a'], index: 0 })
  })

  it('indent is impossible for the first sibling', () => {
    const { document, ids } = nested()
    expect(resolveMove(document, ids['a']!, 'indent')).toBeNull()
  })

  it('outdent places a pane after its former parent', () => {
    const { document, ids } = nested()
    expect(resolveMove(document, ids['inner']!, 'outdent')).toEqual({
      parentId: ids['root'],
      index: 2
    })
  })

  it('outdent is impossible for a direct child of the root', () => {
    const { document, ids } = nested()
    expect(resolveMove(document, ids['a']!, 'outdent')).toBeNull()
  })

  it('every resolved move is a legal movePane', () => {
    const { document, ids } = nested()
    for (const id of [ids['a']!, ids['b']!, ids['inner']!]) {
      for (const move of ['raise', 'lower', 'indent', 'outdent'] as const) {
        const target = resolveMove(document, id, move)
        if (!target) continue
        expect(movePane(document, id, target)).not.toBeNull()
      }
    }
  })
})

describe('placement helpers', () => {
  it('placementOf finds the parent and index', () => {
    const document = createLayoutDocument()
    const a = createPicturePane('A')
    const b = createPicturePane('B')
    document.rootPane!.children.push(a, b)
    expect(placementOf(document, b.id)).toEqual({ parentId: document.rootPane!.id, index: 1 })
    expect(placementOf(document, document.rootPane!.id)).toBeNull()
  })

  it('contains reports a pane as containing itself and its descendants', () => {
    const parent = createPicturePane('Parent')
    const child = createPicturePane('Child')
    const grandchild = createPicturePane('Grandchild')
    child.children.push(grandchild)
    parent.children.push(child)
    const document = createLayoutDocument()
    document.rootPane!.children.push(parent)

    expect(contains(document, parent.id, parent.id)).toBe(true)
    expect(contains(document, parent.id, grandchild.id)).toBe(true)
    expect(contains(document, child.id, parent.id)).toBe(false)
  })
})
