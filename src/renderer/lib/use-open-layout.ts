import { useCallback, useState } from 'react'

import type { LayoutSource } from '@shared/contract'
import type { LayoutDocument } from '@shared/formats/bflyt'
import { getClient } from '@renderer/lib/orpc'
import { reportError } from '@renderer/lib/toast'
import { useDocuments } from '@renderer/editor/store/document'
import { useFolder } from '@renderer/editor/store/folder'

/**
 * Opens a layout into a document tab. The main process parses it and hands over
 * the whole document once; from then on the renderer owns the model.
 */
export function useOpenLayout(): {
  openLayout: (source: LayoutSource, newTab?: boolean) => void
  pending: string | null
} {
  const [pending, setPending] = useState<string | null>(null)
  const openTab = useDocuments((state) => state.openTab)
  // A layout takes the main area back to the canvas; see useOpenFile.
  const closeByml = useFolder((state) => state.closeByml)

  const openLayout = useCallback(
    (source: LayoutSource, newTab = false) => {
      const key = source.kind === 'file' ? source.path : source.entryKey
      setPending(key)

      void (async () => {
        try {
          const result = await getClient().layout.open({ source })
          closeByml()
          const displaced = openTab({
            documentId: result.documentId,
            snapshotKey: result.snapshotKey,
            displayName: result.displayName,
            source: result.source,
            // The contract passes the document through by type, so this cast
            // restores the codec's own type rather than inventing one.
            document: result.document as unknown as LayoutDocument
          }, { newTab })

          // The store reuses the active tab by default; release what it displaced.
          if (displaced) {
            void getClient()
              .layout.close({ documentId: displaced })
              .catch((detail: unknown) =>
                console.warn('[bflayout] could not release document:', detail)
              )
          }
        } catch (cause) {
          reportError(cause, { retry: () => openLayout(source, newTab) })
        } finally {
          setPending(null)
        }
      })()
    },
    [closeByml, openTab]
  )

  return { openLayout, pending }
}
