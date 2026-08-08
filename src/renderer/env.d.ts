/// <reference types="vite/client" />

interface BFLayoutPreloadApi {
  readonly platform: string
  /** Subscribes to native menu commands; returns an unsubscribe function. */
  readonly onMenuCommand: (handler: (command: string) => void) => () => void
  /**
   * Undo/redo inside the focused text field, performed by main.
   *
   * A menu accelerator consumes the keystroke before the page sees it, so a focused input
   * never gets its native Cmd+Z; these are how it gets one. Optional because a build
   * without the preload bridge should degrade rather than throw.
   */
  readonly editUndo?: () => void
  readonly editRedo?: () => void
  /** Asks main to re-send the window's fullscreen state; see use-fullscreen.ts. */
  readonly requestFullscreenState?: () => void
}

interface Window {
  readonly bflayout: BFLayoutPreloadApi
}
