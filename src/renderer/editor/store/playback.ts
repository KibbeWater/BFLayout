import { create } from 'zustand'

import {
  buildOverrides,
  normalizeFrame,
  type AnimationDocument,
  type AnimationOverrides
} from '@shared/formats/bflan'
import type { LayoutSource } from '@shared/contract'

/**
 * Animation playback state.
 *
 * The overrides for the current frame are recomputed whenever the frame moves and
 * cached here, rather than being rebuilt inside the render loop: the canvas
 * redraws on camera moves and selection changes too, and re-evaluating every
 * curve for those would be wasted work.
 *
 * Playback never touches the layout document. Stopping clears `overrides`, which
 * is all it takes to restore the authored values — there is nothing to undo.
 */
export interface PlaybackState {
  readonly animationId: string | null
  readonly displayName: string | null
  readonly document: AnimationDocument | null
  readonly source: LayoutSource | null
  readonly frame: number
  readonly playing: boolean
  /** Overrides for `frame`, or null when no animation is loaded. */
  readonly overrides: AnimationOverrides | null
  /** Overrides the animation's own loop flag when set. */
  readonly loopOverride: boolean | null

  load: (animation: {
    animationId: string
    displayName: string
    document: AnimationDocument
    source: LayoutSource
  }) => void
  unload: () => void
  setFrame: (frame: number) => void
  /** Advances by `delta` frames, wrapping or clamping per the loop setting. */
  advance: (delta: number) => void
  play: () => void
  pause: () => void
  toggle: () => void
  setLoop: (loop: boolean | null) => void
}

function framesOf(document: AnimationDocument | null): number {
  return document?.info?.frameSize ?? 0
}

export const usePlayback = create<PlaybackState>((set, get) => ({
  animationId: null,
  displayName: null,
  document: null,
  source: null,
  frame: 0,
  playing: false,
  overrides: null,
  loopOverride: null,

  load: ({ animationId, displayName, document, source }) =>
    set({
      animationId,
      displayName,
      document,
      source,
      frame: 0,
      playing: false,
      overrides: buildOverrides(document, 0)
    }),

  unload: () =>
    set({
      animationId: null,
      displayName: null,
      document: null,
      source: null,
      frame: 0,
      playing: false,
      overrides: null
    }),

  setFrame: (frame) => {
    const { document, loopOverride } = get()
    if (!document) return
    const at = normalizeFrame(document, frame, loopOverride ?? undefined)
    set({ frame: at, overrides: buildOverrides(document, at) })
  },

  advance: (delta) => {
    const { document, frame, loopOverride } = get()
    if (!document) return
    const looping = loopOverride ?? document.info?.loop ?? false
    const next = frame + delta
    const size = framesOf(document)

    if (!looping && next >= size) {
      // Reaching the end of a non-looping animation stops rather than sticking
      // on the last frame with the play button still lit.
      set({ frame: size, overrides: buildOverrides(document, size), playing: false })
      return
    }

    const at = normalizeFrame(document, next, looping)
    set({ frame: at, overrides: buildOverrides(document, at) })
  },

  play: () => {
    const { document, frame } = get()
    if (!document) return
    // Restarting from the end is the useful behaviour; otherwise pressing play
    // on a finished animation appears to do nothing.
    const at = frame >= framesOf(document) ? 0 : frame
    set({ playing: true, frame: at, overrides: buildOverrides(document, at) })
  },

  pause: () => set({ playing: false }),

  toggle: () => (get().playing ? get().pause() : get().play()),

  setLoop: (loopOverride) => set({ loopOverride })
}))
