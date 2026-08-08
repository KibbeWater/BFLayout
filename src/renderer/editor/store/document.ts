import { create } from 'zustand'

import {
  findPane,
  walkPanes,
  type LayoutDocument,
  type Pane
} from '@shared/formats/bflyt'
import type { LayoutSource } from '@shared/contract'
import {
  EMPTY_UNDO,
  pushCommand,
  type Command,
  type UndoStack
} from '@renderer/editor/commands'

/**
 * The renderer owns the working document.
 *
 * Every edit — including a 60fps canvas drag — mutates this store locally, so
 * interaction never round-trips through IPC. The main process keeps the
 * original section bytes and re-encodes only what is marked dirty on save.
 */
export interface DocumentTab {
  readonly documentId: string
  displayName: string
  source: LayoutSource
  document: LayoutDocument
  selectedPaneIds: string[]
  /** Panes collapsed in the hierarchy tree. */
  collapsedIds: Set<string>
  /** True once anything has been edited since the last save. */
  unsaved: boolean
  /** Bumped on every mutation so the canvas knows to redraw. */
  revision: number
  history: UndoStack
}

interface DocumentStore {
  readonly tabs: DocumentTab[]
  readonly activeId: string | null
  /**
   * Opens a document, replacing the active tab unless `newTab` is set.
   *
   * Replacing is the default because browsing a dump means opening one layout after
   * another to look at them, and a tab per glance buries the ones you care about.
   * Returns the documentId it displaced, if any, so the caller can release it —
   * the store does no IPC of its own.
   */
  openTab: (
    tab: Omit<
      DocumentTab,
      'selectedPaneIds' | 'collapsedIds' | 'unsaved' | 'revision' | 'history'
    >,
    options?: { newTab?: boolean }
  ) => string | null
  closeTab: (documentId: string) => void
  setActive: (documentId: string) => void
  select: (paneIds: string[]) => void
  toggleCollapsed: (paneId: string) => void
  /** Applies a mutation to the active document and marks it unsaved. */
  mutate: (recipe: (tab: DocumentTab) => void) => void
  /** Runs a command and records it so it can be undone. */
  runCommand: (command: Command) => void
  undo: () => void
  redo: () => void
  /** Clears the unsaved flag on one tab, or the active one when omitted. */
  markSaved: (documentId?: string) => void
  /** Points a tab at a new file after a save-as. */
  retarget: (documentId: string, source: LayoutSource, displayName: string) => void
}

function activeTab(state: DocumentStore): DocumentTab | undefined {
  return state.tabs.find((tab) => tab.documentId === state.activeId)
}

export const useDocuments = create<DocumentStore>((set, get) => ({
  tabs: [],
  activeId: null,

  openTab: (tab, options) => {
    const state = get()
    if (state.tabs.some((t) => t.documentId === tab.documentId)) {
      set({ activeId: tab.documentId })
      return null
    }

    const fresh: DocumentTab = {
      ...tab,
      selectedPaneIds: [],
      collapsedIds: new Set<string>(),
      unsaved: false,
      revision: 0,
      history: EMPTY_UNDO
    }

    const active = state.tabs.find((t) => t.documentId === state.activeId)
    // Never silently discard edits: a tab with unsaved work is kept and the new
    // document opens beside it instead.
    const replaceable = !options?.newTab && active !== undefined && !active.unsaved

    if (replaceable) {
      set({
        tabs: state.tabs.map((t) => (t.documentId === active.documentId ? fresh : t)),
        activeId: fresh.documentId
      })
      return active.documentId
    }

    set({ tabs: [...state.tabs, fresh], activeId: fresh.documentId })
    return null
  },

  closeTab: (documentId) =>
    set((state) => {
      const tabs = state.tabs.filter((tab) => tab.documentId !== documentId)
      const activeId =
        state.activeId === documentId ? (tabs[tabs.length - 1]?.documentId ?? null) : state.activeId
      return { tabs, activeId }
    }),

  setActive: (activeId) => set({ activeId }),

  select: (paneIds) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.documentId === state.activeId ? { ...tab, selectedPaneIds: paneIds } : tab
      )
    })),

  toggleCollapsed: (paneId) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => {
        if (tab.documentId !== state.activeId) return tab
        const collapsedIds = new Set(tab.collapsedIds)
        if (collapsedIds.has(paneId)) collapsedIds.delete(paneId)
        else collapsedIds.add(paneId)
        return { ...tab, collapsedIds }
      })
    })),

  mutate: (recipe) => {
    const current = activeTab(get())
    if (!current) return
    set((state) => ({
      tabs: state.tabs.map((tab) => {
        if (tab.documentId !== state.activeId) return tab
        // The document tree is mutated in place; `revision` is what React and
        // the GL renderer actually subscribe to.
        recipe(tab)
        return { ...tab, unsaved: true, revision: tab.revision + 1 }
      })
    }))
  },

  runCommand: (command) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => {
        if (tab.documentId !== state.activeId) return tab
        command.apply(tab.document)
        return {
          ...tab,
          history: pushCommand(tab.history, command),
          unsaved: true,
          revision: tab.revision + 1
        }
      })
    })),

  undo: () =>
    set((state) => ({
      tabs: state.tabs.map((tab) => {
        if (tab.documentId !== state.activeId) return tab
        const command = tab.history.undo[tab.history.undo.length - 1]
        if (!command) return tab
        command.invert(tab.document)
        return {
          ...tab,
          history: {
            undo: tab.history.undo.slice(0, -1),
            redo: [...tab.history.redo, command]
          },
          unsaved: true,
          revision: tab.revision + 1
        }
      })
    })),

  redo: () =>
    set((state) => ({
      tabs: state.tabs.map((tab) => {
        if (tab.documentId !== state.activeId) return tab
        const command = tab.history.redo[tab.history.redo.length - 1]
        if (!command) return tab
        command.apply(tab.document)
        return {
          ...tab,
          history: {
            undo: [...tab.history.undo, command],
            redo: tab.history.redo.slice(0, -1)
          },
          unsaved: true,
          revision: tab.revision + 1
        }
      })
    })),

  markSaved: (documentId?: string) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.documentId === (documentId ?? state.activeId) ? { ...tab, unsaved: false } : tab
      )
    })),

  retarget: (documentId, source, displayName) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.documentId === documentId ? { ...tab, source, displayName } : tab
      )
    }))
}))

export function useActiveTab(): DocumentTab | undefined {
  return useDocuments((state) => state.tabs.find((tab) => tab.documentId === state.activeId))
}

/** Marks a pane and every ancestor dirty, so a save re-encodes the whole chain. */
export function markPaneDirty(document: LayoutDocument, paneId: string): void {
  const chain: Pane[] = []
  const search = (pane: Pane): boolean => {
    chain.push(pane)
    if (pane.id === paneId) return true
    for (const child of pane.children) {
      if (search(child)) return true
    }
    chain.pop()
    return false
  }
  if (document.rootPane) search(document.rootPane)
  // Only the pane itself changes bytes; ancestors keep their own sections.
  const target = chain[chain.length - 1]
  if (target) target.dirty = true
}

export function paneById(document: LayoutDocument, paneId: string): Pane | null {
  return findPane(document.rootPane, (pane) => pane.id === paneId)
}

export function countPanes(document: LayoutDocument): number {
  let count = 0
  walkPanes(document.rootPane, () => count++)
  return count
}
