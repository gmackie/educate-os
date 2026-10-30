// The SPA's routes, from the location hash, so links, history and reloads all work.
import { useSyncExternalStore } from "react";
import { readHash, subscribeToHash } from "@gadgets/ui/hash-location";

/** The tabs of a workspace's page, in order. */
export const WORKSPACE_TABS = [
  { path: "overview", label: "Overview" },
  { path: "traffic", label: "Traffic" },
  { path: "ai", label: "AI" },
  { path: "storage", label: "Storage" },
  { path: "sign-ins", label: "Sign-ins" },
  { path: "domains", label: "Domains" },
  { path: "releases", label: "Releases" },
  { path: "settings", label: "Settings" },
  { path: "audit", label: "Audit" },
] as const;

/** A workspace tab. */
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number]["path"];

/** The top-level screens, in navigation order. */
export const SCREENS = [
  { path: "workspaces", label: "Workspaces" },
  { path: "users", label: "Users" },
  { path: "devices", label: "Devices" },
  { path: "audit", label: "Audit log" },
  { path: "settings", label: "Settings" },
] as const;

/** A top-level screen. */
export type Screen = (typeof SCREENS)[number]["path"];

/** Where the location points. */
export type Route =
  | { screen: Screen }
  | { screen: "workspace"; id: string; tab: WorkspaceTab };

const parse = (hash: string): Route => {
  const parts = hash.replace(/^#\/?/, "").split("/").map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return "";
    }
  });
  if (parts[0] === "workspaces" && parts[1]) {
    const tab = WORKSPACE_TABS.find((t) => t.path === parts[2])?.path ?? "overview";
    return { screen: "workspace", id: parts[1], tab };
  }
  return { screen: SCREENS.find((s) => s.path === parts[0])?.path ?? "workspaces" };
};

let cached: { hash: string; route: Route } | undefined;
const current = (): Route => {
  const hash = readHash();
  if (cached?.hash !== hash) cached = { hash, route: parse(hash) };
  return cached.route;
};
const DEFAULT: Route = { screen: "workspaces" };

/** The route the hash names. */
export const useRoute = (): Route => useSyncExternalStore(subscribeToHash, current, () => DEFAULT);

/** A workspace tab's link. */
export const workspaceHref = (id: string, tab: WorkspaceTab = "overview") => `#/workspaces/${encodeURIComponent(id)}/${tab}`;
