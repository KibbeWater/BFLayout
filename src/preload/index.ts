import { contextBridge, ipcRenderer } from 'electron'

/**
 * oRPC transport bootstrap.
 *
 * The renderer talks to the main process over a MessagePort. Ports cannot be
 * handed through contextBridge, so the channel is created here and port2 is
 * given to the page with window.postMessage, which does support transferables.
 *
 * The page asks for the port rather than the other way round: this listener is
 * installed while the preload script evaluates, i.e. before any page script
 * runs, so the request can never be missed.
 */
window.addEventListener('message', (event) => {
  if (event.source !== window) return
  if ((event.data as { type?: string } | null)?.type !== 'orpc-request-port') return

  const channel = new MessageChannel()
  ipcRenderer.postMessage('start-orpc-server', null, [channel.port1])
  window.postMessage({ type: 'orpc-port' }, '*', [channel.port2])
})

contextBridge.exposeInMainWorld('bflayout', {
  platform: process.platform,

  /**
   * Native menu commands, forwarded from main.
   *
   * The renderer owns all editor state, so the menu cannot act on its own: every
   * item in `main/menu.ts` sends a command string here instead. Without this
   * bridge the entire menu bar is inert, which is how it shipped — the type
   * declaration in `renderer/env.d.ts` existed and both consumers guard with
   * `if (!api?.onMenuCommand) return`, so nothing failed loudly and every
   * accelerator, Cmd+S included, silently did nothing.
   *
   * The handler is wrapped rather than passed straight to ipcRenderer so the
   * renderer never receives Electron's IpcRendererEvent, which would leak `sender`
   * into the sandboxed page.
   */
  onMenuCommand: (handler: (command: string) => void): (() => void) => {
    const listener = (_event: unknown, command: string): void => handler(command)
    ipcRenderer.on('menu-command', listener)
    return () => {
      ipcRenderer.off('menu-command', listener)
    }
  },

  /**
   * Undo or redo inside whatever text field currently has focus.
   *
   * A native menu accelerator consumes the keystroke before the page sees it, so `Cmd+Z`
   * never reaches a focused input. The Edit menu's Undo is not a `role: 'undo'` item — it
   * has to reach the *document* history most of the time — which left a gap: once the
   * renderer correctly declined to undo the document while the caret sat in a field, nothing
   * performed the field's undo either, and Cmd+Z did nothing at all.
   *
   * `webContents.undo()` is the API for exactly this, and it lives in main, so the renderer
   * asks for it. Cut, copy and paste avoid the whole problem by using native roles; undo
   * cannot, because its meaning depends on focus.
   */
  editUndo: (): void => ipcRenderer.send('edit-undo'),
  editRedo: (): void => ipcRenderer.send('edit-redo'),

  /**
   * Asks main to re-report whether the window is fullscreen.
   *
   * Fullscreen state was push-only: main sent it on `enter-full-screen`, `leave-full-screen` and
   * `did-finish-load`. The last of those can fire before React has mounted and subscribed, and a
   * window that is *already* fullscreen when it opens — which macOS does when it restores a
   * space — emits no transition at all. Either way the renderer never learned, and the inset that
   * keeps clear of the traffic lights stayed in place as a gap with no traffic lights in it.
   *
   * A request rather than a reply channel, so the answer arrives through the same path as every
   * other report and there is one place that decides what the state is.
   */
  requestFullscreenState: (): void => ipcRenderer.send('ask-fullscreen'),

  /**
   * Tells main which appearance to use for *native* chrome.
   *
   * The CSS class only reaches the page. Menus, traffic lights, scrollbars, native dialogs and the
   * window frame follow `nativeTheme.themeSource`, and a light app with dark system dialogs is the
   * kind of seam that reads as unpolished.
   */
  setThemeSource: (theme: 'dark' | 'light' | 'system'): void =>
    ipcRenderer.send('set-theme-source', theme),

  /**
   * Reports the active document, so the window can behave like a document window.
   *
   * `edited` drives the dot macOS draws in the close button when there are unsaved changes, and
   * `path` gives the title bar its proxy icon — both standard for a document-based Mac app, and both
   * things this app already knew and did not say.
   */
  setDocumentState: (state: { title: string; path: string | null; edited: boolean }): void =>
    ipcRenderer.send('set-document-state', state)
})
