import { create } from 'zustand'

/**
 * The folder being browsed, plus where we have been.
 *
 * Kept separate from the archive workspace because the two are independent: you
 * can browse a romfs while an archive from somewhere else is open, and closing one
 * should not disturb the other.
 */
/** Which panel the left sidebar is showing. */
export type SidebarTab = 'files' | 'archive' | 'textures' | 'materials'

interface FolderStore {
  /**
   * The folder the user opened. Stays put while you navigate inside it, so the
   * breadcrumbs can be relative to it rather than to the filesystem root — nobody
   * browsing a dump wants five crumbs of home directory before the interesting part.
   */
  readonly rootPath: string | null
  readonly path: string | null
  /** Directories visited, so Back can retrace rather than only going up. */
  readonly history: string[]
  /**
   * Lives here rather than in the panel because opening an archive from the file
   * browser has to move the sidebar to the Archive tab. Without that the archive
   * opens into a tab you are not looking at, and the click appears to do nothing.
   */
  readonly tab: SidebarTab
  open: (path: string) => void
  navigate: (path: string) => void
  back: () => void
  close: () => void
  setTab: (tab: SidebarTab) => void
  showArchiveTab: () => void
}

export const useFolder = create<FolderStore>((set, get) => ({
  rootPath: null,
  path: null,
  history: [],
  tab: 'archive',

  open: (path) => set({ rootPath: path, path, history: [], tab: 'files' }),

  navigate: (path) =>
    set((state) => ({
      path,
      history: state.path ? [...state.history, state.path] : state.history
    })),

  back: () => {
    const { history } = get()
    const previous = history[history.length - 1]
    if (!previous) return
    set({ path: previous, history: history.slice(0, -1) })
  },

  close: () => set({ rootPath: null, path: null, history: [] }),

  setTab: (tab) => set({ tab }),

  showArchiveTab: () => set({ tab: 'archive' })
}))
