import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Loader2, PlugZap, RotateCw } from 'lucide-react'

import { describeError } from '@renderer/lib/errors'
import { initRpc } from '@renderer/lib/orpc'

type Status = { phase: 'connecting' } | { phase: 'ready' } | { phase: 'failed'; error: unknown }

/**
 * Holds back the app until the MessagePort handshake with the main process
 * succeeds, and shows a real failure screen with a retry if it does not — the
 * alternative is a window that renders nothing and explains nothing.
 */
export function RpcGate({ children }: { children: ReactNode }): ReactNode {
  const [status, setStatus] = useState<Status>({ phase: 'connecting' })

  const connect = useCallback(() => {
    let cancelled = false
    setStatus({ phase: 'connecting' })
    initRpc()
      .then(() => {
        if (!cancelled) setStatus({ phase: 'ready' })
      })
      .catch((error: unknown) => {
        if (!cancelled) setStatus({ phase: 'failed', error })
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(connect, [connect])

  if (status.phase === 'ready') return children

  if (status.phase === 'connecting') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
        <p className="text-xs">Connecting to the background process…</p>
      </div>
    )
  }

  const described = describeError(status.error)
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-10">
      <PlugZap className="size-8 text-destructive" />
      <div className="max-w-lg text-center">
        <h2 className="text-lg font-semibold">{described.title}</h2>
        <p className="mt-2 select-text text-sm text-muted-foreground">{described.detail}</p>
        <p className="mt-2 text-xs text-muted-foreground/70">
          Without this connection BFLayout cannot open or save files.
        </p>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={connect}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground hover:opacity-90"
        >
          <RotateCw className="size-3.5" />
          Retry connection
        </button>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-md border px-3 py-1.5 hover:bg-accent"
        >
          Reload editor
        </button>
      </div>
    </div>
  )
}
