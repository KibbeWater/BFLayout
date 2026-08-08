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
  /**
   * The BYML document showing in the main area, or null for the canvas.
   *
   * A romfs is mostly configuration data rather than layouts, so browsing one
   * means opening BYML far more often than BFLYT. It takes over the main area
   * because these trees are wide and deep — the sidebar cannot show them usefully.
   */
  readonly bymlPath: string | null
  open: (path: string) => void
  navigate: (path: string) => void
  back: () => void
  close: () => void
  setTab: (tab: SidebarTab) => void
  openByml: (path: string) => void
  closeByml: () => void
  showArchiveTab: () => void
}

export const useFolder = create<FolderStore>((set, get) => ({
  rootPath: null,
  path: null,
  history: [],
  tab: 'archive',
  bymlPath: null,

  // A new folder invalidates any BYML shown from the old one.
  open: (path) => set({ rootPath: path, path, history: [], tab: 'files', bymlPath: null }),

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

  close: () => set({ rootPath: null, path: null, history: [], bymlPath: null }),

  setTab: (tab) => set({ tab }),

  openByml: (bymlPath) => set({ bymlPath }),
  closeByml: () => set({ bymlPath: null }),

  showArchiveTab: () => set({ tab: 'archive' })
}))
