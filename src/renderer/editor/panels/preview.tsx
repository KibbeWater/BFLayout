import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Box,
  Braces,
  FileQuestion,
  Image,
  Loader2,
  MessageSquareText,
  Music,
  SlidersHorizontal,
  Type,
  Workflow
} from 'lucide-react'

import type { LayoutSource, Preview } from '@shared/contract'
import { getClient, getOrpc } from '@renderer/lib/orpc'
import { describeError } from '@renderer/lib/errors'
import { reportError, reportSuccess } from '@renderer/lib/toast'
import { BymlTree } from '@renderer/editor/panels/byml-viewer'

/**
 * Shows what can be made of a file that is not a layout.
 *
 * Most of a romfs is not a layout, and everything else used to be a dead end: the file tree and
 * the archive browser classified a font, a texture container or a data tree and then reported
 * "cannot open" for files this build reads perfectly well. A font *archive* was the worst of it —
 * it opened as an archive whose every entry did nothing, which reads as the app being broken
 * rather than a feature being absent.
 *
 * Deliberately read-only. Editing is the layout canvas's job; the point here is that clicking a
 * file shows you the file.
 */
export function PreviewPanel({
  source,
  onClose
}: {
  source: LayoutSource
  onClose: () => void
}): ReactNode {
  const orpc = getOrpc()
  const preview = useQuery(orpc.preview.open.queryOptions({ input: { source } }))

  const content = preview.data?.content
  const style = content ? KIND_STYLE[content.kind] : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/*
        One header for every format, with a coloured badge naming the kind.
        
        The preview shows eight very different things, and without a consistent frame each read as a
        different screen. The badge is the fastest answer to "what am I looking at", and its colour
        makes the answer recognisable before the words are read.
      */}
      <div className="shrink-0 border-b">
        <div className="flex items-center gap-2 px-3 pt-2.5">
          {style ? (
            <span
              className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${style.badge}`}
            >
              {style.icon}
              {style.label}
            </span>
          ) : null}
          <p
            className="min-w-0 flex-1 truncate text-sm font-medium"
            title={preview.data?.name}
          >
            {preview.data?.name ?? 'Opening…'}
          </p>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Close
          </button>
        </div>
        {preview.data ? (
          <p className="px-3 pb-2 pt-0.5 font-mono text-[10px] text-muted-foreground/70">
            {preview.data.format} · {formatSize(preview.data.bytes)}
            {preview.data.compression === 'none' ? '' : ` · ${preview.data.compression}`}
          </p>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {preview.isPending ? (
          <Centre>
            <Loader2 className="size-4 animate-spin" /> Reading…
          </Centre>
        ) : preview.error ? (
          <Centre>
            <AlertTriangle className="size-4 text-destructive" />
            {describeError(preview.error).detail}
          </Centre>
        ) : preview.data ? (
          <Body preview={preview.data} source={source} />
        ) : null}
      </div>
    </div>
  )
}

/**
 * Badge, icon and accent for each content kind.
 *
 * A lookup rather than logic in the header, so adding a format means adding a row here and the shell
 * cannot end up with a format it has no label for — the type checker requires every kind to appear.
 */
const KIND_STYLE: Record<
  Preview['content']['kind'],
  { label: string; badge: string; icon: ReactNode }
> = {
  font: {
    label: 'font',
    badge: 'bg-violet-500/15 text-violet-400',
    icon: <Type className="size-3" />
  },
  textures: {
    label: 'textures',
    badge: 'bg-sky-500/15 text-sky-400',
    icon: <Image className="size-3" />
  },
  data: {
    label: 'data',
    badge: 'bg-emerald-500/15 text-emerald-400',
    icon: <Braces className="size-3" />
  },
  messages: {
    label: 'text',
    badge: 'bg-amber-500/15 text-amber-400',
    icon: <MessageSquareText className="size-3" />
  },
  model: {
    label: 'model',
    badge: 'bg-orange-500/15 text-orange-400',
    icon: <Box className="size-3" />
  },
  parameters: {
    label: 'parameters',
    badge: 'bg-teal-500/15 text-teal-400',
    icon: <SlidersHorizontal className="size-3" />
  },
  audio: {
    label: 'audio',
    badge: 'bg-pink-500/15 text-pink-400',
    icon: <Music className="size-3" />
  },
  logic: {
    label: 'logic',
    badge: 'bg-indigo-500/15 text-indigo-400',
    icon: <Workflow className="size-3" />
  },
  unsupported: {
    label: 'unread',
    badge: 'bg-muted text-muted-foreground',
    icon: <FileQuestion className="size-3" />
  }
}

function Body({ preview, source }: { preview: Preview; source: LayoutSource }): ReactNode {
  const content = preview.content
  switch (content.kind) {
    case 'font':
      return <FontBody content={content} />
    case 'data':
      return <BymlTree document={content.document} />
    case 'messages':
      return <MessageList content={content} source={source} />
    case 'model':
      return <ModelBody content={content} />
    case 'parameters':
      return <ParameterBody content={content} />
    case 'audio':
      return <AudioBody content={content} />
    case 'logic':
      return <LogicBody content={content} />
    case 'textures':
      return <TextureList content={content} />
    case 'unsupported':
      return (
        <Centre>
          <AlertTriangle className="size-4 text-muted-foreground/60" />
          {content.reason}
        </Centre>
      )
    default: {
      const exhaustive: never = content
      return <Centre>{String(exhaustive)}</Centre>
    }
  }
}

/** A sample that exercises Latin, digits, punctuation and kana in one line. */
const SAMPLE = 'ABCDEFGhijklmn 0123456789 !?&@ あいうえお 漢字'

function FontBody({
  content
}: {
  content: Extract<Preview['content'], { kind: 'font' }>
}): ReactNode {
  const [registered, setRegistered] = useState<Record<string, boolean>>({})
  const [size, setSize] = useState(28)

  /*
   * Registered under a preview-only family prefix.
   *
   * The canvas scopes its own family names by font archive so two dumps cannot collide; reusing
   * that scheme here would couple the preview to it for no benefit, and a distinct prefix makes
   * it obvious which registrations came from looking rather than from drawing a layout.
   */
  const faces = useMemo(() => content.faces, [content.faces])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      for (const face of faces) {
        const family = `bflayout-preview-${face.name}`
        try {
          const font = new FontFace(family, await face.sfnt.arrayBuffer())
          await font.load()
          if (cancelled) return
          document.fonts.add(font)
          setRegistered((current) => ({ ...current, [face.name]: true }))
        } catch {
          // A face the browser rejects is left unrendered rather than failing the panel; the
          // row still reports its size and kind, which is more than nothing.
          if (!cancelled) setRegistered((current) => ({ ...current, [face.name]: false }))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [faces])

  return (
    <div className="space-y-4 p-3">
      {content.complexes.length > 0 ? (
        <section>
          <h3 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Font complexes
          </h3>
          <p className="mb-2 text-[11px] text-muted-foreground/70">
            Each names its faces in fallback order — specialised faces first, main typeface last.
            A layout&apos;s font list names one of these, not a typeface.
          </p>
          <ul className="space-y-1.5">
            {content.complexes.map((complex) => (
              <li key={complex.name} className="rounded border p-2">
                <p className="font-mono text-xs">{complex.name}</p>
                <ol className="mt-1 space-y-0.5">
                  {complex.faces.map((face, index) => (
                    <li key={`${face}-${index}`} className="text-[11px] text-muted-foreground">
                      {index + 1}. {face}
                      {content.missing.includes(face) ? (
                        <span className="ml-1 text-amber-500">— not in this archive</span>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {faces.length > 0 ? (
        <section>
          <div className="mb-2 flex items-center gap-2">
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {faces.length} face{faces.length === 1 ? '' : 's'}
            </h3>
            <input
              type="range"
              min={12}
              max={64}
              value={size}
              onChange={(event) => setSize(Number(event.target.value))}
              className="ml-auto w-32"
              title="Sample size"
            />
            <span className="w-8 text-right tabular-nums text-[11px] text-muted-foreground">
              {size}px
            </span>
          </div>
          <ul className="space-y-2">
            {faces.map((face) => (
              <li key={face.name} className="rounded border p-2">
                <p className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{face.name}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {face.kind.toUpperCase()} · {formatSize(face.bytes)}
                  </span>
                </p>
                {registered[face.name] === false ? (
                  <p className="mt-1 text-[11px] text-destructive">
                    The browser would not load this face.
                  </p>
                ) : (
                  <p
                    className="mt-1 select-text break-words leading-tight"
                    style={{
                      fontFamily: `"bflayout-preview-${face.name}", sans-serif`,
                      fontSize: `${size}px`
                    }}
                  >
                    {SAMPLE}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {faces.length === 0 && content.complexes.length === 0 ? (
        <Centre>No faces or complexes in this file.</Centre>
      ) : null}
    </div>
  )
}

/**
 * A game's text, filterable by label or content.
 *
 * A filter rather than a scroll, because a single table can hold thousands of strings and finding
 * one by eye is not a workflow. Control sequences arrive as `{n:group.type}` placeholders from the
 * parser and are shown as such — dimmed, so the actual words stand out from the machinery around
 * them.
 */
function MessageList({
  content,
  source
}: {
  content: Extract<Preview['content'], { kind: 'messages' }>
  source: LayoutSource
}): ReactNode {
  const orpc = getOrpc()
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState('')
  /** Edited text by message index. Only what changed is ever sent. */
  const [drafts, setDrafts] = useState<Record<number, string>>({})
  const [saving, setSaving] = useState(false)

  /*
   * The preview truncates its message list — a table can hold thousands of strings
   * and the panel only ever showed the first slice. Editing needs the real thing,
   * so the authoritative table is loaded separately and the preview's copy is only
   * what fills the panel until it arrives.
   */
  const table = useQuery(orpc.messages.open.queryOptions({ input: { source } }))

  const messages = table.data?.messages ?? content.messages
  const needle = filter.trim().toLowerCase()
  const shown = useMemo(
    () =>
      needle === ''
        ? messages
        : messages.filter(
            (message) =>
              message.label.toLowerCase().includes(needle) ||
              message.text.toLowerCase().includes(needle)
          ),
    [messages, needle]
  )

  const edited = Object.entries(drafts).filter(([index, text]) => {
    const original = messages.find((message) => message.index === Number(index))
    return original !== undefined && original.text !== text
  })

  const save = (): void => {
    if (edited.length === 0) return
    setSaving(true)
    void (async () => {
      try {
        const result = await getClient().messages.save({
          source,
          edits: edited.map(([index, text]) => ({ index: Number(index), text }))
        })
        setDrafts({})
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.messages.open.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.preview.open.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.project.status.key() })
        ])
        reportSuccess(
          result.redirected ? 'Saved into the mod' : 'Saved',
          result.path === null
            ? `${result.changed} message${result.changed === 1 ? '' : 's'} written into the archive. Save the archive to put it on disk.`
            : `${result.changed} message${result.changed === 1 ? '' : 's'} written to ${result.path}.`
        )
      } catch (cause) {
        reportError(cause, { retry: save })
      } finally {
        setSaving(false)
      }
    })()
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b px-3 py-1.5">
        <div className="flex items-center gap-2">
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter labels and text"
            className="w-full rounded border bg-input/40 px-1.5 py-1 text-xs outline-none"
          />
          <span className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground">
            {shown.length === messages.length
              ? `${messages.length} messages`
              : `${shown.length} of ${messages.length}`}
            {' · '}
            {content.encoding}
          </span>
          <button
            type="button"
            onClick={save}
            disabled={saving || edited.length === 0}
            className="shrink-0 rounded border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-40"
            title={
              edited.length === 0
                ? 'Nothing edited yet'
                : `Write ${edited.length} changed message${edited.length === 1 ? '' : 's'}`
            }
          >
            {saving ? 'Saving…' : `Save${edited.length > 0 ? ` (${edited.length})` : ''}`}
          </button>
        </div>
        {table.isPending && content.messages.length < content.total ? (
          <p className="mt-1 text-[11px] text-muted-foreground/60">
            Loading the rest of the table…
          </p>
        ) : null}
      </div>

      <ul className="min-h-0 flex-1 overflow-auto p-2">
        {shown.map((message) => {
          const draft = drafts[message.index]
          const dirty = draft !== undefined && draft !== message.text
          return (
            <li
              key={`${message.index}-${message.label}`}
              className={`mb-1.5 rounded border p-2 ${dirty ? 'border-primary/60' : ''}`}
            >
              <p className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                <span className="min-w-0 flex-1 truncate">{message.label}</span>
                {'hasCommands' in message && message.hasCommands ? (
                  <span
                    className="shrink-0 rounded bg-muted/60 px-1 text-[9px] uppercase"
                    title="Carries inline commands. The {n:…} placeholders can be moved, repeated or removed — but not invented, since each one carries data the placeholder cannot show."
                  >
                    cmd
                  </span>
                ) : null}
              </p>
              {/*
                A textarea rather than the dimmed read-only rendering. The placeholders
                have to stay literally editable — moving a variable substitution to a
                different point in a sentence is most of what translating is — and a
                rich rendering would either hide them or make them unselectable.
              */}
              <textarea
                value={draft ?? message.text}
                onChange={(event) =>
                  setDrafts({ ...drafts, [message.index]: event.target.value })
                }
                rows={Math.min(6, Math.max(1, Math.ceil((draft ?? message.text).length / 60)))}
                spellCheck={false}
                className="mt-0.5 w-full resize-y rounded bg-transparent px-1 py-0.5 text-xs outline-none focus:bg-input/40"
              />
            </li>
          )
        })}
        {shown.length === 0 ? (
          <li className="p-4 text-center text-xs text-muted-foreground/60">
            Nothing matches that.
          </li>
        ) : null}
      </ul>
    </div>
  )
}

/*
 * The dimmed read-only rendering of `{n:...}` placeholders used to live here and
 * has been removed with the read-only list. Placeholders have to stay literally
 * editable — moving a variable substitution to a different point in a sentence is
 * most of what translating is — and any rich rendering either hides them or makes
 * them unselectable.
 */

/**
 * A model container's structure. No geometry — decoding vertex buffers is a different project, and
 * what is useful without one is what the file contains.
 */
function ModelBody({
  content
}: {
  content: Extract<Preview['content'], { kind: 'model' }>
}): ReactNode {
  return (
    <div className="space-y-3 p-3">
      <p className="text-[11px] text-muted-foreground">
        {content.name} · version {content.version} · {content.modelCount} model
        {content.modelCount === 1 ? '' : 's'} · {content.subfileCount} subfile
        {content.subfileCount === 1 ? '' : 's'}
      </p>

      {content.subfileKinds.length > 0 ? (
        <p className="flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
          {content.subfileKinds.map((entry) => (
            <span key={entry.kind} className="rounded border px-1.5 py-0.5">
              {entry.kind} × {entry.count}
            </span>
          ))}
        </p>
      ) : null}

      <ul className="space-y-2">
        {content.models.map((model) => (
          <li key={model.name} className="rounded border p-2">
            <p className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{model.name}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {model.vertexCount.toLocaleString()} vertices · {model.shapeCount} shape
                {model.shapeCount === 1 ? '' : 's'} · {model.boneCount} bone
                {model.boneCount === 1 ? '' : 's'}
              </span>
            </p>
            {model.materials.length > 0 ? (
              <ul className="mt-1.5 space-y-1">
                {model.materials.map((material) => (
                  <li key={material.name} className="rounded bg-muted/40 px-1.5 py-1">
                    <p className="font-mono text-[11px]">{material.name}</p>
                    {material.textures.length > 0 ? (
                      <p className="mt-0.5 flex flex-wrap gap-1 text-[10px] text-muted-foreground">
                        {material.textures.map((texture) => (
                          <span key={texture}>{texture}</span>
                        ))}
                        {material.textureCount > material.textures.length ? (
                          <span className="text-amber-500">
                            +{material.textureCount - material.textures.length} more
                          </span>
                        ) : null}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
      {content.models.length < content.modelCount ? (
        <p className="text-[11px] text-amber-500">
          Showing {content.models.length} of {content.modelCount} models.
        </p>
      ) : null}
    </div>
  )
}

/**
 * An AAMP parameter tree, flattened and indented by depth.
 *
 * Labels are the resolved name *or* the hash in hex — AAMP stores CRC32 hashes rather than names and
 * only some resolve, so a hash is shown as a hash rather than dressed up as a name. A parameter
 * whose value type never occurs in real files is marked, because its layout is inferred.
 */
function ParameterBody({
  content
}: {
  content: Extract<Preview['content'], { kind: 'parameters' }>
}): ReactNode {
  const [filter, setFilter] = useState('')
  const needle = filter.trim().toLowerCase()
  const shown = useMemo(
    () =>
      needle === ''
        ? content.nodes
        : content.nodes.filter(
            (node) =>
              node.label.toLowerCase().includes(needle) ||
              node.value.toLowerCase().includes(needle)
          ),
    [content.nodes, needle]
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b px-3 py-1.5">
        <div className="flex items-center gap-2">
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter names and values"
            className="w-full rounded border bg-input/40 px-1.5 py-1 text-xs outline-none"
          />
          <span className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground">
            {content.typeName} · {content.counts.parameters} parameters
          </span>
        </div>
        {content.unresolvedNames > 0 ? (
          <p className="mt-1 text-[11px] text-muted-foreground/70">
            {content.unresolvedNames} name{content.unresolvedNames === 1 ? '' : 's'} shown as a hash:
            AAMP stores CRC32 hashes, not names, and no candidate matched.
          </p>
        ) : null}
      </div>

      <ul className="min-h-0 flex-1 overflow-auto py-1 font-mono text-[11px]">
        {shown.map((node, index) => (
          <li
            key={`${node.depth}-${node.label}-${index}`}
            className="flex gap-2 px-2 py-0.5 hover:bg-accent/40"
            style={{ paddingLeft: `${node.depth * 12 + 8}px` }}
          >
            <span className={node.kind === 'parameter' ? '' : 'font-semibold'}>{node.label}</span>
            {node.kind === 'parameter' ? (
              <>
                <span className="text-muted-foreground/50">{node.type}</span>
                <span className="min-w-0 flex-1 truncate select-text">{node.value}</span>
                {node.verified ? null : (
                  <span
                    title="This value type does not occur in any real file checked, so its layout is inferred"
                    className="shrink-0 text-amber-500"
                  >
                    inferred
                  </span>
                )}
              </>
            ) : (
              <span className="text-muted-foreground/50">{node.type}</span>
            )}
          </li>
        ))}
      </ul>
      {content.nodes.length < content.total ? (
        <p className="shrink-0 border-t px-3 py-1 text-[11px] text-amber-500">
          Showing {content.nodes.length} of {content.total} nodes.
        </p>
      ) : null}
    </div>
  )
}

/**
 * An AINB logic graph, as far as the format has given it up.
 *
 * Deliberately **not** a node graph with edges, and that is the honest part. Node-to-node
 * connections live in the per-node parameter bodies, which this build locates and bounds-checks but
 * does not decode — so which node feeds which is unknown. Drawing a graph would mean inventing the
 * edges, and a convincing wrong picture of a game's AI is worse than an accurate list.
 *
 * What the file does say, and what is shown: its entry points, every node with its type and name,
 * how the types are distributed, and the other AINB modules it pulls in — which is a real edge, at
 * file level rather than node level, and the one relationship available without decoding bodies.
 */
function LogicBody({
  content
}: {
  content: Extract<Preview['content'], { kind: 'logic' }>
}): ReactNode {
  const [filter, setFilter] = useState('')
  const [focused, setFocused] = useState<number | null>(null)
  const needle = filter.trim().toLowerCase()

  const shown = useMemo(
    () =>
      needle === ''
        ? content.nodes
        : content.nodes.filter(
            (node) =>
              node.name.toLowerCase().includes(needle) ||
              String(node.type).includes(needle) ||
              String(node.index) === needle
          ),
    [content.nodes, needle]
  )

  const named = content.nodes.filter((node) => node.userDefined).length

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-2 border-b p-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px]">
          <span className="font-mono text-xs">{content.name}</span>
          <span className="text-muted-foreground">
            {content.category} · v{content.version} · {content.nodeCount} node
            {content.nodeCount === 1 ? '' : 's'} ({named} named) · {content.globalParameterCount}{' '}
            globals
          </span>
        </div>

        {content.commands.length > 0 ? (
          <div>
            <h3 className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Entry points
            </h3>
            <ul className="flex flex-wrap gap-1.5">
              {content.commands.map((command) => (
                <li key={`${command.name}-${command.entryNodeIndex}`}>
                  {/* Jumping to the entry node is the one bit of navigation the data supports. */}
                  <button
                    type="button"
                    onClick={() => {
                      setFilter('')
                      setFocused(command.entryNodeIndex)
                    }}
                    title={`Show node ${command.entryNodeIndex}`}
                    className="flex items-center gap-1 rounded border border-indigo-500/40 bg-indigo-500/10 px-1.5 py-0.5 font-mono text-[11px] hover:bg-indigo-500/20"
                  >
                    {command.name}
                    <span className="text-muted-foreground">#{command.entryNodeIndex}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {content.modules.length > 0 ? (
          <div>
            <h3 className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Pulls in {content.modules.length} module{content.modules.length === 1 ? '' : 's'}
            </h3>
            <p className="flex flex-wrap gap-1 font-mono text-[10px] text-muted-foreground">
              {content.modules.map((module) => (
                <span key={module} className="rounded bg-muted px-1 py-0.5">
                  {module.replace(/\.module$/, '')}
                </span>
              ))}
            </p>
          </div>
        ) : null}

        {content.nodeTypeCounts.length > 1 ? (
          <div>
            <h3 className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Node types
            </h3>
            {/*
              A bar per type. Only type 0 carries a name, so the rest are numbers on purpose:
              nothing in these files labels them, and a label borrowed from elsewhere would be a
              guess presented as a fact.
            */}
            <ul className="space-y-0.5">
              {content.nodeTypeCounts.slice(0, 8).map((entry) => (
                <li key={entry.type} className="flex items-center gap-2 text-[10px]">
                  <span className="w-16 shrink-0 font-mono text-muted-foreground">
                    {entry.type === 0 ? 'user' : `type ${entry.type}`}
                  </span>
                  <span className="h-1.5 flex-1 overflow-hidden rounded bg-muted">
                    <span
                      className="block h-full rounded bg-indigo-500/60"
                      style={{
                        width: `${Math.max(2, (entry.count / content.nodeCount) * 100)}%`
                      }}
                    />
                  </span>
                  <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground">
                    {entry.count}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {content.problems.length > 0 ? (
          <ul className="space-y-0.5 text-[11px] text-amber-500">
            {content.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        ) : null}

        <div className="flex items-center gap-2">
          <input
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value)
              setFocused(null)
            }}
            placeholder="Filter nodes by name, type or index"
            className="w-full rounded border bg-input/40 px-1.5 py-1 text-xs outline-none"
          />
          <span className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground">
            {shown.length === content.nodes.length
              ? `${shown.length} shown`
              : `${shown.length} of ${content.nodes.length}`}
          </span>
        </div>
        <p className="text-[10px] text-muted-foreground/60">
          Connections between nodes are not decoded — the per-node parameter bodies are located but
          unread, so no edges are drawn rather than invented ones.
        </p>
      </div>

      <ul className="min-h-0 flex-1 overflow-auto py-1 font-mono text-[11px]">
        {shown.map((node) => (
          <li
            key={node.index}
            className={`flex items-baseline gap-2 px-3 py-0.5 ${
              focused === node.index ? 'bg-indigo-500/20' : 'hover:bg-accent/40'
            }`}
          >
            <span className="w-10 shrink-0 text-right text-muted-foreground/60">
              {node.index}
            </span>
            <span className="w-14 shrink-0 text-muted-foreground">
              {node.userDefined ? 'user' : `t${node.type}`}
            </span>
            <span className="min-w-0 flex-1 truncate select-text">
              {node.name || <span className="text-muted-foreground/40">(unnamed)</span>}
            </span>
          </li>
        ))}
      </ul>
      {content.nodes.length < content.nodeCount ? (
        <p className="shrink-0 border-t px-3 py-1 text-[11px] text-amber-500">
          Showing {content.nodes.length} of {content.nodeCount} nodes.
        </p>
      ) : null}
    </div>
  )
}

/** An audio sample's metadata. Playback would need a decoder this build does not have. */
function AudioBody({
  content
}: {
  content: Extract<Preview['content'], { kind: 'audio' }>
}): ReactNode {
  const rows: [string, string][] = [
    ['Channels', String(content.channelCount)],
    ['Sample rate', content.sampleRate === null ? 'mixed' : `${content.sampleRate} Hz`],
    ['Codec', content.codec],
    [
      'Duration',
      content.durationSeconds === null ? 'unknown' : formatDuration(content.durationSeconds)
    ],
    ['Looping', content.looping ? 'yes' : 'no']
  ]

  return (
    <div className="space-y-3 p-3">
      <dl className="space-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="flex gap-2 text-xs">
            <dt className="w-28 shrink-0 text-muted-foreground">{label}</dt>
            <dd className="select-text font-mono">{value}</dd>
          </div>
        ))}
      </dl>
      {content.decodable ? null : (
        <p className="rounded bg-muted px-2 py-1.5 text-[11px] text-muted-foreground">
          {content.undecodableReason ??
            'This build reads the header but does not decode the audio, so there is nothing to play.'}
        </p>
      )}
    </div>
  )
}

function formatDuration(seconds: number): string {
  const whole = Math.floor(seconds)
  const minutes = Math.floor(whole / 60)
  const rest = (seconds - minutes * 60).toFixed(1)
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`
}

function TextureList({
  content
}: {
  content: Extract<Preview['content'], { kind: 'textures' }>
}): ReactNode {
  return (
    <div className="p-3">
      <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {content.textures.length} texture{content.textures.length === 1 ? '' : 's'}
      </h3>
      <ul className="space-y-1">
        {content.textures.map((texture) => (
          <li
            key={texture.name}
            className="flex items-baseline gap-2 rounded border px-2 py-1 text-xs"
          >
            <span className="min-w-0 flex-1 truncate font-mono">{texture.name}</span>
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {texture.width}×{texture.height}
              {texture.mipCount > 1 ? ` · ${texture.mipCount} mips` : ''} · {texture.format}
            </span>
            {texture.decodable ? null : (
              <span className="shrink-0 text-[11px] text-amber-500">no decoder</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

function Centre({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="flex h-full items-center justify-center gap-2 p-6 text-center text-xs text-muted-foreground">
      {children}
    </div>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
