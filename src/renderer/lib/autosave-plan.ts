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
  /** Identifies the tab itself, so a plan names *which* tab's document to serialise. */
  readonly documentId: string
  readonly snapshotKey: string
  readonly displayName: string
  readonly unsaved: boolean
  readonly revision: number
}

/** Carried between runs; mutated in place so the caller keeps no bookkeeping of its own. */
export interface AutosaveMemory {
  /**
   * What was last written per key: the document id *and* revision, or null once discarded.
   *
   * The id matters. `revision` is a per-tab edit counter starting at zero, not a clock, so
   * comparing it across tabs aliases: two tabs on one file whose counters happen to reach the
   * same number looked like "already written" and the second tab's different document was
   * skipped.
   */
  readonly written: Map<string, { documentId: string; revision: number } | null>
  /** Keys seen holding unsaved edits at any point this session. */
  readonly everDirty: Set<string>
}

export interface AutosavePlan {
  /** `documentId` says whose document to send: the key alone is ambiguous. */
  readonly put: { key: string; documentId: string; displayName: string }[]
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
  const put: { key: string; documentId: string; displayName: string }[] = []
  const remove: string[] = []
  const unkeyed: string[] = []
  const live = new Set<string>()

  /*
   * Grouped by key before deciding anything.
   *
   * A key is a *file*, and a file can have more than one tab on it — edit a layout, then
   * click it again in the archive browser and a clean duplicate opens beside the dirty one.
   * Deciding per tab then emitted a put and a remove for the same key in one plan, and
   * whichever landed last won: the dirty tab's edits ended up with no snapshot at all,
   * every single flush. The rule has to be about the file: while *any* tab on it holds
   * unsaved edits there is work to protect, and only when none do is the disk copy better.
   */
  const byKey = new Map<string, AutosaveTab[]>()
  for (const tab of tabs) {
    if (!tab.snapshotKey) {
      unkeyed.push(tab.displayName)
      continue
    }
    live.add(tab.snapshotKey)
    const group = byKey.get(tab.snapshotKey)
    if (group) group.push(tab)
    else byKey.set(tab.snapshotKey, [tab])
  }

  for (const [key, group] of byKey) {
    const dirty = pickDirty(group, memory.written.get(key) ?? null)

    if (dirty) {
      memory.everDirty.add(key)
      const last = memory.written.get(key)
      if (last && last.documentId === dirty.documentId && last.revision === dirty.revision) {
        continue
      }
      memory.written.set(key, { documentId: dirty.documentId, revision: dirty.revision })
      put.push({ key, documentId: dirty.documentId, displayName: dirty.displayName })
      continue
    }

    // No tab on this file has unsaved work: the file on disk is the better copy.
    if (memory.everDirty.has(key) && memory.written.get(key) !== null) {
      memory.written.set(key, null)
      remove.push(key)
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
 * Which of several dirty tabs on one file gets the snapshot.
 *
 * One row per file means one tab's document, and there is no timestamp to choose by —
 * `revision` counts edits, so "highest revision" means "most edits ever", not "edited most
 * recently". A tab with thirty edits from an hour ago would win over one with three fresh
 * ones, forever, and the fresh tab's work would simply never be protected.
 *
 * So the tab that was written last keeps the row while it is still dirty, and otherwise the
 * turn passes. Rotating rather than fixing on one tab means neither is starved: whichever
 * has changed since its last write is the one that gets written next.
 */
function pickDirty(
  group: readonly AutosaveTab[],
  last: { documentId: string; revision: number } | null
): AutosaveTab | undefined {
  const dirty = group.filter((tab) => tab.unsaved)
  if (dirty.length <= 1) return dirty[0]

  // Anything that has changed since it was last written goes first.
  const changed = dirty.filter(
    (tab) => !last || tab.documentId !== last.documentId || tab.revision !== last.revision
  )
  return (changed[0] ?? dirty[0])!
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
  /*
   * Per file, matching what `planAutosave` decides on. Marking per tab made a mixed
   * dirty/clean pair on one file flip its mark between the revision and -1 on every pass,
   * so this returned true forever and the debounce never settled.
   */
  /*
   * Marked per file, but from every tab's state rather than the maximum revision. Taking a
   * max meant a second dirty tab on the same file could not move the mark — so its edits
   * never scheduled a flush and were never snapshotted.
   */
  const marks = new Map<string, number>()
  for (const tab of tabs) {
    const mark = tab.unsaved ? tab.revision : -1
    const key = tab.snapshotKey
    // Summed, so any tab changing changes the mark; the value itself is meaningless.
    marks.set(key, (marks.get(key) ?? 0) + mark + 1)
  }

  let changed = marks.size !== seen.size
  for (const [key, mark] of marks) {
    if (seen.get(key) !== mark) changed = true
    seen.set(key, mark)
  }
  for (const key of [...seen.keys()]) if (!marks.has(key)) seen.delete(key)
  return changed
}
