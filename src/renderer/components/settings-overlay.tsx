import { useEffect, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, X } from 'lucide-react'

import type { AppSettings } from '@shared/contract'
import { getOrpc } from '@renderer/lib/orpc'
import { ProjectSettings } from '@renderer/components/project-settings'

/**
 * Settings, on ⌘, — where macOS puts them and where people look.
 *
 * Two sections because there are genuinely two kinds. **Editor** settings belong
 * to the person and follow them between projects: the theme, the grid, whether
 * snapping is on. **Project** settings belong to the mod and travel with it: where
 * it deploys, what counts as part of it, which checks apply.
 *
 * Every editor setting here was already persisted and adjustable only by editing
 * the database or hunting for a toggle in a panel. That is the gap this closes.
 */

function Row({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}): ReactNode {
  return (
    <label className="flex items-start gap-3 py-1.5">
      <span className="min-w-0 flex-1">
        <span className="block text-xs">{label}</span>
        {hint ? <span className="block text-[11px] text-muted-foreground/70">{hint}</span> : null}
      </span>
      <span className="shrink-0">{children}</span>
    </label>
  )
}

function EditorSettings(): ReactNode {
  const orpc = getOrpc()
  const queryClient = useQueryClient()
  const settings = useQuery(orpc.app.settings.get.queryOptions())

  const patch = useMutation(
    orpc.app.settings.patch.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.app.settings.get.key() })
    })
  )

  if (!settings.data) {
    return (
      <p className="flex items-center gap-2 p-3 text-xs text-muted-foreground/60">
        <Loader2 className="size-3 animate-spin" />
        Loading…
      </p>
    )
  }

  const value = settings.data
  const set = (change: Partial<AppSettings>): void => patch.mutate(change)

  return (
    <div className="divide-y">
      <Row label="Theme" hint="System follows macOS, including the window chrome.">
        <select
          value={value.theme}
          onChange={(event) => set({ theme: event.target.value as AppSettings['theme'] })}
          className="rounded border bg-background px-2 py-1 text-xs"
        >
          <option value="system">System</option>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </Row>

      <Row label="Show the grid">
        <input
          type="checkbox"
          checked={value.showGrid}
          onChange={(event) => set({ showGrid: event.target.checked })}
        />
      </Row>
      <Row label="Grid size" hint="Pixels between lines.">
        <input
          type="number"
          min={2}
          max={512}
          value={value.gridSize}
          onChange={(event) => set({ gridSize: Number(event.target.value) })}
          className="w-20 rounded border bg-background px-2 py-1 font-mono text-xs"
        />
      </Row>
      <Row label="Snap to guides" hint="Aligns a dragged pane to its neighbours' edges.">
        <input
          type="checkbox"
          checked={value.snapToGuides}
          onChange={(event) => set({ snapToGuides: event.target.checked })}
        />
      </Row>

      <Row
        label="Canvas background"
        hint="Layouts are authored over both light and dark game art."
      >
        <input
          type="color"
          value={value.backgroundColor}
          onChange={(event) => set({ backgroundColor: event.target.value })}
          className="h-7 w-14 rounded border bg-background"
        />
      </Row>

      <Row label="Outline the root pane">
        <input
          type="checkbox"
          checked={value.showRootPaneBounds}
          onChange={(event) => set({ showRootPaneBounds: event.target.checked })}
        />
      </Row>
      <Row
        label="Show panes the game hides"
        hint="Draws invisible panes dimmed rather than omitting them."
      >
        <input
          type="checkbox"
          checked={value.showInvisiblePanes}
          onChange={(event) => set({ showInvisiblePanes: event.target.checked })}
        />
      </Row>
      <Row
        label="Move children with their parent"
        hint="Off drags a pane out of its parent's transform instead."
      >
        <input
          type="checkbox"
          checked={value.transformChildren}
          onChange={(event) => set({ transformChildren: event.target.checked })}
        />
      </Row>
      <Row
        label="Draw parts as empty boxes"
        hint="Parts otherwise draw the layout they instantiate, which can be slow in a deep tree."
      >
        <input
          type="checkbox"
          checked={value.viewPartsAsNullPanes}
          onChange={(event) => set({ viewPartsAsNullPanes: event.target.checked })}
        />
      </Row>

      <Row label="Folder browser" hint="A tree suits hunting down; a list suits a big folder.">
        <select
          value={value.folderViewMode}
          onChange={(event) =>
            set({ folderViewMode: event.target.value as AppSettings['folderViewMode'] })
          }
          className="rounded border bg-background px-2 py-1 text-xs"
        >
          <option value="tree">Tree</option>
          <option value="list">List</option>
        </select>
      </Row>
    </div>
  )
}

export function SettingsOverlay(): ReactNode {
  const orpc = getOrpc()
  const [open, setOpen] = useState(false)
  const [section, setSection] = useState<'editor' | 'project'>('editor')

  const project = useQuery({ ...orpc.project.active.queryOptions(), enabled: open })

  useEffect(() => {
    const api = window.bflayout
    if (!api?.onMenuCommand) return
    return api.onMenuCommand((command) => {
      if (command === 'open-settings') setOpen((showing) => !showing)
    })
  }, [])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 p-8"
      onClick={() => setOpen(false)}
      role="presentation"
    >
      <div
        className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-lg border bg-card shadow-xl"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-label="Settings"
      >
        <div className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
          <h2 className="text-sm font-semibold">Settings</h2>
          <div className="flex items-center gap-1">
            {(['editor', 'project'] as const).map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => setSection(name)}
                className={`rounded px-2 py-1 text-[11px] font-medium uppercase tracking-wide ${
                  section === name
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {name}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="ml-auto rounded p-1 hover:bg-accent"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-4">
          {section === 'editor' ? (
            <EditorSettings />
          ) : project.data ? (
            <ProjectSettings project={project.data} onClose={() => setOpen(false)} />
          ) : (
            <p className="p-3 text-xs text-muted-foreground/70">
              No mod project is open. Project settings — where it deploys, what counts as
              part of it, which checks apply — belong to a project, so open one first.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
