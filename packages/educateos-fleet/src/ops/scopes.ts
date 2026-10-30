import { z } from "zod";

/**
 * What an enrolled admin edition may do at a district (SCHO-263). A district grants scopes per
 * registered ops key and can drop any of them, or the key, from its own /admin at any time.
 */
export const OpsScope = z.enum([
  "health",
  "analytics",
  "directory:read",
  "directory:write",
  "devices",
  "releases",
]);
/** An ops scope. */
export type OpsScope = z.infer<typeof OpsScope>;

/** The actions an admin can take on one person in the directory. */
export const DirectoryAction = z.enum(["suspend", "restore", "sign-out-everywhere", "roles", "ai-access"]);
/** A directory action. */
export type DirectoryAction = z.infer<typeof DirectoryAction>;

/** Every route of the district's `/api/ops/*` surface, named. */
export type OpsRouteName =
  | "health"
  | "analytics"
  | "directory.list"
  | "directory.get"
  | "directory.action"
  | "devices.list"
  | "devices.revoke"
  | "devices.revoke-below-version"
  | "releases";

/** One row of {@link OPS_ROUTES}. */
export interface OpsRoute {
  name: OpsRouteName;
  method: "GET" | "POST";
  /** Path segments; `:name` captures one segment as a parameter. */
  path: string;
  scope: OpsScope;
}

/**
 * The route → scope table. A route that isn't listed is refused, whatever the key's scopes, so a
 * new endpoint can't become reachable without being given a scope here first.
 *
 * `devices/revoke-below-version` is listed before `devices/:id/revoke`; the two can't collide
 * anyway, since they have different lengths.
 */
export const OPS_ROUTES: readonly OpsRoute[] = [
  { name: "health", method: "GET", path: "/api/ops/health", scope: "health" },
  { name: "analytics", method: "GET", path: "/api/ops/analytics", scope: "analytics" },
  { name: "directory.list", method: "GET", path: "/api/ops/directory", scope: "directory:read" },
  { name: "directory.get", method: "GET", path: "/api/ops/directory/:principal", scope: "directory:read" },
  { name: "directory.action", method: "POST", path: "/api/ops/directory/:principal/:action", scope: "directory:write" },
  { name: "devices.list", method: "GET", path: "/api/ops/devices", scope: "devices" },
  { name: "devices.revoke-below-version", method: "POST", path: "/api/ops/devices/revoke-below-version", scope: "devices" },
  { name: "devices.revoke", method: "POST", path: "/api/ops/devices/:id/revoke", scope: "devices" },
  { name: "releases", method: "GET", path: "/api/ops/releases", scope: "releases" },
];

/** A request matched against {@link OPS_ROUTES}. */
export interface OpsRouteMatch {
  route: OpsRoute;
  /** The captured `:name` segments, percent-decoded. */
  params: Record<string, string>;
}

/** A path parameter: an opaque identifier, never free text. */
const PARAM = /^[A-Za-z0-9_.:@-]{1,128}$/;

/**
 * Finds the route for a method and path, or undefined. Parameters must look like identifiers, and
 * a directory action must be one of {@link DirectoryAction}, so nothing unexpected reaches a handler.
 */
export function matchOpsRoute(method: string, pathname: string): OpsRouteMatch | undefined {
  const segments = pathname.split("/");
  for (const route of OPS_ROUTES) {
    if (route.method !== method.toUpperCase()) continue;
    const pattern = route.path.split("/");
    if (pattern.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < pattern.length && matched; i++) {
      const expected = pattern[i]!;
      const actual = segments[i]!;
      if (expected.startsWith(":")) {
        let value: string;
        try {
          value = decodeURIComponent(actual);
        } catch {
          matched = false;
          break;
        }
        if (!PARAM.test(value)) matched = false;
        else params[expected.slice(1)] = value;
      } else if (expected !== actual) {
        matched = false;
      }
    }
    if (!matched) continue;
    if (route.name === "directory.action" && !DirectoryAction.safeParse(params.action).success) continue;
    return { route, params };
  }
  return undefined;
}

/** The scope a method and path need, or undefined for a path that isn't an ops route. */
export function scopeForRoute(method: string, pathname: string): OpsScope | undefined {
  return matchOpsRoute(method, pathname)?.route.scope;
}
