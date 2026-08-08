import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { getClient, getOrpc } from '@renderer/lib/orpc'
import { reportError, reportSuccess } from '@renderer/lib/toast'
import { useActiveTab, useDocuments, type DocumentTab } from '@renderer/editor/store/document'

export interface SaveControls {
  readonly save: () => void
  readonly saveAs: () => void
  /**
   * Saves every tab holding unsaved edits, resolving to whether all of them
   * succeeded. Used by the close-the-window prompt, which has to know: a partial
   * save must not be reported as done, or closing would still lose work.
   */
  readonly saveAll: () => Promise<boolean>
  /**
   * Saves one tab by id, resolving to whether it succeeded. Lets the close-a-tab
   * prompt honour "Save" without having to make that tab active first.
   */
  readonly saveDocument: (documentId: string) => Promise<boolean>
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
  const applyKeys = useDocuments((state) => state.resyncKeys)

  /** Pulls every open document's current durable key back from main. */
  const resyncKeys = async (): Promise<void> => {
    try {
      const summaries = await getClient().layout.list()
      applyKeys(new Map(summaries.map((entry) => [entry.documentId, entry.snapshotKey])))
    } catch (cause) {
      // A stale key costs recoverability, not the save that just succeeded, so this
      // reports to the console rather than turning a successful save into an error.
      console.warn('[bflayout] could not refresh recovery keys after saving:', cause)
    }
  }
  const [saving, setSaving] = useState(false)

  /**
   * Saves one specific tab, rather than whichever is active.
   *
   * Taking the tab as an argument is what makes `saveAll` possible: the prompt
   * shown when a window closes has to save several documents, and switching the
   * active tab between saves just to reuse a closure over it would flicker the
   * whole editor and race with the close.
   */
  const saveTab = async (target: DocumentTab, targetPath?: string): Promise<boolean> => {
    const client = getClient()
    /*
     * The revision the bytes were built from.
     *
     * Serializing and writing is asynchronous, so an edit made in the meantime is not
     * in the file. `markSaved` refuses to clear the flag if the revision moved, which
     * leaves the tab correctly marked unsaved rather than silently losing the edit
     * when it is later closed.
     */
    const builtFrom = target.revision

    try {
      if (target.source.kind === 'archive') {
        const result = await client.layout.save({
          documentId: target.documentId,
          document: target.document
        })
        const archive = await client.archive.save({
          archiveId: target.source.archiveId,
          ...(targetPath ? { path: targetPath } : {})
        })
        reportSuccess(
          targetPath ? 'Saved a copy' : 'Saved',
          `${target.displayName} (${result.bytes} bytes) written into ${archive.displayName}.`
        )
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.archive.get.key() }),
          noteRecent(archive.path, 'archive'),
          /*
           * Saving the archive to a new path moves every layout inside it at once, so
           * every open tab from that archive has a snapshot key naming the old file.
           * Main is the authority on the current identity, so the keys come from there
           * rather than being recomputed here from a path the renderer would have to
           * guess at.
           */
          resyncKeys()
        ])
      } else {
        const result = await client.layout.save({
          documentId: target.documentId,
          document: target.document,
          ...(targetPath ? { path: targetPath } : {})
        })
        retarget(target.documentId, result.source, result.displayName, result.snapshotKey)
        reportSuccess(
          targetPath ? 'Saved a copy' : 'Saved',
          `${result.displayName} written (${result.bytes} bytes).`
        )
        if (result.source.kind === 'file') await noteRecent(result.source.path, 'layout')
      }

      markSaved(target.documentId, builtFrom)
      return true
    } catch (cause) {
      reportError(cause, { retry: () => void saveTab(target, targetPath) })
      return false
    }
  }

  /** Saves the active tab, keeping the busy flag for the toolbar. */
  const run = (targetPath?: string): void => {
    if (!tab) return
    setSaving(true)
    void saveTab(tab, targetPath).finally(() => setSaving(false))
  }

  const saveAll = async (): Promise<boolean> => {
    const unsavedTabs = useDocuments.getState().tabs.filter((candidate) => candidate.unsaved)
    if (unsavedTabs.length === 0) return true

    setSaving(true)
    try {
      // Sequential on purpose: saving into an archive rewrites the whole archive,
      // and two tabs can share one, so concurrent writes would race on the file.
      let allSucceeded = true
      for (const candidate of unsavedTabs) {
        if (!(await saveTab(candidate))) allSucceeded = false
      }
      return allSucceeded
    } finally {
      setSaving(false)
    }
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

  const saveDocument = async (documentId: string): Promise<boolean> => {
    const target = useDocuments.getState().tabs.find((entry) => entry.documentId === documentId)
    if (!target) return false
    setSaving(true)
    try {
      return await saveTab(target)
    } finally {
      setSaving(false)
    }
  }

  return {
    save: () => run(),
    saveAs,
    saveAll,
    saveDocument,
    saving,
    canSave: tab !== undefined,
    saveAsBlockedReason: tab ? null : 'Open a layout first'
  }
}
