import type { ReactNode } from 'react'

import { ErrorBoundary } from './error-boundary'

export function AppShell({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {/* Scoped so a crash inside one screen does not take the whole window. */}
      <ErrorBoundary>{children}</ErrorBoundary>
    </div>
  )
}
