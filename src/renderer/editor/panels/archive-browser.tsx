import { useMemo, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Box,
  Braces,
  ChevronDown,
  FileQuestion,
  Film,
  Folder,
  Image,
  Layers,
  Loader2,
  MessageSquareText,
  Music,
  Package,
  Sparkles,
  Type,
  Workflow
} from 'lucide-react'

import type { ArchiveEntryInfo } from '@shared/contract'
import { getClient, getOrpc } from '@renderer/lib/orpc'
import { describeError } from '@renderer/lib/errors'
import { reportError, reportSuccess } from '@renderer/lib/toast'
import { useOpenLayout } from '@renderer/lib/use-open-layout'
import { useDocuments } from '@renderer/editor/store/document'
import { useFolder } from '@renderer/editor/store/folder'
import { useWorkspace } from '@renderer/editor/store/workspace'

const KIND_ICON: Record<ArchiveEntryInfo['kind'], ReactNode> = {
  layout: <Layers className="size-3.5 shrink-0 text-primary" />,
  animation: <Film className="size-3.5 shrink-0 text-muted-foreground" />,
  texture: <Image className="size-3.5 shrink-0 text-muted-foreground" />,
  font: <Type className="size-3.5 shrink-0 text-muted-foreground" />,
  archive: <Package className="size-3.5 shrink-0 text-muted-foreground" />,
  data: <Braces className="size-3.5 shrink-0 text-muted-foreground" />,
  message: <MessageSquareText className="size-3.5 shrink-0 text-muted-foreground" />,
  model: <Box className="size-3.5 shrink-0 text-muted-foreground" />,
  shader: <Sparkles className="size-3.5 shrink-0 text-muted-foreground/60" />,
  audio: <Music className="size-3.5 shrink-0 text-muted-foreground" />,
  logic: <Workflow className="size-3.5 shrink-0 text-muted-foreground/60" />,
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
  const [saving, setSaving] = useState(false)
  const openPreview = useFolder((state) => state.openPreview)
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

  /**
   * Writes the archive to disk.
   *
   * Every path that dirties an archive needs one of these, and until now the only one went
   * through a layout tab's save — so an archive holding nothing openable could be dirtied and
   * never written.
   */
  const saveArchive = (): void => {
    if (!archiveId) return
    setSaving(true)
    void (async () => {
      try {
        const { archive: saved, redirected } = await getClient().archive.save({ archiveId })
        await queryClient.invalidateQueries({ queryKey: orpc.archive.get.key() })
        reportSuccess(
          redirected ? 'Saved into the mod' : 'Saved',
          redirected
            ? `${saved.displayName} copied into your mod folder at ${saved.path}. The dump is untouched.`
            : `${saved.displayName} written to disk.`
        )
      } catch (cause) {
        reportError(cause, { retry: saveArchive })
      } finally {
        setSaving(false)
      }
    })()
  }

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
   * Adds a file to the archive.
   *
   * The name is asked for rather than taken from the file, because where an entry
   * sits inside the archive is part of its identity: `blyt/Foo.bflyt` and
   * `Foo.bflyt` are different files to the game, and only one of them will be
   * found. The picked file's name is offered as the default under the folder the
   * user was looking at.
   */
  const addEntry = (folder: string): void => {
    void (async () => {
      const client = getClient()
      try {
        const chosen = await client.dialog.openFiles({ purpose: 'any' })
        if (chosen.canceled || chosen.paths.length === 0) return
        const picked = chosen.paths[0]!
        const base = picked.split(/[/\\]/).pop() ?? 'file'

        const name = window.prompt(
          'Name for this entry inside the archive.\n\nThe path matters: the game looks the file up by exactly this name.',
          folder ? `${folder}/${base}` : base
        )
        if (name === null || name.trim() === '') return

        setBusyEntry(name)
        const result = await client.archive.addEntry({
          archiveId: archiveId!,
          name: name.trim(),
          path: picked
        })
        await queryClient.invalidateQueries({ queryKey: orpc.archive.get.key() })
        reportSuccess(
          'Added',
          `${name.trim()} added to ${result.archive.displayName} (${result.bytes} bytes). Save the archive to write it to disk.`
        )
      } catch (cause) {
        reportError(cause)
      } finally {
        setBusyEntry(null)
      }
    })()
  }

  const deleteEntry = (entry: ArchiveEntryInfo): void => {
    if (
      !window.confirm(
        `Remove ${entry.displayName} from this archive?\n\nIt is gone once the archive is saved. Extract it first if you might want it back.`
      )
    ) {
      return
    }
    setBusyEntry(entry.key)
    void (async () => {
      try {
        await getClient().archive.deleteEntry({ archiveId: archiveId!, entryKey: entry.key })
        await queryClient.invalidateQueries({ queryKey: orpc.archive.get.key() })
        reportSuccess('Removed', `${entry.displayName} is no longer in this archive.`)
      } catch (cause) {
        reportError(cause, { retry: () => deleteEntry(entry) })
      } finally {
        setBusyEntry(null)
      }
    })()
  }

  const renameEntry = (entry: ArchiveEntryInfo): void => {
    const name = window.prompt(
      'New name for this entry.\n\nSARC finds files by the hash of their name, so this is a real rename — anything referring to the old name will stop finding it.',
      entry.displayName
    )
    if (name === null || name.trim() === '' || name.trim() === entry.displayName) return

    setBusyEntry(entry.key)
    void (async () => {
      try {
        await getClient().archive.renameEntry({
          archiveId: archiveId!,
          entryKey: entry.key,
          name: name.trim()
        })
        await queryClient.invalidateQueries({ queryKey: orpc.archive.get.key() })
        reportSuccess('Renamed', `${entry.displayName} is now ${name.trim()}.`)
      } catch (cause) {
        reportError(cause, { retry: () => renameEntry(entry) })
      } finally {
        setBusyEntry(null)
      }
    })()
  }

  const duplicateEntry = (entry: ArchiveEntryInfo): void => {
    const suggested = entry.displayName.replace(/(\.[^./]+)?$/, (extension) => `_copy${extension}`)
    const name = window.prompt('Name for the copy.', suggested)
    if (name === null || name.trim() === '') return

    setBusyEntry(entry.key)
    void (async () => {
      try {
        await getClient().archive.duplicateEntry({
          archiveId: archiveId!,
          entryKey: entry.key,
          name: name.trim()
        })
        await queryClient.invalidateQueries({ queryKey: orpc.archive.get.key() })
        reportSuccess('Duplicated', `${name.trim()} added alongside ${entry.displayName}.`)
      } catch (cause) {
        reportError(cause, { retry: () => duplicateEntry(entry) })
      } finally {
        setBusyEntry(null)
      }
    })()
  }

  /**
   * Fills in missing entry names from the dump index.
   *
   * A hash-only archive can be read but not written, which makes it read-only in
   * practice — and the names are not lost, only absent: they are written down in
   * the layouts and archives *around* it, which is exactly what the index has
   * already collected. Every texture, layout, animation and font name it knows is
   * offered as a candidate and the ones whose hash matches stick.
   */
  const recoverNames = (): void => {
    setBusyEntry('names')
    void (async () => {
      const client = getClient()
      try {
        const kinds = ['texture', 'part', 'animation', 'font'] as const
        const collected = await Promise.all(
          kinds.map((kind) => client.index.names({ kind }))
        )
        const candidates = [...new Set(collected.flat())]
        // The names inside an archive carry folders; the index knows the bare names.
        const withFolders = candidates.flatMap((name) => [
          name,
          `blyt/${name}`,
          `timg/${name}`,
          `anim/${name}`,
          `font/${name}`
        ])

        if (withFolders.length === 0) {
          reportError(
            new Error(
              'The dump has not been indexed yet, so there are no names to try. Index it from the Search tab first.'
            )
          )
          return
        }

        const result = await client.archive.recoverNames({
          archiveId: archiveId!,
          candidates: withFolders
        })
        await queryClient.invalidateQueries({ queryKey: orpc.archive.get.key() })

        const remaining = result.unnamedCount
        reportSuccess(
          remaining === 0 ? 'Every name recovered' : 'Some names recovered',
          remaining === 0
            ? `${result.displayName} can now be written back.`
            : `${remaining} of ${result.entries.length} entries still have no name, so this archive still cannot be saved. The missing names are not referenced anywhere the index has seen.`
        )
      } catch (cause) {
        reportError(cause, { retry: recoverNames })
      } finally {
        setBusyEntry(null)
      }
    })()
  }

  /**
   * Replaces an entry from a file the user picks.
   *
   * Still the route for a texture whose format has no encoder here. The Textures
   * panel can now write pixels straight into a container in place, but only where
   * the format is uncompressed and the size is unchanged — for anything BCn or
   * ASTC, swapping in a `.bntx` built elsewhere is the way, and it needs no
   * compressor on this side.
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
        /*
         * Everything that could be holding the old bytes is told to forget them: the archive
         * descriptor, the texture list and decoded textures, and — through the command the
         * canvas already listens for — the uploaded GL textures, which are keyed by name and
         * would otherwise keep drawing the old art. A replaced texture that still looks
         * unchanged reads as a failed import.
         */
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.archive.get.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.textures.list.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.textures.get.key() })
        ])
        window.dispatchEvent(new CustomEvent('bflayout-command', { detail: 'textures-changed' }))

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
          {/*
            Saving an archive was only reachable as step two of saving a layout tab, which meant
            an archive with no openable layout — a shared texture archive, the headline case for
            Replace — could be made dirty and then never written: no tab to save through, Close
            refusing because it is dirty, and quit discarding it. This is the missing door.
          */}
          <button
            type="button"
            onClick={saveArchive}
            disabled={saving || !data.dirty}
            title={
              data.dirty
                ? 'Write this archive to disk'
                : 'This archive has no unsaved changes'
            }
            className="shrink-0 rounded border px-1.5 py-0.5 text-[11px] hover:bg-accent disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
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
          <div className="mt-1 rounded bg-muted px-1.5 py-1 text-[11px] text-muted-foreground">
            <p>
              {data.unnamedCount} of {data.entries.length} entries have no stored name. They are
              listed by hash and can be extracted, but nothing in this archive can be replaced:
              writing a SARC needs every name, so a change here could never be saved.
            </p>
            <button
              type="button"
              onClick={recoverNames}
              disabled={busyEntry !== null}
              className="mt-1 rounded border bg-background px-1.5 py-0.5 text-[10px] hover:bg-accent disabled:opacity-40"
              title="Try every name the dump index knows against the missing hashes"
            >
              {busyEntry === 'names' ? 'Recovering…' : 'Recover names from the index'}
            </button>
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto py-1">
        {groups.map(([folder, entries]) => (
          <div key={folder || '(root)'} className="mb-1">
            <div className="flex items-center gap-1 px-2 py-1 text-[11px] uppercase tracking-wide text-muted-foreground">
              <ChevronDown className="size-3" />
              <Folder className="size-3" />
              {folder || 'root'}
              <button
                type="button"
                onClick={() => addEntry(folder)}
                disabled={busyEntry !== null || data.unnamedCount > 0}
                title={
                  data.unnamedCount > 0
                    ? 'This archive cannot be written back until its names are recovered'
                    : `Add a file to ${folder || 'the archive root'}`
                }
                className="ml-auto rounded border px-1 py-0 text-[10px] normal-case tracking-normal hover:bg-accent disabled:opacity-30"
              >
                + add
              </button>
              <span className="normal-case tracking-normal opacity-60">
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
                        /*
                         * Everything else goes to the preview.
                         *
                         * These rows used to select and then do nothing but produce a toast — most
                         * visibly in a font archive, where *every* entry behaved that way, which
                         * reads as the app being broken rather than a viewer being absent. The
                         * preview shows what it can and names the format when it cannot.
                         */
                        openPreview({ kind: 'archive', archiveId, entryKey: entry.key })
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
                        disabled={busyEntry !== null || !entry.named || data.unnamedCount > 0}
                        title={
                          !entry.named
                            ? 'This entry has no stored name, so it cannot be replaced'
                            : data.unnamedCount > 0
                              ? 'This archive holds entries with no stored name, so it cannot be written back at all — replacing anything in it would produce changes that can never be saved'
                              : `Replace ${entry.displayName} from a file`
                        }
                        className="rounded border bg-background px-1 py-0.5 text-[10px] hover:bg-accent disabled:opacity-40"
                      >
                        Replace
                      </button>
                      <button
                        type="button"
                        onClick={() => duplicateEntry(entry)}
                        disabled={busyEntry !== null || data.unnamedCount > 0}
                        title={`Add a copy of ${entry.displayName} under a new name`}
                        className="rounded border bg-background px-1 py-0.5 text-[10px] hover:bg-accent disabled:opacity-40"
                      >
                        Copy
                      </button>
                      <button
                        type="button"
                        onClick={() => renameEntry(entry)}
                        disabled={busyEntry !== null || !entry.named || data.unnamedCount > 0}
                        title={`Rename ${entry.displayName}`}
                        className="rounded border bg-background px-1 py-0.5 text-[10px] hover:bg-accent disabled:opacity-40"
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteEntry(entry)}
                        disabled={busyEntry !== null || data.unnamedCount > 0}
                        title={`Remove ${entry.displayName} from the archive`}
                        className="rounded border bg-background px-1 py-0.5 text-[10px] text-destructive hover:bg-accent disabled:opacity-40"
                      >
                        Delete
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
