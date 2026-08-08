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
  /**
   * The durable identity of the file behind this tab, for keying recovery snapshots.
   *
   * Carried on the tab rather than looked up, because a snapshot has to be discardable
   * *after* the tab closes and its main-process session is gone. Not readonly: a save-as
   * moves the file, and `retarget` has to follow it — a key still naming the old file
   * meant recovery would restore the new edits into, and then save over, the very file
   * the user had moved away from.
   */
  snapshotKey: string
  displayName: string
  source: LayoutSource
  document: LayoutDocument
  selectedPaneIds: string[]
  /** Panes collapsed in the hierarchy tree. */
  collapsedIds: Set<string>
  /** True once anything has been edited since the last save. */
  unsaved: boolean
  /**
   * Undo-stack depth as of the last save, or -1 when the save point is unreachable.
   *
   * Lets `unsaved` be exact: undoing back to how the file was opened reports it clean
   * again, where before undo and redo both set `unsaved = true` unconditionally and a
   * document could never return to a saved state without saving.
   *
   * -1 once an edit happens that undo cannot reverse, or once the bounded stack drops
   * the entry the save point referred to — after either, the depth no longer
   * identifies that state.
   */
  savedDepth: number
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
      'selectedPaneIds' | 'collapsedIds' | 'unsaved' | 'savedDepth' | 'revision' | 'history'
    >,
    /**
     * `unsaved` opens the tab already dirty, which is what a recovered document is:
     * its contents exist nowhere on disk. Without it the tab claimed to match a file
     * it had never been written to, so the close prompt stayed quiet and — worse — the
     * tab counted as replaceable, and opening the next layout silently discarded it.
     */
    options?: { newTab?: boolean; unsaved?: boolean }
  ) => string | null
  closeTab: (documentId: string) => void
  setActive: (documentId: string) => void
  select: (paneIds: string[]) => void
  toggleCollapsed: (paneId: string) => void
  /**
   * Expands whatever is hiding a pane, so a selection made elsewhere is visible in
   * the tree. Selecting on the canvas otherwise leaves it collapsed and invisible.
   */
  revealPane: (paneId: string) => void
  /** Applies a mutation to the active document and marks it unsaved. */
  mutate: (recipe: (tab: DocumentTab) => void) => void
  /** Runs a command and records it so it can be undone. */
  runCommand: (command: Command) => void
  undo: () => void
  redo: () => void
  /**
   * Clears the unsaved flag on one tab, or the active one when omitted.
   *
   * `atRevision` guards a save race: the document is serialized and shipped to main
   * asynchronously, so an edit made while that was in flight is not in the bytes on
   * disk. Clearing the flag anyway made those edits look saved, and closing the tab
   * then discarded them without asking. Pass the revision the save was built from and
   * the flag only clears if nothing has changed since.
   */
  markSaved: (documentId?: string, atRevision?: number) => void
  /** Points a tab at a new file after a save-as. */
  retarget: (
    documentId: string,
    source: LayoutSource,
    displayName: string,
    snapshotKey: string
  ) => void
  /**
   * Refreshes the durable keys from main, for when something moved the files rather than
   * the tabs — saving an archive to a new path retargets every layout inside it at once.
   */
  resyncKeys: (keys: ReadonlyMap<string, string>) => void
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

    /*
     * One tab per file. Document ids are fresh per open, so nothing else stopped the
     * same layout appearing twice — and two tabs on one file share a single recovery
     * snapshot row, so whichever flushed last won and the other's edits became
     * unrecoverable.
     *
     * A clean duplicate is simply activated, and its session released. When the incoming
     * document is a recovery it takes the clean tab's place instead, since the recovered
     * copy is the one with the edits. An existing tab holding *unsaved* work is never
     * touched: opening beside it costs a shared snapshot row, discarding it costs the
     * work itself.
     */
    const sameFile = state.tabs.find((t) => t.snapshotKey === tab.snapshotKey)
    if (sameFile && !sameFile.unsaved) {
      if (!options?.unsaved) {
        set({ activeId: sameFile.documentId })
        return tab.documentId
      }
      const recovered: DocumentTab = {
        ...tab,
        selectedPaneIds: [],
        collapsedIds: new Set<string>(),
        unsaved: true,
        savedDepth: -1,
        revision: 0,
        history: EMPTY_UNDO
      }
      set({
        tabs: state.tabs.map((t) => (t.documentId === sameFile.documentId ? recovered : t)),
        activeId: recovered.documentId
      })
      return sameFile.documentId
    }

    const unsaved = options?.unsaved ?? false
    const fresh: DocumentTab = {
      ...tab,
      selectedPaneIds: [],
      collapsedIds: new Set<string>(),
      unsaved,
      // No reachable save point for a document that has never been written.
      savedDepth: unsaved ? -1 : 0,
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

  revealPane: (paneId) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => {
        if (tab.documentId !== state.activeId) return tab
        if (tab.collapsedIds.size === 0) return tab

        // Walk down to the pane, collecting the branches that contain it.
        const ancestors: string[] = []
        const find = (pane: Pane): boolean => {
          if (pane.id === paneId) return true
          for (const child of pane.children) {
            if (find(child)) {
              ancestors.push(pane.id)
              return true
            }
          }
          return false
        }
        if (!tab.document.rootPane || !find(tab.document.rootPane)) return tab
        if (!ancestors.some((id) => tab.collapsedIds.has(id))) return tab

        const collapsedIds = new Set(tab.collapsedIds)
        for (const id of ancestors) collapsedIds.delete(id)
        return { ...tab, collapsedIds }
      })
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
        // A mutation outside the command system cannot be undone, so the save point
        // is no longer reachable.
        return { ...tab, unsaved: true, savedDepth: -1, revision: tab.revision + 1 }
      })
    }))
  },

  runCommand: (command) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => {
        if (tab.documentId !== state.activeId) return tab
        command.apply(tab.document)
        const history = pushCommand(tab.history, command)

        /*
         * The save point can stop identifying the saved state in two ways, and both
         * have to invalidate it or a diverged document reports itself clean.
         *
         * 1. The bounded stack drops its oldest entry instead of growing, so every
         *    depth now refers to a different state.
         * 2. The save point lives in the redo branch this command is about to discard.
         *    Undo past a save, then make a different edit: the new command lands at the
         *    same depth the save recorded, so `unsaved` flipped back to false while the
         *    document held the new edit and the disk held the old one. Every guard built
         *    on this — the close prompt, the tab-close confirmation, tab reuse — then
         *    treated the tab as safe to discard.
         */
        const trimmed = history.undo.length === tab.history.undo.length
        const divergedFromSavePoint = tab.savedDepth > tab.history.undo.length
        const savedDepth = trimmed || divergedFromSavePoint ? -1 : tab.savedDepth
        return {
          ...tab,
          history,
          savedDepth,
          unsaved: history.undo.length !== savedDepth,
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
        const history = {
          undo: tab.history.undo.slice(0, -1),
          redo: [...tab.history.redo, command]
        }
        return {
          ...tab,
          history,
          // Undoing back to the save point means the file matches what is on disk.
          unsaved: history.undo.length !== tab.savedDepth,
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
        const history = {
          undo: [...tab.history.undo, command],
          redo: tab.history.redo.slice(0, -1)
        }
        return {
          ...tab,
          history,
          unsaved: history.undo.length !== tab.savedDepth,
          revision: tab.revision + 1
        }
      })
    })),

  markSaved: (documentId?: string, atRevision?: number) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => {
        if (tab.documentId !== (documentId ?? state.activeId)) return tab
        /*
         * Edited since the save was built, so those changes are not on disk — but the
         * save *did* write, so the old save point no longer names what the file holds
         * either. Leaving `savedDepth` alone meant undoing back to it reported the
         * document clean while disk held the mid-flight state, and closing then
         * discarded the difference in silence.
         */
        if (atRevision !== undefined && tab.revision !== atRevision) {
          return { ...tab, savedDepth: -1 }
        }
        return { ...tab, unsaved: false, savedDepth: tab.history.undo.length }
      })
    })),

  retarget: (documentId, source, displayName, snapshotKey) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.documentId === documentId ? { ...tab, source, displayName, snapshotKey } : tab
      )
    })),

  resyncKeys: (keys) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => {
        const fresh = keys.get(tab.documentId)
        return fresh === undefined || fresh === tab.snapshotKey ? tab : { ...tab, snapshotKey: fresh }
      })
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
