import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  Crosshair,
  Grid3x3,
  Image as ImageIcon,
  Magnet,
  Maximize
} from 'lucide-react'

import type { LayoutDocument, Pane, PartPane } from '@shared/formats/bflyt'
import { walkPanes } from '@shared/formats/bflyt'
import type { LayoutSource } from '@shared/contract'
import {
  apply,
  flattenPanes,
  hitTest,
  invert,
  worldBounds,
  type Affine,
  type PaneTransform
} from '@shared/formats/bflyt/transform'
import {
  RESIZE_HANDLES,
  alignmentCandidates,
  alignmentSnap,
  handleCursor,
  handlePosition,
  panesInRect,
  resizePane,
  type Guide,
  type ResizeHandle
} from '@shared/formats/bflyt/editing'
import { getOrpc } from '@renderer/lib/orpc'
import {
  markPaneDirty,
  paneById,
  useActiveTab,
  useDocuments,
  type DocumentTab
} from '@renderer/editor/store/document'
import {
  composeCommands,
  deletePane,
  duplicatePane,
  setPaneFields,
  type Command
} from '@renderer/editor/commands'

import { usePlayback } from '@renderer/editor/store/playback'
import { LayoutRenderer, type Camera } from './renderer'

/** The zoom range the camera is allowed to take, wherever it is set from. */
const MIN_ZOOM = 0.02
const MAX_ZOOM = 8

function clampZoom(value: number): number {
  // A zero-sized container makes the fit calculation NaN, which would blank the
  // canvas with no indication why.
  if (!Number.isFinite(value) || value <= 0) return MIN_ZOOM
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value))
}

/**
 * Arrow keys to a layout-space delta. Y is negated because layout space puts +Y
 * upwards while the keys mean screen directions.
 */
const NUDGE_KEYS: Record<string, readonly [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, 1],
  ArrowDown: [0, -1]
}

interface DragState {
  readonly paneIds: string[]
  readonly startX: number
  readonly startY: number
  readonly origins: Map<string, [number, number]>
  /**
   * The dragged pane's world bounds as they were when the drag began.
   *
   * Captured once rather than read from `renderer.flattened` each frame. That array
   * is rebuilt on every mutation, and the drag mutates per pointermove, so mid-drag
   * it holds the pane at its *previous frame's* position — while the delta being
   * tested is measured from the drag origin. Adding the two double-counted every
   * frame after the first, so guides engaged around halfway to the target and the
   * pane landed short of the line it had just drawn.
   *
   * Null when more than one pane is moving, which is when guides do not apply.
   */
  readonly originBounds: readonly [number, number, number, number] | null
}

/** In-progress resize of a single pane. */
interface ResizeState {
  readonly paneId: string
  readonly handle: ResizeHandle
  readonly startX: number
  readonly startY: number
  readonly before: {
    width: number
    height: number
    translate: [number, number, number]
  }
}

/** Rubber-band selection, in layout coordinates. */
interface MarqueeState {
  readonly startX: number
  readonly startY: number
  x: number
  y: number
  /** True when the marquee adds to the existing selection. */
  readonly additive: boolean
}

