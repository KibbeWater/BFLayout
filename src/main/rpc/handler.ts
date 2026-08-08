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
}
