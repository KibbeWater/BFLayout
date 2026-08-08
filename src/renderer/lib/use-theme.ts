import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'

import { getOrpc } from '@renderer/lib/orpc'

/**
 * Applies the theme setting, which until now was stored and ignored.
 *
 * `theme` has been a persisted field with three values for a long time, `dark` was hardcoded on the
 * `<html>` element, and nothing ever read the setting — so `light` and `system` did nothing at all
 * while the welcome screen printed the chosen value back as if it had taken effect.
 *
 * Two halves, and the second is what makes it feel like a Mac app rather than a web page in a
 * window:
 *
 *   1. The `.dark` class on the document element, which is what Tailwind's variant keys off.
 *   2. `nativeTheme.themeSource` in main, so the *native* chrome follows too — menus, the traffic
 *      lights, scrollbars, native dialogs and the window frame. Setting only the CSS leaves a light
 *      app with dark system dialogs, which is exactly the kind of seam that reads as unpolished.
 *
 * `system` follows the OS live. `prefers-color-scheme` is the right listener for that: Chromium wires
 * it to the platform appearance, so switching macOS between light and dark updates without a reload
 * and without polling.
 */
export function useTheme(): void {
  const orpc = getOrpc()
  const settings = useQuery(orpc.app.settings.get.queryOptions())
  const theme = settings.data?.theme ?? 'dark'

  useEffect(() => {
    const root = document.documentElement
    const media = window.matchMedia('(prefers-color-scheme: dark)')

    const apply = (): void => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches)
      root.classList.toggle('dark', dark)
    }

    apply()
    // Main owns the native side; it also needs to know so its own dialogs match.
    window.bflayout?.setThemeSource?.(theme)

    if (theme !== 'system') return
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])
}
