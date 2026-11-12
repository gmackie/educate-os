import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'
import { workshopRouterBasepath } from './workshopPath'

export function createRouter() {
  return createTanStackRouter({
    routeTree,
    // `/` today; `/ai` where the Workshop is mounted under `/ai/` on a district origin. Route paths,
    // `<Link to>` and `navigate()` stay relative to it.
    basepath: workshopRouterBasepath(),
    // The workspace is a full-height app whose panes swap their scrollers in place as the user
    // navigates (the chat list and a chat thread, for one). The router keys element positions by
    // DOM path, so it would hand one scroller's position to whichever replaced it; the workspace
    // manages its own scroll positions instead.
    scrollRestoration: ({ location }) => !location.pathname.startsWith('/workspace/'),
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createRouter>
  }
}
