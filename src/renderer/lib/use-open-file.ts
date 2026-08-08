import { useCallback, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'

import { classifyEntry } from '@shared/formats/entry-kind'
import { getClient, getOrpc } from '@renderer/lib/orpc'
import { reportError, reportInfo } from '@renderer/lib/toast'
import { useDocuments } from '@renderer/editor/store/document'
import { useFolder } from '@renderer/editor/store/folder'
import { useWorkspace } from '@renderer/editor/store/workspace'

/** What the caller already knows about a path, when it knows anything. */
export type OpenHint = 'archive' | 'layout' | 'auto'

/**
 * How many layouts an open produced, so the caller can decide what to show. An
 * archive with one layout opens it; with several, the archive browser presents the
 * choice instead.
 */
export interface OpenResult {
  readonly openedLayouts: number
}

/**
 * Opens what the user picked: an archive, a loose layout, or a folder to browse.
 *
 * A path can arrive from a dialog, from the recents list, or from the folder
 * browser. The browser has already sniffed the file's magic and passes a hint,
 * because in a romfs the extension is unreliable — `.blarc.zs` is a
 * ZSTD-compressed SARC and plenty of files are named nothing recognisable at all.
 * Without a hint the extension is used, which is right for files the user picked
 * themselves.
 *
 * Every failure reports through the toast surface with a retry, and `busy` keeps
 * buttons from looking inert while a large archive decompresses.
 */
export function useOpenFile(): {
  openViaDialog: () => void
  openFolderViaDialog: () => void
  openPath: (path: string, hint?: OpenHint, newTab?: boolean) => Promise<OpenResult>
  busy: boolean
} {
  const [busy, setBusy] = useState(false)
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const setActiveArchive = useWorkspace((state) => state.setActiveArchive)
  const openFolder = useFolder((state) => state.open)
  /**
   * Opening a layout takes the main area back to the canvas.
   *
   * Without this, clicking a `.bflyt` while a BYML tree was showing opened the tab
   * but left the tree on screen — indistinguishable from the click doing nothing,
   * which is the failure mode this app works hard to avoid elsewhere.
   */
  const closeByml = useFolder((state) => state.closeByml)
  const openTab = useDocuments((state) => state.openTab)

  /**
   * Releases a document the store displaced when a tab was reused. Failing here
   * leaks a parsed document in main, which is not worth interrupting anyone over.
   */
  const release = useCallback((documentId: string | null) => {
    if (!documentId) return
    void getClient()
      .layout.close({ documentId })
      .catch((cause: unknown) => console.warn('[bflayout] could not release document:', cause))
  }, [])

  /** Recording a recent file must never turn a successful open into a failure. */
  const noteRecent = useCallback(
    async (path: string, kind: 'archive' | 'layout') => {
      try {
        await getClient().app.recents.add({ path, kind })
        await queryClient.invalidateQueries({ queryKey: getOrpc().app.recents.list.key() })
      } catch (cause) {
        console.warn('[bflayout] could not record recent file:', cause)
      }
    },
    [queryClient]
  )

  const openPath = useCallback(
    async (path: string, hint: OpenHint = 'auto', newTab = false): Promise<OpenResult> => {
      const client = getClient()
      const orpc = getOrpc()
      setBusy(true)

      try {
        let kind: string = hint === 'auto' ? classifyEntry(path) : hint

        /**
         * The extension is only a hint, and in a romfs a poor one. Before telling
         * someone a file cannot be opened, read its magic — that is what the folder
         * browser does, and a path arriving from the recents list deserves the same
         * treatment rather than being rejected on its name.
         */
        if (kind === 'other') {
          const identified = await client.folder.identify({ path })
          if (identified.opensAs === 'archive' || identified.opensAs === 'layout') {
            kind = identified.opensAs
          }
        }

        if (kind === 'layout') {
          closeByml()
          const opened = await client.layout.open({ source: { kind: 'file', path } })
          release(
            openTab(
              {
                documentId: opened.documentId,
                snapshotKey: opened.snapshotKey,
                displayName: opened.displayName,
                source: opened.source,
                document: opened.document
              },
              { newTab }
            )
          )
          await noteRecent(path, 'layout')
          await navigate({ to: '/editor' })
          return { openedLayouts: 1 }
        }

        if (kind !== 'archive') {
          const name = path.split('/').pop() ?? path
          reportInfo(
            `Cannot open ${name}`,
            kind === 'other'
              ? `${name} is not a format this editor recognises. It opens BFLYT layouts and ` +
                'the SARC archives they ship in.'
              : `${name} is a ${kind} file. This editor opens layouts and the archives they ` +
                'ship in — open the archive that contains it, or browse a folder.'
          )
          return { openedLayouts: 0 }
        }

        const archive = await client.archive.open({ path })
        setActiveArchive(archive.archiveId)
        await noteRecent(path, 'archive')
        await queryClient.invalidateQueries({ queryKey: orpc.archive.list.key() })
        await navigate({ to: '/editor' })

        /**
         * A layout archive usually holds exactly one layout, so open it.
         *
         * Without this, clicking a .blarc in a romfs opens a container and leaves
         * the canvas empty — technically correct and indistinguishable from nothing
         * happening. With several layouts there is a real choice to make, so the
         * archive browser is left to present them.
         */
        const layouts = archive.entries.filter((entry) => entry.kind === 'layout')
        if (layouts.length === 1) {
          closeByml()
          const only = layouts[0]!
          const opened = await client.layout.open({
            source: { kind: 'archive', archiveId: archive.archiveId, entryKey: only.key }
          })
          release(
            openTab(
              {
                documentId: opened.documentId,
                snapshotKey: opened.snapshotKey,
                displayName: opened.displayName,
                source: opened.source,
                document: opened.document
              },
              { newTab }
            )
          )
        }
        return { openedLayouts: layouts.length }
      } catch (cause) {
        reportError(cause, { retry: () => void openPath(path, hint, newTab) })
        return { openedLayouts: 0 }
      } finally {
        setBusy(false)
      }
    },
    [closeByml, navigate, noteRecent, openTab, queryClient, release, setActiveArchive]
  )

  const openViaDialog = useCallback(() => {
    const client = getClient()
    setBusy(true)
    void (async () => {
      try {
        const result = await client.dialog.openFiles({ purpose: 'any' })
        if (result.canceled || result.paths.length === 0) return
        await openPath(result.paths[0]!)
      } catch (cause) {
        reportError(cause, { retry: openViaDialog })
      } finally {
        setBusy(false)
      }
    })()
  }, [openPath])

  const openFolderViaDialog = useCallback(() => {
    const client = getClient()
    setBusy(true)
    void (async () => {
      try {
        const result = await client.dialog.openFolder()
        if (result.canceled || !result.path) return
        openFolder(result.path)
        await navigate({ to: '/editor' })
      } catch (cause) {
        reportError(cause, { retry: openFolderViaDialog })
      } finally {
        setBusy(false)
      }
    })()
  }, [navigate, openFolder])

  return { openViaDialog, openFolderViaDialog, openPath, busy }
}
