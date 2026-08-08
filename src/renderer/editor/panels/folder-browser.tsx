import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Braces,
  ChevronDown,
  ChevronRight,
  FileAudio,
  FileQuestion,
  FileText,
  Film,
  Folder,
  FolderOpen,
  Image,
  Layers,
  List,
  ListTree,
  Loader2,
  Package,
  PackageOpen,
  Box,
  Type
} from 'lucide-react'

import type { FolderEntry, FolderEntryKind, FolderViewMode } from '@shared/contract'
import { getClient, getOrpc } from '@renderer/lib/orpc'
import { describeError } from '@renderer/lib/errors'
import { reportError, reportSuccess } from '@renderer/lib/toast'
import { useOpenFile } from '@renderer/lib/use-open-file'
import { useFolder } from '@renderer/editor/store/folder'
import { WindowedList } from '@renderer/components/windowed-list'

/**
 * Browses a folder on disk, built for a dumped romfs.
 *
 * Directories are listed only when opened — a dump is tens of thousands of files
 * across a deep tree, and walking it up front would stall before showing anything.
 * That holds in both view modes: the tree fetches a directory when it is expanded,
 * so an expanded tree costs exactly the directories you opened.
 *
 * Two modes because the two shapes of romfs directory need different things. A
 * tree suits hunting down through Pack/Actor/…; a flat list suits `Layout/`, where
 * 544 siblings in an indented tree are unreadable. The choice is a setting.
 */

const KIND_ICON: Record<FolderEntryKind, ReactNode> = {
  directory: <Folder className="size-3.5 text-sky-400" />,
  layout: <Layers className="size-3.5 text-primary" />,
  layoutArchive: <PackageOpen className="size-3.5 text-primary" />,
  animation: <Film className="size-3.5 text-fuchsia-400" />,
  texture: <Image className="size-3.5 text-emerald-400" />,
  font: <Type className="size-3.5 text-amber-400" />,
  fontArchive: <Type className="size-3.5 text-amber-600" />,
  archive: <Package className="size-3.5 text-orange-400" />,
  byml: <Braces className="size-3.5 text-teal-400" />,
  model: <Box className="size-3.5 text-indigo-400" />,
  audio: <FileAudio className="size-3.5 text-rose-400" />,
  text: <FileText className="size-3.5 text-muted-foreground" />,
  other: <FileQuestion className="size-3.5 text-muted-foreground/40" />
}

/** Kinds this editor can actually open, so the rest can be visibly inert. */
const OPENABLE = new Set<FolderEntryKind>([
  'layout',
  'layoutArchive',
  'archive',
  'directory',
  // BYML documents open in the read-only tree viewer.
  'byml'
])

function formatSize(bytes: number): string {
  if (bytes === 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function FolderBrowser(): ReactNode {
  const orpc = getOrpc()
  const queryClient = useQueryClient()
  const root = useFolder((state) => state.path)
  const anchor = useFolder((state) => state.rootPath)
  const settings = useQuery(orpc.app.settings.get.queryOptions())
  const patch = useMutation(
    orpc.app.settings.patch.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.app.settings.get.key() })
    })
  )

  const mode: FolderViewMode = settings.data?.folderViewMode ?? 'tree'

  if (!root) return <OpenFolderPrompt />

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Breadcrumbs
        root={root}
        anchor={anchor ?? root}
        mode={mode}
        onToggleMode={() =>
          patch.mutate({ folderViewMode: mode === 'tree' ? 'list' : 'tree' })
        }
      />
      {/*
        List mode owns its own scrolling, because it windows its rows and has to know
        the viewport height. Tree mode still scrolls in a plain container.
      */}
      {mode === 'tree' ? (
        <div className="min-h-0 flex-1 overflow-auto p-1">
          <DirectoryNode path={root} depth={0} defaultOpen />
        </div>
      ) : (
        <FlatList path={root} />
      )}
    </div>
  )
}

function OpenFolderPrompt(): ReactNode {
  const { openFolderViaDialog, busy } = useOpenFile()

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
      <p className="text-xs text-muted-foreground/70">
        Open a folder to browse a game dump — point it at a romfs directory.
      </p>
      <button
        type="button"
        onClick={openFolderViaDialog}
        disabled={busy}
        className="flex items-center gap-1.5 rounded border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <FolderOpen className="size-3.5" />}
        Open folder
      </button>
    </div>
  )
}

