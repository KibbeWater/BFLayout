import { useMemo, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
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
import { getOrpc } from '@renderer/lib/orpc'
import { useOpenLayout } from '@renderer/lib/use-open-layout'
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

  const archive = useQuery({
    ...orpc.archive.get.queryOptions({ input: { archiveId: archiveId ?? '' } }),
    enabled: archiveId !== null
  })

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
    return (
      <div className="p-3">
        <p className="text-xs text-muted-foreground">This archive could not be read.</p>
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
        <p className="truncate font-medium" title={data.path}>
          {data.displayName}
        </p>
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
                  <li key={entry.key}>
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
                        }
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
                        <span className="shrink-0 text-[11px] text-muted-foreground/60">
                          {formatSize(entry.size)}
                        </span>
                      )}
                    </button>
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
