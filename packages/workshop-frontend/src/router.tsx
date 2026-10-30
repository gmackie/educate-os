import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'
import { workshopRouterBasepath } from './workshopPath'

export function createRouter() {
  return createTanStackRouter({
    routeTree,
    // `/` today; `/ai` where the Workshop is mounted under `/ai/` on a district origin. Route paths,
    // `<Link to>` and `navigate()` stay relative to it.
    basepath: workshopRouterBasepath(),
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createRouter>
  }
}
