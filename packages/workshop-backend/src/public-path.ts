// Where the Workshop is mounted on its origin (SCHO-259). Today's deployments serve it at the root;
// on a district origin the router serves the LMS at `/` and the Workshop under `/ai`, forwarding
// `/ai/api*` and `/ai/blueprint-screenshot/*` here with the prefix intact. The entry point strips
// the prefix once (`workshopRequestPath`), and URLs the backend hands to browsers are built under
// `PUBLIC_BASE_PATH` (`publicPath`). Paths the Workshop does not own -- `/gatekeeper/*`, the
// gatekeepers' OAuth callbacks -- stay at the origin root and never go through `publicPath`.

import { BLUEPRINT_SCREENSHOT_PATH_PREFIX } from "@gadgets/workshop-shared/api";

/** The mount the router uses for the Workshop on a district origin. Always accepted. */
export const DISTRICT_WORKSHOP_MOUNT = "/ai";

const SEGMENTS = /^(\/[A-Za-z0-9._~-]+)+$/;

/**
 * The configured `PUBLIC_BASE_PATH` as `""` (root, the default) or `/segment(s)` with no trailing
 * slash. Accepts `ai`, `/ai` or `/ai/`. Throws on anything else: a malformed value would otherwise
 * send browsers to wrong URLs.
 */
export function publicBasePath(env: { PUBLIC_BASE_PATH?: string }): string {
  let raw = env.PUBLIC_BASE_PATH?.trim() ?? "";
  if (raw === "" || raw === "/") return "";
  let path = "/" + raw.replace(/^\//, "").replace(/\/$/, "");
  if (!SEGMENTS.test(path) || path.split("/").some(segment => segment === "." || segment === "..")) {
    throw new Error(`PUBLIC_BASE_PATH is not a plain path: ${JSON.stringify(env.PUBLIC_BASE_PATH)}`);
  }
  return path;
}

/** `path` (origin-relative, e.g. `/api/site-logo`) under the deployment's `PUBLIC_BASE_PATH`. */
export function publicPath(env: { PUBLIC_BASE_PATH?: string }, path: string): string {
  return publicBasePath(env) + path;
}

function ownsPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/") ||
      path.startsWith(BLUEPRINT_SCREENSHOT_PATH_PREFIX);
}

/**
 * The request path with the Workshop's mount removed, so `/ai/api/...` routes exactly like
 * `/api/...`. Only a mount followed by a path the backend serves (`/api`, `/api/...`,
 * `/blueprint-screenshot/...`) is stripped; anything else is returned unchanged and ends in the
 * entry point's 404. The district mount (`/ai`) is always accepted, as is `PUBLIC_BASE_PATH`.
 */
export function workshopRequestPath(pathname: string, env: { PUBLIC_BASE_PATH?: string }): string {
  if (ownsPath(pathname)) return pathname;
  for (let mount of new Set([DISTRICT_WORKSHOP_MOUNT, publicBasePath(env)])) {
    if (mount === "" || !pathname.startsWith(mount + "/")) continue;
    let rest = pathname.slice(mount.length);
    if (ownsPath(rest)) return rest;
  }
  return pathname;
}