/**
 * Path crumbs, relative to the folder that was opened.
 *
 * Showing the absolute path spends most of the bar on home-directory segments
 * nobody browsing a dump cares about, so the opened folder is the first crumb and
 * everything left of it is dropped. Crumbs navigate; the anchor cannot be escaped,
 * because it is the scope the user chose.
 */
function Breadcrumbs({
  root,
  anchor,
  mode,
  onToggleMode
}: {
  root: string
  anchor: string
  mode: FolderViewMode
  onToggleMode: () => void
}): ReactNode {
  const navigate = useFolder((state) => state.navigate)

  const anchorName = anchor.split('/').filter(Boolean).pop() ?? anchor
  const inside = root.startsWith(anchor) ? root.slice(anchor.length) : ''
  const segments = inside.split('/').filter((part) => part.length > 0)

  const crumbs = [
    { label: anchorName, path: anchor },
    ...segments.map((segment, index) => ({
      label: segment,
      path: `${anchor}/${segments.slice(0, index + 1).join('/')}`
    }))
  ]

  return (
    <div className="shrink-0 border-b">
      <div className="flex items-center gap-1 px-1.5 py-1">
        <button
          type="button"
          onClick={onToggleMode}
          title={
            mode === 'tree'
              ? 'Switch to a flat list — better for folders with thousands of files'
              : 'Switch to an expanding tree'
          }
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {mode === 'tree' ? <ListTree className="size-3.5" /> : <List className="size-3.5" />}
        </button>
        <div className="flex min-w-0 flex-1 flex-wrap items-center text-[10px] text-muted-foreground">
          {crumbs.map((crumb, index) => {
            const last = index === crumbs.length - 1
            return (
              <span key={crumb.path} className="flex items-center">
                <button
                  type="button"
                  onClick={() => navigate(crumb.path)}
                  title={crumb.path}
                  className={`max-w-32 truncate rounded px-1 hover:bg-accent hover:text-foreground ${
                    last ? 'font-medium text-foreground' : ''
                  }`}
                >
                  {crumb.label}
                </button>
                {last ? null : <span className="text-muted-foreground/40">/</span>}
              </span>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** A directory in tree mode. Children are fetched only once it is expanded. */
function DirectoryNode({
  path,
  depth,
  name,
  defaultOpen = false
}: {
  path: string
  depth: number
  name?: string
  defaultOpen?: boolean
}): ReactNode {
  const orpc = getOrpc()
  const [open, setOpen] = useState(defaultOpen)
  /**
   * How many children to render.
   *
   * A romfs directory can be enormous — this game's `Tex/` holds 29,342 files — and
   * the tree rendered a node for every one, which took seconds and left tens of
   * thousands of elements behind. The flat list windows its rows instead, but a
   * recursive tree has no fixed row height to window by, so it is capped and says so.
   * The cap is never silent: the remaining count is shown with a button to go further.
   */
  const [shown, setShown] = useState(TREE_PAGE)

  const query = useQuery({
    ...orpc.folder.list.queryOptions({ input: { path } }),
    // The whole point of the tree: nothing is read until it is opened.
    enabled: open
  })

  return (
    <div>
      {name === undefined ? null : (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-xs hover:bg-accent/60"
          style={{ paddingLeft: depth * 12 + 4 }}
          title={path}
        >
          {open ? (
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
          )}
          {KIND_ICON.directory}
          <span className="min-w-0 flex-1 truncate">{name}</span>
          {query.isFetching ? <Loader2 className="size-3 shrink-0 animate-spin" /> : null}
        </button>
      )}

      {open ? (
        query.isError ? (
          <ListError depth={depth + 1} error={query.error} onRetry={() => void query.refetch()} />
        ) : query.data ? (
          query.data.entries.length === 0 ? (
            <p
              className="py-0.5 text-[10px] text-muted-foreground/50"
              style={{ paddingLeft: (depth + 1) * 12 + 20 }}
            >
              empty
            </p>
          ) : (
            <>
              {query.data.entries.slice(0, shown).map((entry) =>
                entry.kind === 'directory' ? (
                  <DirectoryNode
                    key={entry.path}
                    path={entry.path}
                    name={entry.name}
                    depth={depth + 1}
                  />
                ) : (
                  <FileRow key={entry.path} entry={entry} depth={depth + 1} />
                )
              )}
              {query.data.entries.length > shown ? (
                <button
                  type="button"
                  onClick={() => setShown((value) => value + TREE_PAGE)}
                  style={{ paddingLeft: (depth + 1) * 12 + 20 }}
                  className="flex w-full items-center gap-1 py-0.5 text-left text-[10px] text-primary hover:underline"
                >
                  {(query.data.entries.length - shown).toLocaleString()} more —
                  show {Math.min(TREE_PAGE, query.data.entries.length - shown)}
                  <span className="text-muted-foreground/60">
                    (or switch to list view to filter them)
                  </span>
                </button>
              ) : null}
            </>
          )
        ) : (
          <p
            className="py-0.5 text-[10px] text-muted-foreground/50"
            style={{ paddingLeft: (depth + 1) * 12 + 20 }}
          >
            <Loader2 className="mr-1 inline size-3 animate-spin" />
            reading…
          </p>
        )
      ) : null}
    </div>
  )
}

/** Flat, filterable listing of one directory, with drill-down. */
function FlatList({ path }: { path: string }): ReactNode {
  const orpc = getOrpc()
  const navigate = useFolder((state) => state.navigate)
  const anchor = useFolder((state) => state.rootPath)
  const [filter, setFilter] = useState('')
  const query = useQuery(orpc.folder.list.queryOptions({ input: { path } }))

  if (query.isError) {
    return <ListError depth={0} error={query.error} onRetry={() => void query.refetch()} />
  }
  if (!query.data) {
    return (
      <p className="p-2 text-xs text-muted-foreground/60">
        <Loader2 className="mr-1.5 inline size-3 animate-spin" />
        Reading…
      </p>
    )
  }

  const needle = filter.trim().toLowerCase()
  const entries = needle
    ? query.data.entries.filter((entry) => entry.name.toLowerCase().includes(needle))
    : query.data.entries

  const header = (
    <>
      <div className="sticky top-0 z-10 mb-1 flex items-center gap-1 bg-card/95 pb-1">
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={`Filter ${query.data.entries.length} items…`}
          className="min-w-0 flex-1 rounded border bg-input/40 px-1.5 py-0.5 text-[11px]"
        />
      </div>
      {query.data.parent && anchor && path !== anchor && query.data.parent.startsWith(anchor) ? (
        <button
          type="button"
          onClick={() => navigate(query.data.parent!)}
          className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs text-muted-foreground hover:bg-accent/60"
        >
          <Folder className="size-3.5" />
          ..
        </button>
      ) : null}
      {entries.length === 0 ? (
        <p className="p-2 text-xs text-muted-foreground/60">
          {needle ? 'Nothing matches that filter.' : 'This folder is empty.'}
        </p>
      ) : null}
    </>
  )

  return (
    <WindowedList
      items={entries}
      rowHeight={FLAT_ROW_HEIGHT}
      header={header}
      className="min-h-0 flex-1 overflow-auto p-1"
      keyOf={(entry) => entry.path}
      renderRow={(entry) =>
        entry.kind === 'directory' ? (
          <button
            type="button"
            onClick={() => navigate(entry.path)}
            className="flex h-full w-full items-center gap-1.5 rounded px-1.5 text-left text-xs hover:bg-accent/60"
            title={entry.path}
          >
            {KIND_ICON.directory}
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            <ChevronRight className="size-3 shrink-0 text-muted-foreground/50" />
          </button>
        ) : (
          <FileRow entry={entry} depth={0} />
        )
      }
    />
  )
}

/**
 * Row height in the flat list, which the windower needs to know up front.
 *
 * Matches `text-xs` (16px of line box) plus the row's vertical padding. Rows are
 * stretched to fill it rather than sized by their content, so a row that grows would
 * be clipped instead of silently drifting the spacers out of step.
 */
const FLAT_ROW_HEIGHT = 24

/**
 * How many children the tree renders per page.
 *
 * Chosen to clear real directories in one go — this game's largest layout folder holds
 * 544 files — while still bounding the pathological ones: `Tex/` has 29,342 and `Icon/`
 * 11,425, and rendering those took seconds. A thousand rows is comfortable; thirty
 * thousand is not.
 */
const TREE_PAGE = 1000

function ListError({
  depth,
  error,
  onRetry
}: {
  depth: number
  error: unknown
  onRetry: () => void
}): ReactNode {
  const described = describeError(error)
  return (
    <div className="py-1 text-[11px]" style={{ paddingLeft: depth * 12 + 4 }}>
      <p className="flex items-center gap-1 text-destructive">
        <AlertTriangle className="size-3 shrink-0" />
        {described.title}
      </p>
      <p className="select-text text-muted-foreground">{described.detail}</p>
      <button type="button" onClick={onRetry} className="mt-1 rounded border px-1.5 hover:bg-accent">
        Try again
      </button>
    </div>
  )
}

function FileRow({ entry, depth }: { entry: FolderEntry; depth: number }): ReactNode {
  const { openPath } = useOpenFile()
  const showArchive = useFolder((state) => state.showArchiveTab)
  const openByml = useFolder((state) => state.openByml)
  const openPreview = useFolder((state) => state.openPreview)
  const [busy, setBusy] = useState(false)

  const openable = OPENABLE.has(entry.kind)

  const activate = (newTab = false): void => {
    setBusy(true)
    void (async () => {
      try {
        // Sniff before opening: in a romfs the extension is a hint and the magic is
        // the truth — .blarc.zs is a ZSTD-compressed SARC.
        const identified = await getClient().folder.identify({ path: entry.path })
        switch (identified.opensAs) {
          case 'archive': {
            const result = await openPath(entry.path, 'archive', newTab)
            if (result.openedLayouts === 1) {
              reportSuccess('Opened', `${entry.name} — its layout is on the canvas.`)
            } else {
              // Several layouts, or none: the contents appear in a different tab, so
              // switching is the difference between "it worked" and "nothing happened".
              showArchive()
              reportSuccess(
                'Archive opened',
                result.openedLayouts === 0
                  ? `${entry.name} holds no layouts; its contents are in the Archive tab.`
                  : `${entry.name} holds ${result.openedLayouts} layouts — pick one in the Archive tab.`
              )
            }
            break
          }
          case 'layout':
            await openPath(entry.path, 'layout', newTab)
            break
          case 'byml':
            // Takes over the main area; the canvas is a click away.
            openByml(entry.path)
            break
          default:
            /*
             * Everything else goes to the preview rather than a toast.
             *
             * `Cannot open` was wrong about most of what it was shown: fonts, texture containers
             * and data trees all decode here, and the ones that genuinely do not — BFRES, shaders
             * — are better served by being told what the file *is* than by being refused. The
             * preview handles both, and reports the format either way.
             */
            openPreview({ kind: 'file', path: entry.path })
            break
        }
      } catch (cause) {
        reportError(cause, { retry: () => activate(newTab) })
      } finally {
        setBusy(false)
      }
    })()
  }

  return (
    <button
      type="button"
      // Opening replaces the current tab; a modifier or middle click adds one, the
      // same gesture browsers use.
      onClick={(event) => activate(event.metaKey || event.ctrlKey || event.shiftKey)}
      onAuxClick={(event) => event.button === 1 && activate(true)}
      disabled={busy}
      className={`flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-accent/60 disabled:opacity-60 ${
        openable ? '' : 'text-muted-foreground/60'
      }`}
      style={{ paddingLeft: depth * 12 + 4 + 16 }}
      title={
        openable
          ? `${entry.path}\nCmd/Ctrl/Shift-click to open in a new tab`
          : `${entry.path}\n(not a format this editor opens)`
      }
    >
      {busy ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : KIND_ICON[entry.kind]}
      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      {entry.compressed ? (
        <span
          className="shrink-0 rounded bg-muted/60 px-1 text-[9px] uppercase text-muted-foreground"
          title="Compressed; decompressed on open"
        >
          zs
        </span>
      ) : null}
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">
        {formatSize(entry.size)}
      </span>
    </button>
  )
}
