import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { getClient, getOrpc } from '@renderer/lib/orpc'
import { reportError, reportSuccess } from '@renderer/lib/toast'
import { useActiveTab, useDocuments } from '@renderer/editor/store/document'

export interface SaveControls {
  readonly save: () => void
  readonly saveAs: () => void
  readonly saving: boolean
  readonly canSave: boolean
  /** Why save-as is unavailable, for a tooltip; null when it is available. */
  readonly saveAsBlockedReason: string | null
}

/**
 * Saving is two steps for an archive-backed layout: the document is serialized
 * into its archive entry, then the archive is packed and written to disk. They
 * are reported separately on purpose — a failure writing the archive must not
 * look like the layout saved fine, because the bytes are not on disk yet.
 *
 * Save-as means different things depending on where the layout came from. For a
 * loose `.bflyt` it writes the layout to a new file. For a layout inside an
 * archive it writes the whole *archive* to a new path, because extracting one
 * entry to a loose file would quietly detach it from the archive it belongs to.
 */
export function useSave(): SaveControls {
  const orpc = getOrpc()
  const queryClient = useQueryClient()
  const tab = useActiveTab()
  const markSaved = useDocuments((state) => state.markSaved)
  const retarget = useDocuments((state) => state.retarget)
  const [saving, setSaving] = useState(false)

  const run = (targetPath?: string): void => {
    if (!tab) return
    setSaving(true)

    void (async () => {
      const client = getClient()
      try {
        if (tab.source.kind === 'archive') {
          const result = await client.layout.save({
            documentId: tab.documentId,
            document: tab.document
          })
          const archive = await client.archive.save({
            archiveId: tab.source.archiveId,
            ...(targetPath ? { path: targetPath } : {})
          })
          reportSuccess(
            targetPath ? 'Saved a copy' : 'Saved',
            `${tab.displayName} (${result.bytes} bytes) written into ${archive.displayName}.`
          )
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: orpc.archive.get.key() }),
            noteRecent(archive.path, 'archive')
          ])
        } else {
          const result = await client.layout.save({
            documentId: tab.documentId,
            document: tab.document,
            ...(targetPath ? { path: targetPath } : {})
          })
          retarget(tab.documentId, result.source, result.displayName)
          reportSuccess(
            targetPath ? 'Saved a copy' : 'Saved',
            `${result.displayName} written (${result.bytes} bytes).`
          )
          if (result.source.kind === 'file') await noteRecent(result.source.path, 'layout')
        }

        markSaved()
      } catch (cause) {
        reportError(cause, { retry: () => run(targetPath) })
      } finally {
        setSaving(false)
      }
    })()
  }

  /**
   * Recording a recent file must never turn a successful save into a failure —
   * the bytes are already on disk by this point.
   */
  const noteRecent = async (path: string, kind: 'layout' | 'archive'): Promise<void> => {
    try {
      await getClient().app.recents.add({ path, kind })
      await queryClient.invalidateQueries({ queryKey: orpc.app.recents.list.key() })
    } catch (cause) {
      console.warn('[bflayout] could not record the saved file as recent:', cause)
    }
  }

  const saveAs = (): void => {
    if (!tab) return
    setSaving(true)

    void (async () => {
      try {
        const suggested =
          tab.source.kind === 'archive'
            ? await archiveName(tab.source.archiveId)
            : tab.displayName

        const chosen = await getClient().dialog.saveFileAs({
          purpose: tab.source.kind === 'archive' ? 'archive' : 'layout',
          ...(suggested ? { defaultName: suggested } : {})
        })

        setSaving(false)
        if (chosen.canceled || !chosen.path) return
        run(chosen.path)
      } catch (cause) {
        setSaving(false)
        reportError(cause, { retry: saveAs })
      }
    })()
  }

  const archiveName = async (archiveId: string): Promise<string | null> => {
    try {
      return (await getClient().archive.get({ archiveId })).displayName
    } catch {
      // Only used to prefill the dialog, so a failure here is not worth reporting.
      return null
    }
  }

  return {
    save: () => run(),
    saveAs,
    saving,
    canSave: tab !== undefined,
    saveAsBlockedReason: tab ? null : 'Open a layout first'
  }
}
