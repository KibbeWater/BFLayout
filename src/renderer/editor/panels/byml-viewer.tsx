import { useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Loader2, Search } from 'lucide-react'

import type { BymlDocumentView, BymlNodeView } from '@shared/contract'
import { formatScalar, isViewContainer, viewChildCount } from '@shared/formats/byml'
import { getOrpc } from '@renderer/lib/orpc'
import { describeError } from '@renderer/lib/errors'

/**
 * A read-only tree view of a BYML configuration document.
 *
 * These files are what a romfs is mostly made of — this game ships 1812 of them
 * against 544 layouts — and until now the browser could identify one but not show
 * you anything inside it. There is no writer, so this deliberately does not pretend
 * to be editable.
 *
 * Rows are rendered lazily: a collapsed container renders none of its subtree, so
 * the 19,369-node documents in this dump open instantly and only what you expand
 * costs anything.
 */

/** Below this, everything is expanded on open; above it, only the root. */
const AUTO_EXPAND_NODES = 200

export function BymlViewer({ path }: { path: string }): ReactNode {
  const orpc = getOrpc()
  const [filter, setFilter] = useState('')

  const document = useQuery(orpc.byml.open.queryOptions({ input: { path } }))

  if (document.isPending) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 p-4 text-xs text-muted-foreground/60">
        <Loader2 className="size-3 animate-spin" />
        Reading document…
      </div>
    )
  }

  if (document.isError) {
    const described = describeError(document.error)
    return (
      <div className="p-3">
        <p className="text-xs font-medium">{described.title}</p>
        <p className="mt-1 text-[11px] text-muted-foreground">{described.detail}</p>
        <button
          type="button"
          onClick={() => void document.refetch()}
          className="mt-2 rounded border px-2 py-1 text-xs hover:bg-accent"
        >
          Try again
        </button>
      </div>
    )
  }

  const data = document.data

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b px-3 py-2">
        <p className="truncate font-medium" title={path}>
          {path.split('/').pop()}
        </p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          BYML v{data.version} · {data.littleEndian ? 'little-endian' : 'big-endian'} ·{' '}
          {data.nodeCount.toLocaleString()} nodes · read-only
        </p>
      </div>
      <BymlTree document={data} filter={filter} onFilter={setFilter} />
    </div>
  )
}

/**
 * The filter box and the tree itself, without the file heading.
 *
 * Split out so the preview panel can show a `bgyml` entry from inside an archive with the same
 * tree rather than a worse copy of it — `bgyml` is the most common file type in a modern romfs,
 * and almost all of them live in archives.
 */
export function BymlTree({
  document: data,
  filter: controlledFilter,
  onFilter
}: {
  document: BymlDocumentView
  filter?: string
  onFilter?: (value: string) => void
}): ReactNode {
  const [ownFilter, setOwnFilter] = useState('')
  const filter = controlledFilter ?? ownFilter
  const setFilter = onFilter ?? setOwnFilter

  return (
    <>
      <div className="shrink-0 border-b px-3 py-1.5">
        <div className="flex items-center gap-1 rounded border bg-input/40 px-1.5">
          <Search className="size-3 shrink-0 text-muted-foreground/60" />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter keys and values"
            className="w-full bg-transparent py-1 text-xs outline-none"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto py-1 font-mono text-[11px]">
        {data.root === null ? (
          <p className="p-3 text-muted-foreground/60">This document has no root node.</p>
        ) : (
          <Node
            node={data.root}
            label="root"
            depth={0}
            filter={filter.trim().toLowerCase()}
            autoExpand={data.nodeCount <= AUTO_EXPAND_NODES}
          />
        )}
      </div>
    </>
  )
}

/**
 * Whether a subtree contains the filter text, in a key or a scalar value.
 *
 * Recomputed per render of a visible row only, and memoised per node, because the
 * alternative — precomputing over the whole document on every keystroke — is what
 * makes a filter feel slow on a 19,000-node tree.
 */
function matches(node: BymlNodeView, label: string, filter: string): boolean {
  if (filter === '') return true
  if (label.toLowerCase().includes(filter)) return true

  switch (node.kind) {
    case 'array':
      return node.items.some((item, index) => matches(item, String(index), filter))
    case 'map':
      return node.entries.some((entry) => matches(entry.value, entry.key, filter))
    case 'hashmap':
      return node.entries.some((entry) =>
        matches(entry.value, entry.hash.toString(16), filter)
      )
    default:
      return formatScalar(node).toLowerCase().includes(filter)
  }
}

function Node({
  node,
  label,
  depth,
  filter,
  autoExpand
}: {
  node: BymlNodeView
  label: string
  depth: number
  filter: string
  autoExpand: boolean
}): ReactNode {
  // Filtering expands as you type: a hit three levels down is useless if the
  // branches above it are still shut.
  const [open, setOpen] = useState(autoExpand || depth === 0)
  const expanded = filter === '' ? open : true

  const visible = useMemo(() => matches(node, label, filter), [node, label, filter])
  if (!visible) return null

  const container = isViewContainer(node)
  const indent = { paddingLeft: `${depth * 12 + 6}px` }

  if (!container) {
    return (
      <div style={indent} className="flex gap-1.5 py-px pr-2 hover:bg-accent/40">
        <span className="shrink-0 text-muted-foreground">{label}</span>
        <span className="text-foreground/90">{formatScalar(node)}</span>
        {node.kind === 'binary' ? (
          <span className="truncate text-muted-foreground/50" title={node.preview}>
            {node.preview}
          </span>
        ) : null}
      </div>
    )
  }

  const count = viewChildCount(node)

  return (
    <>
      <button
        type="button"
        style={indent}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1 py-px pr-2 text-left hover:bg-accent/40"
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground/60" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground/60" />
        )}
        <span className="text-muted-foreground">{label}</span>
        <span className="text-muted-foreground/50">
          {node.kind === 'array' ? `[${count}]` : `{${count}}`}
        </span>
      </button>

      {expanded ? <Children node={node} depth={depth} filter={filter} autoExpand={autoExpand} /> : null}
    </>
  )
}

function Children({
  node,
  depth,
  filter,
  autoExpand
}: {
  node: BymlNodeView
  depth: number
  filter: string
  autoExpand: boolean
}): ReactNode {
  if (node.kind === 'array') {
    return (
      <>
        {node.items.map((item, index) => (
          <Node
            key={index}
            node={item}
            label={String(index)}
            depth={depth + 1}
            filter={filter}
            autoExpand={autoExpand}
          />
        ))}
      </>
    )
  }

  if (node.kind === 'map') {
    return (
      <>
        {node.entries.map((entry, index) => (
          <Node
            key={`${entry.key}-${index}`}
            node={entry.value}
            label={entry.key}
            depth={depth + 1}
            filter={filter}
            autoExpand={autoExpand}
          />
        ))}
      </>
    )
  }

  if (node.kind === 'hashmap') {
    return (
      <>
        {node.entries.map((entry, index) => (
          <Node
            key={`${entry.hash}-${index}`}
            node={entry.value}
            // The key strings are not stored in the file, only their hashes, so
            // there is nothing more informative to show than the hash itself.
            label={`<${entry.hash.toString(16).padStart(8, '0')}>`}
            depth={depth + 1}
            filter={filter}
            autoExpand={autoExpand}
          />
        ))}
      </>
    )
  }

  return null
}
