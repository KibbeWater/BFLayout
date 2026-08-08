import { beforeEach, describe, expect, it } from 'vitest'

import { createLayoutDocument, createPicturePane } from '@shared/formats/bflyt/create'
import type { LayoutDocument } from '@shared/formats/bflyt'
import { setPaneSnapshot, snapshotPane, type Command } from '@renderer/editor/commands'
import { useDocuments } from '@renderer/editor/store/document'

/**
 * The unsaved flag, and the save point it is derived from.
 *
 * Worth testing directly rather than through the UI because everything protecting the
 * user's work reads it: the window-close prompt, the tab-close confirmation, and the
 * tab-reuse rule that only replaces a tab it believes is clean. A false "clean" is
 * silent data loss through the exact guards built to prevent it.
 */

function documentWithPane(): { document: LayoutDocument; paneId: string } {
  const document = createLayoutDocument()
  const pane = createPicturePane('Button')
  document.rootPane!.children.push(pane)
  return { document, paneId: pane.id }
}

/** A command that renames the pane, so each one is a distinct, undoable edit. */
function rename(document: LayoutDocument, paneId: string, to: string): Command {
  const pane = document.rootPane!.children.find((child) => child.id === paneId)!
  const before = snapshotPane(pane)
  const after = { ...before, name: to }
  return setPaneSnapshot(paneId, `Rename to ${to}`, before, after)
}

describe('document store save point', () => {
  let document: LayoutDocument
  let paneId: string

  beforeEach(() => {
    const made = documentWithPane()
    document = made.document
    paneId = made.paneId

    useDocuments.setState({ tabs: [], activeId: null })
    useDocuments.getState().openTab({
      documentId: 'doc_1',
      displayName: 'Test.bflyt',
      source: { kind: 'file', path: '/tmp/Test.bflyt' },
      document
    })
  })

  const tab = (): ReturnType<typeof useDocuments.getState>['tabs'][number] =>
    useDocuments.getState().tabs[0]!

  it('opens clean and dirties on the first edit', () => {
    expect(tab().unsaved).toBe(false)
    useDocuments.getState().runCommand(rename(document, paneId, 'A'))
    expect(tab().unsaved).toBe(true)
  })

  it('reports clean again when undone back to the save point', () => {
    const store = useDocuments.getState()
    store.runCommand(rename(document, paneId, 'A'))
    store.markSaved('doc_1')
    expect(tab().unsaved).toBe(false)

    store.runCommand(rename(document, paneId, 'B'))
    expect(tab().unsaved).toBe(true)

    store.undo()
    expect(tab().unsaved).toBe(false)

    store.redo()
    expect(tab().unsaved).toBe(true)
  })

  it('stays unsaved when a new edit diverges from the save point', () => {
    /*
     * The bug this exists for: undo past a save, then make a *different* edit. The new
     * command lands at the same stack depth the save recorded, so a naive depth
     * comparison called the document clean while it held an edit the disk did not.
     * Every close guard then treated the tab as safe to discard.
     */
    const store = useDocuments.getState()
    store.runCommand(rename(document, paneId, 'A'))
    store.markSaved('doc_1')
    expect(tab().savedDepth).toBe(1)

    store.undo()
    expect(tab().unsaved).toBe(true)

    // A different edit, landing at depth 1 — the same depth the save recorded.
    store.runCommand(rename(document, paneId, 'Different'))
    expect(tab().history.undo).toHaveLength(1)
    expect(tab().unsaved).toBe(true)
    expect(tab().savedDepth).toBe(-1)
  })

  it('does not resurrect a save point through further undo and redo', () => {
    const store = useDocuments.getState()
    store.runCommand(rename(document, paneId, 'A'))
    store.markSaved('doc_1')
    store.undo()
    store.runCommand(rename(document, paneId, 'Different'))

    // Once invalidated the depth must never match again, at any depth.
    store.undo()
    expect(tab().unsaved).toBe(true)
    store.redo()
    expect(tab().unsaved).toBe(true)
  })

  it('ignores a save built from a stale revision', () => {
    // Serializing and writing is asynchronous; an edit landing in between is not in
    // the bytes on disk, so the flag must stay set.
    const store = useDocuments.getState()
    store.runCommand(rename(document, paneId, 'A'))
    const builtFrom = tab().revision

    store.runCommand(rename(document, paneId, 'B'))
    store.markSaved('doc_1', builtFrom)
    expect(tab().unsaved).toBe(true)

    store.markSaved('doc_1', tab().revision)
    expect(tab().unsaved).toBe(false)
  })

  it('refuses to reuse a tab that holds unsaved work', () => {
    // Tab reuse is the third guard reading this flag: an unsaved tab must be kept and
    // the new document opened beside it.
    const store = useDocuments.getState()
    store.runCommand(rename(document, paneId, 'A'))

    const displaced = store.openTab({
      documentId: 'doc_2',
      displayName: 'Other.bflyt',
      source: { kind: 'file', path: '/tmp/Other.bflyt' },
      document: createLayoutDocument()
    })

    expect(displaced).toBeNull()
    expect(useDocuments.getState().tabs).toHaveLength(2)
  })
})
