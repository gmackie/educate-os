// Where the Workshop is mounted on its origin. Today's deployments serve it at the root (base `/`);
// a district origin serves it under `/ai/` (SCHO-259), with the LMS at the root. The base is fixed
// at build time by `VITE_WORKSHOP_BASE_PATH` (see vite.config.ts), which Vite exposes to the app as
// `import.meta.env.BASE_URL`.
//
// Every absolute Workshop URL the app builds -- the RPC socket, `/api/*` fetches, screenshots,
// SPA pages it links to outside the router -- goes through `workshopPath()`. Paths the Workshop
// does not own stay at the origin root and must not: `/gatekeeper/*` (each gatekeeper Worker, via
// the router) and `/cdn-cgi/*` (Cloudflare Access). Router links (`<Link to>`, `navigate()`) are
// already relative to the router's `basepath` and must not be wrapped either.

import { joinWorkshopPath, normalizeWorkshopBase, routerBasepathFor } from './workshopBase'

/** The Workshop's build-time base, `/` or e.g. `/ai/`. */
export const WORKSHOP_BASE: string = normalizeWorkshopBase(import.meta.env.BASE_URL)

/** The absolute path on this origin of `path`, given relative to the Workshop's mount. */
export function workshopPath(path: string, base: string = WORKSHOP_BASE): string {
  return joinWorkshopPath(base, path)
}

/** The TanStack Router `basepath`: `/` at the root, `/ai` under `/ai/`. */
export function workshopRouterBasepath(base: string = WORKSHOP_BASE): string {
  return routerBasepathFor(base)
}

/** `workshopPath(path)` as a full URL on the current origin, for links copied out of the app. */
export function workshopUrl(path: string, base: string = WORKSHOP_BASE): string {
  return window.location.origin + workshopPath(path, base)
}
