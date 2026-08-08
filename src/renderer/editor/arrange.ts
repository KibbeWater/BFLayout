import type { LayoutDocument } from '@shared/formats/bflyt'
import {
  alignDeltas,
  distributeDeltas,
  type AlignEdge
} from '@shared/formats/bflyt/editing'
import {
  apply,
  flattenPanes,
  invert,
  worldBounds,
  type PaneTransform
} from '@shared/formats/bflyt/transform'
import {
  composeCommands,
  placementOf,
  setPaneFields,
  type Command
} from '@renderer/editor/commands'

/**
 * Aligning and distributing a multi-pane selection.
 *
 * Multi-select could previously only be dragged: the properties panel edits
 * `selectedPaneIds[0]` and nothing acted on the group, so the marquee and shift-click
 * machinery had no payoff. These are the operations layout work is mostly made of.
 *
 * Kept out of the canvas component because it needs no GL: `flattenPanes` is pure, so
 * the properties panel can compute world positions itself rather than reaching into
 * the renderer.
 */
export type Arrangement = AlignEdge | 'distributeX' | 'distributeY'

export const ARRANGEMENT_LABELS: Record<Arrangement, string> = {
  left: 'Align left',
  centerX: 'Align horizontal centres',
  right: 'Align right',
  top: 'Align tops',
  centerY: 'Align vertical centres',
  bottom: 'Align bottoms',
  distributeX: 'Distribute horizontally',
  distributeY: 'Distribute vertically'
}

/**
 * Converts a world-space delta into `pane`'s parent's space.
 *
 * `translate` is expressed relative to the parent, so a shared world offset is a
 * different local offset for each pane once any ancestor rotates or scales.
 */
function toParentDelta(
  parent: PaneTransform | undefined,
  dx: number,
  dy: number
): [number, number] {
  if (!parent) return [dx, dy]
  const inverse = invert(parent.world)
  if (!inverse) return [dx, dy]
  const [ox, oy] = apply(inverse, 0, 0)
  const [px, py] = apply(inverse, dx, dy)
  return [px - ox, py - oy]
}

/**
 * Drops panes whose ancestor is also selected.
 *
 * A child already moves with its parent, so aligning both would move the child twice
 * and undo the alignment it had just been given.
 */
function independent(
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
 * The command for one arrangement, or null when there is nothing to do — fewer than
 * two independent panes, or every delta already zero.
 */
export function arrangeCommand(
  document: LayoutDocument,
  selection: readonly string[],
  how: Arrangement
): Command | null {
  if (!document.rootPane) return null

  const flattened = flattenPanes(document.rootPane)
  const byId = new Map(flattened.map((entry) => [entry.pane.id, entry]))

  const targets = independent(flattened, selection)
    .map((id) => byId.get(id))
    .filter((entry): entry is PaneTransform => entry !== undefined)
  if (targets.length < 2) return null

  const rects = targets.map((entry) => worldBounds(entry))
  const deltas =
    how === 'distributeX'
      ? distributeDeltas(rects, 'x')
      : how === 'distributeY'
        ? distributeDeltas(rects, 'y')
        : alignDeltas(rects, how)

  const commands: Command[] = []
  targets.forEach((entry, index) => {
    const [dx, dy] = deltas[index] ?? [0, 0]
    if (dx === 0 && dy === 0) return

    const placement = placementOf(document, entry.pane.id)
    const parent = placement ? byId.get(placement.parentId) : undefined
    const [localDx, localDy] = toParentDelta(parent, dx, dy)
    if (localDx === 0 && localDy === 0) return

    const before = [...entry.pane.translate] as [number, number, number]
    commands.push(
      setPaneFields(
        entry.pane.id,
        ARRANGEMENT_LABELS[how],
        { translate: before },
        {
          translate: [before[0] + localDx, before[1] + localDy, before[2]] as [
            number,
            number,
            number
          ]
        }
      )
    )
  })

  if (commands.length === 0) return null
  return composeCommands(ARRANGEMENT_LABELS[how], commands)
}
