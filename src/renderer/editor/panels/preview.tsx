import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Loader2 } from 'lucide-react'

import type { LayoutSource, Preview } from '@shared/contract'
import { getOrpc } from '@renderer/lib/orpc'
import { describeError } from '@renderer/lib/errors'
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-baseline gap-2 border-b px-3 py-2">
        <p className="min-w-0 flex-1 truncate font-medium" title={preview.data?.name}>
          {preview.data?.name ?? 'Opening…'}
        </p>
        {preview.data ? (
          <p className="shrink-0 text-[11px] text-muted-foreground">
            {preview.data.format} · {formatSize(preview.data.bytes)}
            {preview.data.compression === 'none' ? '' : ` · ${preview.data.compression}`}
          </p>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded border px-1.5 py-0.5 text-[11px] hover:bg-accent"
        >
          Close
        </button>
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
          <Body preview={preview.data} />
        ) : null}
      </div>
    </div>
  )
}

function Body({ preview }: { preview: Preview }): ReactNode {
  const content = preview.content
  switch (content.kind) {
    case 'font':
      return <FontBody content={content} />
    case 'data':
      return <BymlTree document={content.document} />
    case 'messages':
      return <MessageList content={content} />
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
  content
}: {
  content: Extract<Preview['content'], { kind: 'messages' }>
}): ReactNode {
  const [filter, setFilter] = useState('')
  const needle = filter.trim().toLowerCase()
  const shown = useMemo(
    () =>
      needle === ''
        ? content.messages
        : content.messages.filter(
            (message) =>
              message.label.toLowerCase().includes(needle) ||
              message.text.toLowerCase().includes(needle)
          ),
    [content.messages, needle]
  )

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
            {shown.length === content.total
              ? `${content.total} messages`
              : `${shown.length} of ${content.total}`}
            {' · '}
            {content.encoding}
          </span>
        </div>
        {content.messages.length < content.total ? (
          <p className="mt-1 text-[11px] text-amber-500">
            Showing the first {content.messages.length} of {content.total}; filtering searches
            those.
          </p>
        ) : null}
      </div>

      <ul className="min-h-0 flex-1 overflow-auto p-2">
        {shown.map((message) => (
          <li key={`${message.index}-${message.label}`} className="mb-1.5 rounded border p-2">
            <p className="font-mono text-[11px] text-muted-foreground">{message.label}</p>
            <p className="mt-0.5 select-text whitespace-pre-wrap break-words text-xs">
              {renderText(message.text)}
            </p>
          </li>
        ))}
        {shown.length === 0 ? (
          <li className="p-4 text-center text-xs text-muted-foreground/60">
            Nothing matches that.
          </li>
        ) : null}
      </ul>
    </div>
  )
}

/** Dims the `{n:...}` placeholders so the words read as words. */
function renderText(text: string): ReactNode {
  const parts = text.split(/(\{n:[^}]*\})/g)
  return parts.map((part, index) =>
    part.startsWith('{n:') ? (
      <span key={index} className="text-muted-foreground/50">
        {part}
      </span>
    ) : (
      part
    )
  )
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
