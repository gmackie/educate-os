import { isGatekeeperAppPath } from "@gadgets/workshop-shared/gatekeeper";

export const MAX_GATEKEEPER_APP_PROMPT_LENGTH = 4_000;

// A Durable Object ID string, which is what a workspace ID is.
const WORKSPACE_ID_PATTERN = /^[0-9a-f]{64}$/;

export type GatekeeperAppWorkspaceTarget = { workspaceId: string; gadgetId?: number };

/**
 * Validates a workspace target arriving from a sandboxed gatekeeper app before the host navigates
 * to it. The app is untrusted input, so the shape is checked here rather than at the router.
 */
export function parseGatekeeperAppWorkspaceTarget(
  workspaceId: unknown,
  gadgetId: unknown,
): GatekeeperAppWorkspaceTarget {
  if (typeof workspaceId !== "string" || !WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new TypeError("Invalid gatekeeper app workspace target.");
  }
  if (gadgetId === undefined) return { workspaceId };
  if (typeof gadgetId !== "number" || !Number.isSafeInteger(gadgetId) || gadgetId < 0) {
    throw new TypeError("Invalid gatekeeper app workspace target.");
  }
  return { workspaceId, gadgetId };
}

export function normalizeGatekeeperAppPrompt(value: string): string {
  if (typeof value !== "string") throw new TypeError("Gatekeeper app prompt must be text.");
  const prompt = value.trim();
  if (!prompt) throw new TypeError("Gatekeeper app prompt cannot be empty.");
  if (prompt.length > MAX_GATEKEEPER_APP_PROMPT_LENGTH) {
    throw new RangeError("Gatekeeper app prompt is too long.");
  }
  return prompt;
}

/** The search params of a gatekeeper app's page, `/gatekeepers/$appId`. */
export type GatekeeperAppSearch = {
  /** The place in the app the page opens, e.g. a sidebar entry's path. */
  path?: string;
};

/**
 * Validates the `/gatekeepers/$appId` search params. The URL can come from anywhere (a link, a
 * bookmark, the app's own setLocation), so a path isGatekeeperAppPath rejects is dropped rather
 * than handed to the app.
 */
export function parseGatekeeperAppSearch(search: Record<string, unknown>): GatekeeperAppSearch {
  return isGatekeeperAppPath(search.path) ? { path: search.path } : {};
}
