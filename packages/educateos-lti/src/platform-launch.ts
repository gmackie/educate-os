// EducateOS as an LTI 1.3 Platform (SCHO-179, IF-10): the launch's wire protocol. A launch starts
// as an OIDC third-party-initiated login aimed at the tool (LTI Core 1.3 §5.1.1, LTI Security
// Framework 1.0 §5.1.1); the tool answers with an authentication request to the platform's
// authorization endpoint, and the platform answers that with a signed id_token posted to one of
// the tool's registered redirect URIs. This module holds the parts with no state: the login
// initiation URL, the authentication request's schema, the launch's claims and their signature.
// See docs/educateos/lti.md.
import { SignJWT } from "jose";
import { z } from "zod";
import { DistrictId, OfferingId, PrincipalId } from "@educateos/contracts";
import { LTI_CLAIM, LTI_VERSION } from "./claims.ts";
import { platformDeepLinkingSettings } from "./platform-deep-linking.ts";
import { PlatformDeploymentId, PlatformToolId, type PlatformTool, type PlatformToolPrivacy } from "./platform-tools.ts";
import type { ToolKeySet } from "./tool-keys.ts";

const LIS = "http://purl.imsglobal.org/vocab/lis/v2/";

/** The LIS membership roles a platform launch carries (LTI Core 1.3 Appendix A.2.3). */
export const PLATFORM_LAUNCH_ROLE = {
  instructor: `${LIS}membership#Instructor`,
  learner: `${LIS}membership#Learner`,
} as const;
/** A platform launch role. */
export type PlatformLaunchRole = (typeof PLATFORM_LAUNCH_ROLE)[keyof typeof PLATFORM_LAUNCH_ROLE];

/** The context type of an offering (LTI Core 1.3 Appendix A.1). */
export const COURSE_OFFERING_CONTEXT_TYPE = `${LIS}course#CourseOffering`;

/** The NRPS versions the platform serves, as its launch claim lists them. */
export const PLATFORM_NRPS_SERVICE_VERSIONS = ["2.0"] as const;

/**
 * The launch claim that tells a tool where the offering's roster is (NRPS 2.0 §3.6.1): the
 * membership URL of the launch's deployment and offering (`platformMembershipsPath`).
 */
export function platformNamesRoleServiceClaim(membershipsUrl: string): Record<string, unknown> {
  return { [LTI_CLAIM.nrpsService]: { context_memberships_url: membershipsUrl, service_versions: [...PLATFORM_NRPS_SERVICE_VERSIONS] } };
}

/** How long a signed platform id_token is valid, in seconds. */
export const PLATFORM_ID_TOKEN_TTL_SECONDS = 300;

/**
 * The tool's OIDC authentication request (LTI Security Framework 1.0 §5.1.1.2), as the platform's
 * authorization endpoint receives it. Every fixed parameter must have the one value LTI allows,
 * and `nonce` is required. Unknown parameters are dropped, as OIDC asks.
 */
export const PlatformAuthRequest = z.object({
  scope: z.literal("openid"),
  response_type: z.literal("id_token"),
  response_mode: z.literal("form_post"),
  prompt: z.literal("none"),
  client_id: PlatformToolId,
  redirect_uri: z.url({ protocol: /^https$/ }).max(2048),
  login_hint: z.string().min(1).max(255),
  lti_message_hint: z.string().min(1).max(255),
  nonce: z.string().min(1).max(255),
  state: z.string().min(1).max(2048).optional(),
});
/** A tool's authentication request. */
export type PlatformAuthRequest = z.infer<typeof PlatformAuthRequest>;

/**
 * What a launch was started for, kept from the moment a signed-in person starts it until the
 * tool's authentication request redeems it, once. `bindingHash` is the SHA-256 of a value only
 * the starting browser holds, so a ticket that leaks to another browser cannot be redeemed.
 */
export const PlatformLaunchTicket = z.strictObject({
  districtId: DistrictId,
  toolId: PlatformToolId,
  deploymentId: PlatformDeploymentId,
  offeringId: OfferingId,
  principalId: PrincipalId,
  /** The person's opaque subject for this tool, which is also the launch's `login_hint`. */
  subject: z.string().min(1).max(255),
  roles: z.array(z.enum([PLATFORM_LAUNCH_ROLE.instructor, PLATFORM_LAUNCH_ROLE.learner])).min(1),
  resourceLinkId: z.string().min(1).max(255),
  targetLinkUri: z.url({ protocol: /^https$/ }),
  bindingHash: z.string().min(1),
  /**
   * Set when the launch is a deep linking request (Deep Linking 2.0 §4.4) rather than a resource
   * link launch: where the tool returns the teacher's selection, and the opaque `data` it must
   * echo, both bound to one deep linking flow (`PlatformDeepLinkFlow`).
   */
  deepLinking: z.strictObject({ returnUrl: z.url({ protocol: /^https$/ }), data: z.string().min(1).max(255) }).optional(),
});
/** A launch ticket. */
export type PlatformLaunchTicket = z.infer<typeof PlatformLaunchTicket>;

