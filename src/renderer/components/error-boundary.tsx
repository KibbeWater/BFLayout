import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RotateCw } from 'lucide-react'

interface Props {
  readonly children: ReactNode
  /** Shown instead of the default panel; receives a reset callback. */
  readonly fallback?: (error: Error, reset: () => void) => ReactNode
  readonly onError?: (error: Error, info: ErrorInfo) => void
}

interface State {
  readonly error: Error | null
}

/**
 * Every render error caught this session, newest last.
 *
 * Read by the end-to-end self-test. Kept here rather than on a dev global because the
 * boundary is the only thing that knows, and because a caught-then-reset error is
 * otherwise invisible.
 */
const renderErrors: string[] = []

export function caughtRenderErrors(): readonly string[] {
  return renderErrors
}

/**
 * Last line of defence for renderer crashes. Without this a thrown render error
 * unmounts the tree and leaves an empty window with no explanation.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[bflayout] render error:', error, info.componentStack)
    /*
     * Recorded as well as logged, so the end-to-end pass can assert that a render error
     * did *not* happen. A boundary that catches successfully leaves no trace in the DOM
     * once it is reset, which is how a crash-and-recover looked identical to never
     * crashing — twice, for the same conditional-hook mistake in two different panels.
     */
    renderErrors.push(error.message)
    this.props.onError?.(error, info)
  }

  private readonly reset = (): void => this.setState({ error: null })

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    if (this.props.fallback) return this.props.fallback(error, this.reset)

    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-10">
        <AlertTriangle className="size-8 text-destructive" />
        <div className="max-w-xl text-center">
          <h2 className="text-lg font-semibold">Something in the editor stopped working</h2>
          <p className="mt-2 select-text text-sm text-muted-foreground">{error.message}</p>
          <p className="mt-2 text-xs text-muted-foreground/70">
            Any unsaved layout changes are still in memory — try again before reloading.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={this.reset}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground hover:opacity-90"
          >
            <RotateCw className="size-3.5" />
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md border px-3 py-1.5 hover:bg-accent"
          >
            Reload editor
          </button>
        </div>
        {error.stack ? (
          <details className="max-h-48 w-full max-w-2xl overflow-auto rounded border bg-card p-2">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              Technical details
            </summary>
            <pre className="mt-2 select-text whitespace-pre-wrap text-[11px] text-muted-foreground">
              {error.stack}
            </pre>
          </details>
        ) : null}
      </div>
    )
  }
}
