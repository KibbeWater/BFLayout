import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Braces,
  Database,
  Film,
  Image,
  Layers,
  Loader2,
  MessageSquareText,
  Palette,
  Puzzle,
  RefreshCw,
  Radio,
  Search,
  Share2,
  Type,
  X
} from 'lucide-react'

import type { IndexSearchHit } from '@shared/contract'
import { getClient, getOrpc } from '@renderer/lib/orpc'
import { reportError, reportSuccess } from '@renderer/lib/toast'
import { useFolder } from '@renderer/editor/store/folder'
import { useOpenFile } from '@renderer/lib/use-open-file'
import { useOpenLayout } from '@renderer/lib/use-open-layout'
import { WindowedList } from '@renderer/components/windowed-list'

/**
 * Searching the dump by the names inside its files.
 *
 * Browsing a romfs answers "what files are there"; almost every question a modder
 * actually has is the other one — *where is the thing called this*. Pane names,
 * texture names, material names and the game's own text all live inside binary
 * containers where no file browser and no `grep` can reach them. The index puts
 * them in sqlite; this is the way in.
 */

const KIND_ICON: Record<string, ReactNode> = {
  pane: <Layers className="size-3.5 text-primary" />,
  material: <Palette className="size-3.5 text-fuchsia-400" />,
  texture: <Image className="size-3.5 text-emerald-400" />,
  font: <Type className="size-3.5 text-amber-400" />,
  part: <Puzzle className="size-3.5 text-sky-400" />,
  animation: <Film className="size-3.5 text-fuchsia-400" />,
  animationTarget: <Film className="size-3.5 text-fuchsia-300" />,
  message: <MessageSquareText className="size-3.5 text-teal-400" />,
  bymlKey: <Braces className="size-3.5 text-teal-500" />
}

const FILTERS = [
  { key: 'pane', label: 'panes' },
  { key: 'texture', label: 'textures' },
  { key: 'material', label: 'materials' },
  { key: 'message', label: 'text' },
  { key: 'part', label: 'parts' },
  { key: 'animation', label: 'anims' },
  { key: 'bymlKey', label: 'byml' }
] as const

const ROW_HEIGHT = 40

/** Debounced, so typing does not fire a query per keystroke over 300,000 rows. */
function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return settled
}

/**
 * The running game's current screen, if a Colony plugin is reporting it.
 *
 * Recorded, never acted on: the report becomes a *search*, because the game's name
 * for a screen (`ScreenDialog`) and the file that draws it (`Dialog.bflyt`) agree
 * only by convention. Searching finds it when the naming lines up and shows the
 * near misses when it does not.
 */
function GameLink({ onFind }: { onFind: (name: string) => void }): ReactNode {
  const orpc = getOrpc()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)

  const status = useQuery({
    ...orpc.gameLink.status.queryOptions(),
    refetchInterval: (result) => (result.state.data?.listening ? 1000 : false)
  })

  const toggle = (): void => {
    setBusy(true)
    void (async () => {
      try {
        const client = getClient()
        if (status.data?.listening) {
          await client.gameLink.stop()
        } else {
          await client.gameLink.start({ port: 47600 })
        }
        void queryClient.invalidateQueries({ queryKey: orpc.gameLink.status.key() })
      } catch (cause) {
        reportError(cause, { retry: toggle })
      } finally {
        setBusy(false)
      }
    })()
  }

  const last = status.data?.last ?? null

  return (
    <div className="flex flex-col gap-1 border-t px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <Radio
          className={`size-3 shrink-0 ${status.data?.listening ? 'text-emerald-500' : 'text-muted-foreground/50'}`}
        />
        <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
          {status.data?.listening
            ? `Listening on 127.0.0.1:${status.data.port} for the game`
            : 'Game link off'}
        </span>
        <button
          type="button"
          onClick={toggle}
          disabled={busy}
          className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] hover:bg-accent disabled:opacity-50"
          title={
            status.data?.listening
              ? 'Stop listening'
              : 'Let a Colony plugin report which screen the game is showing (see docs/game-link.md)'
          }
        >
          {busy ? '…' : status.data?.listening ? 'Stop' : 'Start'}
        </button>
      </div>
      {last ? (
        <button
          type="button"
          onClick={() => onFind(last.screen)}
          className="flex items-center gap-1.5 rounded bg-primary/10 px-1.5 py-1 text-left text-[10px] hover:bg-primary/20"
          title="Search the index for this screen"
        >
          <span className="min-w-0 flex-1 truncate">
            Game is showing <span className="font-medium">{last.screen}</span>
            {last.layout ? ` (${last.layout})` : ''}
          </span>
          <span className="shrink-0 text-primary">find it</span>
        </button>
      ) : status.data?.error ? (
        <p className="text-[10px] text-destructive">{status.data.error}</p>
      ) : null}
    </div>
  )
}

