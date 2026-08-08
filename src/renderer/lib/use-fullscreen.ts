import { useEffect, useState } from 'react'

/**
 * True while the window is in fullscreen.
 *
 * Reported by the main process rather than observed here: window fullscreen is not
 * the same thing as HTML fullscreen, so `document.fullscreenElement` never fires
 * for it. It matters because the macOS traffic lights disappear in fullscreen, and
 * the padding that keeps clear of them becomes an empty gap.
 */
export function useFullscreen(): boolean {
  const [fullscreen, setFullscreen] = useState(false)

  useEffect(() => {
    const api = window.bflayout
    if (!api?.onMenuCommand) return
    const stop = api.onMenuCommand((command) => {
      if (command === 'fullscreen-on') setFullscreen(true)
      else if (command === 'fullscreen-off') setFullscreen(false)
    })

    /*
     * Asked for once the listener is in place, rather than relying on having caught a report.
     *
     * The three main-side reports — enter, leave, and `did-finish-load` — all happen at moments
     * this hook may not have been subscribed for: the load report can beat React to mounting, and
     * a window that opens *already* fullscreen, which macOS does when it restores a space, fires
     * no transition at all. Both left the inset that clears the traffic lights sitting there with
     * no traffic lights behind it.
     */
    api.requestFullscreenState?.()
    return stop
  }, [])

  return fullscreen
}

/** True on macOS, where the window uses hiddenInset. */
export const IS_MAC =
  typeof window !== 'undefined' && window.bflayout?.platform === 'darwin'
