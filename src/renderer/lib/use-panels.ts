import { useCallback, useMemo, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import type { PanelKey } from '@shared/contract'
import { getOrpc } from '@renderer/lib/orpc'

/**
 * Which editor panels are showing.
 *
 * Kept in settings rather than component state so an arrangement survives a
 * restart, and so the native View menu and the toolbar toggles are reading and
 * writing the same thing instead of drifting apart.
 */
export interface PanelVisibility {
  readonly showSidebar: boolean
  readonly showHierarchy: boolean
  readonly showProperties: boolean
  readonly showTimeline: boolean
  readonly toggle: (key: PanelKey) => void
  readonly set: (key: PanelKey, value: boolean) => void
  readonly sidebarWidth: number
  readonly propertiesWidth: number
  readonly timelineHeight: number
  /** Commits a dragged size; the drag itself is previewed locally. */
  readonly setSize: (
    key: 'sidebarWidth' | 'propertiesWidth' | 'timelineHeight',
    value: number
  ) => void
}

export function usePanels(): PanelVisibility {
  const orpc = getOrpc()
  const queryClient = useQueryClient()
  const settings = useQuery(orpc.app.settings.get.queryOptions())
  const patch = useMutation(
    orpc.app.settings.patch.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.app.settings.get.key() })
    })
  )

  // Default to visible while settings load, so the editor never flashes empty.
  const showSidebar = settings.data?.showSidebar ?? true
  const showHierarchy = settings.data?.showHierarchy ?? true
  const showProperties = settings.data?.showProperties ?? true
  const showTimeline = settings.data?.showTimeline ?? true

  /**
   * Current values behind a ref so `toggle` can read them without listing them as
   * dependencies.
   *
   * Identity matters more than it looks here: `useMenuCommands` depends on the
   * whole object this hook returns, and re-subscribing tears down and re-registers
   * the menu IPC listener. When `toggle` closed over a fresh object literal that
   * happened on every render of the editor — including all sixty of them per second
   * during a canvas drag.
   */
  const currentRef = useRef<Record<PanelKey, boolean>>({
    showSidebar,
    showHierarchy,
    showProperties,
    showTimeline
  })
  currentRef.current = { showSidebar, showHierarchy, showProperties, showTimeline }

  // `mutate` is a stable reference in React Query v5, unlike the mutation object.
  const { mutate } = patch

  const set = useCallback((key: PanelKey, value: boolean) => mutate({ [key]: value }), [mutate])

  const toggle = useCallback((key: PanelKey) => set(key, !currentRef.current[key]), [set])

  const setSize = useCallback(
    (key: 'sidebarWidth' | 'propertiesWidth' | 'timelineHeight', value: number) =>
      mutate({ [key]: Math.round(value) }),
    [mutate]
  )

  const sidebarWidth = settings.data?.sidebarWidth ?? 288
  const propertiesWidth = settings.data?.propertiesWidth ?? 320
  const timelineHeight = settings.data?.timelineHeight ?? 220

  return useMemo(
    () => ({
      showSidebar,
      showHierarchy,
      showProperties,
      showTimeline,
      toggle,
      set,
      sidebarWidth,
      propertiesWidth,
      timelineHeight,
      setSize
    }),
    [
      showSidebar,
      showHierarchy,
      showProperties,
      showTimeline,
      toggle,
      set,
      sidebarWidth,
      propertiesWidth,
      timelineHeight,
      setSize
    ]
  )
}
