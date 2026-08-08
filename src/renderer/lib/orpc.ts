import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/message-port'
import type { ContractRouterClient } from '@orpc/contract'
import { createTanstackQueryUtils } from '@orpc/tanstack-query'

import type { contract } from '@shared/contract'

export type AppClient = ContractRouterClient<typeof contract>
export type AppOrpc = ReturnType<typeof createTanstackQueryUtils<AppClient>>

/**
 * Asks the preload script for a MessagePort wired to the main process. The
 * preload installs its listener before any page script runs, so requesting the
 * port (rather than waiting to be handed one) cannot race.
 */
function requestPort(timeoutMs: number): Promise<MessagePort> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup()
      reject(
        new Error(
          'The editor could not reach its background process. The preload script did not respond within ' +
            `${Math.round(timeoutMs / 1000)}s.`
        )
      )
    }, timeoutMs)

    function cleanup(): void {
      window.clearTimeout(timer)
      window.removeEventListener('message', onMessage)
    }

    function onMessage(event: MessageEvent): void {
      if (event.source !== window) return
      if ((event.data as { type?: string } | null)?.type !== 'orpc-port') return
      const port = event.ports[0]
      if (!port) return
      cleanup()
      resolve(port)
    }

    window.addEventListener('message', onMessage)
    window.postMessage({ type: 'orpc-request-port' }, '*')
  })
}

let active: { client: AppClient; orpc: AppOrpc } | undefined

/**
 * Connects to the main process. Deliberately not done at module scope: a failed
 * handshake there would abort module evaluation and leave a blank window, so
 * the caller owns the failure state and can show it and offer a retry.
 */
export async function initRpc(options?: { timeoutMs?: number }): Promise<void> {
  if (active) return

  const port = await requestPort(options?.timeoutMs ?? 10_000)
  port.start()

  const client: AppClient = createORPCClient(new RPCLink({ port }))
  active = { client, orpc: createTanstackQueryUtils(client) }

  // Lets the main process drive the RPC surface during automated dev checks.
  if (import.meta.env.DEV) {
    ;(window as unknown as { __bfclient?: unknown }).__bfclient = client
  }
}

function require_(): { client: AppClient; orpc: AppOrpc } {
  if (!active) {
    throw new Error('RPC used before initRpc() completed')
  }
  return active
}

export function getClient(): AppClient {
  return require_().client
}

export function getOrpc(): AppOrpc {
  return require_().orpc
}
