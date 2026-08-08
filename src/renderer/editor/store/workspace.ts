import { create } from 'zustand'

interface WorkspaceStore {
  /** Archive currently browsed. Archive contents themselves live in query cache. */
  readonly activeArchiveId: string | null
  readonly selectedEntryKey: string | null
  setActiveArchive: (archiveId: string | null) => void
  selectEntry: (key: string | null) => void
}

export const useWorkspace = create<WorkspaceStore>((set) => ({
  activeArchiveId: null,
  selectedEntryKey: null,
  setActiveArchive: (activeArchiveId) => set({ activeArchiveId, selectedEntryKey: null }),
  selectEntry: (selectedEntryKey) => set({ selectedEntryKey })
}))
