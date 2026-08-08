import { useEffect, type ReactNode } from 'react'

import { useAutosave } from '@renderer/lib/use-autosave'
import { useSave } from '@renderer/lib/use-save'
import { useUnsavedGuard } from '@renderer/lib/use-unsaved-guard'
import { ErrorBoundary } from './error-boundary'

export function AppShell({ children }: { children: ReactNode }): ReactNode {
  useSaveAllCommand()
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
 * Handles the `save-all` command main sends when a window is closing with unsaved
 * work, and keeps main's unsaved count current.
 *
 * Both live in the shell rather than the editor screen because tabs survive
 * navigation but `EditorScreen` does not. With the handler mounted only on
 * `/editor`, editing a layout and then going Home meant Cmd+W offered to save,
 * nothing listened, and main waited out its fifteen-second timeout before silently
 * refusing to close the window.
 */
function useSaveAllCommand(): void {
  const { saveAll, saveDocument } = useSave()
  // Mounted here so the count keeps reaching main on every route.
  useUnsavedGuard(saveDocument)

  useEffect(() => {
    const api = window.bflayout
    if (!api?.onMenuCommand) return
    return api.onMenuCommand((command) => {
      if (command === 'save-all') void saveAll()
    })
  }, [saveAll])
}
