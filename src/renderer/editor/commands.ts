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
 * The fixed width of a pane's name field, which the writer truncates to.
 * See `writeBase` in shared/formats/bflyt/panes.ts.
 */
const PANE_NAME_BYTES = 0x18

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
      const suffix = `_${i}`
      /*
       * Trimmed to fit the field the writer will store it in.
       *
       * Pane names are a fixed 24 bytes and `fixedString` truncates silently, so a
       * name that is unique in memory but not in its first 24 characters becomes a
       * duplicate on disk — two panes one animation would drive at once, which is
       * the exact hazard this function exists to avoid. Uniqueness therefore has to
       * be checked on the truncated name.
       */
      const candidate = stem.slice(0, PANE_NAME_BYTES - suffix.length) + suffix
      if (!taken.has(candidate)) {
        taken.add(candidate)
        return candidate
      }
    }
    return `${stem.slice(0, PANE_NAME_BYTES - 8)}_${taken.size}`
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

/** Where a pane sits: its parent and its index among that parent's children. */
export interface PanePlacement {
  readonly parentId: string
  readonly index: number
}

/** Where `paneId` currently sits, or null if it is the root or missing. */
export function placementOf(document: LayoutDocument, paneId: string): PanePlacement | null {
  const parent = findPane(document.rootPane, (candidate) =>
    candidate.children.some((child) => child.id === paneId)
  )
  if (!parent) return null
  return { parentId: parent.id, index: parent.children.findIndex((child) => child.id === paneId) }
}

/** True when `ancestorId` is `paneId` or contains it, at any depth. */
export function contains(document: LayoutDocument, ancestorId: string, paneId: string): boolean {
  const ancestor = findPane(document.rootPane, (candidate) => candidate.id === ancestorId)
  if (!ancestor) return false
  if (ancestorId === paneId) return true
  return findPane(ancestor, (candidate) => candidate.id === paneId) !== null
}

/**
 * Moves a pane to a new parent and index.
 *
 * This is how z-order is changed at all: draw order *is* tree order, so a pane can
 * only be brought forward by moving it later among its siblings. Before this the
 * only way to reorder was to delete and recreate, which lost every property the
 * pane had.
 *
 * Returns null when the move is impossible rather than corrupting the tree: the root
 * has no parent to move within, and moving a pane inside its own subtree would
 * detach that subtree from the document entirely.
 */
export function movePane(
  document: LayoutDocument,
  paneId: string,
  to: PanePlacement
): Command | null {
  const from = placementOf(document, paneId)
  if (!from) return null
  if (contains(document, paneId, to.parentId)) return null

  if (!findPane(document.rootPane, (candidate) => candidate.id === paneId)) return null

  /**
   * Resolves against the document it is handed, not the one captured above, so the
   * command behaves like every other one here and does not hold a stale tree.
   */
  const place = (
    target: LayoutDocument,
    to: PanePlacement,
    fromPlacement: PanePlacement
  ): void => {
    const pane = findPane(target.rootPane, (candidate) => candidate.id === paneId)
    const oldParent = findPane(
      target.rootPane,
      (candidate) => candidate.id === fromPlacement.parentId
    )
    const newParent = findPane(target.rootPane, (candidate) => candidate.id === to.parentId)
    if (!pane || !oldParent || !newParent) return

    const at = oldParent.children.indexOf(pane)
    if (at >= 0) oldParent.children.splice(at, 1)

    const index = Math.max(0, Math.min(to.index, newParent.children.length))
    newParent.children.splice(index, 0, pane)

    /*
     * Both parents are dirtied as well as the pane. A pane's own section carries its
     * properties, but its *position in the stream* is what encodes the tree, so the
     * parents have to be re-emitted rather than replayed from their original bytes.
     */
    pane.dirty = true
    oldParent.dirty = true
    newParent.dirty = true
  }

  const label = `Move ${
    findPane(document.rootPane, (candidate) => candidate.id === paneId)?.name || 'pane'
  }`

  return {
    label,
    apply: (target) => place(target, to, from),
    invert: (target) => place(target, from, to)
  }
}

/**
 * The four ways a pane can be moved through the tree without dragging.
 *
 * These are the outliner moves, chosen over drag-and-drop because they are precise,
 * keyboard-driven, and unambiguous about where the pane lands — dropping between two
 * rows of a deep tree is exactly the interaction that needs a steady hand and a lot
 * of hit-testing to get right.
 *
 * `raise`/`lower` change draw order among siblings; `indent`/`outdent` change parent.
 */
export type PaneMove = 'raise' | 'lower' | 'indent' | 'outdent'

/**
 * Resolves a move to a placement, or null when it cannot be made.
 *
 * Later siblings draw on top, so "raise" means *up* visually but *later* in the
 * array. The naming follows what the user sees.
 */
export function resolveMove(
  document: LayoutDocument,
  paneId: string,
  move: PaneMove
): PanePlacement | null {
  const from = placementOf(document, paneId)
  if (!from) return null

  const parent = findPane(document.rootPane, (candidate) => candidate.id === from.parentId)
  if (!parent) return null

  switch (move) {
    case 'raise':
      // Already last, so already on top.
      if (from.index >= parent.children.length - 1) return null
      return { parentId: from.parentId, index: from.index + 1 }

    case 'lower':
      if (from.index <= 0) return null
      return { parentId: from.parentId, index: from.index - 1 }

    case 'indent': {
      // Becomes the last child of the sibling before it, which is where an outliner
      // puts it and keeps the visual order unchanged.
      const previous = parent.children[from.index - 1]
      if (!previous) return null
      return { parentId: previous.id, index: previous.children.length }
    }

    case 'outdent': {
      const grandparent = placementOf(document, parent.id)
      // The root's children have nowhere further out to go.
      if (!grandparent) return null
      return { parentId: grandparent.parentId, index: grandparent.index + 1 }
    }
  }
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
