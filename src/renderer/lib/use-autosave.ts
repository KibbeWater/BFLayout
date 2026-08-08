import { useEffect } from 'react'

import { getClient } from '@renderer/lib/orpc'
import { useDocuments } from '@renderer/editor/store/document'

/**
 * Writes crash-recovery snapshots of unsaved documents.
 *
 * The close and quit prompts cover a deliberate exit. This covers the process going away
 * without one — a crash, a kill, a power cut — which was the remaining way to lose work.
 *
 * Snapshots are keyed by the file's durable identity (`tab.snapshotKey`), not by document
 * id: ids are minted per open and restart every launch, so a snapshot keyed by one could
 * be overwritten by an unrelated file on the next run, and a save could never find the
 * row it was meant to clear.
 *
 * Debounced rather than periodic, because a snapshot is worth taking once editing pauses
 * and serialising a multi-megabyte document mid-drag would be pointless work. Two things
 * keep the debounce honest:
 *
 *   - Only a change in `revision` reschedules. The store also fires for selection and
 *     tab switches, and letting those push the timer out meant someone clicking steadily
 *     around the canvas could go arbitrarily long with no snapshot at all.
 *   - A max wait caps how long edits can hold it off, so a steady stream of small
 *     changes still gets written.
 *
 * Failures are swallowed to a console warning on purpose. A snapshot is a safety net; if
 * it cannot be written there is nothing the user can do about it and nothing is lost yet,
 * so interrupting them with a toast would be worse than the problem.
 */
const DEBOUNCE_MS = 4000
const MAX_WAIT_MS = 20_000

export function useAutosave(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    /** Revisions already written, keyed by snapshot key, so an unchanged tab is not re-serialised. */
    const written = new Map<string, number>()
    /** Last seen revision per tab, so selection churn does not look like an edit. */
    const seen = new Map<string, number>()

    const clearTimers = (): void => {
      if (timer) clearTimeout(timer)
      if (deadline) clearTimeout(deadline)
      timer = undefined
      deadline = undefined
    }

    const flush = (): void => {
      clearTimers()
      const client = getClient()
      const { tabs } = useDocuments.getState()
      const live = new Set(tabs.map((tab) => tab.snapshotKey))

      for (const tab of tabs) {
        /*
         * A tab with no key cannot be snapshotted, and sending one anyway surfaced as
         * "Input validation failed" from the RPC layer several seconds later — true, but
         * useless for finding the tab that caused it. Say what is actually wrong.
         */
        if (!tab.snapshotKey) {
          console.warn(
            `[bflayout] no snapshot key for ${tab.displayName}; it will not be recoverable`
          )
          continue
        }

        if (!tab.unsaved) {
          // Saved, so the file on disk is the better copy; drop any stale snapshot.
          // Unconditionally, not only when this session wrote it: the row may well
          // come from a previous run that crashed with this same file open.
          if (written.get(tab.snapshotKey) !== -1) {
            written.set(tab.snapshotKey, -1)
            void client.snapshot
              .remove({ key: tab.snapshotKey })
              .catch((cause: unknown) =>
                console.warn('[bflayout] could not discard a recovery snapshot:', cause)
              )
          }
          continue
        }

        if (written.get(tab.snapshotKey) === tab.revision) continue
        written.set(tab.snapshotKey, tab.revision)
        void client.snapshot
          .put({
            key: tab.snapshotKey,
            displayName: tab.displayName,
            document: tab.document
          })
          .catch((cause: unknown) => {
            written.delete(tab.snapshotKey)
            console.warn('[bflayout] could not write a recovery snapshot:', cause)
          })
      }

      // A closed tab's snapshot goes with it: the guard already asked about its edits.
      for (const key of [...written.keys()]) {
        if (live.has(key)) continue
        written.delete(key)
        void client.snapshot
          .remove({ key })
          .catch((cause: unknown) =>
            console.warn('[bflayout] could not discard a recovery snapshot:', cause)
          )
      }
    }

    const schedule = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(flush, DEBOUNCE_MS)
      // Started once and left to run: a burst of edits keeps resetting the debounce,
      // and this is what guarantees the burst still gets a snapshot.
      deadline ??= setTimeout(flush, MAX_WAIT_MS)
    }

    /**
     * True when something changed that a snapshot would capture — an edit, a tab
     * appearing or going away, or a save landing. Selection and collapse state are
     * deliberately not in that list.
     */
    const worthSnapshotting = (): boolean => {
      const { tabs } = useDocuments.getState()
      let changed = tabs.length !== seen.size
      for (const tab of tabs) {
        const mark = tab.unsaved ? tab.revision : -1
        if (seen.get(tab.snapshotKey) !== mark) changed = true
        seen.set(tab.snapshotKey, mark)
      }
      const keys = new Set(tabs.map((tab) => tab.snapshotKey))
      for (const key of [...seen.keys()]) if (!keys.has(key)) seen.delete(key)
      return changed
    }

    worthSnapshotting()
    schedule()
    const unsubscribe = useDocuments.subscribe(() => {
      if (worthSnapshotting()) schedule()
    })
    return () => {
      clearTimers()
      unsubscribe()
    }
  }, [])
}
