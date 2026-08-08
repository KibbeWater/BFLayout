import { useEffect } from 'react'

import { useDocuments } from '@renderer/editor/store/document'

/**
 * Makes the window behave like a document window.
 *
 * On macOS that is a set of behaviours rather than a look, and this app already knew every fact
 * needed for them while saying none of them:
 *
 *   - The **title** names the open file, so the window is identifiable in Mission Control and in the
 *     Window menu rather than reading "BFLayout" forever.
 *   - The **proxy icon** in the title bar comes from the represented filename, which also makes the
 *     title draggable to another app and right-clickable for the enclosing folder.
 *   - The **dot in the close button** appears while there are unsaved changes. Every other Mac editor
 *     does this, and its absence is the sort of thing that registers as "not quite native" without
 *     being obvious.
 *
 * Mounted in the shell rather than the editor screen, because the window has a title on every route —
 * including the welcome screen, where the honest title is just the app name.
 */
export function useDocumentWindow(): void {
  const tabs = useDocuments((state) => state.tabs)
  const activeId = useDocuments((state) => state.activeId)

  useEffect(() => {
    const active = tabs.find((tab) => tab.documentId === activeId)
    const unsaved = tabs.some((tab) => tab.unsaved)

    /*
     * The path, not the archive entry key. A represented filename has to be something the Finder can
     * resolve, so a layout inside an archive is represented by the archive — which is the file that
     * actually exists and the one the proxy icon should reveal.
     */
    const path =
      active === undefined
        ? null
        : active.source.kind === 'file'
          ? active.source.path
          : null

    window.bflayout?.setDocumentState?.({
      title: active ? `${active.displayName}${active.unsaved ? ' — Edited' : ''}` : 'BFLayout',
      path,
      edited: unsaved
    })
  }, [tabs, activeId])
}
