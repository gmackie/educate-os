// The admin's configuration, read from its vars (SCHO-263).
//
//   EDITION                 hosted | oss. Defaults to oss, the edition anyone can deploy.
//   OSS_WORKSPACE_ORIGINS   oss only: the origins (comma-separated) this admin may manage, normally
//                           the district(s) in the same Cloudflare account.
//   ADMINS                  who may sign in: comma-separated entries, each an email address or an
//                           Access subject, optionally followed by `:viewer` for read-only access.
import { Edition, type OperatorRole } from "../shared/api.ts";

/** The admin's edition and what it restricts. */
export interface AdminConfig {
  edition: Edition;
  /** In the OSS edition, the only origins workspaces may have. Undefined in the hosted edition. */
  allowedOrigins?: ReadonlySet<string>;
}

/**
 * educateos.io's guided install, linked from the hosted admin's Workspaces page. It stays on
 * educateos.io (SCHO-263): it runs inside the site Worker with the release bucket and the control
 * plane's slug reservations.
 */
export const GUIDED_INSTALL_URL = "https://educateos.io/app/install";

/** A configuration error: the admin refuses every request until it is fixed. */
export class AdminConfigError extends Error {
  override readonly name = "AdminConfigError";
}

/**
 * Normalizes a district origin: `https://` and a hostname with at least one dot, no credentials,
 * path, query or fragment, no IP literal. Returns undefined for anything else.
 */
export function normalizeOrigin(input: string): string | undefined {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return undefined;
  if ((url.pathname !== "/" && url.pathname !== "") || url.search !== "" || url.hash !== "") return undefined;
  const host = url.hostname;
  if (!host.includes(".") || host.startsWith("[") || /^\d+(\.\d+){3}$/.test(host)) return undefined;
  return url.origin;
}

/** Reads the edition and, for OSS, its allowed origins. */
export function readConfig(vars: { EDITION?: string; OSS_WORKSPACE_ORIGINS?: string }): AdminConfig {
  const edition = Edition.safeParse(vars.EDITION ?? "oss");
  if (!edition.success) throw new AdminConfigError("EDITION must be hosted or oss");
  if (edition.data === "hosted") return { edition: "hosted" };
  const origins = new Set<string>();
  for (const entry of (vars.OSS_WORKSPACE_ORIGINS ?? "").split(/[\s,]+/).filter(Boolean)) {
    const origin = normalizeOrigin(entry);
    if (origin === undefined) throw new AdminConfigError("OSS_WORKSPACE_ORIGINS has an entry that is not an https origin");
    origins.add(origin);
  }
  return { edition: "oss", allowedOrigins: origins };
}

/** Whether this admin may manage a workspace at `origin`. */
export function originAllowed(config: AdminConfig, origin: string): boolean {
  return config.allowedOrigins === undefined || config.allowedOrigins.has(origin);
}

/** One ADMINS entry. */
export interface AdminEntry {
  /** An email address (compared case-insensitively) or an Access subject (compared exactly). */
  who: string;
  role: OperatorRole;
}

/** Parses ADMINS. An empty or missing list admits nobody. */
export function parseAdmins(value: string | undefined): AdminEntry[] {
  return (value ?? "").split(/[\s,]+/).filter(Boolean).map((entry) => {
    const viewer = entry.endsWith(":viewer");
    const who = viewer ? entry.slice(0, -":viewer".length) : entry.replace(/:admin$/, "");
    return { who, role: viewer ? "viewer" : "admin" };
  });
}

/** The role ADMINS gives a signed-in person, or undefined if it doesn't list them. */
export function roleFor(admins: readonly AdminEntry[], identity: { subject: string; email: string }): OperatorRole | undefined {
  const email = identity.email.toLowerCase();
  let role: OperatorRole | undefined;
  for (const entry of admins) {
    // An entry with an @ is an email address and matches only the email; any other, only the subject.
    const matches = entry.who.includes("@") ? entry.who.toLowerCase() === email : entry.who === identity.subject;
    // If someone is listed twice, the stronger role wins.
    if (matches) role = role === "admin" ? "admin" : entry.role;
  }
  return role;
}
