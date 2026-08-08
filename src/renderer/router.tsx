import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet
} from '@tanstack/react-router'

import { AppShell } from './components/app-shell'
import { WelcomeScreen } from './components/welcome-screen'
import { EditorScreen } from './editor/editor-screen'

const rootRoute = createRootRoute({
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  )
})

const welcomeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: WelcomeScreen
})

const editorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/editor',
  component: EditorScreen
})

const routeTree = rootRoute.addChildren([welcomeRoute, editorRoute])

// Memory history: there is no URL bar, and a packaged app loads over file://
// where path-based history breaks.
export const router = createRouter({
  routeTree,
  history: createMemoryHistory({ initialEntries: ['/'] }),
  defaultPreload: false
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
