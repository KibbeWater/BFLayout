import { useEffect } from 'react'

import { getClient } from '@renderer/lib/orpc'
import { useDocuments } from '@renderer/editor/store/document'
import { newAutosaveMemory, planAutosave, shouldReschedule } from '@renderer/lib/autosave-plan'

/**
 * Writes crash-recovery snapshots of unsaved documents.
 *
 * The close and quit prompts cover a deliberate exit. This covers the process going away
 * without one — a crash, a kill, a power cut — which was the remaining way to lose work.
 *
 * What gets written and what gets discarded is decided in `autosave-plan.ts`, which is pure
 * and unit-tested; this owns only the timing and the IPC. That split exists because the
 * rule is where the mistakes were, and two of them cost real work — see that file.
 *
 * Debounced rather than periodic, because a snapshot is worth taking once editing pauses
 * and serialising a multi-megabyte document mid-drag would be pointless work. A max wait
 * caps how long a steady stream of edits can hold it off.
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
    const memory = newAutosaveMemory()
    /** Last seen revision per key, so selection churn does not look like an edit. */
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
      const plan = planAutosave(tabs, memory)

      for (const name of plan.unkeyed) {
        // A tab with no key cannot be snapshotted, and sending one anyway surfaced as
        // "Input validation failed" from the RPC layer — true, but useless for finding
        // which tab caused it.
        console.warn(`[bflayout] no snapshot key for ${name}; it will not be recoverable`)
      }

      for (const entry of plan.put) {
        // By document id, not by key: two tabs can share a key, and matching on the key
        // serialised whichever came first while the other tab's edits went unsnapshotted.
        const tab = tabs.find((candidate) => candidate.documentId === entry.documentId)
        if (!tab) continue
        void client.snapshot
          .put({ key: entry.key, displayName: entry.displayName, document: tab.document })
          .catch((cause: unknown) => {
            // Forget it was written, so the next flush tries again.
            memory.written.delete(entry.key)
            console.warn('[bflayout] could not write a recovery snapshot:', cause)
          })
      }

      for (const key of plan.remove) {
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

    shouldReschedule(useDocuments.getState().tabs, seen)
    schedule()
    const unsubscribe = useDocuments.subscribe(() => {
      if (shouldReschedule(useDocuments.getState().tabs, seen)) schedule()
    })
    return () => {
      clearTimers()
      unsubscribe()
    }
  }, [])
}
