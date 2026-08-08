import { useCallback, useEffect } from 'react'

import { getClient } from '@renderer/lib/orpc'
import { reportError } from '@renderer/lib/toast'
import { useDocuments } from '@renderer/editor/store/document'

/**
 * Keeps main informed about unsaved work, and asks before discarding it.
 *
 * Two separate paths can lose edits and neither used to say anything:
 *
 *   - closing a tab, which is entirely in the renderer's hands;
 *   - closing the window or quitting, which only main can intercept, and only
 *     synchronously — hence the pushed count rather than a request/response.
 *
 * The count is pushed on change rather than polled so main always has an answer
 * ready when `BrowserWindow.on('close')` fires.
 */
export function useUnsavedGuard(saveDocument: (documentId: string) => Promise<boolean>): {
  /**
   * Closes a tab, asking first when it holds unsaved edits. Resolves to whether
   * the tab was actually closed.
   */
  readonly closeTabSafely: (documentId: string) => Promise<boolean>
} {
  const closeTab = useDocuments((state) => state.closeTab)

  // Subscribing outside React's render cycle: this only needs to reach main, and
  // re-rendering on every keystroke of a document edit would be wasteful.
  useEffect(() => {
    let lastSent = -1

    const push = (count: number): void => {
      if (count === lastSent) return
      lastSent = count
      void getClient()
        .app.setUnsavedCount({ count })
        .catch((cause: unknown) => {
          // Main falls back to allowing the close. Worth logging, not worth a toast:
          // there is nothing the user can do about it and nothing is lost yet.
          console.warn('[bflayout] could not report unsaved state to the main process:', cause)
        })
    }

    const countUnsaved = (): number =>
      useDocuments.getState().tabs.filter((tab) => tab.unsaved).length

    /*
     * Dirty *archives* count too, not just dirty tabs.
     *
     * An archive holds unsaved changes of its own: a layout save writes the re-encoded entry
     * into it, and replacing an entry from a file does the same — both leave bytes that exist
     * nowhere but memory. Neither necessarily leaves a dirty tab, so counting tabs alone meant
     * quitting discarded them without a word, which is precisely the loss the archive's own
     * close refusal exists to prevent. Half a guard is worse than none, because the refusal
     * implies the other half is there.
     *
     * Polled rather than subscribed: archives live in main and nothing pushes their state, and
     * a few seconds of staleness only matters at the moment of quitting, which this keeps
     * current enough for.
     */
    let dirtyArchives = 0
    const total = (): number => countUnsaved() + dirtyArchives

    const pollArchives = (): void => {
      void getClient()
        .archive.list()
        .then((archives) => {
          const next = archives.filter((archive) => archive.dirty).length
          if (next === dirtyArchives) return
          dirtyArchives = next
          push(total())
        })
        .catch(() => {
          // An unreachable main process is not something to report from a poll.
        })
    }

    push(total())
    pollArchives()
    const timer = setInterval(pollArchives, 4000)
    const unsubscribe = useDocuments.subscribe(() => push(total()))
    return () => {
      clearInterval(timer)
      unsubscribe()
    }
  }, [])

  const closeTabSafely = useCallback(
    async (documentId: string): Promise<boolean> => {
      const tab = useDocuments.getState().tabs.find((entry) => entry.documentId === documentId)
      if (!tab) return false

      if (tab.unsaved) {
        let choice: 'save' | 'discard' | 'cancel'
        try {
          const answer = await getClient().dialog.confirmDiscard({
            name: tab.displayName,
            scope: 'tab'
          })
          choice = answer.choice
        } catch (cause) {
          // If the prompt cannot be shown, keep the tab. Closing it would be a
          // silent discard, which is the thing this guard exists to prevent.
          reportError(cause)
          return false
        }

        if (choice === 'cancel') return false
        if (choice === 'save') {
          // A failed save keeps the tab open: the error is already reported, and
          // closing anyway would discard exactly what the user asked to keep.
          if (!(await saveDocument(documentId))) return false
        }
      }

      closeTab(documentId)
      void getClient()
        .layout.close({ documentId })
        .catch((cause: unknown) =>
          console.warn('[bflayout] could not release document:', cause)
        )
      return true
    },
    [closeTab, saveDocument]
  )

  return { closeTabSafely }
}
