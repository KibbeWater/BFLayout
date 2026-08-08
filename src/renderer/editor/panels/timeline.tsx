import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Film,
  Loader2,
  Pause,
  Play,
  Repeat,
  SkipBack,
  SkipForward,
  X
} from 'lucide-react'

import type { LayoutSource } from '@shared/contract'
import { tagName, targetName, type AnimationDocument } from '@shared/formats/bflan'
import { getClient, getOrpc } from '@renderer/lib/orpc'
import { describeError } from '@renderer/lib/errors'
import { reportError } from '@renderer/lib/toast'
import { useActiveTab } from '@renderer/editor/store/document'
import { usePlayback } from '@renderer/editor/store/playback'

/**
 * Animation dock: pick an animation, play or scrub it, and see its keyframes.
 *
 * This is playback and inspection only — keyframes are shown but not editable.
 * Playback is driven by requestAnimationFrame at the animation's own 60fps frame
 * units and never writes to the layout document; the canvas resolves
 * `override ?? static` per frame instead. Stopping restores the authored values
 * with nothing to undo.
 */
export function TimelinePanel(): ReactNode {
  /*
   * Open by default. It used to start collapsed while the editor still reserved its
   * full height for it, so showing the panel took two clicks and wasted the space in
   * between — the toggle exists to get the height back, which only works if the panel
   * is using it in the first place.
   */
  const [collapsed, setCollapsed] = useState(false)
  const tab = useActiveTab()
  const animationId = usePlayback((state) => state.animationId)

  if (!tab) return null

  return (
    <section className="flex shrink-0 flex-col border-t bg-card/40">
      <header className="flex items-center gap-2 px-2 py-1">
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {collapsed ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          <Film className="size-3.5" />
          Animation
        </button>
        {animationId ? <Transport /> : null}
      </header>
      {collapsed ? null : <Body source={tab.source} />}
    </section>
  )
}

function Body({ source }: { source: LayoutSource }): ReactNode {
  const orpc = getOrpc()
  const query = useQuery(orpc.animation.list.queryOptions({ input: { source } }))
  const document = usePlayback((state) => state.document)

  if (query.isPending) {
    return (
      <p className="p-3 text-xs text-muted-foreground/60">
        <Loader2 className="mr-1.5 inline size-3 animate-spin" />
        Looking for animations…
      </p>
    )
  }

  if (query.isError) {
    const described = describeError(query.error)
    return (
      <div className="p-3 text-xs">
        <p className="flex items-center gap-1.5 text-destructive">
          <AlertTriangle className="size-3.5 shrink-0" />
          {described.title}
        </p>
        <p className="mt-1 select-text text-muted-foreground">{described.detail}</p>
        <button
          type="button"
          onClick={() => void query.refetch()}
          className="mt-2 rounded border px-2 py-1 hover:bg-accent"
        >
          Try again
        </button>
      </div>
    )
  }

  return (
    <div className="flex max-h-64 min-h-0">
      <div className="w-56 shrink-0 overflow-y-auto border-r">
        {query.data.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground/60">
            No .bflan animations found next to this layout.
          </p>
        ) : (
          <ul className="p-1">
            {query.data.map((candidate) => (
              <AnimationRow key={candidate.key} candidate={candidate} source={source} />
            ))}
          </ul>
        )}
      </div>
      <div className="min-w-0 flex-1 overflow-auto">
        {document ? <Tracks document={document} /> : (
          <p className="p-3 text-xs text-muted-foreground/60">
            Select an animation to see its tracks.
          </p>
        )}
      </div>
    </div>
  )
}

