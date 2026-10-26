// ClassLink's credentials are Worker secrets (ADR-0004): configuration names the tenant and the
// app, and the district Worker binds the client IDs and secrets under these names. Errors name a
// missing binding, never a value.
import { EducateOsError } from "@educateos/contracts";
import { RosterSyncError } from "../sync-run.ts";
import type { OneRosterClientCredentials } from "../oneroster/rest/client.ts";

/** The Worker secrets ClassLink's credentials are bound as. */
export const CLASSLINK_SECRET_NAMES = {
  /** The Roster Server OAuth client's ID. */
  rosterClientId: "CLASSLINK_ONEROSTER_CLIENT_ID",
  /** The Roster Server OAuth client's secret. */
  rosterClientSecret: "CLASSLINK_ONEROSTER_CLIENT_SECRET",
  /** The sign-in relying party's client secret. Its client ID is configuration. */
  ssoClientSecret: "CLASSLINK_SSO_CLIENT_SECRET",
} as const;

function bound(env: Readonly<Record<string, unknown>>, name: string): string | undefined {
  const value = env[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The Roster Server credentials from a Worker's environment.
 *
 * @throws RosterSyncError `auth-failed`, naming the missing bindings, when either is unset.
 */
export function classLinkRosterCredentials(env: Readonly<Record<string, unknown>>): OneRosterClientCredentials {
  const clientId = bound(env, CLASSLINK_SECRET_NAMES.rosterClientId);
  const clientSecret = bound(env, CLASSLINK_SECRET_NAMES.rosterClientSecret);
  if (clientId === undefined || clientSecret === undefined) {
    const missing = [clientId === undefined ? CLASSLINK_SECRET_NAMES.rosterClientId : [], clientSecret === undefined ? CLASSLINK_SECRET_NAMES.rosterClientSecret : []].flat();
    throw new RosterSyncError("auth-failed", `the ClassLink roster credentials are not bound: set the Worker secrets ${missing.join(" and ")}`);
  }
  return { clientId, clientSecret };
}

/**
 * The sign-in client secret from a Worker's environment.
 *
 * @throws EducateOsError `unavailable` when it is unset: sign-in is misconfigured, not refused.
 */
export function classLinkSsoClientSecret(env: Readonly<Record<string, unknown>>): string {
  const secret = bound(env, CLASSLINK_SECRET_NAMES.ssoClientSecret);
  if (secret === undefined) throw new EducateOsError("unavailable", "ClassLink sign-in is not set up for this district yet.");
  return secret;
}
