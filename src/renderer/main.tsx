import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'

import './globals.css'
import { ErrorBoundary } from './components/error-boundary'
import { RpcGate } from './components/rpc-gate'
import { Toaster } from './components/toaster'
import { queryClient } from './lib/query'
import { reportError } from './lib/toast'
import { router } from './router'
import { useDocuments } from './editor/store/document'
import { panesInRect } from '@shared/formats/bflyt/editing'
import { decodeBc7Block } from '@shared/formats/bntx'
import { useFolder } from './editor/store/folder'
import { usePlayback } from './editor/store/playback'
import { useWorkspace } from './editor/store/workspace'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('#root missing from index.html')

// Nothing should fail silently, including work started outside React.
window.addEventListener('unhandledrejection', (event) => {
  reportError(event.reason)
})
window.addEventListener('error', (event) => {
  if (event.error) reportError(event.error)
})

/**
 * Dev-only handle for the automated self-test, which drives the editor from the
 * main process. It needs to open a layout into the store and navigate, which
 * nothing outside React can otherwise reach. Stripped from production builds.
 */
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>)['__bfdev'] = {
    documents: useDocuments,
    workspace: useWorkspace,
    playback: usePlayback,
    folder: useFolder,
    editing: { panesInRect },
    // Exposed for the BC7 GPU cross-check, which needs a CPU decode to compare against.
    bntx: { decodeBc7Block },
    router
  }
}

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RpcGate>
          <RouterProvider router={router} />
        </RpcGate>
        <Toaster />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>
)
