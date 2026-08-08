import { useCallback, useRef } from 'react'

import { useFolder } from '@renderer/editor/store/folder'

/**
 * Keeps a scroll container where the user left it across remounts.
 *
 * The sidebar renders one tab at a time, so switching to Archive and back unmounts the whole file
 * browser and its scroll position goes with the DOM node. Fixing expansion and filters without this
 * made it arguably worse: the tree stayed open at the place you were and then showed you the top of
 * it, so the state was correct and invisible.
 *
 * Restored in a ref callback rather than an effect, because the callback runs with the node already
 * laid out and its content already measured — an effect can fire before the rows exist, in which
 * case setting `scrollTop` past the current height is silently clamped to zero.
 *
 * `key` should identify the view *and* what it is showing: the tree and the flat list scroll
 * independently over the same directory, so a path alone would make them fight.
 */
export function useRememberedScroll(key: string): {
  ref: (node: HTMLElement | null) => void
  onScroll: (event: { currentTarget: { scrollTop: number } }) => void
} {
  const offsets = useFolder((state) => state.scrollOffsets)
  const setScrollOffset = useFolder((state) => state.setScrollOffset)

  /*
   * The remembered offset is read through a ref rather than as a dependency.
   *
   * The ref callback must not be re-created every time the offset changes — that would detach and
   * reattach on every scroll event, and each reattach would restore the position it had just saved,
   * pinning the view. The callback therefore depends only on the key.
   */
  const latest = useRef(offsets)
  latest.current = offsets

  const ref = useCallback(
    (node: HTMLElement | null) => {
      if (!node) return
      const remembered = latest.current[key]
      if (remembered) node.scrollTop = remembered
    },
    [key]
  )

  const onScroll = useCallback(
    (event: { currentTarget: { scrollTop: number } }) => {
      setScrollOffset(key, event.currentTarget.scrollTop)
    },
    [key, setScrollOffset]
  )

  return { ref, onScroll }
}
