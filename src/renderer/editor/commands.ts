import type { LayoutDocument, Pane } from '@shared/formats/bflyt'
import { findPane, nextPaneId, walkPanes } from '@shared/formats/bflyt'

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

/**
 * Everything about a pane except its children, deep-cloned.
 *
 * `setPaneFields` only knows the ten fields the canvas drags, which left every
 * properties-panel edit — text content, font size, material index, texture SRT,
 * blend mode, vertex colours, the lot — outside undo entirely. Rather than
 * enumerate each pane kind's fields, snapshot the whole node: panes are small once
 * their children are excluded, and this cannot fall behind the model.
 *
 * The clone is deep because nested values like `textureSrt` and a window pane's
 * frames are mutated in place; a shallow copy would alias the snapshot to the live
 * object and undo would restore the edited values.
 */
export type PaneSnapshot = Record<string, unknown>

export function snapshotPane(pane: Pane): PaneSnapshot {
  const { children: _children, ...rest } = pane as Pane & { children: unknown }
  return structuredClone(rest) as PaneSnapshot
}

/**
 * Restores a whole pane, for edits that can touch any field.
 *
 * Children and identity are deliberately left alone: this command describes what a
 * property edit changed, and reparenting or deleting is someone else's job.
 */
export function setPaneSnapshot(
  paneId: string,
  label: string,
  before: PaneSnapshot,
  after: PaneSnapshot
): Command {
  const restore = (document: LayoutDocument, snapshot: PaneSnapshot): void => {
    const pane = findPane(document.rootPane, (candidate) => candidate.id === paneId)
    if (!pane) return
    const { children: _children, id: _id, ...fields } = structuredClone(snapshot) as {
      children?: unknown
      id?: unknown
    }
    Object.assign(pane, fields)
    pane.dirty = true
  }

  return {
    label,
    apply: (document) => restore(document, after),
    invert: (document) => restore(document, before)
  }
}

/**
 * Restores a material, for the same reason as `setPaneSnapshot`.
 *
 * Materials are addressed by index rather than by identity because that is how
 * panes reference them; a command that outlived a reordering would be wrong either
 * way, and reordering materials is not something the editor can do.
 */
export function setMaterialSnapshot(
  index: number,
  label: string,
  before: PaneSnapshot,
  after: PaneSnapshot
): Command {
  const restore = (document: LayoutDocument, snapshot: PaneSnapshot): void => {
    const material = document.materials[index]
    if (!material) return
    Object.assign(material, structuredClone(snapshot))
    material.dirty = true
  }

  return {
    label,
    apply: (document) => restore(document, after),
    invert: (document) => restore(document, before)
  }
}

/**
 * Copies a pane and its subtree in beside the original.
 *
 * Copying an existing pane and nudging it is the most common edit in layout work —
 * a second button, a third row — and there was no way to do it: `create.ts` only
 * makes blank panes, so the alternative was rebuilding every property by hand.
 *
 * Every copied pane gets a fresh id and a name that is not already taken, because
 * animations and groups address panes *by name*; duplicating a name would make an
 * animation drive two panes at once.
 */
export function duplicatePane(document: LayoutDocument, paneId: string): Command | null {
  const parent = findPane(document.rootPane, (candidate) =>
    candidate.children.some((child) => child.id === paneId)
  )
  if (!parent) return null

  const index = parent.children.findIndex((child) => child.id === paneId)
  const original = parent.children[index]
  if (!original) return null

  const taken = new Set<string>()
  if (document.rootPane) walkPanes(document.rootPane, (pane) => taken.add(pane.name))

  const nameFor = (base: string): string => {
    // Strip any counter the original already carries, so copies of Btn_1 become
    // Btn_2 rather than Btn_1_1.
    const stem = base.replace(/_\d+$/, '') || 'Pane'
    for (let i = 1; i < 1000; i++) {
      const candidate = `${stem}_${i}`
      if (!taken.has(candidate)) {
        taken.add(candidate)
        return candidate
      }
    }
    return `${stem}_${taken.size}`
  }

  const clone = (pane: Pane): Pane => {
    const { children, ...rest } = pane as Pane & { children: Pane[] }
    const copy = structuredClone(rest) as Pane & { children: Pane[] }
    copy.id = nextPaneId(pane.kind)
    copy.name = nameFor(pane.name)
    // A copy is new content, so it must be encoded rather than replayed from the
    // original's preserved bytes.
    copy.dirty = true
    copy.children = children.map(clone)
    return copy
  }

  const copy = clone(original)
  return addPane(parent.id, copy, index + 1)
}

/**
 * Bundles several commands into one undo entry.
 *
 * Anything that acts on a multi-pane selection needs this. Dragging twenty
 * marquee-selected panes used to push twenty separate commands, so undoing the
 * drag took twenty presses — and with a 200-entry cap, ten such drags silently
 * evicted the rest of the session's history.
 *
 * Inversion runs in reverse order, which matters when the commands are not
 * independent: deleting two siblings and then undoing must reinsert them in the
 * opposite order for the recorded indices to line up.
 *
 * The caller must build each command against the state it will actually be applied
 * to. `deletePane` records the index it found the pane at, so creating two
 * deletions from the same starting document gives the second a stale index and
 * undo restores it to the wrong slot. Create, apply, then create the next —
 * re-applying a delete is a no-op because it matches by identity, so the composite
 * is still safe to hand to `runCommand`.
 */
export function composeCommands(label: string, commands: readonly Command[]): Command {
  return {
    label,
    apply: (document) => {
      for (const command of commands) command.apply(document)
    },
    invert: (document) => {
      for (let i = commands.length - 1; i >= 0; i--) commands[i]!.invert(document)
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
      // Idempotent: callers that compose several inserts apply each as they build,
      // so `runCommand` applies the composite a second time. Splicing again would
      // put the same pane object in the tree twice.
      if (parent.children.includes(pane)) return
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
