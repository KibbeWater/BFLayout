import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { FileUp, FolderOpen, History, Layers, LifeBuoy, Loader2, Pin, X } from 'lucide-react'

import { getClient, getOrpc } from '@renderer/lib/orpc'
import { reportError, reportInfo, reportSuccess } from '@renderer/lib/toast'
import { useDocuments } from '@renderer/editor/store/document'
import { useOpenFile } from '@renderer/lib/use-open-file'
import { useSessionRestore } from '@renderer/lib/use-session'
import { IS_MAC, useFullscreen } from '@renderer/lib/use-fullscreen'

/**
 * Offers the previous session back rather than reopening it automatically. An
 * archive that has moved or been repacked since would otherwise turn every
 * launch into an error screen.
 */
function SessionCard(): ReactNode {
  const navigate = useNavigate()
  const { snapshot, restoring, restore, dismiss } = useSessionRestore(() =>
    void navigate({ to: '/editor' })
  )

  if (!snapshot) return null

  const layouts = snapshot.layouts.length
  const archives = snapshot.archives.length

  return (
    <div className="flex w-full max-w-xl items-center gap-3 rounded-lg border bg-card/60 p-3">
      <History className="size-4 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1 text-xs">
        <span className="font-medium">Previous session</span>
        <span className="text-muted-foreground">
          {' — '}
          {archives} archive{archives === 1 ? '' : 's'}, {layouts} layout
          {layouts === 1 ? '' : 's'}
        </span>
      </p>
      <button
        type="button"
        onClick={restore}
        disabled={restoring}
        className="flex items-center gap-1.5 rounded border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
      >
        {restoring ? <Loader2 className="size-3.5 animate-spin" /> : null}
        Reopen
      </button>
      <button
        type="button"
        onClick={dismiss}
        className="rounded p-1 hover:bg-accent"
        aria-label="Dismiss the previous session"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}

/**
 * Offers back documents that were unsaved when the process last went away.
 *
 * Distinct from the previous-session card above, which reopens *files* from disk. This
 * restores the working document itself — edits that were never written anywhere — so it
 * is the only thing standing between a crash and lost work. It is offered rather than
 * applied automatically for the same reason: silently reinstating an in-memory copy over
 * a file someone has since changed elsewhere would be its own way to lose work.
 */
function RecoveryCard(): ReactNode {
  const orpc = getOrpc()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const openTab = useDocuments((state) => state.openTab)
  const [busy, setBusy] = useState(false)

  const available = useQuery(orpc.snapshot.list.queryOptions())
  const snapshots = available.data ?? []
  if (snapshots.length === 0) return null

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: orpc.snapshot.list.key() })
  }

  const restore = (): void => {
    setBusy(true)
    void (async () => {
      const client = getClient()
      let recovered = 0
      try {
        for (const summary of snapshots) {
          const record = await client.snapshot.get({ documentId: summary.documentId })
          // A snapshot whose row will not parse is skipped rather than failing the lot.
          if (!record) continue
          openTab(
            {
              documentId: record.documentId,
              displayName: record.displayName,
              source: record.source,
              document: record.document
            },
            { newTab: true }
          )
          recovered++
        }

        if (recovered === 0) {
          reportInfo(
            'Nothing to recover',
            'The snapshots could not be read back, so they have been discarded.'
          )
          await client.snapshot.clear()
        } else {
          reportSuccess(
            'Recovered',
            `${recovered} unsaved layout${recovered === 1 ? '' : 's'} restored. They are still unsaved — save to write them to disk.`
          )
          await navigate({ to: '/editor' })
        }
        invalidate()
      } catch (cause) {
        reportError(cause, { retry: restore })
      } finally {
        setBusy(false)
      }
    })()
  }

  const discard = (): void => {
    void (async () => {
      try {
        await getClient().snapshot.clear()
        invalidate()
      } catch (cause) {
        reportError(cause, { retry: discard })
      }
    })()
  }

  const newest = Math.max(...snapshots.map((entry) => entry.updatedAt))

  return (
    <div className="flex w-full max-w-xl items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
      <LifeBuoy className="size-4 shrink-0 text-amber-500" />
      <p className="min-w-0 flex-1 text-xs">
        <span className="font-medium">Unsaved work recovered</span>
        <span className="text-muted-foreground">
          {' — '}
          {snapshots.length} layout{snapshots.length === 1 ? '' : 's'}, last edited{' '}
          {new Date(newest).toLocaleString()}
        </span>
      </p>
      <button
        type="button"
        onClick={restore}
        disabled={busy}
        className="flex items-center gap-1.5 rounded border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
        Recover
      </button>
      <button
        type="button"
        onClick={discard}
        className="rounded p-1 hover:bg-accent"
        aria-label="Discard the recovered work"
        title="Discard the recovered work"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}

