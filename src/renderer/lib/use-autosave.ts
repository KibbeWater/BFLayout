import { useEffect } from 'react'

import { getClient } from '@renderer/lib/orpc'
import { useDocuments } from '@renderer/editor/store/document'

/**
 * Writes crash-recovery snapshots of unsaved documents.
 *
 * The close and quit prompts cover a deliberate exit. This covers the process going away
 * without one — a crash, a kill, a power cut — which was the remaining way to lose work.
 *
 * Debounced rather than periodic: a snapshot is worth taking once editing pauses, and
 * writing mid-drag would serialise a multi-megabyte document sixty times a second. The
 * drag path does not touch the store anyway, so the timer only sees committed commands.
 *
 * Failures are swallowed to a console warning on purpose. A snapshot is a safety net; if
 * it cannot be written there is nothing the user can do about it and nothing is lost yet,
 * so interrupting them with a toast would be worse than the problem.
 */
const DEBOUNCE_MS = 4000

export function useAutosave(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    /** Revisions already written, so an unchanged tab is not re-serialised. */
    const written = new Map<string, number>()

    const flush = (): void => {
      const client = getClient()
      const { tabs } = useDocuments.getState()
      const live = new Set(tabs.map((tab) => tab.documentId))

      for (const tab of tabs) {
        if (!tab.unsaved) {
          // Saved, so the file on disk is the better copy; drop any stale snapshot.
          if (written.has(tab.documentId)) {
            written.delete(tab.documentId)
            void client.snapshot
              .remove({ documentId: tab.documentId })
              .catch((cause: unknown) =>
                console.warn('[bflayout] could not discard a recovery snapshot:', cause)
              )
          }
          continue
        }

        if (written.get(tab.documentId) === tab.revision) continue
        written.set(tab.documentId, tab.revision)
        void client.snapshot
          .put({
            documentId: tab.documentId,
            displayName: tab.displayName,
            source: tab.source,
            document: tab.document
          })
          .catch((cause: unknown) => {
            written.delete(tab.documentId)
            console.warn('[bflayout] could not write a recovery snapshot:', cause)
          })
      }

      // A closed tab's snapshot goes with it: the guard already asked about its edits.
      for (const documentId of [...written.keys()]) {
        if (live.has(documentId)) continue
        written.delete(documentId)
        void client.snapshot
          .remove({ documentId })
          .catch((cause: unknown) =>
            console.warn('[bflayout] could not discard a recovery snapshot:', cause)
          )
      }
    }

    const schedule = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(flush, DEBOUNCE_MS)
    }

    schedule()
    const unsubscribe = useDocuments.subscribe(schedule)
    return () => {
      if (timer) clearTimeout(timer)
      unsubscribe()
    }
  }, [])
}