function AnimationRow({
  candidate,
  source
}: {
  candidate: { key: string; displayName: string; size: number }
  source: LayoutSource
}): ReactNode {
  const load = usePlayback((state) => state.load)
  const activeId = usePlayback((state) => state.animationId)
  const activeName = usePlayback((state) => state.displayName)
  const [loading, setLoading] = useState(false)

  const active = activeId !== null && activeName === candidate.displayName

  const openIt = (): void => {
    setLoading(true)
    void (async () => {
      try {
        const opened = await getClient().animation.open({ source, key: candidate.key })
        load({
          animationId: opened.animationId,
          displayName: opened.displayName,
          document: opened.document,
          source: opened.source
        })
      } catch (cause) {
        reportError(cause, { retry: openIt })
      } finally {
        setLoading(false)
      }
    })()
  }

  return (
    <li>
      <button
        type="button"
        onClick={openIt}
        disabled={loading}
        className={`flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-accent/60 ${
          active ? 'bg-accent' : ''
        }`}
      >
        {loading ? (
          <Loader2 className="size-3 shrink-0 animate-spin" />
        ) : (
          <Film className="size-3 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate" title={candidate.key}>
          {candidate.displayName}
        </span>
      </button>
    </li>
  )
}

function Transport(): ReactNode {
  const playing = usePlayback((state) => state.playing)
  const frame = usePlayback((state) => state.frame)
  const document = usePlayback((state) => state.document)
  const displayName = usePlayback((state) => state.displayName)
  const loopOverride = usePlayback((state) => state.loopOverride)
  const toggle = usePlayback((state) => state.toggle)
  const setFrame = usePlayback((state) => state.setFrame)
  const advance = usePlayback((state) => state.advance)
  const setLoop = usePlayback((state) => state.setLoop)
  const unload = usePlayback((state) => state.unload)

  const frames = document?.info?.frameSize ?? 0
  const looping = loopOverride ?? document?.info?.loop ?? false

  // Playback clock. Frame units are the animation's own 60fps, and elapsed real
  // time drives them so playback stays correct if a frame takes too long.
  const lastRef = useRef<number | null>(null)
  useEffect(() => {
    if (!playing) {
      lastRef.current = null
      return
    }
    let handle = 0
    const tick = (now: number): void => {
      const last = lastRef.current
      lastRef.current = now
      if (last !== null) advance(((now - last) / 1000) * 60)
      handle = requestAnimationFrame(tick)
    }
    handle = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(handle)
  }, [playing, advance])

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      <button
        type="button"
        onClick={() => setFrame(0)}
        title="Go to start"
        className="rounded p-1 hover:bg-accent"
      >
        <SkipBack className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={toggle}
        title={playing ? 'Pause' : 'Play'}
        className="rounded p-1 hover:bg-accent"
      >
        {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
      </button>
      <button
        type="button"
        onClick={() => setFrame(frames)}
        title="Go to end"
        className="rounded p-1 hover:bg-accent"
      >
        <SkipForward className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={() => setLoop(loopOverride === null ? !looping : null)}
        title={
          loopOverride === null
            ? `Loop follows the file (${looping ? 'on' : 'off'})`
            : `Loop forced ${looping ? 'on' : 'off'} — click to follow the file`
        }
        className={`rounded p-1 hover:bg-accent ${
          looping ? 'text-foreground' : 'text-muted-foreground/50'
        } ${loopOverride !== null ? 'ring-1 ring-primary/40' : ''}`}
      >
        <Repeat className="size-3.5" />
      </button>

      <input
        type="range"
        min={0}
        max={Math.max(1, frames)}
        step={0.5}
        value={frame}
        onChange={(event) => setFrame(Number(event.target.value))}
        className="min-w-0 flex-1"
        aria-label="Animation frame"
      />
      <span className="w-24 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
        {frame.toFixed(1)} / {frames}
      </span>
      <span className="max-w-40 truncate text-[11px] text-muted-foreground" title={displayName ?? ''}>
        {displayName}
      </span>
      <button
        type="button"
        onClick={unload}
        title="Close the animation and restore authored values"
        className="rounded p-1 hover:bg-accent"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}

function Tracks({ document }: { document: AnimationDocument }): ReactNode {
  const frame = usePlayback((state) => state.frame)
  const frames = document.info?.frameSize ?? 0
  const entries = document.info?.entries ?? []

  if (entries.length === 0) {
    return (
      <p className="p-3 text-xs text-muted-foreground/60">
        This animation has no keyed panes or materials.
      </p>
    )
  }

  const position = frames > 0 ? (frame / frames) * 100 : 0

  return (
    <div className="relative">
      {/*
        Playhead spans every row so it reads as one line down the timeline. The
        offset skips the two label columns (w-36 + w-32 = 17rem), which is why the
        percentage is taken of the remaining width rather than the whole table.
      */}
      <div
        className="pointer-events-none absolute inset-y-0 z-10 w-px bg-primary"
        style={{ left: `calc(17rem + (100% - 17rem) * ${position / 100})` }}
      />
      <table className="w-full border-collapse text-[11px]">
        <tbody>
          {entries.map((entry) =>
            entry.tags.flatMap((tag) =>
              tag.components.map((component) => (
                <tr
                  key={`${entry.name}-${tag.signature}-${component.target}-${component.index}`}
                  className="border-b border-border/40"
                >
                  <th className="w-36 max-w-36 truncate px-2 py-0.5 text-left font-normal">
                    <span className="truncate text-muted-foreground" title={entry.name}>
                      {entry.name}
                    </span>
                  </th>
                  <td className="w-32 max-w-32 truncate px-1 py-0.5 text-muted-foreground/70">
                    {tagName(tag.signature)} · {targetName(tag.signature, component.target)}
                  </td>
                  <td className="relative h-4">
                    {component.keyframes.map((key, at) => (
                      <span
                        key={at}
                        title={`frame ${key.frame} = ${key.value.toFixed(3)}${
                          component.curve === 'hermite' ? ` (slope ${key.slope.toFixed(3)})` : ''
                        }`}
                        className={`absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border ${
                          component.curve === 'hermite'
                            ? 'border-sky-400 bg-sky-400/60'
                            : 'border-amber-400 bg-amber-400/60'
                        }`}
                        style={{ left: `${frames > 0 ? (key.frame / frames) * 100 : 0}%` }}
                      />
                    ))}
                  </td>
                </tr>
              ))
            )
          )}
        </tbody>
      </table>
    </div>
  )
}
