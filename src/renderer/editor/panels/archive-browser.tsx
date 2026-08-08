import { useMemo, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ChevronDown,
  FileQuestion,
  Film,
  Folder,
  Image,
  Layers,
  Loader2,
  Package,
  Type
} from 'lucide-react'

import type { ArchiveEntryInfo } from '@shared/contract'
import { getClient, getOrpc } from '@renderer/lib/orpc'
import { describeError } from '@renderer/lib/errors'
import { reportError, reportInfo, reportSuccess } from '@renderer/lib/toast'
import { useOpenLayout } from '@renderer/lib/use-open-layout'
import { useDocuments } from '@renderer/editor/store/document'
import { useWorkspace } from '@renderer/editor/store/workspace'

const KIND_ICON: Record<ArchiveEntryInfo['kind'], ReactNode> = {
  layout: <Layers className="size-3.5 shrink-0 text-primary" />,
  animation: <Film className="size-3.5 shrink-0 text-muted-foreground" />,
  texture: <Image className="size-3.5 shrink-0 text-muted-foreground" />,
  font: <Type className="size-3.5 shrink-0 text-muted-foreground" />,
  archive: <Package className="size-3.5 shrink-0 text-muted-foreground" />,
  other: <FileQuestion className="size-3.5 shrink-0 text-muted-foreground/60" />
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Splits "blyt/Header.bflyt" into its folder and leaf. */
function splitPath(name: string): { folder: string; leaf: string } {
  const slash = name.lastIndexOf('/')
  if (slash < 0) return { folder: '', leaf: name }
  return { folder: name.slice(0, slash), leaf: name.slice(slash + 1) }
}

export function ArchiveBrowser(): ReactNode {
  const orpc = getOrpc()
  const archiveId = useWorkspace((state) => state.activeArchiveId)
  const selectedKey = useWorkspace((state) => state.selectedEntryKey)
  const selectEntry = useWorkspace((state) => state.selectEntry)
  const { openLayout, pending } = useOpenLayout()
  const setActiveArchive = useWorkspace((state) => state.setActiveArchive)
  const tabs = useDocuments((state) => state.tabs)
  const [closing, setClosing] = useState(false)
  const [busyEntry, setBusyEntry] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const archive = useQuery({
    ...orpc.archive.get.queryOptions({ input: { archiveId: archiveId ?? '' } }),
    enabled: archiveId !== null
  })

  /**
   * Closes the archive being browsed.
   *
   * Refused while a tab still holds a layout from it: that tab's save writes the re-encoded
   * entry back into this in-memory archive, so closing it first would leave the save failing
   * with nothing to write into and no save-as available for an archive-backed layout. Refused
   * too while it has unsaved changes, which is the same hazard one step earlier.
   */
  const openFromHere = tabs.filter(
    (tab) => tab.source.kind === 'archive' && tab.source.archiveId === archiveId
  )

  const closeArchive = (): void => {
    if (!archiveId) return
    setClosing(true)
    void (async () => {
      try {
        await getClient().archive.close({ archiveId })
        setActiveArchive(null)
      } catch (cause) {
        reportError(cause, { retry: closeArchive })
      } finally {
        setClosing(false)
      }
    })()
  }

  /**
   * Writes an entry to a file the user picks.
   *
   * The way anything other than a decoded texture gets out of an archive: layouts, animations,
   * texture containers and BYML were all readable inside the app and unreachable from outside
   * it. The bytes are exactly what the archive holds — compression in a `.szs` wraps the whole
   * SARC, not each entry — so what lands on disk is what the game's own loader would see.
   */
  const extractEntry = (entry: ArchiveEntryInfo): void => {
    if (!archiveId) return
    setBusyEntry(entry.key)
    void (async () => {
      try {
        const client = getClient()
        const chosen = await client.dialog.saveFileAs({
          purpose: 'any',
          defaultName: entry.displayName.split('/').pop() ?? entry.displayName
        })
        if (chosen.canceled || !chosen.path) return
        const written = await client.archive.extractEntry({
          archiveId,
          entryKey: entry.key,
          path: chosen.path
        })
        reportSuccess('Extracted', `${entry.displayName} written (${written.bytes} bytes).`)
      } catch (cause) {
        reportError(cause, { retry: () => extractEntry(entry) })
      } finally {
        setBusyEntry(null)
      }
    })()
  }

  /**
   * Replaces an entry from a file the user picks.
   *
   * Also the practical route to importing a texture: doing that properly needs a BNTX writer, a
   * BCn/ASTC compressor and a forward Tegra swizzle, none of which exist here, while swapping in
   * a `.bntx` built elsewhere needs none of them.
   *
   * What arrived is reported rather than validated. Refusing bytes this build cannot parse would
   * block the legitimate case of a format it does not model; accepting them silently would let
   * someone leave an unreadable entry in an archive and discover it much later.
   */
  const importEntry = (entry: ArchiveEntryInfo): void => {
    if (!archiveId) return
    setBusyEntry(entry.key)
    void (async () => {
      try {
        const client = getClient()
        const chosen = await client.dialog.openFiles({ purpose: 'any' })
        const path = chosen.paths[0]
        if (chosen.canceled || !path) return
        const result = await client.archive.importEntry({
          archiveId,
          entryKey: entry.key,
          path
        })
        await queryClient.invalidateQueries({ queryKey: orpc.archive.get.key() })
        reportSuccess(
          'Replaced',
          `${entry.displayName} now holds ${result.bytes} bytes (${result.detected}). ` +
            'Save the archive to write it to disk.'
        )
      } catch (cause) {
        reportError(cause, { retry: () => importEntry(entry) })
      } finally {
        setBusyEntry(null)
      }
    })()
  }

  const groups = useMemo(() => {
    const entries = archive.data?.entries ?? []
    const byFolder = new Map<string, ArchiveEntryInfo[]>()
    for (const entry of entries) {
      const { folder } = splitPath(entry.displayName)
      const bucket = byFolder.get(folder)
      if (bucket) bucket.push(entry)
      else byFolder.set(folder, [entry])
    }
    return [...byFolder.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [archive.data])

  if (!archiveId) {
    return (
      <Empty>
        Open an archive to browse it.
      </Empty>
    )
  }

  if (archive.isPending) {
    return (
      <Empty>
        <Loader2 className="size-3 animate-spin" />
        Reading archive…
      </Empty>
    )
  }

  if (archive.isError) {
    // The typed-error chain carries the format, byte offset and section all the way
    // here; a fixed "could not be read" threw all of that away.
    const described = describeError(archive.error)
    return (
      <div className="p-3">
        <p className="text-xs font-medium">{described.title}</p>
        <p className="mt-1 text-[11px] text-muted-foreground">{described.detail}</p>
        <button
          type="button"
          onClick={() => void archive.refetch()}
          className="mt-2 rounded border px-2 py-1 text-xs hover:bg-accent"
        >
          Try again
        </button>
      </div>
    )
  }

  const data = archive.data

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b px-3 py-2">
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 truncate font-medium" title={data.path}>
            {data.displayName}
          </p>
          {/*
            Closing an archive is explicit, and deliberately so.
            
            Nothing used to close one at all, so every archive opened stayed open for the
            session — which is not merely a leak: resolving a texture searches the layout's own
            archive and then every other open one, so the list only grew and a stale archive
            could keep answering with a same-named texture.
            
            Reclaiming them automatically was tried and reverted. "Referenced" is not
            knowable: opening an archive *so that its textures resolve* is a documented
            workflow, and once the browser moves on it looks exactly like an abandoned one — so
            a sweep silently un-textured panes, and rewrote the saved session to drop the
            archive for good. A button the user presses cannot be wrong about intent.
          */}
          <button
            type="button"
            onClick={closeArchive}
            disabled={closing || data.dirty || openFromHere.length > 0}
            title={
              data.dirty
                ? 'This archive has unsaved changes; save it before closing'
                : openFromHere.length > 0
                  ? `${openFromHere.length} open layout${openFromHere.length === 1 ? '' : 's'} still come from this archive; close ${openFromHere.length === 1 ? 'it' : 'them'} first`
                  : 'Close this archive and free its memory'
            }
            className="shrink-0 rounded border px-1.5 py-0.5 text-[11px] hover:bg-accent disabled:opacity-40"
          >
            Close
          </button>
        </div>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {data.entries.length} files · {data.compression === 'none' ? 'uncompressed' : data.compression.toUpperCase()}
          {data.littleEndian ? '' : ' · big-endian'}
          {data.dirty ? ' · unsaved changes' : ''}
        </p>
        {data.unnamedCount > 0 ? (
          <p className="mt-1 rounded bg-muted px-1.5 py-1 text-[11px] text-muted-foreground">
            {data.unnamedCount} of {data.entries.length} entries have no stored name. They are
            listed by hash and can be read but not replaced until a name is recovered.
          </p>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto py-1">
        {groups.map(([folder, entries]) => (
          <div key={folder || '(root)'} className="mb-1">
            <div className="flex items-center gap-1 px-2 py-1 text-[11px] uppercase tracking-wide text-muted-foreground">
              <ChevronDown className="size-3" />
              <Folder className="size-3" />
              {folder || 'root'}
              <span className="ml-auto normal-case tracking-normal opacity-60">
                {entries.length}
              </span>
            </div>
            <ul>
              {entries.map((entry) => {
                const { leaf } = splitPath(entry.displayName)
                const selected = entry.key === selectedKey
                return (
                  <li key={entry.key} className="group/entry relative">
                    <button
                      type="button"
                      // Opening reuses the current tab; a modifier adds one.
                      onClick={(event) => {
                        selectEntry(entry.key)
                        if (entry.kind === 'layout') {
                          openLayout(
                            { kind: 'archive', archiveId, entryKey: entry.key },
                            event.metaKey || event.ctrlKey || event.shiftKey
                          )
                          return
                        }
                        // Anything else has no viewer here. Saying so beats a click
                        // that selects a row and appears to do nothing.
                        reportInfo(
                          `Cannot open ${leaf}`,
                          entry.kind === 'texture'
                            ? 'Textures are listed in the Textures tab, alongside the layout that uses them.'
                            : entry.kind === 'animation'
                              ? 'Animations are listed in the timeline once their layout is open.'
                              : `${leaf} is a ${entry.kind} entry; this editor opens the layouts in an archive.`
                        )
                      }}
                      onAuxClick={(event) => {
                        if (event.button !== 1 || entry.kind !== 'layout') return
                        openLayout({ kind: 'archive', archiveId, entryKey: entry.key }, true)
                      }}
                      className={`flex w-full items-center gap-1.5 px-3 py-1 text-left hover:bg-accent ${
                        selected ? 'bg-accent' : ''
                      }`}
                      title={
                        entry.kind === 'layout'
                          ? `Open ${entry.displayName} (${formatSize(entry.size)})`
                          : `${entry.displayName} · ${formatSize(entry.size)}`
                      }
                    >
                      {KIND_ICON[entry.kind]}
                      <span
                        className={`flex-1 truncate ${entry.named ? '' : 'font-mono text-muted-foreground'}`}
                      >
                        {leaf}
                      </span>
                      {pending === entry.key ? (
                        <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
                      ) : (
                        <span className="shrink-0 text-[11px] text-muted-foreground/60 group-hover/entry:opacity-0">
                          {formatSize(entry.size)}
                        </span>
                      )}
                    </button>
                    {/*
                      Extract and Replace, revealed on hover so they do not crowd a list of
                      thirty thousand rows. Absolutely positioned rather than inside the row
                      button, because a button inside a button is invalid and the row's click
                      would swallow theirs.
                    */}
                    <span className="absolute right-2 top-0 hidden h-full items-center gap-1 group-hover/entry:flex">
                      <button
                        type="button"
                        onClick={() => extractEntry(entry)}
                        disabled={busyEntry !== null}
                        title={`Write ${entry.displayName} to a file`}
                        className="rounded border bg-background px-1 py-0.5 text-[10px] hover:bg-accent disabled:opacity-40"
                      >
                        Extract
                      </button>
                      <button
                        type="button"
                        onClick={() => importEntry(entry)}
                        disabled={busyEntry !== null || !entry.named}
                        title={
                          entry.named
                            ? `Replace ${entry.displayName} from a file`
                            : 'This entry has no stored name, so it cannot be replaced'
                        }
                        className="rounded border bg-background px-1 py-0.5 text-[10px] hover:bg-accent disabled:opacity-40"
                      >
                        Replace
                      </button>
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </div>
    </div>
  )
}

function Empty({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="flex flex-1 items-center justify-center gap-2 p-4 text-center text-xs text-muted-foreground/60">
      {children}
    </div>
  )
}
