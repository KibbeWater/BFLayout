import { create } from 'zustand'

import type { LayoutSource } from '@shared/contract'

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
  /**
   * The file being previewed, or null.
   *
   * A `LayoutSource` rather than a path because the same panel serves a loose file and an archive
   * entry — clicking a font inside a `.bfarc` and clicking one on disk should land in the same
   * place, and only the source differs.
   */
  previewing: LayoutSource | null
  openPreview: (source: LayoutSource) => void
  closePreview: () => void

  /**
   * Which directories are expanded, and how many children each is showing.
   *
   * Here rather than in the tree components because the sidebar renders one tab at a time — so
   * switching to Archive and back **unmounted** the whole browser and took every expanded
   * directory, the filter and the paging with it. After walking six levels into a dump, glancing
   * at another tab meant walking back down. Navigation position survived because it already lived
   * here; the shape of the tree did not.
   *
   * Keyed by absolute path, so it is stable across remounts and across navigation.
   */
  expanded: Record<string, boolean>
  toggleExpanded: (path: string) => void
  /** Children rendered per directory, for the "show more" paging on enormous folders. */
  shownChildren: Record<string, number>
  setShownChildren: (path: string, count: number) => void
  /** The list-mode filter, which is per directory: a filter for one folder means nothing in another. */
  filters: Record<string, string>
  setFilter: (path: string, value: string) => void
  /**
   * How far each view was scrolled, keyed by view mode and path.
   *
   * The last piece of browsing state that a tab switch destroyed. Expansion and filters surviving
   * while the scroll jumped back to the top is arguably worse than losing everything, because the
   * tree is still open at the place you were — just not showing it. Keyed by mode as well as path
   * because the tree and the flat list scroll independently over the same directory.
   */
  scrollOffsets: Record<string, number>
  setScrollOffset: (key: string, offset: number) => void
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

  /*
   * Closing the folder forgets the tree as well as the location. A different dump has different
   * directories, so carrying expansion state across would be remembering paths that no longer exist.
   */
  close: () =>
    set({
      rootPath: null,
      path: null,
      history: [],
      bymlPath: null,
      previewing: null,
      expanded: {},
      shownChildren: {},
      filters: {},
      scrollOffsets: {}
    }),

  setTab: (tab) => set({ tab }),

  // Opening one closes the other: both take over the main area, and showing them at once would
  // mean deciding which wins.
  openByml: (bymlPath) => set({ bymlPath, previewing: null }),
  closeByml: () => set({ bymlPath: null }),

  previewing: null,
  openPreview: (previewing) => set({ previewing, bymlPath: null }),
  closePreview: () => set({ previewing: null }),

  expanded: {},
  toggleExpanded: (path) =>
    set((state) => ({ expanded: { ...state.expanded, [path]: !state.expanded[path] } })),

  shownChildren: {},
  setShownChildren: (path, count) =>
    set((state) => ({ shownChildren: { ...state.shownChildren, [path]: count } })),

  filters: {},
  setFilter: (path, value) => set((state) => ({ filters: { ...state.filters, [path]: value } })),

  scrollOffsets: {},
  setScrollOffset: (key, offset) =>
    set((state) => ({ scrollOffsets: { ...state.scrollOffsets, [key]: offset } })),

  showArchiveTab: () => set({ tab: 'archive' })
}))