export function WelcomeScreen(): ReactNode {
  const orpc = getOrpc()
  const queryClient = useQueryClient()
  const { openViaDialog, openFolderViaDialog, openPath, busy } = useOpenFile()
  const fullscreen = useFullscreen()
  const settings = useQuery(orpc.app.settings.get.queryOptions())
  const recents = useQuery(orpc.app.recents.list.queryOptions())

  const invalidateRecents = (): void => {
    void queryClient.invalidateQueries({ queryKey: orpc.app.recents.list.key() })
  }

  const setPinned = useMutation(
    orpc.app.recents.setPinned.mutationOptions({ onSuccess: invalidateRecents })
  )
  const remove = useMutation(
    orpc.app.recents.remove.mutationOptions({ onSuccess: invalidateRecents })
  )

  return (
    // Extra top padding clears the macOS traffic lights, which hiddenInset draws
    // over the content — but not in fullscreen, where there are none.
    <div
      className={`flex h-full flex-col items-center justify-center gap-8 overflow-auto p-10 ${
        IS_MAC && !fullscreen ? 'pt-16' : ''
      }`}
    >
      <div className="flex flex-col items-center gap-3">
        <div className="flex items-center gap-3">
          <Layers className="size-7 text-primary" />
          <h1 className="text-2xl font-semibold tracking-tight">BFLayout</h1>
        </div>
        <p className="max-w-md text-center text-muted-foreground">
          Layout editor for Nintendo Switch BFLYT files and the archives they ship in.
        </p>
      </div>

      <RecoveryCard />
      <SessionCard />

      <div className="flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          onClick={openViaDialog}
          disabled={busy}
          className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <FileUp className="size-4" />}
          Open file…
        </button>
        <button
          type="button"
          onClick={openFolderViaDialog}
          disabled={busy}
          className="flex items-center gap-2 rounded-md border px-4 py-2 font-medium hover:bg-accent disabled:opacity-60"
          title="Browse a game dump — point it at a romfs directory"
        >
          <FolderOpen className="size-4" />
          Open folder…
        </button>
      </div>
      <p className="-mt-4 max-w-md text-center text-xs text-muted-foreground/70">
        A folder opens a browser for a dumped romfs; a file opens an archive or a
        loose layout directly.
      </p>

      <section className="w-full max-w-lg">
        <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Recent
        </h2>
        {recents.isPending ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground/60">
            <Loader2 className="size-3 animate-spin" />
            Loading…
          </p>
        ) : recents.isError ? (
          <div className="rounded-md border border-destructive/50 p-3">
            <p className="text-xs text-muted-foreground">
              Recent files could not be loaded.
            </p>
            <button
              type="button"
              onClick={() => void recents.refetch()}
              className="mt-2 rounded border px-2 py-1 text-xs hover:bg-accent"
            >
              Try again
            </button>
          </div>
        ) : recents.data && recents.data.length > 0 ? (
          /**
           * Capped and scrollable. The list holds up to 40 entries plus pinned ones,
           * which pushed the Open buttons off the bottom of the window — the one
           * thing on this screen that has to stay reachable.
           */
          <ul className="max-h-64 divide-y overflow-y-auto rounded-md border">
            {recents.data.map((entry) => (
              <li key={entry.id} className="flex items-center gap-2 px-3 py-2">
                <button
                  type="button"
                  onClick={(event) =>
                    void openPath(
                      entry.path,
                      'auto',
                      event.metaKey || event.ctrlKey || event.shiftKey
                    )
                  }
                  disabled={busy}
                  className="flex-1 truncate text-left hover:underline disabled:opacity-60"
                  title={entry.path}
                >
                  {entry.displayName}
                </button>
                <span className="text-[11px] uppercase text-muted-foreground/70">
                  {entry.kind}
                </span>
                <button
                  type="button"
                  onClick={() => setPinned.mutate({ id: entry.id, pinned: !entry.pinned })}
                  className="rounded p-1 hover:bg-accent"
                  title={entry.pinned ? 'Unpin' : 'Pin'}
                >
                  <Pin
                    className={`size-3.5 ${entry.pinned ? 'text-primary' : 'text-muted-foreground/60'}`}
                  />
                </button>
                <button
                  type="button"
                  onClick={() => remove.mutate({ id: entry.id })}
                  className="rounded p-1 hover:bg-accent"
                  title="Remove"
                >
                  <X className="size-3.5 text-muted-foreground/60" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground/60">
            Nothing yet — opened files will be listed here.
          </p>
        )}
      </section>

      {settings.data ? (
        <p className="text-[11px] text-muted-foreground/50">
          grid {settings.data.gridSize}px · theme {settings.data.theme}
        </p>
      ) : null}
    </div>
  )
}
