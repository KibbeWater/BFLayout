import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'

import { reportError } from './toast'

/**
 * Every query and mutation failure is surfaced. React Query would otherwise
 * hold errors in state that a component might never render, which is exactly
 * how a user ends up staring at a screen that quietly did nothing.
 */
export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      reportError(error, { retry: () => void queryClient.refetchQueries({ queryKey: query.queryKey }) })
    }
  }),
  mutationCache: new MutationCache({
    onError: (error) => {
      reportError(error)
    }
  }),
  defaultOptions: {
    queries: {
      // Everything behind the RPC boundary is local IO, and the main process
      // tells us when it changes. Refetching on focus/interval buys nothing.
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      retry: false
    }
  }
})
