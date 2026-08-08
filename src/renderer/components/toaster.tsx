import type { ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Info, RotateCw, X } from 'lucide-react'

import { useToasts, type Toast } from '@renderer/lib/toast'

const styles: Record<Toast['kind'], { border: string; icon: ReactNode }> = {
  error: {
    border: 'border-destructive/60',
    icon: <AlertTriangle className="size-4 shrink-0 text-destructive" />
  },
  success: {
    border: 'border-primary/50',
    icon: <CheckCircle2 className="size-4 shrink-0 text-primary" />
  },
  info: {
    border: 'border-border',
    icon: <Info className="size-4 shrink-0 text-muted-foreground" />
  }
}

export function Toaster(): ReactNode {
  const toasts = useToasts((state) => state.toasts)
  const dismiss = useToasts((state) => state.dismiss)

  if (toasts.length === 0) return null

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-96 flex-col gap-2">
      {toasts.map((toast) => {
        const style = styles[toast.kind]
        return (
          <div
            key={toast.id}
            role={toast.kind === 'error' ? 'alert' : 'status'}
            className={`pointer-events-auto flex gap-2 rounded-md border bg-card p-3 shadow-lg ${style.border}`}
          >
            {style.icon}
            <div className="min-w-0 flex-1">
              <p className="font-medium leading-snug">{toast.title}</p>
              {toast.detail ? (
                <p className="mt-1 select-text break-words text-xs leading-relaxed text-muted-foreground">
                  {toast.detail}
                </p>
              ) : null}
              {toast.retry ? (
                <button
                  type="button"
                  onClick={() => {
                    dismiss(toast.id)
                    toast.retry?.()
                  }}
                  className="mt-2 flex items-center gap-1.5 rounded border px-2 py-1 text-xs hover:bg-accent"
                >
                  <RotateCw className="size-3" />
                  Try again
                </button>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              className="h-fit rounded p-0.5 hover:bg-accent"
              aria-label="Dismiss"
            >
              <X className="size-3.5 text-muted-foreground" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