export function LayoutCanvas(): ReactNode {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const rendererRef = useRef<LayoutRenderer | null>(null)
  const cameraRef = useRef<Camera>({ x: 0, y: 0, zoom: 0.6 })
  const dragRef = useRef<DragState | null>(null)
  const resizeRef = useRef<ResizeState | null>(null)
  const panRef = useRef<{ x: number; y: number } | null>(null)
  /** Latest fitToLayout, so the menu handler need not depend on it. */
  const fitRef = useRef<(() => void) | null>(null)
  const marqueeRef = useRef<MarqueeState | null>(null)

  const [glError, setGlError] = useState<string | null>(null)
  const [showGrid, setShowGrid] = useState(true)
  const [showTextures, setShowTextures] = useState(true)
  const [snap, setSnap] = useState(false)
  const [cursor, setCursor] = useState<[number, number]>([0, 0])
  /** Bumped when a texture finishes loading, purely to force a redraw. */
  const [textureRevision, setTextureRevision] = useState(0)
  const [textureFailures, setTextureFailures] = useState<{ name: string; detail: string }[]>([])
  /** Marquee and guides live in React state because they are drawn as overlays. */
  const [marquee, setMarquee] = useState<MarqueeState | null>(null)
  const [guides, setGuides] = useState<readonly Guide[]>([])

  const tab = useActiveTab()
  // Playback drives redraws through this: the overrides object is replaced on
  // every frame change, so it is the only dependency the draw effect needs.
  const overrides = usePlayback((state) => state.overrides)
  const select = useDocuments((state) => state.select)
  const mutate = useDocuments((state) => state.mutate)
  const runCommand = useDocuments((state) => state.runCommand)
  const undo = useDocuments((state) => state.undo)
  const redo = useDocuments((state) => state.redo)

  /**
   * Holds the newest wheel handler, so the listener below can be registered once
   * while still calling into the current closure.
   */
  const wheelRef = useRef<(event: WheelEvent) => void>(() => {})

  // Stable across renders so the add and remove below always match.
  const dispatchWheel = useMemo(
    () =>
      (event: WheelEvent): void => {
        wheelRef.current(event)
      },
    []
  )

  /**
   * Attaches the container and its non-passive wheel listener.
   *
   * A ref callback rather than an effect for the same reason `attachCanvas` is:
   * the element does not exist on the first render when no layout is open, so a
   * mount-time effect would run against null and never run again.
   */
  const attachContainer = useCallback(
    (node: HTMLDivElement | null) => {
      const previous = containerRef.current
      if (previous) previous.removeEventListener('wheel', dispatchWheel)
      containerRef.current = node
      if (node) node.addEventListener('wheel', dispatchWheel, { passive: false })
    },
    [dispatchWheel]
  )

  /**
   * Moves every selected pane, as one undo entry.
   *
   * Y is inverted because layout space puts +Y upwards while the arrow keys mean
   * screen directions.
   */
  const nudgeSelection = useCallback(
    (paneIds: readonly string[], dx: number, dy: number): void => {
      const state = useDocuments.getState()
      const tab = state.tabs.find((entry) => entry.documentId === state.activeId)
      if (!tab) return

      /*
       * Panes whose ancestor is also selected are dropped, the same way the drag
       * path does it: a child already moves with its parent's translate, so nudging
       * both moved the child twice as far.
       */
      const moving = independentSelection(rendererRef.current?.flattened ?? [], paneIds)

      const moves = moving
        .map((id) => paneById(tab.document, id))
        .filter((pane): pane is Pane => pane !== null)
        .map((pane) => ({
          id: pane.id,
          before: [...pane.translate] as [number, number, number],
          after: [pane.translate[0] + dx, pane.translate[1] + dy, pane.translate[2]] as [
            number,
            number,
            number
          ]
        }))

      if (moves.length === 0) return
      state.runCommand(composeCommands(`Nudge ${moves.length} pane${moves.length === 1 ? '' : 's'}`,
        moves.map((move) =>
          setPaneFields(move.id, 'Nudge', { translate: move.before }, { translate: move.after })
        )
      ))
    },
    []
  )

  /** Copies every selected pane in beside itself, as one undo entry. */
  const duplicateSelection = useCallback((paneIds: readonly string[]): void => {
    const state = useDocuments.getState()
    const tab = state.tabs.find((entry) => entry.documentId === state.activeId)
    if (!tab) return

    /*
     * Descendants of another selected pane are skipped: duplicating a parent already
     * copies its whole subtree, so duplicating both produced the child twice — once
     * inside the parent's copy and once beside the original.
     */
    const roots = independentSelection(rendererRef.current?.flattened ?? [], paneIds)

    // Built and applied one at a time so each copy sees the names the previous one
    // took, and so the insert indices stay valid.
    const commands: Command[] = []
    const copies: string[] = []
    for (const id of roots) {
      const before = new Set(
        (paneById(tab.document, id) ? parentOf(tab.document, id)?.children ?? [] : []).map(
          (child) => child.id
        )
      )
      const command = duplicatePane(tab.document, id)
      if (!command) continue
      command.apply(tab.document)
      commands.push(command)

      // The copy is whichever sibling was not there a moment ago.
      const after = parentOf(tab.document, id)?.children ?? []
      const copy = after.find((child) => !before.has(child.id))
      if (copy) copies.push(copy.id)
    }

    if (commands.length === 0) return
    state.runCommand(
      composeCommands(
        `Duplicate ${commands.length} pane${commands.length === 1 ? '' : 's'}`,
        commands
      )
    )
    // Select the copies, so duplicate-then-nudge moves the new panes rather than
    // silently moving the originals again.
    if (copies.length > 0) state.select(copies)
  }, [])

  /** Deletes every selected pane, as one undo entry. */
  const deleteSelection = useCallback((paneIds: readonly string[]): void => {
    const state = useDocuments.getState()
    const tab = state.tabs.find((entry) => entry.documentId === state.activeId)
    if (!tab) return

    /*
     * Each command is applied as it is built, so the next one records an index
     * that matches the array it will actually be inverted into. Creating them all
     * against the starting document gives later siblings stale indices and undo
     * puts them back in the wrong place. Re-applying in `runCommand` is harmless:
     * a delete matches by identity and finds nothing the second time.
     *
     * The root has no parent to be removed from, so it is never deletable.
     */
    const commands: Command[] = []
    for (const id of paneIds) {
      if (id === tab.document.rootPane?.id) continue
      const command = deletePane(tab.document, id)
      if (!command) continue
      command.apply(tab.document)
      commands.push(command)
    }

    if (commands.length === 0) return
    state.runCommand(
      composeCommands(`Delete ${commands.length} pane${commands.length === 1 ? '' : 's'}`, commands)
    )
    state.select([])
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      /*
       * Keep out of anything the user is typing into. `isContentEditable` matters
       * as much as the tag list: a contenteditable would otherwise swallow its own
       * arrow keys and Backspace into pane nudges and deletions.
       */
      if (
        target &&
        (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)
      ) {
        return
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
        return
      }

      const state = useDocuments.getState()
      const tab = state.tabs.find((entry) => entry.documentId === state.activeId)
      if (!tab) return
      const selection = tab.selectedPaneIds

      // Escape clears the selection, which is the only way back to "nothing
      // selected" without clicking empty canvas.
      if (event.key === 'Escape') {
        if (selection.length === 0) return
        event.preventDefault()
        state.select([])
        return
      }

      if (selection.length === 0) return

      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        deleteSelection(selection)
        return
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd') {
        event.preventDefault()
        duplicateSelection(selection)
        return
      }

      const nudge = NUDGE_KEYS[event.key]
      if (!nudge) return
      event.preventDefault()
      // Shift nudges by ten, the convention in every editor of this kind.
      const step = event.shiftKey ? 10 : 1
      nudgeSelection(selection, nudge[0] * step, nudge[1] * step)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [undo, redo, deleteSelection, nudgeSelection])

  // Canvas commands from the native View menu. They live here because the state
  // they toggle does, and duplicating it in the menu would let the two drift.
  useEffect(() => {
    const onCommand = (event: Event): void => {
      switch ((event as CustomEvent<string>).detail) {
        case 'toggle-grid':
          setShowGrid((value) => !value)
          break
        case 'toggle-textures':
          setShowTextures((value) => !value)
          break
        case 'fit':
          fitRef.current?.()
          break
        default:
          break
      }
    }
    window.addEventListener('bflayout-command', onCommand)
    return () => window.removeEventListener('bflayout-command', onCommand)
  }, [])

  const orpc = getOrpc()
  const settings = useQuery(orpc.app.settings.get.queryOptions())

  /**
   * Layouts for the prt1 part panes in this document. Fetched in one batch and
   * cached by query key, so switching tabs back and forth does not re-read them.
   */
  const partNames = useMemo(() => {
    if (!tab) return []
    const names = new Set<string>()
    walkPanes(tab.document.rootPane, (pane) => {
      if (pane.kind === 'prt1') {
        const name = (pane as PartPane).externalLayoutName
        if (name) names.add(name)
      }
    })
    return [...names].sort()
  }, [tab?.documentId, tab?.revision])

  const partQuery = useQuery({
    ...orpc.layout.parts.queryOptions({
      input: { source: tab?.source as LayoutSource, names: partNames }
    }),
    enabled: tab !== undefined && partNames.length > 0
  })

  const parts = useMemo(() => {
    const map = new Map<string, LayoutDocument>()
    for (const entry of partQuery.data?.resolved ?? []) map.set(entry.name, entry.document)
    return map
  }, [partQuery.data])
  const gridSize = settings.data?.gridSize ?? 32
  const showInvisible = settings.data?.showInvisiblePanes ?? true

  /**
   * One renderer per canvas element, created by a ref callback rather than an
   * effect.
   *
   * The element's existence *is* the dependency: this component renders a
   * placeholder instead of a canvas when no layout is open, so a mount-time effect
   * runs while canvasRef is still null and — with an empty dependency list — never
   * runs again. Opening a folder navigates to the editor before any document
   * exists, which hit that every time and left the canvas permanently blank while
   * the DOM overlays kept drawing, so only the selection handles appeared.
   */
  const attachCanvas = useCallback((canvas: HTMLCanvasElement | null) => {
    if (!canvas) {
      rendererRef.current?.dispose()
      rendererRef.current = null
      return
    }
    if (rendererRef.current) return

    try {
      // Textures arrive after the first paint, so the renderer asks for a redraw
      // rather than the canvas polling for them.
      rendererRef.current = new LayoutRenderer(canvas, () =>
        setTextureRevision((value) => value + 1)
      )
      setGlError(null)
      if (import.meta.env.DEV) {
        // Test seam: the self-test asserts on texture load state, which is
        // otherwise unreachable from outside React. See src/main/selftest.ts.
        const dev = (window as unknown as Record<string, Record<string, unknown>>)['__bfdev']
        if (dev) dev['renderer'] = rendererRef.current
      }
      // The element only just appeared, so nothing has drawn into it yet.
      setTextureRevision((value) => value + 1)
    } catch (cause) {
      setGlError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  const draw = useCallback(() => {
    const renderer = rendererRef.current
    const container = containerRef.current
    if (!renderer || !container || !tab) return

    const rect = container.getBoundingClientRect()
    renderer.textures.setSource(tab.source)
    try {
      renderer.render(
        tab.document,
        cameraRef.current,
        {
          showGrid,
          gridSize,
          showInvisiblePanes: showInvisible,
          showTextures,
          selectedIds: tab.selectedPaneIds,
          overrides,
          parts
        },
        { width: rect.width, height: rect.height, dpr: window.devicePixelRatio || 1 }
      )
    } catch (cause) {
      // A draw failure must not spin the animation loop forever.
      setGlError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [tab, showGrid, gridSize, showInvisible, showTextures, overrides, parts])

  // Redraw on document revision, selection, settings, textures and resize.
  useEffect(() => {
    draw()
    setTextureFailures(rendererRef.current?.textures.failures() ?? [])
  }, [draw, tab?.revision, tab?.selectedPaneIds, textureRevision])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver(() => draw())
    observer.observe(container)
    return () => observer.disconnect()
  }, [draw])

  /** Screen pixels to layout coordinates. */
  const toLayout = useCallback((clientX: number, clientY: number): [number, number] => {
    const container = containerRef.current
    if (!container) return [0, 0]
    const rect = container.getBoundingClientRect()
    const camera = cameraRef.current
    const x = camera.x + (clientX - rect.left - rect.width / 2) / camera.zoom
    // Screen Y grows downward; layout Y grows upward.
    const y = camera.y - (clientY - rect.top - rect.height / 2) / camera.zoom
    return [x, y]
  }, [])

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!tab) return
    const renderer = rendererRef.current
    if (!renderer) return

    const [x, y] = toLayout(event.clientX, event.clientY)

    // Middle button or space-less right drag pans the view.
    if (event.button === 1 || event.button === 2) {
      panRef.current = { x: event.clientX, y: event.clientY }
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }

    // A resize handle wins over whatever is underneath it, otherwise handles on
    // top of a pane would be impossible to grab.
    const grabbed = handleUnder(tab, renderer.flattened, x, y, cameraRef.current.zoom)
    if (grabbed) {
      const pane = grabbed.entry.pane
      resizeRef.current = {
        paneId: pane.id,
        handle: grabbed.handle,
        startX: x,
        startY: y,
        before: {
          width: pane.width,
          height: pane.height,
          translate: [...pane.translate] as [number, number, number]
        }
      }
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }

    const additive = event.shiftKey || event.metaKey || event.ctrlKey
    const hit = hitTest(renderer.flattened, x, y, { includeHidden: showInvisible })

    if (!hit) {
      // Empty space starts a marquee. The selection is only cleared once the drag
      // ends, so a click that turns out to be a drag does not flash empty first.
      if (!additive) select([])
      const started: MarqueeState = { startX: x, startY: y, x, y, additive }
      marqueeRef.current = started
      setMarquee(started)
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }

    const current = tab.selectedPaneIds
    const selection = additive
      ? current.includes(hit.pane.id)
        ? current.filter((id) => id !== hit.pane.id)
        : [...current, hit.pane.id]
      : current.includes(hit.pane.id)
        ? current
        : [hit.pane.id]
    select(selection)

    // Deselecting with a modifier must not then start dragging the pane away.
    if (additive && !selection.includes(hit.pane.id)) return

    // Every selected pane moves together, minus any whose ancestor is also
    // selected — those already move with the ancestor and would double up.
    const moving = independentSelection(renderer.flattened, selection)
    const origins = new Map<string, [number, number]>()
    for (const id of moving) {
      const pane = findById(tab.document.rootPane, id)
      if (pane) origins.set(id, [pane.translate[0], pane.translate[1]])
    }

    const single = moving.length === 1 ? moving[0] : undefined
    const singleEntry =
      single === undefined
        ? undefined
        : renderer.flattened.find((candidate) => candidate.pane.id === single)

    dragRef.current = {
      paneIds: [...origins.keys()],
      startX: x,
      startY: y,
      origins,
      originBounds: singleEntry ? worldBounds(singleEntry) : null
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const [x, y] = toLayout(event.clientX, event.clientY)
    setCursor([Math.round(x), Math.round(y)])

    const pan = panRef.current
    if (pan) {
      const camera = cameraRef.current
      camera.x -= (event.clientX - pan.x) / camera.zoom
      camera.y += (event.clientY - pan.y) / camera.zoom
      panRef.current = { x: event.clientX, y: event.clientY }
      draw()
      return
    }

    const marqueeState = marqueeRef.current
    if (marqueeState) {
      marqueeState.x = x
      marqueeState.y = y
      setMarquee({ ...marqueeState })
      return
    }

    const resize = resizeRef.current
    if (resize && tab) {
      const renderer = rendererRef.current
      const pane = findById(tab.document.rootPane, resize.paneId)
      if (!pane || !renderer) return

      // Handle drags are in world space but resizePane works in the pane's own
      // space, so the delta is rotated back through the parent transform.
      const entry = renderer.flattened.find((candidate) => candidate.pane.id === resize.paneId)
      const [dxLocal, dyLocal] = entry
        ? toLocalDelta(entry, x - resize.startX, y - resize.startY)
        : [x - resize.startX, y - resize.startY]

      const step = snap && !event.altKey ? gridSize : 0
      const quantise = (value: number): number =>
        step > 0 ? Math.round(value / step) * step : value

      mutate((current) => {
        const target = findById(current.document.rootPane, resize.paneId)
        if (!target) return
        target.width = resize.before.width
        target.height = resize.before.height
        target.translate[0] = resize.before.translate[0]
        target.translate[1] = resize.before.translate[1]

        const result = resizePane(target, resize.handle, quantise(dxLocal), quantise(dyLocal))
        target.width = result.width
        target.height = result.height
        target.translate[0] = resize.before.translate[0] + result.translateDx
        target.translate[1] = resize.before.translate[1] + result.translateDy
        markPaneDirty(current.document, resize.paneId)
      })
      return
    }

    const drag = dragRef.current
    if (!drag || !tab) return

    /**
     * Dragging mutates the document directly and redraws, without pushing an
     * undo entry per frame — one entry is recorded on pointer-up. This is also
     * why the working model lives in the renderer: a 60fps drag cannot afford a
     * round trip to the main process.
     */
    const dx = x - drag.startX
    const dy = y - drag.startY

    /**
     * Snapping rounds the pane's resulting position to the grid rather than the
     * mouse delta, so a pane that started off-grid lands on it instead of staying
     * permanently offset. Alt is the standard override.
     */
    const snapping = snap && !event.altKey
    const step = snapping ? gridSize : 0
    const place = (value: number): number => (step > 0 ? Math.round(value / step) * step : value)

    /**
     * Alignment guides run *after* grid snapping and can override it, because
     * lining up with an existing pane is almost always what was intended when both
     * are within reach. The threshold is divided by the zoom so the pull feels the
     * same however far in you are.
     *
     * Two corrections from how this started:
     *
     *   - The guide offset is measured from the *snapped* rectangle. Measuring the
     *     unsnapped one and then adding the result on top of a snapped position
     *     landed the pane short of the line it had just drawn, by whatever the grid
     *     had moved it — so the guide claimed an alignment that never happened.
     *   - Guides no longer require grid snap to be on. They are the more precise of
     *     the two tools, and gating them behind the coarser one was backwards. Alt
     *     still suppresses both.
     */
    let guideDx = 0
    let guideDy = 0
    let shown: readonly Guide[] = []
    const renderer = rendererRef.current
    const firstId = drag.paneIds[0]
    const firstOrigin = firstId === undefined ? undefined : drag.origins.get(firstId)
    if (!event.altKey && renderer && drag.originBounds && firstOrigin) {
      // What the grid actually moved the pane by, which is what the bounds move by.
      const snappedDx = place(firstOrigin[0] + dx) - firstOrigin[0]
      const snappedDy = place(firstOrigin[1] + dy) - firstOrigin[1]
      const [l, b, r, t] = drag.originBounds
      const result = alignmentSnap(
        [l + snappedDx, b + snappedDy, r + snappedDx, t + snappedDy],
        alignmentCandidates(renderer.flattened, drag.paneIds),
        GUIDE_THRESHOLD_PIXELS / cameraRef.current.zoom
      )
      guideDx = result.dx
      guideDy = result.dy
      shown = result.guides
    }
    setGuides(shown)

    mutate((current) => {
      for (const paneId of drag.paneIds) {
        const origin = drag.origins.get(paneId)
        if (!origin) continue
        const pane = findById(current.document.rootPane, paneId)
        if (!pane) continue
        pane.translate[0] = place(origin[0] + dx) + guideDx
        pane.translate[1] = place(origin[1] + dy) + guideDy
        markPaneDirty(current.document, paneId)
      }
    })
  }

  const endInteraction = (event: React.PointerEvent<HTMLDivElement>): void => {
    const finishedMarquee = marqueeRef.current
    if (finishedMarquee && tab) {
      const renderer = rendererRef.current
      // A click without movement is a deselect, which pointer-down already did.
      const dragged =
        Math.abs(finishedMarquee.x - finishedMarquee.startX) > 1 ||
        Math.abs(finishedMarquee.y - finishedMarquee.startY) > 1
      if (renderer && dragged) {
        const inside = panesInRect(
          renderer.flattened,
          [finishedMarquee.startX, finishedMarquee.startY, finishedMarquee.x, finishedMarquee.y],
          { includeHidden: showInvisible }
        ).map((entry) => entry.pane.id)
        const combined = finishedMarquee.additive
          ? [...new Set([...tab.selectedPaneIds, ...inside])]
          : inside
        select(combined)
      }
      marqueeRef.current = null
      setMarquee(null)
    }

    const resize = resizeRef.current
    if (resize && tab) {
      const pane = findById(tab.document.rootPane, resize.paneId)
      const changed =
        pane &&
        (pane.width !== resize.before.width ||
          pane.height !== resize.before.height ||
          pane.translate[0] !== resize.before.translate[0] ||
          pane.translate[1] !== resize.before.translate[1])
      if (pane && changed) {
        runCommand(
          setPaneFields(
            resize.paneId,
            `Resize ${pane.name || 'pane'}`,
            {
              width: resize.before.width,
              height: resize.before.height,
              translate: resize.before.translate
            },
            {
              width: pane.width,
              height: pane.height,
              translate: [...pane.translate] as [number, number, number]
            }
          )
        )
      }
      resizeRef.current = null
    }

    setGuides([])

    const drag = dragRef.current
    if (drag && tab) {
      /**
       * One undo entry per drag, recorded here rather than per pointer-move.
       * The document already holds the final position, so the command's apply()
       * is a no-op replay and only invert() does real work.
       *
       * Composed across the whole selection, not pushed per pane: dragging twenty
       * marquee-selected panes used to cost twenty presses of Cmd+Z, and ten such
       * drags would evict the rest of the history through the 200-entry cap.
       */
      const moves: Command[] = []
      let movedName = 'pane'
      for (const paneId of drag.paneIds) {
        const before = drag.origins.get(paneId)
        const pane = findById(tab.document.rootPane, paneId)
        if (!before || !pane) continue
        const moved = before[0] !== pane.translate[0] || before[1] !== pane.translate[1]
        if (!moved) continue
        movedName = pane.name || 'pane'
        moves.push(
          setPaneFields(
            paneId,
            `Move ${movedName}`,
            { translate: [before[0], before[1], pane.translate[2]] },
            { translate: [...pane.translate] as [number, number, number] }
          )
        )
      }

      if (moves.length === 1) runCommand(moves[0]!)
      else if (moves.length > 1) {
        runCommand(composeCommands(`Move ${moves.length} panes`, moves))
      }
    }

    dragRef.current = null
    panRef.current = null
    marqueeRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  /**
   * Trackpad-first navigation, following the convention macOS apps use.
   *
   * A two-finger scroll pans, both axes; a pinch zooms at the cursor. The browser
   * reports a pinch as a wheel event with `ctrlKey` set, which is also what
   * Cmd/Ctrl + scroll produces — so the same branch serves a trackpad pinch and a
   * mouse wheel held with a modifier, and plain wheel scrolling pans like every
   * other canvas on the platform.
   */
  /**
   * Trackpad and wheel navigation.
   *
   * Attached natively rather than through React's `onWheel`, because React
   * registers wheel listeners as passive: `preventDefault` inside one is ignored,
   * Chromium logs a warning per event, and Cmd/Ctrl + wheel zooms the whole app
   * chrome on top of the canvas zoom. It has to be a non-passive listener to stop
   * that, and only `addEventListener` can ask for one.
   */
  const onWheel = (event: WheelEvent): void => {
    event.preventDefault()
    const camera = cameraRef.current

    if (event.ctrlKey || event.metaKey) {
      const before = toLayout(event.clientX, event.clientY)
      const factor = Math.exp(-event.deltaY * 0.01)
      camera.zoom = clampZoom(camera.zoom * factor)
      const after = toLayout(event.clientX, event.clientY)
      // Keep the point under the cursor fixed while zooming.
      camera.x += before[0] - after[0]
      camera.y += before[1] - after[1]
      draw()
      return
    }

    // Shift swaps the axes, which is how a mouse wheel scrolls sideways.
    const dx = event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX
    const dy = event.shiftKey && event.deltaX === 0 ? 0 : event.deltaY
    camera.x += dx / camera.zoom
    camera.y -= dy / camera.zoom
    draw()
  }

  wheelRef.current = onWheel

  const fitToLayout = (): void => {
    const container = containerRef.current
    if (!container || !tab) return
    const rect = container.getBoundingClientRect()
    const camera = cameraRef.current
    camera.x = 0
    camera.y = 0
    const margin = 1.1
    // Clamped to the same range the wheel enforces: a tiny container or a huge
    // authored canvas could otherwise fit to a zoom the rest of the code rejects.
    camera.zoom = clampZoom(
      Math.min(
        rect.width / (tab.document.info.width * margin),
        rect.height / (tab.document.info.height * margin)
      )
    )
    draw()
  }
  fitRef.current = fitToLayout

  if (!tab) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground/60">
        Open a layout from the archive to see it here.
      </div>
    )
  }

  if (glError) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <AlertTriangle className="size-6 text-destructive" />
        <p className="max-w-md text-sm">The layout canvas could not start.</p>
        <p className="max-w-md select-text text-xs text-muted-foreground">{glError}</p>
        <p className="max-w-md text-xs text-muted-foreground/70">
          The hierarchy and property panels still work, so the layout remains editable.
        </p>
        {/*
          Clearing the error unmounts this screen and remounts the canvas, which
          runs `attachCanvas` again and builds a fresh renderer. Without it a single
          transient draw failure — a lost context, a driver hiccup — was permanent
          for the rest of the session with no way back.
        */}
        <button
          type="button"
          onClick={() => setGlError(null)}
          className="rounded border px-2.5 py-1 text-xs hover:bg-accent"
        >
          Try again
        </button>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-2 py-1">
        <button
          type="button"
          onClick={() => setShowGrid((value) => !value)}
          className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] hover:bg-accent ${
            showGrid ? 'text-foreground' : 'text-muted-foreground/60'
          }`}
          title="Toggle grid"
        >
          <Grid3x3 className="size-3.5" />
          Grid
        </button>
        <button
          type="button"
          onClick={() => setShowTextures((value) => !value)}
          className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] hover:bg-accent ${
            showTextures ? 'text-foreground' : 'text-muted-foreground/60'
          }`}
          title="Toggle textures — off shows vertex colours alone"
        >
          <ImageIcon className="size-3.5" />
          Textures
        </button>
        <button
          type="button"
          onClick={() => setSnap((value) => !value)}
          className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] hover:bg-accent ${
            snap ? 'text-foreground' : 'text-muted-foreground/60'
          }`}
          title="Snap dragged panes to the grid — hold Alt to override"
        >
          <Magnet className="size-3.5" />
          Snap
        </button>
        <button
          type="button"
          onClick={fitToLayout}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] hover:bg-accent"
          title="Fit layout to view"
        >
          <Maximize className="size-3.5" />
          Fit
        </button>
        <span className="ml-auto flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
          <Crosshair className="size-3" />
          {cursor[0]}, {cursor[1]}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {tab.document.info.width}×{tab.document.info.height}
        </span>
      </div>

      <div
        ref={attachContainer}
        className="relative min-h-0 flex-1 touch-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endInteraction}
        onPointerCancel={endInteraction}
        onContextMenu={(event) => event.preventDefault()}
      >
        <canvas ref={attachCanvas} className="absolute inset-0 size-full" />
        {showTextures && textureFailures.length > 0 ? (
          <TextureFailureNotice failures={textureFailures} />
        ) : null}
        <Overlays
          tab={tab}
          camera={cameraRef.current}
          container={containerRef.current}
          marquee={marquee}
          guides={guides}
          revision={tab.revision}
        />
      </div>
    </div>
  )
}

/**
 * Explains the magenta checkers.
 *
 * A placeholder tells you a texture is wrong but not why, and "why" is usually one
 * answer for the whole layout — most commonly ASTC, which this build cannot decode
 * and which is the majority of some games' textures.
 */
function TextureFailureNotice({
  failures
}: {
  failures: { name: string; detail: string }[]
}): ReactNode {
  const [open, setOpen] = useState(false)

  // Group by reason: twenty rows of the same message is noise, one is information.
  const reasons = new Map<string, string[]>()
  for (const failure of failures) {
    const list = reasons.get(failure.detail)
    if (list) list.push(failure.name)
    else reasons.set(failure.detail, [failure.name])
  }

  return (
    <div className="pointer-events-auto absolute bottom-2 left-2 max-w-md rounded border border-amber-500/40 bg-background/95 p-2 text-[11px] shadow">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 text-left"
      >
        <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />
        <span className="flex-1">
          {failures.length} texture{failures.length === 1 ? '' : 's'} shown as a magenta
          placeholder
        </span>
        <span className="text-muted-foreground">{open ? 'hide' : 'why?'}</span>
      </button>
      {open ? (
        <ul className="mt-1.5 space-y-1 text-muted-foreground">
          {[...reasons].map(([detail, names]) => (
            <li key={detail}>
              <span className="select-text">{detail}</span>
              <span className="text-muted-foreground/60">
                {' '}
                — {names.length === 1 ? names[0] : `${names.length} textures`}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** Layout-space distance that a resize handle can be grabbed from. */
const HANDLE_GRAB_PIXELS = 7

/** How close an edge has to be, in screen pixels, before a guide pulls it. */
const GUIDE_THRESHOLD_PIXELS = 6

const HANDLE_SIZE_PIXELS = 8

/**
 * The resize handle under the pointer, if any.
 *
 * Only the single selected pane offers handles: showing eight per pane across a
 * multi-selection would bury the layout under boxes, and resizing several panes
 * at once is not a thing this editor does.
 */
function handleUnder(
  tab: DocumentTab,
  flattened: readonly PaneTransform[],
  x: number,
  y: number,
  zoom: number
): { entry: PaneTransform; handle: ResizeHandle } | null {
  if (tab.selectedPaneIds.length !== 1) return null
  const entry = flattened.find((candidate) => candidate.pane.id === tab.selectedPaneIds[0])
  if (!entry) return null

  const reach = HANDLE_GRAB_PIXELS / zoom
  for (const handle of RESIZE_HANDLES) {
    const [hx, hy] = handlePosition(entry.pane, handle)
    const [wx, wy] = apply(entry.world, hx, hy)
    if (Math.abs(wx - x) <= reach && Math.abs(wy - y) <= reach) return { entry, handle }
  }
  return null
}

/**
 * Rotates a world-space delta into a pane's own space.
 *
 * Resizing works on width and height, which live in the pane's local frame, so a
 * drag on a rotated pane has to be un-rotated first or the handle would fight the
 * pointer. The translation part of the matrix is irrelevant to a delta.
 */
function toLocalDelta(entry: PaneTransform, dx: number, dy: number): [number, number] {
  const inverse = invert(entry.world)
  if (!inverse) return [dx, dy]
  const [ox, oy] = apply(inverse, 0, 0)
  const [px, py] = apply(inverse, dx, dy)
  return [px - ox, py - oy]
}

/**
 * Drops panes from a selection whose ancestor is also selected.
 *
 * Children already move with their parent, so including both would apply the drag
 * delta twice and the child would race ahead.
 */
/** The pane that has `paneId` as a direct child, or null for the root. */
function parentOf(document: LayoutDocument, paneId: string): Pane | null {
  if (!document.rootPane) return null
  let found: Pane | null = null
  walkPanes(document.rootPane, (pane) => {
    if (pane.children.some((child) => child.id === paneId)) found = pane
  })
  return found
}

function independentSelection(
  flattened: readonly PaneTransform[],
  selected: readonly string[]
): string[] {
  const chosen = new Set(selected)
  const covered = new Set<string>()

  // flattenPanes emits parents before children, so one pass suffices.
  for (const entry of flattened) {
    if (chosen.has(entry.pane.id) || covered.has(entry.pane.id)) {
      for (const child of entry.pane.children) covered.add(child.id)
    }
  }

  return selected.filter((id) => !covered.has(id))
}

/**
 * Marquee, alignment guides and resize handles, drawn as DOM rather than GL.
 *
 * They need their own cursors and hit areas, and there are at most a dozen of
 * them, so absolutely-positioned elements are simpler and better-behaved than
 * another GL pass would be.
 */
function Overlays({
  tab,
  camera,
  container,
  marquee,
  guides
}: {
  tab: DocumentTab
  camera: Camera
  container: HTMLDivElement | null
  marquee: MarqueeState | null
  guides: readonly Guide[]
  /** Unused, but its change is what re-renders this after a document mutation. */
  revision: number
}): ReactNode {
  if (!container) return null
  const bounds = container.getBoundingClientRect()

  /** Layout coordinates to CSS pixels within the container. */
  const toScreen = (x: number, y: number): [number, number] => [
    (x - camera.x) * camera.zoom + bounds.width / 2,
    -(y - camera.y) * camera.zoom + bounds.height / 2
  ]

  const selectedId = tab.selectedPaneIds.length === 1 ? tab.selectedPaneIds[0] : undefined
  const selected = selectedId ? paneById(tab.document, selectedId) : null
  const world = selected ? worldTransformOf(tab, selected.id) : null

  return (
    <>
      {guides.map((guide) => {
        const [sx, sy] = toScreen(guide.position, guide.position)
        return guide.axis === 'x' ? (
          <div
            key={`x${guide.position}`}
            className="pointer-events-none absolute inset-y-0 w-px bg-fuchsia-400/80"
            style={{ left: sx }}
          />
        ) : (
          <div
            key={`y${guide.position}`}
            className="pointer-events-none absolute inset-x-0 h-px bg-fuchsia-400/80"
            style={{ top: sy }}
          />
        )
      })}

      {marquee ? (
        <div
          className="pointer-events-none absolute border border-primary bg-primary/10"
          style={marqueeStyle(marquee, toScreen)}
        />
      ) : null}

      {selected && world
        ? RESIZE_HANDLES.map((handle) => {
            const [hx, hy] = handlePosition(selected, handle)
            const [wx, wy] = apply(world, hx, hy)
            const [sx, sy] = toScreen(wx, wy)
            return (
              <div
                key={handle}
                // Pointer events pass through to the canvas, which owns the drag;
                // these only exist to be seen and to set the cursor.
                className="pointer-events-none absolute border border-primary bg-background"
                style={{
                  left: sx - HANDLE_SIZE_PIXELS / 2,
                  top: sy - HANDLE_SIZE_PIXELS / 2,
                  width: HANDLE_SIZE_PIXELS,
                  height: HANDLE_SIZE_PIXELS,
                  cursor: handleCursor(handle)
                }}
              />
            )
          })
        : null}
    </>
  )
}

function marqueeStyle(
  marquee: MarqueeState,
  toScreen: (x: number, y: number) => [number, number]
): { left: number; top: number; width: number; height: number } {
  const [x0, y0] = toScreen(marquee.startX, marquee.startY)
  const [x1, y1] = toScreen(marquee.x, marquee.y)
  return {
    left: Math.min(x0, x1),
    top: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0)
  }
}

/** World transform of a pane, recomputed from the document. */
function worldTransformOf(tab: DocumentTab, paneId: string): Affine | null {
  const entry = flattenPanes(tab.document.rootPane).find(
    (candidate) => candidate.pane.id === paneId
  )
  return entry?.world ?? null
}

function findById(pane: Pane | null, id: string): Pane | null {
  if (!pane) return null
  if (pane.id === id) return pane
  for (const child of pane.children) {
    const found = findById(child, id)
    if (found) return found
  }
  return null
}
