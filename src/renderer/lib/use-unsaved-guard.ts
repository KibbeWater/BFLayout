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

    push(countUnsaved())
    return useDocuments.subscribe(() => push(countUnsaved()))
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
