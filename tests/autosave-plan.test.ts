import { describe, expect, it } from 'vitest'

import {
  newAutosaveMemory,
  planAutosave,
  shouldReschedule,
  type AutosaveTab
} from '@renderer/lib/autosave-plan'

/**
 * The rule behind crash-recovery snapshots, which is where every mistake in this feature
 * has been. Each test below names the failure it prevents.
 */
/**
 * Keys written with an explicit escape, and only once.
 *
 * The separator really is a NUL — it is the one byte a path cannot contain — and a literal
 * one in a source file is invisible, so two spellings of the "same" key drifted apart
 * without anything to see.
 */
const MENU = `file\u0000/tmp/Menu.bflyt`
const OTHER = `file\u0000/tmp/Other.bflyt`

const tab = (overrides: Partial<AutosaveTab> = {}): AutosaveTab => ({
  documentId: 'doc_1',
  snapshotKey: MENU,
  displayName: 'Menu.bflyt',
  unsaved: true,
  revision: 1,
  ...overrides
})

describe('autosave plan', () => {
  it('writes a snapshot for an unsaved tab', () => {
    const plan = planAutosave([tab()], newAutosaveMemory())
    expect(plan.put).toEqual([{ key: MENU, documentId: 'doc_1', displayName: 'Menu.bflyt' }])
    expect(plan.remove).toEqual([])
  })

  it('does not re-serialise a document that has not changed', () => {
    const memory = newAutosaveMemory()
    planAutosave([tab()], memory)
    expect(planAutosave([tab()], memory).put).toEqual([])
    // A further edit does get written.
    expect(planAutosave([tab({ revision: 2 })], memory).put).toHaveLength(1)
  })

  it('keeps a crash snapshot when the file is merely reopened', () => {
    /*
     * The path that made this a real bug: after a crash the welcome screen offers both
     * "Reopen" and "Recover". Clicking Reopen produces a *clean* tab, and discarding on
     * clean rather than on saved deleted the crash row four seconds later — before the
     * user had declined it, and while the Recover button was still on screen.
     */
    const memory = newAutosaveMemory()
    const plan = planAutosave([tab({ unsaved: false })], memory)
    expect(plan.remove).toEqual([])
    expect(plan.put).toEqual([])
  })

  it('discards the snapshot once an edited tab is saved', () => {
    const memory = newAutosaveMemory()
    planAutosave([tab()], memory)
    const plan = planAutosave([tab({ unsaved: false })], memory)
    expect(plan.remove).toEqual([MENU])
  })

  it('discards only once, not on every flush after a save', () => {
    const memory = newAutosaveMemory()
    planAutosave([tab()], memory)
    planAutosave([tab({ unsaved: false })], memory)
    expect(planAutosave([tab({ unsaved: false })], memory).remove).toEqual([])
  })

  it('discards a snapshot when its tab closes', () => {
    // The close guard already asked about those edits, so the row has served its purpose.
    const memory = newAutosaveMemory()
    planAutosave([tab()], memory)
    expect(planAutosave([], memory).remove).toEqual([MENU])
  })

  it('keys by file, so two different files never collide', () => {
    const memory = newAutosaveMemory()
    const plan = planAutosave(
      [tab(), tab({ snapshotKey: OTHER, displayName: 'Other.bflyt' })],
      memory
    )
    expect(plan.put.map((entry) => entry.key)).toEqual([
      MENU,
      OTHER
    ])
  })

  it('never writes and discards the same file in one plan', () => {
    /*
     * Reachable in one click: edit a layout, then click it again in the archive browser.
     * The dedupe declines to touch a tab holding unsaved work, so a clean duplicate opens
     * beside it — and deciding per tab then produced a put *and* a remove for that one
     * file, so whichever landed last won and the edits ended up with no snapshot at all.
     */
    const memory = newAutosaveMemory()
    const plan = planAutosave(
      [tab(), tab({ documentId: 'doc_2', unsaved: false, revision: 0 })],
      memory
    )
    expect(plan.put).toHaveLength(1)
    expect(plan.remove).toEqual([])
  })

  it('snapshots the tab that actually holds the edits', () => {
    // The plan names a document id because the key alone is ambiguous; matching on the
    // key serialised whichever tab came first, which could be the clean one.
    const plan = planAutosave(
      [tab({ documentId: 'clean', unsaved: false, revision: 0 }), tab({ documentId: 'dirty', revision: 7 })],
      newAutosaveMemory()
    )
    expect(plan.put).toEqual([
      { key: MENU, documentId: 'dirty', displayName: 'Menu.bflyt' }
    ])
  })

  it('discards only once every tab on the file is clean', () => {
    const memory = newAutosaveMemory()
    planAutosave([tab({ documentId: 'dirty', revision: 3 })], memory)
    // Still one dirty tab: nothing to discard yet.
    expect(
      planAutosave(
        [tab({ documentId: 'dirty', revision: 3 }), tab({ documentId: 'clean', unsaved: false })],
        memory
      ).remove
    ).toEqual([])
    // Now both clean.
    expect(
      planAutosave(
        [
          tab({ documentId: 'dirty', unsaved: false }),
          tab({ documentId: 'clean', unsaved: false })
        ],
        memory
      ).remove
    ).toEqual([MENU])
  })

  it('does not starve one of two dirty tabs on the same file', () => {
    /*
     * One row per file means one tab's document, and there is no clock to choose by:
     * `revision` counts edits, so "highest revision" is "most edits ever", not "edited most
     * recently". A tab with thirty old edits used to win over one with three fresh ones on
     * every flush, so the fresh tab's work was never protected at all.
     */
    const memory = newAutosaveMemory()
    const veteran = tab({ documentId: 'veteran', revision: 30 })
    const newcomer = tab({ documentId: 'newcomer', revision: 3 })

    const written = new Set<string>()
    for (let round = 0; round < 4; round++) {
      const plan = planAutosave([veteran, newcomer], memory)
      for (const entry of plan.put) written.add(entry.documentId)
    }

    // Both get a turn rather than one holding the row forever.
    expect(written.has('veteran')).toBe(true)
    expect(written.has('newcomer')).toBe(true)
  })

  it('does not mistake one tab for another when their edit counters coincide', () => {
    // `revision` is per tab and starts at zero, so two tabs reach the same number routinely.
    // Comparing the number alone skipped the second tab's different document as written.
    const memory = newAutosaveMemory()
    planAutosave([tab({ documentId: 'first', revision: 5 })], memory)
    const plan = planAutosave([tab({ documentId: 'second', revision: 5 })], memory)
    expect(plan.put.map((entry) => entry.documentId)).toEqual(['second'])
  })

  it('reschedules when a second dirty tab on one file changes', () => {
    // A max over revisions meant the second tab could not move the mark, so its edits never
    // scheduled a flush.
    const seen = new Map<string, number>()
    const a = tab({ documentId: 'a', revision: 10 })
    shouldReschedule([a, tab({ documentId: 'b', revision: 1 })], seen)
    expect(shouldReschedule([a, tab({ documentId: 'b', revision: 2 })], seen)).toBe(true)
  })

  it('names a tab with no key instead of sending an invalid request', () => {
    const plan = planAutosave([tab({ snapshotKey: '' })], newAutosaveMemory())
    expect(plan.unkeyed).toEqual(['Menu.bflyt'])
    expect(plan.put).toEqual([])
  })
})

