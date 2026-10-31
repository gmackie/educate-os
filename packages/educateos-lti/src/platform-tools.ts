// EducateOS as an LTI 1.3 Platform (SCHO-179, IF-10): the third-party tools a district registers and
// the deployments that let them launch in specific offerings. A tool is registered by a district
// administrator, never by the tool itself; EducateOS assigns its client ID and every deployment ID.
// See docs/educateos/lti.md.
import { z } from "zod";
import { DistrictId, OfferingId, PrincipalId, UtcTimestamp } from "@educateos/contracts";
import { randomToken } from "./stores.ts";

const HttpsUrl = z.url({ protocol: /^https$/ }).max(2048);

/**
 * A registered tool's ID, which is also the `client_id` EducateOS assigns it: the `aud` of every
 * launch it receives and the `iss` and `sub` of its client assertions.
 */
export const PlatformToolId = z.string().regex(/^ltt_[A-Za-z0-9_-]{22}$/, "expected a platform tool ID (ltt_…)");
/** A platform tool ID. */
export type PlatformToolId = z.infer<typeof PlatformToolId>;

/** A deployment's ID: the `deployment_id` claim of every launch through it. */
export const PlatformDeploymentId = z.string().regex(/^ltd_[A-Za-z0-9_-]{22}$/, "expected a platform deployment ID (ltd_…)");
/** A platform deployment ID. */
export type PlatformDeploymentId = z.infer<typeof PlatformDeploymentId>;

/** A new tool ID. */
export const newPlatformToolId = (): PlatformToolId => `ltt_${randomToken().slice(0, 22)}`;
/** A new deployment ID. */
export const newPlatformDeploymentId = (): PlatformDeploymentId => `ltd_${randomToken().slice(0, 22)}`;

const toolFields = {
  /** The name administrators, teachers and students see. */
  name: z.string().trim().min(1).max(120),
  /** The tool's OIDC third-party-initiated login URL, where every launch starts. */
  loginInitiationUrl: HttpsUrl,
  /** The URLs the tool may ask the signed launch to be posted to, each matched exactly. */
  redirectUris: z.array(HttpsUrl).min(1).max(10),
  /** The default `target_link_uri` of a launch. */
  targetLinkUri: HttpsUrl,
  /** Where the tool publishes the keys its client assertions and deep linking responses are signed with. */
  jwksUrl: HttpsUrl,
};

/**
 * Every URL of a tool is https on one origin, the tool's trusted host: a registration cannot send
 * a launch, or fetch keys, anywhere the administrator did not name.
 */
function oneOrigin(tool: { loginInitiationUrl: string; redirectUris: readonly string[]; targetLinkUri: string; jwksUrl: string }, ctx: z.RefinementCtx): void {
  const origin = new URL(tool.loginInitiationUrl).origin;
  const urls = [...tool.redirectUris, tool.targetLinkUri, tool.jwksUrl];
  if (urls.some((url) => new URL(url).origin !== origin)) {
    ctx.addIssue({ code: "custom", message: "Every URL of a tool must share the login initiation URL's origin." });
  }
  if (new Set(tool.redirectUris).size !== tool.redirectUris.length) {
    ctx.addIssue({ code: "custom", message: "A redirect URI is listed twice." });
  }
}

/** What a district administrator registers a tool with. */
export const PlatformToolInput = z.strictObject(toolFields).superRefine(oneOrigin);
/** A tool registration request. */
export type PlatformToolInput = z.infer<typeof PlatformToolInput>;

/** A registered tool. Revoked, it cannot launch or call a service through any deployment. */
export const PlatformTool = z.strictObject({
  id: PlatformToolId,
  districtId: DistrictId,
  ...toolFields,
  status: z.enum(["active", "revoked"]),
  /** Who registered it, and when. */
  registeredBy: PrincipalId,
  registeredAt: UtcTimestamp,
  /** Who changed it last, and when: the registration or the revocation. */
  updatedBy: PrincipalId,
  updatedAt: UtcTimestamp,
}).superRefine(oneOrigin);
/** A registered tool. */
export type PlatformTool = z.infer<typeof PlatformTool>;

