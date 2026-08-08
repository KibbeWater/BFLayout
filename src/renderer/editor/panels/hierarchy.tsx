import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Copy,
  Eye,
  EyeOff,
  Frame,
  Image,
  Plus,
  Puzzle,
  Scissors,
  Square,
  Trash2,
  Type
} from 'lucide-react'

import type { LayoutDocument, Pane, PaneKind } from '@shared/formats/bflyt'
import { walkPanes } from '@shared/formats/bflyt'
import {
  createBoundaryPane,
  createNullPane,
  createPicturePane,
  createTextPane,
  createWindowPane
} from '@shared/formats/bflyt/create'
import {
  addPane,
  deletePane,
  duplicatePane,
  movePane,
  resolveMove,
  setPaneSnapshot,
  snapshotPane,
  type PaneMove
} from '@renderer/editor/commands'

/**
 * Tree restructuring, in the order they read on screen.
 *
 * "Raise" moves a pane *later* among its siblings, which is what puts it on top:
 * draw order is tree order. The label follows what the user sees, not the array.
 */
const MOVES: readonly {
  move: PaneMove
  label: string
  keys: string
  icon: ReactNode
}[] = [
  { move: 'raise', label: 'Bring forward', keys: 'Alt+Up', icon: <ChevronUp className="size-3.5" /> },
  { move: 'lower', label: 'Send backward', keys: 'Alt+Down', icon: <ChevronDown className="size-3.5" /> },
  { move: 'outdent', label: 'Move out of its parent', keys: 'Alt+Left', icon: <ChevronLeft className="size-3.5" /> },
  { move: 'indent', label: 'Move into the pane above', keys: 'Alt+Right', icon: <ChevronRight className="size-3.5" /> }
]
import {
  countPanes,
  paneById,
  useActiveTab,
  useDocuments
} from '@renderer/editor/store/document'

const KIND_META: Record<PaneKind, { icon: ReactNode; label: string }> = {
  pan1: { icon: <Square className="size-3.5 text-muted-foreground/70" />, label: 'Null' },
  pic1: { icon: <Image className="size-3.5 text-primary" />, label: 'Picture' },
  txt1: { icon: <Type className="size-3.5 text-emerald-400" />, label: 'Text' },
  wnd1: { icon: <Frame className="size-3.5 text-amber-400" />, label: 'Window' },
  bnd1: { icon: <Square className="size-3.5 text-sky-400" />, label: 'Boundary' },
  prt1: { icon: <Puzzle className="size-3.5 text-violet-400" />, label: 'Part' },
  scr1: { icon: <Scissors className="size-3.5 text-rose-400" />, label: 'Scissor' },
  ali1: { icon: <Square className="size-3.5 text-teal-400" />, label: 'Alignment' }
}

export function HierarchyPanel(): ReactNode {
  const tab = useActiveTab()
  const revealPane = useDocuments((state) => state.revealPane)

  // Expand whatever is hiding the selection, so a pane picked on the canvas is
  // actually visible in the tree rather than inside a collapsed branch.
  const firstSelected = tab?.selectedPaneIds[0]
  useEffect(() => {
    if (firstSelected) revealPane(firstSelected)
  }, [firstSelected, revealPane])


  if (!tab) {
    return (
      <div className="flex flex-1 items-center justify-center p-4 text-center text-xs text-muted-foreground/60">
        Open a layout to see its pane tree.
      </div>
    )
  }

  if (!tab.document.rootPane) {
    return (
      <div className="flex flex-1 items-center justify-center p-4 text-center text-xs text-muted-foreground/60">
        This layout has no panes.
      </div>
    )
  }

  return (
    <>
      <PaneActions />
      <div className="min-h-0 flex-1 overflow-auto py-1">
        <PaneRow pane={tab.document.rootPane} depth={0} />
      </div>
    </>
  )
}

/** Pane kinds that can be created from scratch, with their factories. */
const CREATABLE = [
  { kind: 'pan1', label: 'Null', create: (name: string) => createNullPane(name) },
  { kind: 'pic1', label: 'Picture', create: (name: string) => createPicturePane(name, 0) },
  { kind: 'txt1', label: 'Text', create: (name: string) => createTextPane(name, 0) },
  { kind: 'wnd1', label: 'Window', create: (name: string) => createWindowPane(name, 0) },
  { kind: 'bnd1', label: 'Boundary', create: (name: string) => createBoundaryPane(name) }
] as const

