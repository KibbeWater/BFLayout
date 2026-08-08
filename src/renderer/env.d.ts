/// <reference types="vite/client" />

interface BFLayoutPreloadApi {
  readonly platform: string
  /** Subscribes to native menu commands; returns an unsubscribe function. */
  readonly onMenuCommand: (handler: (command: string) => void) => () => void
}

interface Window {
  readonly bflayout: BFLayoutPreloadApi
}
