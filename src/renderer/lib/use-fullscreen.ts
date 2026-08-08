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
    return api.onMenuCommand((command) => {
      if (command === 'fullscreen-on') setFullscreen(true)
      else if (command === 'fullscreen-off') setFullscreen(false)
    })
  }, [])

  return fullscreen
}

/** True on macOS, where the window uses hiddenInset. */
export const IS_MAC =
  typeof window !== 'undefined' && window.bflayout?.platform === 'darwin'