/**
 * Add and delete.
 *
 * A new pane goes under the selection when something is selected, which is what
 * you want when building out a group, and under the root otherwise. Both actions
 * go through the undo stack.
 */
function PaneActions(): ReactNode {
  const tab = useActiveTab()
  const runCommand = useDocuments((state) => state.runCommand)
  const select = useDocuments((state) => state.select)
  const [adding, setAdding] = useState(false)

  const selectedId = tab?.selectedPaneIds[0]
  const selected = tab && selectedId ? paneById(tab.document, selectedId) : null
  const isRoot = selected !== null && selected?.id === tab?.document.rootPane?.id

  // A full tree walk, memoised on the document revision. As in MaterialsPanel this
  // helps for re-renders the document did not cause, but not during a drag, which
  // bumps the revision every frame.
  const document = tab?.document
  const revision = tab?.revision
  const paneCount = useMemo(
    () => (document ? countPanes(document) : null),
    [document, revision]
  )

  const add = (entry: (typeof CREATABLE)[number]): void => {
    if (!tab?.document.rootPane) return
    const parent = selected ?? tab.document.rootPane
    // Names must be unique for animations and groups to address panes at all.
    const pane = entry.create(uniqueName(tab.document, entry.label))
    runCommand(addPane(parent.id, pane))
    select([pane.id])
    setAdding(false)
  }

  /**
   * Copies the selection in beside itself. Offered as a button as well as Cmd+D,
   * because a keyboard-only feature is one most people never find.
   */
  const duplicate = (): void => {
    if (!tab || !selected || isRoot) return
    const command = duplicatePane(tab.document, selected.id)
    if (!command) return
    runCommand(command)
  }

  /**
   * Restructures the tree. Offered as buttons as well as Alt+arrow, because draw
   * order is tree order and this is the only way to change what draws on top —
   * a capability nobody would guess was behind a modifier key.
   */
  const move = (direction: PaneMove): void => {
    if (!tab || !selected) return
    const target = resolveMove(tab.document, selected.id, direction)
    if (!target) return
    const command = movePane(tab.document, selected.id, target)
    if (command) runCommand(command)
  }

  const canMove = (direction: PaneMove): boolean =>
    tab !== undefined && selected !== null && resolveMove(tab.document, selected.id, direction) !== null

  const remove = (): void => {
    if (!tab || !selected || isRoot) return
    const command = deletePane(tab.document, selected.id)
    if (!command) return
    runCommand(command)
    select([])
  }

  return (
    <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
      <div className="relative">
        <button
          type="button"
          onClick={() => setAdding((value) => !value)}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] hover:bg-accent"
          title={selected ? `Add a pane under ${selected.name || 'the selection'}` : 'Add a pane under the root'}
        >
          <Plus className="size-3.5" />
          Add
        </button>
        {adding ? (
          <ul className="absolute left-0 top-full z-20 mt-0.5 min-w-32 rounded border bg-popover p-1 shadow-md">
            {CREATABLE.map((entry) => (
              <li key={entry.kind}>
                <button
                  type="button"
                  onClick={() => add(entry)}
                  className="w-full rounded px-2 py-1 text-left text-[11px] hover:bg-accent"
                >
                  {entry.label}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {MOVES.map((entry) => (
        <button
          key={entry.move}
          type="button"
          onClick={() => move(entry.move)}
          disabled={!canMove(entry.move)}
          title={`${entry.label} (${entry.keys})`}
          aria-label={entry.label}
          className="rounded p-0.5 hover:bg-accent disabled:opacity-30"
        >
          {entry.icon}
        </button>
      ))}

      <button
        type="button"
        onClick={duplicate}
        disabled={!selected || isRoot}
        title={
          isRoot
            ? 'The root pane cannot be duplicated'
            : selected
              ? `Duplicate ${selected.name || 'the selected pane'} and its children (Cmd+D)`
              : 'Select a pane first'
        }
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] hover:bg-accent disabled:opacity-30"
      >
        <Copy className="size-3.5" />
        Duplicate
      </button>

      <button
        type="button"
        onClick={remove}
        disabled={!selected || isRoot}
        title={
          isRoot
            ? 'The root pane cannot be deleted'
            : selected
              ? `Delete ${selected.name || 'the selected pane'} and its children`
              : 'Select a pane first'
        }
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] hover:bg-accent disabled:opacity-30"
      >
        <Trash2 className="size-3.5" />
        Delete
      </button>
      <span className="ml-auto text-[11px] text-muted-foreground/60">
        {paneCount === null ? '' : `${paneCount} panes`}
      </span>
    </div>
  )
}

/** Appends a counter until the name is unused, so panes stay addressable. */
function uniqueName(document: LayoutDocument, base: string): string {
  const taken = new Set<string>()
  walkPanes(document.rootPane, (pane) => taken.add(pane.name))
  for (let i = 1; i < 1000; i++) {
    const candidate = `${base}_${i}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base}_${Date.now()}`
}

function PaneRow({ pane, depth }: { pane: Pane; depth: number }): ReactNode {
  const tab = useActiveTab()
  const select = useDocuments((state) => state.select)
  const toggleCollapsed = useDocuments((state) => state.toggleCollapsed)
  const runCommand = useDocuments((state) => state.runCommand)

  const selected = tab?.selectedPaneIds.includes(pane.id) ?? false

  /**
   * Scrolls a pane into view when it becomes selected somewhere else.
   *
   * Selecting on the canvas used to leave the tree wherever it was, so on a deep
   * layout you would select something and see no change here at all.
   *
   * Declared above the `!tab` guard: hooks must run unconditionally, and while the
   * parent currently makes that guard unreachable, relying on that is how the
   * properties panel ended up with a crash.
   */
  const rowRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!selected) return
    rowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  if (!tab) return null

  const collapsed = tab.collapsedIds.has(pane.id)
  const hasChildren = pane.children.length > 0
  const meta = KIND_META[pane.kind]

  const toggleVisible = (): void => {
    const before = snapshotPane(pane)
    pane.visible = !pane.visible
    const after = snapshotPane(pane)
    runCommand(
      setPaneSnapshot(
        pane.id,
        `${after['visible'] ? 'Show' : 'Hide'} ${pane.name || pane.kind}`,
        before,
        after
      )
    )
  }

  return (
    <>
      <div
        ref={rowRef}
        className={`group flex items-center gap-1 pr-2 hover:bg-accent/60 ${
          selected ? 'bg-accent' : ''
        }`}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
      >
        <button
          type="button"
          onClick={() => hasChildren && toggleCollapsed(pane.id)}
          className={`rounded p-0.5 ${hasChildren ? 'hover:bg-accent' : 'invisible'}`}
          aria-label={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
        </button>

        <button
          type="button"
          // Shift or Cmd extends the selection, matching the canvas marquee. The
          // store has always held an array; only the canvas could fill it.
          onClick={(event) => {
            if (event.shiftKey || event.metaKey || event.ctrlKey) {
              select(
                selected
                  ? tab.selectedPaneIds.filter((id) => id !== pane.id)
                  : [...tab.selectedPaneIds, pane.id]
              )
            } else {
              select([pane.id])
            }
          }}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
          title={`${meta.label} · ${pane.name}`}
        >
          {meta.icon}
          <span className={`truncate ${pane.visible ? '' : 'text-muted-foreground/50'}`}>
            {pane.name || '(unnamed)'}
          </span>
          {pane.dirty ? (
            <span
              className="size-1.5 shrink-0 rounded-full bg-primary"
              title="Edited — will be re-encoded on save"
            />
          ) : null}
        </button>

        <button
          type="button"
          onClick={toggleVisible}
          className="rounded p-0.5 opacity-0 hover:bg-accent group-hover:opacity-100"
          title={pane.visible ? 'Hide pane' : 'Show pane'}
        >
          {pane.visible ? (
            <Eye className="size-3 text-muted-foreground" />
          ) : (
            <EyeOff className="size-3 text-muted-foreground/50" />
          )}
        </button>
      </div>

      {!collapsed &&
        pane.children.map((child) => (
          <PaneRow key={child.id} pane={child} depth={depth + 1} />
        ))}
    </>
  )
}
