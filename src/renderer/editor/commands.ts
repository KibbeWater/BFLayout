import type { LayoutDocument, Pane } from '@shared/formats/bflyt'
import { findPane } from '@shared/formats/bflyt'

/**
 * Undo is a command stack of before/after snapshots of the specific fields a
 * command touched, not whole-document copies: layouts can hold thousands of
 * nodes and an editor must not allocate one per keystroke.
 *
 * Commands never clear a pane's `dirty` flag on undo. Dirty only decides whether
 * the writer re-encodes a section or replays its original bytes, so leaving it
 * set costs at most byte-exactness for that one section — while clearing it
 * could emit stale bytes that no longer match the model.
 */
export interface Command {
  readonly label: string
  apply: (document: LayoutDocument) => void
  invert: (document: LayoutDocument) => void
}

type PaneFields = Partial<
  Pick<
    Pane,
    | 'name'
    | 'alpha'
    | 'visible'
    | 'influenceAlpha'
    | 'width'
    | 'height'
    | 'paneMagFlags'
    | 'userDataInfo'
  >
> & {
  translate?: [number, number, number]
  rotate?: [number, number, number]
  scale?: [number, number]
  origin?: { x: number; y: number; parentX: number; parentY: number }
}

function assign(pane: Pane, fields: PaneFields): void {
  if (fields.name !== undefined) pane.name = fields.name
  if (fields.alpha !== undefined) pane.alpha = fields.alpha
  if (fields.visible !== undefined) pane.visible = fields.visible
  if (fields.influenceAlpha !== undefined) pane.influenceAlpha = fields.influenceAlpha
  if (fields.width !== undefined) pane.width = fields.width
  if (fields.height !== undefined) pane.height = fields.height
  if (fields.paneMagFlags !== undefined) pane.paneMagFlags = fields.paneMagFlags
  if (fields.userDataInfo !== undefined) pane.userDataInfo = fields.userDataInfo
  if (fields.translate) pane.translate = [...fields.translate]
  if (fields.rotate) pane.rotate = [...fields.rotate]
  if (fields.scale) pane.scale = [...fields.scale]
  if (fields.origin) pane.origin = { ...fields.origin }
}

/** Captures the current value of exactly the fields a command intends to set. */
export function capturePaneFields(pane: Pane, keys: readonly (keyof PaneFields)[]): PaneFields {
  const out: PaneFields = {}
  for (const key of keys) {
    switch (key) {
      case 'translate':
        out.translate = [...pane.translate]
        break
      case 'rotate':
        out.rotate = [...pane.rotate]
        break
      case 'scale':
        out.scale = [...pane.scale]
        break
      case 'origin':
        out.origin = { ...pane.origin }
        break
      default:
        // Remaining keys are scalars shared with Pane.
        Object.assign(out, { [key]: pane[key as keyof Pane] })
        break
    }
  }
  return out
}

export function setPaneFields(
  paneId: string,
  label: string,
  before: PaneFields,
  after: PaneFields
): Command {
  const target = (document: LayoutDocument): Pane | null =>
    findPane(document.rootPane, (pane) => pane.id === paneId)

  return {
    label,
    apply: (document) => {
      const pane = target(document)
      if (!pane) return
      assign(pane, after)
      pane.dirty = true
    },
    invert: (document) => {
      const pane = target(document)
      if (!pane) return
      assign(pane, before)
      pane.dirty = true
    }
  }
}

export interface UndoStack {
  readonly undo: Command[]
  readonly redo: Command[]
}

export const EMPTY_UNDO: UndoStack = { undo: [], redo: [] }

/** Bounded so a long session cannot grow the stack without limit. */
const MAX_DEPTH = 200

export function pushCommand(stack: UndoStack, command: Command): UndoStack {
  const undo = [...stack.undo, command]
  return {
    undo: undo.length > MAX_DEPTH ? undo.slice(undo.length - MAX_DEPTH) : undo,
    // Any new edit invalidates the redo branch.
    redo: []
  }
}

/**
 * Inserts a pane under a parent.
 *
 * The pane object itself is captured by the command, so undo/redo reinserts the
 * same instance rather than a copy — anything holding a reference to it (a
 * selection, a text raster keyed by id) stays valid across an undo.
 */
export function addPane(parentId: string, pane: Pane, at?: number): Command {
  return {
    label: `Add ${pane.kind} ${pane.name || 'pane'}`,
    apply: (document) => {
      const parent = findPane(document.rootPane, (candidate) => candidate.id === parentId)
      if (!parent) return
      const index = at ?? parent.children.length
      parent.children.splice(Math.max(0, Math.min(index, parent.children.length)), 0, pane)
      // The parent's own section is unchanged; the new pane brings its own.
      pane.dirty = true
    },
    invert: (document) => {
      const parent = findPane(document.rootPane, (candidate) => candidate.id === parentId)
      if (!parent) return
      const index = parent.children.indexOf(pane)
      if (index >= 0) parent.children.splice(index, 1)
    }
  }
}

/**
 * Removes a pane and everything under it.
 *
 * The subtree is kept alive by the command, which is what makes delete undoable
 * without serialising it: the removed pane is still a live object graph and gets
 * spliced back at the same index.
 */
export function deletePane(document: LayoutDocument, paneId: string): Command | null {
  const parent = findPane(document.rootPane, (candidate) =>
    candidate.children.some((child) => child.id === paneId)
  )
  if (!parent) return null

  const index = parent.children.findIndex((child) => child.id === paneId)
  const pane = parent.children[index]
  if (!pane) return null

  const parentId = parent.id
  return {
    label: `Delete ${pane.kind} ${pane.name || 'pane'}`,
    apply: (target) => {
      const holder = findPane(target.rootPane, (candidate) => candidate.id === parentId)
      if (!holder) return
      const at = holder.children.indexOf(pane)
      if (at >= 0) holder.children.splice(at, 1)
    },
    invert: (target) => {
      const holder = findPane(target.rootPane, (candidate) => candidate.id === parentId)
      if (!holder) return
      holder.children.splice(Math.min(index, holder.children.length), 0, pane)
    }
  }
}
