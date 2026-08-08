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
  platform: process.platform
})
