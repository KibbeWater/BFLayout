import { useMemo, type ReactNode } from 'react'

import type { LayoutDocument, Material, Pane, Rgba } from '@shared/formats/bflyt'
import { walkPanes } from '@shared/formats/bflyt'
import { useActiveTab, useDocuments } from '@renderer/editor/store/document'

/**
 * Lists every material in the layout, what it samples and who uses it.
 *
 * The properties panel edits the material a *selected pane* happens to use, which
 * is the wrong shape for two common questions: what materials does this layout
 * have, and which panes share this one. Materials are shared aggressively — a
 * button archive often has three materials for a dozen panes — so seeing the usage
 * count before editing is what stops a "quick colour tweak" changing six panes.
 *
 * Clicking a row selects the panes that use it.
 */
export function MaterialsPanel(): ReactNode {
  const tab = useActiveTab()

  /*
   * Above the early returns, and keyed on the revision rather than on `tab`.
   *
   * Hooks have to run unconditionally on every render. With this below the guards, closing
   * the last tab while the Materials panel was open rendered one hook fewer than the
   * previous pass and React threw — straight to the error boundary. `MaterialSection` in
   * properties.tsx had exactly this bug and exactly this fix; this panel never got it.
   */
  const users = useMemo(
    () => (tab ? collectUsers(tab.document) : new Map<number, Pane[]>()),
    [tab?.documentId, tab?.revision]
  )

  if (!tab) {
    return <p className="p-3 text-xs text-muted-foreground/60">Open a layout to see its materials.</p>
  }

  const { materials } = tab.document
  if (materials.length === 0) {
    return <p className="p-3 text-xs text-muted-foreground/60">This layout has no materials.</p>
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <ul className="p-1">
        {materials.map((material, index) => (
          <MaterialRow
            key={`${index}-${material.name}`}
            material={material}
            index={index}
            document={tab.document}
            users={users.get(index) ?? []}
          />
        ))}
      </ul>
      <p className="border-t px-2 py-1 text-[10px] text-muted-foreground/60">
        {materials.length} material{materials.length === 1 ? '' : 's'} ·{' '}
        {materials.filter((material) => material.dirty).length} edited
      </p>
    </div>
  )
}

/** Material index to the panes that draw with it. */
function collectUsers(document: LayoutDocument): Map<number, Pane[]> {
  const users = new Map<number, Pane[]>()
  const add = (index: number, pane: Pane): void => {
    const list = users.get(index)
    if (list) {
      if (!list.includes(pane)) list.push(pane)
    } else {
      users.set(index, [pane])
    }
  }

  walkPanes(document.rootPane, (pane) => {
    switch (pane.kind) {
      case 'pic1':
      case 'txt1':
        add((pane as { materialIndex: number }).materialIndex, pane)
        break
      case 'wnd1': {
        const window = pane as {
          content: { materialIndex: number }
          frames: { materialIndex: number }[]
        }
        add(window.content.materialIndex, pane)
        for (const frame of window.frames) add(frame.materialIndex, pane)
        break
      }
      default:
        break
    }
  })

  return users
}

function MaterialRow({
  material,
  index,
  document,
  users
}: {
  material: Material
  index: number
  document: LayoutDocument
  users: Pane[]
}): ReactNode {
  const select = useDocuments((state) => state.select)
  const tab = useActiveTab()

  const textures = material.textureMaps
    .map((map) => (map.textureIndex >= 0 ? document.textures[map.textureIndex] : null))
    .filter((name): name is string => name !== null)

  const selected =
    users.length > 0 && users.every((pane) => tab?.selectedPaneIds.includes(pane.id))

  return (
    <li>
      <button
        type="button"
        onClick={() => select(users.map((pane) => pane.id))}
        disabled={users.length === 0}
        title={
          users.length > 0
            ? `Select the ${users.length} pane${users.length === 1 ? '' : 's'} using this material`
            : 'No pane uses this material'
        }
        className={`w-full rounded px-1.5 py-1 text-left hover:bg-accent/60 disabled:cursor-default disabled:hover:bg-transparent ${
          selected ? 'bg-accent' : ''
        }`}
      >
        <div className="flex items-center gap-1.5">
          <span className="w-5 shrink-0 text-right font-mono text-[10px] text-muted-foreground/50">
            {index}
          </span>
          <Swatch color={material.blackColor} title="Black colour" />
          <Swatch color={material.whiteColor} title="White colour" />
          <span className="min-w-0 flex-1 truncate text-xs" title={material.name}>
            {material.name || '(unnamed)'}
          </span>
          {material.dirty ? (
            <span
              className="size-1.5 shrink-0 rounded-full bg-primary"
              title="Edited; will be re-encoded on save"
            />
          ) : null}
        </div>

        <div className="ml-6 flex flex-wrap items-center gap-x-2 text-[10px] text-muted-foreground/70">
          <span>
            {users.length} pane{users.length === 1 ? '' : 's'}
          </span>
          {textures.length > 0 ? (
            <span className="truncate" title={textures.join(', ')}>
              {textures.join(', ')}
            </span>
          ) : (
            <span className="text-muted-foreground/40">no texture</span>
          )}
          {material.blendMode ? <span>blend</span> : null}
          {material.alphaCompare ? <span>alpha test</span> : null}
          {material.tevStages.length > 0 ? <span>{material.tevStages.length} TEV</span> : null}
        </div>
      </button>
    </li>
  )
}

function Swatch({ color, title }: { color: Rgba; title: string }): ReactNode {
  return (
    <span
      className="size-3 shrink-0 rounded-sm border border-border/60"
      title={`${title}: rgba(${color.join(', ')})`}
      style={{
        // Chequerboard behind the swatch so a transparent colour is not a blank.
        backgroundImage: `linear-gradient(rgba(${color[0]},${color[1]},${color[2]},${
          color[3] / 255
        }), rgba(${color[0]},${color[1]},${color[2]},${color[3] / 255})), repeating-conic-gradient(#555 0 25%, #333 0 50%)`,
        backgroundSize: '100%, 6px 6px'
      }}
    />
  )
}