export function SearchPanel(): ReactNode {
  const orpc = getOrpc()
  const queryClient = useQueryClient()
  const root = useFolder((state) => state.rootPath)
  const { openPath } = useOpenFile()
  const { openLayout } = useOpenLayout()

  const [raw, setRaw] = useState('')
  const [kinds, setKinds] = useState<string[]>([])
  const [opening, setOpening] = useState<string | null>(null)
  /**
   * The name whose *usages* are being shown, if any.
   *
   * Searching finds a thing; this asks the opposite question — what refers to it.
   * "Which layouts use this texture", "what instantiates this part", "which
   * animation drives this pane" are the same query in the other direction, and
   * they are the ones that tell you whether an edit is safe: a shared texture
   * changed for one screen changes every screen that names it.
   */
  const [usagesOf, setUsagesOf] = useState<string | null>(null)
  const query = useDebounced(raw, 200)

  /*
   * Polled while a build is running and left alone otherwise. Indexing a dump
   * takes minutes, so a static "building…" with no numbers is indistinguishable
   * from a hang.
   */
  const status = useQuery({
    ...orpc.index.status.queryOptions(),
    refetchInterval: (result) => (result.state.data?.state === 'building' ? 500 : false)
  })

  const indexedHere = useMemo(
    () => (status.data?.indexed ?? []).find((entry) => entry.rootPath === root),
    [status.data, root]
  )

  const results = useQuery({
    ...orpc.index.search.queryOptions({
      input: {
        query,
        ...(kinds.length > 0 ? { kinds } : {}),
        ...(root ? { rootPath: root } : {}),
        limit: 500
      }
    }),
    enabled: usagesOf === null && query.trim().length > 0 && indexedHere !== undefined
  })

  const usages = useQuery({
    ...orpc.index.references.queryOptions({
      input: {
        name: usagesOf ?? '',
        ...(root ? { rootPath: root } : {}),
        limit: 2000
      }
    }),
    enabled: usagesOf !== null && indexedHere !== undefined
  })

  const build = (): void => {
    if (!root) return
    void (async () => {
      try {
        await getClient().index.build({ rootPath: root })
        void queryClient.invalidateQueries({ queryKey: orpc.index.status.key() })
        reportSuccess(
          'Indexing started',
          'Reading every file in the dump. You can keep working while it runs.'
        )
      } catch (cause) {
        reportError(cause, { retry: build })
      }
    })()
  }

  /**
   * Opens what a hit points at.
   *
   * A hit inside an archive opens the archive and then that entry, which is the
   * whole payoff: the result of searching for a pane name is the layout on the
   * canvas, not a path to go and find.
   */
  const open = (hit: IndexSearchHit): void => {
    const absolute = `${hit.rootPath.replace(/\/+$/, '')}/${hit.relativePath}`
    const id = `${hit.relativePath}:${hit.entryName ?? ''}`
    setOpening(id)

    void (async () => {
      try {
        if (hit.entryName === null) {
          await openPath(absolute, 'auto')
          return
        }

        const archive = await getClient().archive.open({ path: absolute })
        const entry = archive.entries.find(
          (candidate) => candidate.displayName === hit.entryName
        )
        if (!entry) {
          reportError(
            new Error(
              `${hit.entryName} is no longer in ${archive.displayName}. The index may be out of date — rebuild it.`
            )
          )
          return
        }

        if (entry.kind === 'layout') {
          openLayout({ kind: 'archive', archiveId: archive.archiveId, entryKey: entry.key })
        } else {
          // Not something the canvas can show; the archive browser can.
          await openPath(absolute, 'archive')
        }
      } catch (cause) {
        reportError(cause, { retry: () => open(hit) })
      } finally {
        setOpening(null)
      }
    })()
  }

  if (!root) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
        <Database className="size-5 text-muted-foreground/50" />
        <p className="text-[11px] text-muted-foreground/70">
          Open a folder first. Searching works over an indexed dump — the names
          inside its files, not just their paths.
        </p>
      </div>
    )
  }

  const building = status.data?.state === 'building'
  const showing = usagesOf === null ? results : usages
  const hits = showing.data ?? []

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-1.5 border-b p-2">
        <div className="flex items-center gap-1.5">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            value={usagesOf === null ? raw : usagesOf}
            onChange={(event) => setRaw(event.target.value)}
            placeholder={indexedHere ? 'Pane, texture, material, text…' : 'Index the dump first'}
            disabled={!indexedHere || usagesOf !== null}
            spellCheck={false}
            className="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-xs disabled:opacity-50"
          />
          {usagesOf !== null ? (
            <button
              type="button"
              onClick={() => setUsagesOf(null)}
              className="shrink-0 rounded p-1 hover:bg-accent"
              title="Back to searching"
              aria-label="Back to searching"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
          <button
            type="button"
            onClick={build}
            disabled={building}
            className="shrink-0 rounded p-1 hover:bg-accent disabled:opacity-50"
            title={indexedHere ? 'Rebuild the index' : 'Index this dump'}
            aria-label={indexedHere ? 'Rebuild the index' : 'Index this dump'}
          >
            {usagesOf !== null ? (
          <p className="text-[10px] text-muted-foreground/70">
            {usages.isFetching
              ? 'Looking for usages…'
              : `${hits.length.toLocaleString()} file${hits.length === 1 ? '' : 's'} name “${usagesOf}”`}
          </p>
        ) : building ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
          </button>
        </div>

        <div className="flex flex-wrap gap-1">
          {FILTERS.map((filter) => {
            const on = kinds.includes(filter.key)
            return (
              <button
                key={filter.key}
                type="button"
                onClick={() =>
                  setKinds(
                    on
                      ? kinds.filter((kind) => kind !== filter.key)
                      : [...kinds, filter.key]
                  )
                }
                className={`rounded px-1.5 py-0.5 text-[10px] ${
                  on
                    ? 'bg-primary/20 text-primary'
                    : 'bg-muted/50 text-muted-foreground hover:text-foreground'
                }`}
              >
                {filter.label}
              </button>
            )
          })}
        </div>

        {usagesOf !== null ? (
          <p className="text-[10px] text-muted-foreground/70">
            {usages.isFetching
              ? 'Looking for usages…'
              : `${hits.length.toLocaleString()} file${hits.length === 1 ? '' : 's'} name “${usagesOf}”`}
          </p>
        ) : building ? (
          <p className="text-[10px] text-muted-foreground/70">
            Indexing {status.data?.done.toLocaleString()} / {status.data?.total.toLocaleString()}
            {status.data?.currentFile ? ` — ${status.data.currentFile}` : ''}
          </p>
        ) : status.data?.state === 'failed' ? (
          <p className="text-[10px] text-destructive">
            Indexing failed: {status.data.detail ?? 'no detail'}
          </p>
        ) : indexedHere ? (
          <p className="text-[10px] text-muted-foreground/60">
            {indexedHere.symbolCount.toLocaleString()} names across{' '}
            {indexedHere.fileCount.toLocaleString()} files
            {results.data ? ` · ${hits.length.toLocaleString()} shown` : ''}
          </p>
        ) : (
          <p className="text-[10px] text-muted-foreground/60">
            Not indexed yet. Reading the whole dump takes a few minutes and only has
            to happen once.
          </p>
        )}
      </div>

      {showing.isFetching && hits.length === 0 ? (
        <p className="flex items-center gap-2 p-3 text-xs text-muted-foreground/60">
          <Loader2 className="size-3 animate-spin" />
          {usagesOf === null ? 'Searching…' : 'Looking for usages…'}
        </p>
      ) : hits.length === 0 ? (
        <p className="p-3 text-[11px] text-muted-foreground/60">
          {usagesOf !== null
            ? `Nothing else names “${usagesOf}”.`
            : query.trim() === ''
              ? 'Type to search names inside every file in the dump.'
              : 'Nothing matched.'}
        </p>
      ) : (
        <WindowedList
          items={hits}
          rowHeight={ROW_HEIGHT}
          className="min-h-0 flex-1 overflow-auto p-1"
          keyOf={(hit) =>
            `${hit.relativePath}:${hit.entryName ?? ''}:${hit.kind}:${hit.name}:${hit.detail ?? ''}`
          }
          renderRow={(hit) => {
            const id = `${hit.relativePath}:${hit.entryName ?? ''}`
            return (
              <div className="group flex h-full w-full items-center">
                <button
                  type="button"
                  onClick={() => open(hit)}
                  disabled={opening === id}
                  className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 text-left hover:bg-accent/60 disabled:opacity-60"
                  title={`${hit.relativePath}${hit.entryName ? ` → ${hit.entryName}` : ''}`}
                >
                  {opening === id ? (
                    <Loader2 className="size-3.5 shrink-0 animate-spin" />
                  ) : (
                    (KIND_ICON[hit.kind] ?? <Search className="size-3.5 text-muted-foreground" />)
                  )}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-xs">{hit.name}</span>
                    <span className="truncate text-[10px] text-muted-foreground/60">
                      {hit.detail ? `${hit.detail} · ` : ''}
                      {hit.entryName ?? hit.relativePath}
                    </span>
                  </span>
                  <span className="shrink-0 text-[9px] uppercase text-muted-foreground/50">
                    {hit.kind}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setUsagesOf(hit.name)}
                  className="mr-1 shrink-0 rounded p-1 opacity-0 hover:bg-accent focus-visible:opacity-100 group-hover:opacity-100"
                  title={`Find every file that names ${hit.name}`}
                  aria-label={`Find every file that names ${hit.name}`}
                >
                  <Share2 className="size-3 text-muted-foreground/70" />
                </button>
              </div>
            )
          }}
        />
      )}

      <GameLink
        onFind={(name) => {
          setUsagesOf(null)
          setRaw(name)
        }}
      />
    </div>
  )
}