/**
 * The URL that starts a launch: the tool's login initiation URL with the third-party-initiated
 * login parameters (LTI Core 1.3 §5.1.1.1) as its query.
 */
export function platformLoginInitiationUrl(
  tool: PlatformTool,
  input: { issuer: string; loginHint: string; messageHint: string; deploymentId: PlatformDeploymentId; targetLinkUri: string },
): string {
  const url = new URL(tool.loginInitiationUrl);
  url.searchParams.set("iss", input.issuer);
  url.searchParams.set("login_hint", input.loginHint);
  url.searchParams.set("lti_message_hint", input.messageHint);
  url.searchParams.set("target_link_uri", input.targetLinkUri);
  url.searchParams.set("client_id", tool.id);
  url.searchParams.set("lti_deployment_id", input.deploymentId);
  return url.toString();
}

/** Who and where a launch is about, beyond its ticket: the offering's names and the person's. */
export interface PlatformLaunchContext {
  readonly offeringTitle: string;
  readonly offeringLabel: string;
  readonly person: { readonly displayName: string; readonly email?: string | undefined };
  readonly privacy: PlatformToolPrivacy;
  /**
   * The offering's membership service URL, when the deployment allows NRPS: advertised to the
   * tool with the NRPS claim.
   */
  readonly membershipsUrl?: string;
}

/**
 * The claims of a resource link launch (LTI Core 1.3 §5.3) for `ticket`, answering `request`, or of
 * a deep linking request (Deep Linking 2.0 §4.4) when the ticket is one. The subject is the
 * person's opaque per-tool subject and the context is the offering alone; the person's name and
 * email are added only when the deployment's privacy settings allow each, and the membership
 * service only when the deployment allows NRPS.
 */
export function platformLaunchClaims(ticket: PlatformLaunchTicket, request: PlatformAuthRequest, context: PlatformLaunchContext): Record<string, unknown> {
  return {
    sub: ticket.subject,
    azp: ticket.toolId,
    nonce: request.nonce,
    [LTI_CLAIM.version]: LTI_VERSION,
    [LTI_CLAIM.deploymentId]: ticket.deploymentId,
    [LTI_CLAIM.targetLinkUri]: ticket.targetLinkUri,
    ...ticket.deepLinking === undefined
      ? { [LTI_CLAIM.messageType]: "LtiResourceLinkRequest", [LTI_CLAIM.resourceLink]: { id: ticket.resourceLinkId } }
      : { [LTI_CLAIM.messageType]: "LtiDeepLinkingRequest", [LTI_CLAIM.deepLinkingSettings]: platformDeepLinkingSettings(ticket.deepLinking) },
    [LTI_CLAIM.roles]: ticket.roles,
    [LTI_CLAIM.context]: { id: ticket.offeringId, label: context.offeringLabel, title: context.offeringTitle, type: [COURSE_OFFERING_CONTEXT_TYPE] },
    ...platformPersonClaims(context.person, context.privacy),
    ...context.membershipsUrl === undefined ? {} : platformNamesRoleServiceClaim(context.membershipsUrl),
  };
}

/**
 * What a launch, or an NRPS member, says about a person beyond their subject and role: their name
 * only if the deployment allows names, their email only if it allows emails.
 */
export function platformPersonClaims(
  person: { readonly displayName: string; readonly email?: string | undefined },
  privacy: PlatformToolPrivacy,
): { name?: string; given_name?: string; family_name?: string; email?: string } {
  const [givenName = "", ...rest] = person.displayName.split(" ");
  return {
    ...privacy.name ? { name: person.displayName, given_name: givenName, ...rest.length > 0 ? { family_name: rest.join(" ") } : {} } : {},
    ...privacy.email && person.email !== undefined ? { email: person.email } : {},
  };
}

/**
 * Signs launch claims as the platform: RS256 with the platform's signing key and its `kid`,
 * issued by `issuer` to the tool alone, valid for {@link PLATFORM_ID_TOKEN_TTL_SECONDS}.
 */
export async function signPlatformIdToken(
  keys: ToolKeySet,
  claims: Record<string, unknown>,
  input: { issuer: string; audience: PlatformToolId; nowMs: number },
): Promise<string> {
  const iat = Math.floor(input.nowMs / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: keys.signing.kid, typ: "JWT" })
    .setIssuer(input.issuer)
    .setAudience(input.audience)
    .setIssuedAt(iat)
    .setExpirationTime(iat + PLATFORM_ID_TOKEN_TTL_SECONDS)
    .sign(keys.signing.privateKey);
}
