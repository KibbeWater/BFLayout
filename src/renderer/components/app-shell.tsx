import { useEffect, type ReactNode } from 'react'

import { useAutosave } from '@renderer/lib/use-autosave'
import { useOpenFile } from '@renderer/lib/use-open-file'
import { useSave } from '@renderer/lib/use-save'
import { useUnsavedGuard } from '@renderer/lib/use-unsaved-guard'
import { ErrorBoundary } from './error-boundary'

export function AppShell({ children }: { children: ReactNode }): ReactNode {
  useGlobalCommands()
  // Recovery snapshots follow the documents, not the route.
  useAutosave()

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {/* Scoped so a crash inside one screen does not take the whole window. */}
      <ErrorBoundary>{children}</ErrorBoundary>
    </div>
  )
}

/**
 * Menu commands that have to work on *every* route.
 *
 * They live in the shell rather than the editor screen because the shell is always
 * mounted and `EditorScreen` is not:
 *
 *   - `save-all` is what main sends when a window is closing with unsaved work. Mounted
 *     only on `/editor`, editing a layout and then going Home meant Cmd+W offered to save,
 *     nothing listened, and main waited out its fifteen-second timeout before silently
 *     refusing to close the window.
 *   - `open-file` and `open-folder` were in the same position but worse, because the one
 *     screen whose entire purpose is opening something is the welcome screen — so Cmd+O
 *     did nothing precisely where you would reach for it.
 *
 * The editor screen handles these too. Whichever is mounted answers; both being mounted
 * cannot double-open, because opening is a dialog and the second call finds the first one
 * already showing.
 */
function useGlobalCommands(): void {
  const { saveAll, saveDocument } = useSave()
  const { openViaDialog, openFolderViaDialog } = useOpenFile()
  // Mounted here so the count keeps reaching main on every route.
  useUnsavedGuard(saveDocument)

  useEffect(() => {
    const api = window.bflayout
    if (!api?.onMenuCommand) return
    return api.onMenuCommand((command) => {
      switch (command) {
        case 'save-all':
          void saveAll()
          break
        case 'open-file':
          void openViaDialog()
          break
        case 'open-folder':
          void openFolderViaDialog()
          break
        default:
          break
      }
    })
  }, [saveAll, openViaDialog, openFolderViaDialog])
}
