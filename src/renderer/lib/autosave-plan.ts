/**
 * Decides which recovery snapshots to write and which to discard.
 *
 * Split out from the hook that performs it because the *rule* is where the mistakes live,
 * not the plumbing. Two of them cost real work:
 *
 *   - keying by document id, which restarts every launch, so one file's crash snapshot
 *     could be claimed and overwritten by an unrelated file on the next run;
 *   - discarding a row as soon as any *clean* tab for that file existed, which meant that
 *     after a crash — when the welcome screen offers both "Reopen" and "Recover" —
 *     clicking Reopen destroyed the recovery before the user had declined it.
 *
 * The rule that survives both: a row is written while a tab holds unsaved edits, and
 * discarded only when a key *this session has seen dirty* goes clean again. That is what a
 * save looks like from here. Merely opening a file resolves nothing, so its snapshot stays
 * on offer.
 */

export interface AutosaveTab {
  readonly snapshotKey: string
  readonly displayName: string
  readonly unsaved: boolean
  readonly revision: number
}

/** Carried between runs; mutated in place so the caller keeps no bookkeeping of its own. */
export interface AutosaveMemory {
  /** Revision last written per key, or -1 once discarded, so nothing is re-serialised. */
  readonly written: Map<string, number>
  /** Keys seen holding unsaved edits at any point this session. */
  readonly everDirty: Set<string>
}

export interface AutosavePlan {
  readonly put: { key: string; displayName: string }[]
  readonly remove: string[]
  /** Tabs with no durable key, which cannot be snapshotted; named so it can be reported. */
  readonly unkeyed: string[]
}

export function newAutosaveMemory(): AutosaveMemory {
  return { written: new Map(), everDirty: new Set() }
}

export function planAutosave(
  tabs: readonly AutosaveTab[],
  memory: AutosaveMemory
): AutosavePlan {
  const put: { key: string; displayName: string }[] = []
  const remove: string[] = []
  const unkeyed: string[] = []
  const live = new Set<string>()

  for (const tab of tabs) {
    if (!tab.snapshotKey) {
      unkeyed.push(tab.displayName)
      continue
    }
    live.add(tab.snapshotKey)

    if (tab.unsaved) {
      memory.everDirty.add(tab.snapshotKey)
      if (memory.written.get(tab.snapshotKey) === tab.revision) continue
      memory.written.set(tab.snapshotKey, tab.revision)
      put.push({ key: tab.snapshotKey, displayName: tab.displayName })
      continue
    }

    // Clean now, dirty earlier: the file on disk is the better copy.
    if (memory.everDirty.has(tab.snapshotKey) && memory.written.get(tab.snapshotKey) !== -1) {
      memory.written.set(tab.snapshotKey, -1)
      remove.push(tab.snapshotKey)
    }
  }

  // A closed tab's snapshot goes with it: the close guard already asked about its edits.
  for (const key of [...memory.written.keys()]) {
    if (live.has(key)) continue
    memory.written.delete(key)
    remove.push(key)
  }

  return { put, remove, unkeyed }
}

/**
 * Whether anything changed that a snapshot would capture.
 *
 * Selection and collapse state are deliberately excluded. The store fires for those too,
 * and letting them reset the debounce meant someone clicking steadily around the canvas
 * could go arbitrarily long with no snapshot at all.
 */
export function shouldReschedule(
  tabs: readonly AutosaveTab[],
  seen: Map<string, number>
): boolean {
  // Against the distinct keys, not the tab count: two tabs on one file would otherwise
  // make this true forever.
  const keys = new Set(tabs.map((tab) => tab.snapshotKey))
  let changed = keys.size !== seen.size
  for (const tab of tabs) {
    const mark = tab.unsaved ? tab.revision : -1
    if (seen.get(tab.snapshotKey) !== mark) changed = true
    seen.set(tab.snapshotKey, mark)
  }
  for (const key of [...seen.keys()]) if (!keys.has(key)) seen.delete(key)
  return changed
}
