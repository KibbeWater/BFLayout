import { beforeEach, describe, expect, it } from 'vitest'

import { createLayoutDocument, createPicturePane } from '@shared/formats/bflyt/create'
import type { LayoutDocument } from '@shared/formats/bflyt'
import { setPaneSnapshot, snapshotPane, type Command } from '@renderer/editor/commands'
import { paneById, useDocuments } from '@renderer/editor/store/document'

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
      snapshotKey: 'file\u0000/tmp/Test.bflyt',
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

  it('does not report clean by undoing back to a save point a mid-flight save invalidated', () => {
    /*
     * The save *did* write, so the old save point no longer names what is on disk
     * either. Leaving savedDepth alone on refusal meant undoing back to it reported the
     * document clean while the file held the mid-flight state — and closing then
     * discarded the difference without a word.
     */
    const store = useDocuments.getState()
    store.runCommand(rename(document, paneId, 'A'))
    const builtFrom = tab().revision
    store.runCommand(rename(document, paneId, 'B'))
    store.markSaved('doc_1', builtFrom)

    store.undo()
    store.undo()
    expect(tab().history.undo).toHaveLength(0)
    expect(tab().unsaved).toBe(true)
  })

  it('activates the existing tab rather than opening a file twice', () => {
    /*
     * Two tabs on one file share a single recovery snapshot row, so whichever flushed
     * last won and the other tab's edits became unrecoverable. Document ids are fresh
     * per open, so the id check alone never caught it.
     */
    const store = useDocuments.getState()
    const displaced = store.openTab({
      documentId: 'doc_again',
      snapshotKey: 'file\u0000/tmp/Test.bflyt',
      displayName: 'Test.bflyt',
      source: { kind: 'file', path: '/tmp/Test.bflyt' },
      document: createLayoutDocument()
    })

    expect(useDocuments.getState().tabs).toHaveLength(1)
    expect(useDocuments.getState().activeId).toBe('doc_1')
    // The caller is handed the session it no longer needs, so it can release it.
    expect(displaced).toBe('doc_again')
  })

  it('lets a recovered document take the place of a clean tab on the same file', () => {
    // The recovered copy is the one carrying edits, so it wins — but only against a
    // tab that has nothing to lose.
    const displaced = useDocuments.getState().openTab(
      {
        documentId: 'doc_recovered',
        snapshotKey: 'file\u0000/tmp/Test.bflyt',
        displayName: 'Test.bflyt',
        source: { kind: 'file', path: '/tmp/Test.bflyt' },
        document: createLayoutDocument()
      },
      { newTab: true, unsaved: true }
    )

    expect(displaced).toBe('doc_1')
    const tabs = useDocuments.getState().tabs
    expect(tabs).toHaveLength(1)
    expect(tabs[0]!.documentId).toBe('doc_recovered')
    expect(tabs[0]!.unsaved).toBe(true)
  })

  it('never displaces a tab that holds unsaved work, even for the same file', () => {
    const store = useDocuments.getState()
    store.runCommand(rename(document, paneId, 'A'))

    store.openTab(
      {
        documentId: 'doc_recovered',
        snapshotKey: 'file\u0000/tmp/Test.bflyt',
        displayName: 'Test.bflyt',
        source: { kind: 'file', path: '/tmp/Test.bflyt' },
        document: createLayoutDocument()
      },
      { newTab: true, unsaved: true }
    )

    expect(useDocuments.getState().tabs).toHaveLength(2)
  })

  it('follows a save-as, so the recovery key names the file being edited', () => {
    /*
     * A key left naming the old file meant crash recovery would restore the
     * post-save-as edits into — and then save over — the very file the user had moved
     * away from, while the file they thought they were editing was never offered.
     */
    const store = useDocuments.getState()
    store.retarget(
      'doc_1',
      { kind: 'file', path: '/tmp/New.bflyt' },
      'New.bflyt',
      'file\u0000/tmp/New.bflyt'
    )

    const tab = useDocuments.getState().tabs[0]!
    expect(tab.snapshotKey).toBe('file\u0000/tmp/New.bflyt')
    expect(tab.displayName).toBe('New.bflyt')
  })

  it('resyncs keys from main, for when an archive moves under its tabs', () => {
    // Saving an archive to a new path retargets every layout inside it at once.
    useDocuments.getState().resyncKeys(new Map([['doc_1', 'archive\u0000/tmp/New.szs\u0000blyt/A.bflyt']]))
    expect(useDocuments.getState().tabs[0]!.snapshotKey).toBe(
      'archive\u0000/tmp/New.szs\u0000blyt/A.bflyt'
    )
  })

  it('opens a recovered document already unsaved, so every guard sees it', () => {
    // A recovered document exists nowhere on disk. Opening it clean left the close
    // prompt quiet and made the tab replaceable, so the next layout opened threw it away.
    const store = useDocuments.getState()
    store.runCommand(rename(document, paneId, 'A'))
    store.markSaved('doc_1')

    const displaced = store.openTab(
      {
        documentId: 'doc_recovered',
        snapshotKey: 'file\u0000/tmp/Recovered.bflyt',
        displayName: 'Recovered.bflyt',
        source: { kind: 'file', path: '/tmp/Recovered.bflyt' },
        document: createLayoutDocument()
      },
      { newTab: true, unsaved: true }
    )

    expect(displaced).toBeNull()
    const recovered = useDocuments.getState().tabs.find((t) => t.documentId === 'doc_recovered')!
    expect(recovered.unsaved).toBe(true)
    expect(recovered.savedDepth).toBe(-1)

    // And it must not be quietly replaced by the next document opened.
    useDocuments.getState().setActive('doc_recovered')
    const replaced = useDocuments.getState().openTab({
      documentId: 'doc_next',
      snapshotKey: 'file\u0000/tmp/Next.bflyt',
      displayName: 'Next.bflyt',
      source: { kind: 'file', path: '/tmp/Next.bflyt' },
      document: createLayoutDocument()
    })
    expect(replaced).toBeNull()
    expect(useDocuments.getState().tabs).toHaveLength(3)
  })

  it('records a rename as exactly one undo entry', () => {
    /*
     * The claim the end-to-end pass could not measure: a rename is one entry, not one per keystroke.
     * Committing per character meant a twenty-character rename cost twenty presses of Cmd+Z and
     * evicted twenty real entries from the bounded stack.
     *
     * Here rather than in the self-test because the subject is the store, and the store is the only
     * thing whose undo stack is not shared with a hundred other checks.
     */
    const store = useDocuments.getState()
    const before = tab().history.undo.length

    const pane = paneById(tab().document, paneId)!
    const wasNamed = snapshotPane(pane)
    pane.name = 'Renamed'
    const nowNamed = snapshotPane(pane)
    store.runCommand(setPaneSnapshot(paneId, 'Edit Renamed', wasNamed, nowNamed))

    expect(tab().history.undo).toHaveLength(before + 1)
    expect(tab().history.undo[before]!.label).toBe('Edit Renamed')
    expect(paneById(tab().document, paneId)!.name).toBe('Renamed')

    // And undoing it is symmetrical: one press, back to the original name.
    store.undo()
    expect(tab().history.undo).toHaveLength(before)
    expect(paneById(tab().document, paneId)!.name).not.toBe('Renamed')
  })

  it('refuses to reuse a tab that holds unsaved work', () => {
    // Tab reuse is the third guard reading this flag: an unsaved tab must be kept and
    // the new document opened beside it.
    const store = useDocuments.getState()
    store.runCommand(rename(document, paneId, 'A'))

    const displaced = store.openTab({
      documentId: 'doc_2',
      snapshotKey: 'file\u0000/tmp/Other.bflyt',
      displayName: 'Other.bflyt',
      source: { kind: 'file', path: '/tmp/Other.bflyt' },
      document: createLayoutDocument()
    })

    expect(displaced).toBeNull()
    expect(useDocuments.getState().tabs).toHaveLength(2)
  })
})
