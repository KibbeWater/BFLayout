import { ipcMain } from 'electron'
import { onError } from '@orpc/server'
import { RPCHandler } from '@orpc/server/message-port'

import { router } from './router'

/**
 * Listens for the MessagePort the preload script forwards on behalf of each
 * renderer, and serves the oRPC router over it.
 */
export function startRpcServer(): void {
  const handler = new RPCHandler(router, {
    interceptors: [
      onError((error) => {
        console.error('[rpc]', error)
      })
    ]
  })

  ipcMain.on('start-orpc-server', (event) => {
    const [port] = event.ports
    if (!port) {
      console.error('[rpc] start-orpc-server received without a MessagePort')
      return
    }
    handler.upgrade(port)
    port.start()
  })

  /*
   * Undo and redo inside a focused text field.
   *
   * A menu accelerator consumes the keystroke before the page sees it, and the Edit menu's
   * Undo cannot be a `role: 'undo'` item because most of the time it has to reach the
   * document's own history. That left a gap: once the renderer correctly declined to undo
   * the document while the caret was in a field, nothing undid the field either. These are
   * the other half of that decision, and `webContents.undo()` is the API for it.
   *
   * Deliberately not part of the oRPC surface: it acts on the sender's own web contents, has
   * no result, and belongs to the frame rather than to the application.
   */
  ipcMain.on('edit-undo', (event) => event.sender.undo())
  ipcMain.on('edit-redo', (event) => event.sender.redo())
}
