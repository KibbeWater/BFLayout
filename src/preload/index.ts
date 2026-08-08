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
  }
})
