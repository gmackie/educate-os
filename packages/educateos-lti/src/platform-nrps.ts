// EducateOS as an LTI 1.3 Platform (SCHO-179, IF-10): the Names and Role Provisioning Service
// (1EdTech NRPS 2.0) a deployed tool reads an offering's roster through. This module holds the
// parts with no state: the membership URL, which names exactly one deployment and one offering
// (a launch advertises it with `platformNamesRoleServiceClaim`), the role filter, and the
// membership container. Who may read it, and who is in it, is decided in `@educateos/lti-district`.
// See docs/educateos/lti.md.
import { OfferingId } from "@educateos/contracts";
import { NRPS_MEMBERSHIP_MEDIA_TYPE } from "./nrps.ts";
import { PLATFORM_LAUNCH_ROLE, type PlatformLaunchRole } from "./platform-launch.ts";
import { PlatformDeploymentId } from "./platform-tools.ts";

/** The largest page a memberships request may ask for with `limit`. */
export const PLATFORM_NRPS_MAX_LIMIT = 1000;

/**
 * The path of a deployment's membership service for one offering, under the platform's
 * `/lti/platform/` prefix. The deployment and the offering are both in it, so one URL reaches one
 * roster through one deployment, and nothing else.
 */
export function platformMembershipsPath(deploymentId: PlatformDeploymentId, offeringId: OfferingId): string {
  return `nrps/${deploymentId}/${offeringId}/memberships`;
}

/** The deployment and offering a membership service path names, or `undefined` if it is not one. */
export function parsePlatformMembershipsPath(path: string): { deploymentId: PlatformDeploymentId; offeringId: OfferingId } | undefined {
  const match = /^nrps\/([^/]+)\/([^/]+)\/memberships$/.exec(path);
  if (match === null) return undefined;
  const deploymentId = PlatformDeploymentId.safeParse(match[1]);
  const offeringId = OfferingId.safeParse(match[2]);
  return deploymentId.success && offeringId.success ? { deploymentId: deploymentId.data, offeringId: offeringId.data } : undefined;
}

/**
 * The role a `role` query parameter asks for (NRPS 2.0 §2.3.1): a full LIS membership role URI or
 * its short name. `undefined` means no filter; `null` a role no member here can hold, so the
 * answer is empty.
 */
export function platformRoleFilter(raw: string | null): PlatformLaunchRole | null | undefined {
  if (raw === null) return undefined;
  for (const role of Object.values(PLATFORM_LAUNCH_ROLE)) {
    if (raw === role || raw === role.slice(role.indexOf("#") + 1)) return role;
  }
  return null;
}

/** One member of a membership container: only what the deployment lets the tool see. */
export interface PlatformMember {
  /** The person's opaque subject for the tool: the `sub` of their launches. */
  readonly user_id: string;
  readonly roles: readonly PlatformLaunchRole[];
  readonly status: "Active";
  readonly name?: string;
  readonly given_name?: string;
  readonly family_name?: string;
  readonly email?: string;
}

/** A membership container (NRPS 2.0 §2.2): the offering's context and its members. */
export interface PlatformMembershipContainer {
  /** The URL this page was read from. */
  readonly id: string;
  readonly context: { readonly id: string; readonly label?: string; readonly title?: string };
  readonly members: readonly PlatformMember[];
}

/** Headers every answer of the membership service carries. */
const NO_STORE = { "cache-control": "no-store" } as const;

/** The membership container as an NRPS response, with a `Link: rel="next"` when there is more. */
export function platformMembershipResponse(container: PlatformMembershipContainer, next?: string): Response {
  return Response.json(container, {
    headers: {
      ...NO_STORE,
      "content-type": NRPS_MEMBERSHIP_MEDIA_TYPE,
      ...next === undefined ? {} : { link: `<${next}>; rel="next"` },
    },
  });
}

/** Why an LTI service call was refused. */
export type PlatformServiceRefusalCode = "invalid_token" | "insufficient_scope" | "invalid_request" | "forbidden";

/**
 * A refused service call (RFC 6750 §3): `invalid_token` (401) for a missing, unknown, expired or
 * revoked token, `insufficient_scope` (403) for a token without the service's scope, and
 * `invalid_request` (400) for a malformed query. Any other refusal, such as another offering's
 * roster, is a plain 403 that says no more.
 */
export function platformServiceRefusal(error: PlatformServiceRefusalCode, scope?: string): Response {
  if (error === "forbidden") return Response.json({ error }, { status: 403, headers: NO_STORE });
  if (error === "invalid_request") return Response.json({ error }, { status: 400, headers: NO_STORE });
  const challenge = `Bearer error="${error}"${scope === undefined ? "" : `, scope="${scope}"`}`;
  return Response.json({ error }, { status: error === "invalid_token" ? 401 : 403, headers: { ...NO_STORE, "www-authenticate": challenge } });
}