describe('autosave rescheduling', () => {
  it('ignores changes a snapshot would not capture', () => {
    // Selection and collapse churn used to push the debounce out, so someone clicking
    // steadily around the canvas could go arbitrarily long with no snapshot at all.
    const seen = new Map<string, number>()
    expect(shouldReschedule([tab()], seen)).toBe(true)
    expect(shouldReschedule([tab()], seen)).toBe(false)
  })

  it('reschedules on an edit and on a save', () => {
    const seen = new Map<string, number>()
    shouldReschedule([tab()], seen)
    expect(shouldReschedule([tab({ revision: 2 })], seen)).toBe(true)
    expect(shouldReschedule([tab({ revision: 2, unsaved: false })], seen)).toBe(true)
  })

  it('settles even with two tabs on one file', () => {
    // Comparing against the tab count rather than the distinct keys made this true
    // forever, which defeated the whole point of the check.
    const seen = new Map<string, number>()
    const pair = [tab(), tab({ documentId: 'doc_2', displayName: 'Menu.bflyt (again)' })]
    expect(shouldReschedule(pair, seen)).toBe(true)
    expect(shouldReschedule(pair, seen)).toBe(false)
  })

  it('settles with a mixed dirty and clean pair on one file', () => {
    // Marking per tab made this pair flip between the revision and -1 every pass, so the
    // debounce never settled and every snapshot waited for the max-wait deadline.
    const seen = new Map<string, number>()
    const pair = [tab({ documentId: 'dirty' }), tab({ documentId: 'clean', unsaved: false })]
    expect(shouldReschedule(pair, seen)).toBe(true)
    expect(shouldReschedule(pair, seen)).toBe(false)
    expect(shouldReschedule(pair, seen)).toBe(false)
  })
})
