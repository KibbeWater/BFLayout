import { useCallback, useEffect, useRef, useState } from 'react'

import type { WorkspaceSnapshot } from '@shared/contract'
import { getClient } from '@renderer/lib/orpc'
import { reportError } from '@renderer/lib/toast'
import { useDocuments } from '@renderer/editor/store/document'
import { useWorkspace } from '@renderer/editor/store/workspace'

/**
 * Remembers and restores which files were open.
 *
 * Only paths are persisted. Restoring re-reads and re-parses from disk, because
 * the file is the truth — reviving a stale in-memory copy over something edited
 * elsewhere is a way to lose work, not to save time.
 *
 * Restoring is *offered*, never automatic: an archive that has moved, been
 * repacked, or grown corrupt would otherwise turn every launch into an error
 * screen. The welcome screen shows the previous session and the user decides.
 */
export function useSessionSnapshot(): void {
  const tabs = useDocuments((state) => state.tabs)
  const activeArchiveId = useWorkspace((state) => state.activeArchiveId)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    // Debounced: opening several layouts in a row should write once.
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      void (async () => {
        try {
          const client = getClient()
          const archives = await client.archive.list()

          const snapshot: WorkspaceSnapshot = {
            archives: archives.map((archive) => archive.path),
            layouts: tabs.map((tab) => {
              const source = tab.source
              if (source.kind === 'file') return { filePath: source.path }
              return {
                archivePath: archives.find(
                  (archive) => archive.archiveId === source.archiveId
                )?.path,
                entryKey: source.entryKey
              }
            })
          }

          await client.app.workspace.set(snapshot)
        } catch (cause) {
          // Losing the session record is a minor inconvenience, not something to
          // interrupt the user for.
          console.warn('[bflayout] could not record the session:', cause)
        }
      })()
    }, 800)

    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    }
  }, [tabs, activeArchiveId])
}

export interface SessionRestore {
  readonly snapshot: WorkspaceSnapshot | null
  readonly restoring: boolean
  readonly restore: () => void
  readonly dismiss: () => void
}

/**
 * The previous session, and a way to reopen it. `onDone` runs after a successful
 * restore so the caller can navigate to the editor.
 */
export function useSessionRestore(onDone: () => void): SessionRestore {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null)
  const [restoring, setRestoring] = useState(false)
  const openTab = useDocuments((state) => state.openTab)
  const setActiveArchive = useWorkspace((state) => state.setActiveArchive)

  useEffect(() => {
    void (async () => {
      try {
        const loaded = await getClient().app.workspace.get()
        if (loaded.archives.length > 0 || loaded.layouts.length > 0) setSnapshot(loaded)
      } catch (cause) {
        console.warn('[bflayout] could not read the previous session:', cause)
      }
    })()
  }, [])

  const restore = useCallback(() => {
    if (!snapshot) return
    setRestoring(true)

    void (async () => {
      const client = getClient()
      const failures: string[] = []
      const archiveIds = new Map<string, string>()

      for (const path of snapshot.archives) {
        try {
          const opened = await client.archive.open({ path })
          archiveIds.set(path, opened.archiveId)
          setActiveArchive(opened.archiveId)
        } catch {
          failures.push(path)
        }
      }

      for (const layout of snapshot.layouts) {
        try {
          const source =
            layout.filePath !== undefined
              ? ({ kind: 'file', path: layout.filePath } as const)
              : layout.archivePath !== undefined && layout.entryKey !== undefined
                ? ({
                    kind: 'archive',
                    archiveId: archiveIds.get(layout.archivePath) ?? '',
                    entryKey: layout.entryKey
                  } as const)
                : null
          if (!source || (source.kind === 'archive' && !source.archiveId)) continue

          const opened = await client.layout.open({ source })
          // Every restored layout gets its own tab: the point of restoring is to
          // get the session back, not to end up with only its last file.
          openTab(
            {
              documentId: opened.documentId,
              displayName: opened.displayName,
              source: opened.source,
              document: opened.document
            },
            { newTab: true }
          )
        } catch {
          failures.push(layout.entryKey ?? layout.filePath ?? 'a layout')
        }
      }

      setRestoring(false)
      setSnapshot(null)

      // Partial success is the common case — a moved archive should not hide the
      // ones that did open, but the user has to be told what is missing.
      if (failures.length > 0) {
        reportError(
          new Error(
            `Could not reopen ${failures.length} item${failures.length === 1 ? '' : 's'}: ` +
              failures.join(', ')
          )
        )
      }
      onDone()
    })()
  }, [snapshot, openTab, setActiveArchive, onDone])

  return {
    snapshot,
    restoring,
    restore,
    dismiss: () => setSnapshot(null)
  }
}