/**
 * The LTI Advantage services a deployment may use, each approved on its own. All are off unless an
 * administrator turns them on: NRPS reads the offering's roster, AGS line items manage gradebook
 * columns, AGS scores send scores (which only ever become pending grade changes for a teacher to
 * approve), and Deep Linking lets a teacher add the tool's content to the offering as a draft.
 */
export const PlatformToolServices = z.strictObject({
  nrps: z.boolean().default(false),
  agsLineItems: z.boolean().default(false),
  agsScores: z.boolean().default(false),
  deepLinking: z.boolean().default(false),
});
/** A deployment's services. */
export type PlatformToolServices = z.infer<typeof PlatformToolServices>;
/** One service a deployment may be allowed. */
export type PlatformToolService = keyof PlatformToolServices;

/**
 * What a launch, and an NRPS roster, tells the tool about a person beyond an opaque per-tool
 * subject and their LTI role. Both are off unless an administrator allows them.
 */
export const PlatformToolPrivacy = z.strictObject({
  name: z.boolean().default(false),
  email: z.boolean().default(false),
});
/** A deployment's privacy settings. */
export type PlatformToolPrivacy = z.infer<typeof PlatformToolPrivacy>;

const Offerings = z.array(OfferingId).min(1).max(50).refine((ids) => new Set(ids).size === ids.length, "An offering is listed twice.");

/** What a district administrator deploys a tool with. */
export const PlatformDeploymentInput = z.strictObject({
  toolId: PlatformToolId,
  /** The only offerings the tool may launch in, and whose rosters and gradebooks it may reach. */
  offerings: Offerings,
  services: PlatformToolServices.default({ nrps: false, agsLineItems: false, agsScores: false, deepLinking: false }),
  privacy: PlatformToolPrivacy.default({ name: false, email: false }),
});
/** A deployment request. */
export type PlatformDeploymentInput = z.infer<typeof PlatformDeploymentInput>;

/** A change to a deployment: whichever of its offerings, services and privacy are given. */
export const PlatformDeploymentChange = z.strictObject({
  offerings: Offerings.optional(),
  services: PlatformToolServices.optional(),
  privacy: PlatformToolPrivacy.optional(),
});
/** A deployment change. */
export type PlatformDeploymentChange = z.infer<typeof PlatformDeploymentChange>;

/** A tool's deployment: where it may launch and what it may do there. */
export const PlatformDeployment = z.strictObject({
  id: PlatformDeploymentId,
  districtId: DistrictId,
  toolId: PlatformToolId,
  offerings: Offerings,
  services: PlatformToolServices,
  privacy: PlatformToolPrivacy,
  status: z.enum(["active", "revoked"]),
  createdBy: PrincipalId,
  createdAt: UtcTimestamp,
  updatedBy: PrincipalId,
  updatedAt: UtcTimestamp,
});
/** A deployment. */
export type PlatformDeployment = z.infer<typeof PlatformDeployment>;

/**
 * Whether `deployment` of `tool` lets the tool act in `offeringId`, using `service` if one is named.
 * Both must be active and belong to the same district, and the offering must be one the deployment
 * names. Every launch and service call is checked with this before anything else.
 */
export function deploymentAllows(
  tool: PlatformTool,
  deployment: PlatformDeployment,
  offeringId: OfferingId,
  service?: PlatformToolService,
): boolean {
  return tool.status === "active"
    && deployment.status === "active"
    && deployment.toolId === tool.id
    && deployment.districtId === tool.districtId
    && deployment.offerings.includes(offeringId)
    && (service === undefined || deployment.services[service]);
}

/** Whether `uri` is exactly one of the tool's registered redirect URIs. */
export function redirectUriAllowed(tool: PlatformTool, uri: string): boolean {
  return tool.redirectUris.includes(uri);
}
