import { useEffect, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'

import { IS_MAC } from '@renderer/lib/use-fullscreen'

/**
 * The keyboard reference, on ⌘/ or from the Help menu.
 *
 * Most of what makes this editor quick to use is not on screen: nudging with the
 * arrow keys, reordering with Alt, the panel toggles. A shortcut nobody can
 * discover is a shortcut nobody uses, and the README is the wrong place to look
 * while your hands are on the keyboard.
 *
 * The table is here rather than derived from the menu because half of these are
 * canvas key handlers that never appear in a menu at all — the arrow-key nudges
 * are deliberately raw keydown handling, since Shift and Alt change what the key
 * *means* rather than selecting a different command.
 */

interface Group {
  readonly title: string
  readonly rows: readonly (readonly [string, string])[]
}

const GROUPS: readonly Group[] = [
  {
    title: 'Files',
    rows: [
      ['Mod+O', 'Open a file'],
      ['Mod+Shift+O', 'Open a folder'],
      ['Mod+S', 'Save'],
      ['Mod+Shift+S', 'Save as'],
      ['Mod+Z', 'Undo'],
      ['Mod+Shift+Z', 'Redo']
    ]
  },
  {
    title: 'Selection',
    rows: [
      ['Mod+A', 'Select every pane'],
      ['Escape', 'Clear the selection'],
      ['Mod+D', 'Duplicate beside itself'],
      ['Delete', 'Delete the selection']
    ]
  },
  {
    title: 'Moving panes',
    rows: [
      ['Arrows', 'Nudge by 1'],
      ['Shift+Arrows', 'Nudge by 10'],
      ['Alt+Up / Down', 'Bring forward / send backward'],
      ['Alt+Left / Right', 'Move out of the parent / into the pane above']
    ]
  },
  {
    title: 'View',
    rows: [
      ['Mod+1', 'Files, Archive & Textures'],
      ['Mod+2', 'Hierarchy'],
      ['Mod+3', 'Properties'],
      ['Mod+4', 'Animation timeline'],
      ['Mod+0', 'Canvas only'],
      ['Mod+F', 'Fit the layout to the view'],
      ['Mod+,', 'Settings'],
      ['Mod+/', 'This list']
    ]
  }
]

/** `Mod` is Command on macOS and Control everywhere else — the same rule the app uses. */
function forPlatform(keys: string): string {
  return keys.replace(/Mod/g, IS_MAC ? '⌘' : 'Ctrl').replace(/\+/g, IS_MAC ? '' : '+')
}

export function ShortcutsOverlay(): ReactNode {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const api = window.bflayout
    if (!api?.onMenuCommand) return
    return api.onMenuCommand((command) => {
      if (command === 'show-shortcuts') setOpen((showing) => !showing)
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
    // A plain overlay rather than a native dialog: it is reference material, it
    // should not steal focus from the canvas, and Escape closing it is enough.
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 p-8"
      onClick={() => setOpen(false)}
      role="presentation"
    >
      <div
        className="max-h-full w-full max-w-2xl overflow-auto rounded-lg border bg-card p-5 shadow-xl"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-label="Keyboard shortcuts"
      >
        <div className="mb-4 flex items-center">
          <h2 className="flex-1 text-sm font-semibold">Keyboard shortcuts</h2>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded p-1 hover:bg-accent"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          {GROUPS.map((group) => (
            <section key={group.title}>
              <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {group.title}
              </h3>
              <dl className="space-y-1">
                {group.rows.map(([keys, what]) => (
                  <div key={keys} className="flex items-baseline gap-3">
                    <dt className="w-32 shrink-0 font-mono text-[11px] text-foreground">
                      {forPlatform(keys)}
                    </dt>
                    <dd className="min-w-0 flex-1 text-[11px] text-muted-foreground">{what}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>

        <p className="mt-4 text-[11px] text-muted-foreground/60">
          Arrow keys move the selection on the canvas. In a text field they move the
          caret — the editor checks where focus is before acting.
        </p>
      </div>
    </div>
  )
}
