// Extracted from PlayTrek `packages/lti/src/claims/parse.ts` and
// `packages/lti/src/deep-linking/handler.ts` at commit 7258e4347, then rewritten for EducateOS:
// every claim the broker relies on is required and validated instead of defaulted with `.catch`,
// and the name, email and role claims are no longer read at all.
import { z } from "zod";

const LTI = "https://purl.imsglobal.org/spec/lti/claim/";
const LTI_DL = "https://purl.imsglobal.org/spec/lti-dl/claim/";
const LTI_AGS = "https://purl.imsglobal.org/spec/lti-ags/claim/";
const LTI_NRPS = "https://purl.imsglobal.org/spec/lti-nrps/claim/";

/** The claim URIs this package reads or writes. */
export const LTI_CLAIM = {
  messageType: `${LTI}message_type`,
  version: `${LTI}version`,
  deploymentId: `${LTI}deployment_id`,
  targetLinkUri: `${LTI}target_link_uri`,
  resourceLink: `${LTI}resource_link`,
  context: `${LTI}context`,
  custom: `${LTI}custom`,
  deepLinkingSettings: `${LTI_DL}deep_linking_settings`,
  contentItems: `${LTI_DL}content_items`,
  data: `${LTI_DL}data`,
  message: `${LTI_DL}msg`,
  agsEndpoint: `${LTI_AGS}endpoint`,
  nrpsService: `${LTI_NRPS}namesroleservice`,
} as const;

/** The only LTI version the broker accepts. */
export const LTI_VERSION = "1.3.0";

/** The launch message types the broker accepts. Anything else is refused, never defaulted. */
export const LaunchMessageType = z.enum(["LtiResourceLinkRequest", "LtiDeepLinkingRequest"]);
/** A launch message type. */
export type LaunchMessageType = z.infer<typeof LaunchMessageType>;

const LtiId = z.string().min(1).max(255);
const HttpsUrl = z.url({ protocol: /^https$/ });

/**
 * The platform's `deep_linking_settings` claim. `deep_link_return_url` is required: a deep linking
 * request with nowhere to return to cannot be answered.
 */
export const DeepLinkingSettings = z.object({
  deep_link_return_url: HttpsUrl,
  accept_types: z.array(z.string()).min(1),
  accept_presentation_document_targets: z.array(z.string()).min(1),
  accept_multiple: z.boolean().optional(),
  /** Opaque platform state that must be echoed back unchanged. */
  data: z.string().max(4096).optional(),
});
/** Deep linking settings. */
export type DeepLinkingSettings = z.infer<typeof DeepLinkingSettings>;

/**
 * The claims of an id_token whose signature and registered claims (`iss`, `aud`, `exp`, `iat`,
 * `nbf`) have already been verified. This is a stripping `z.object` rather than `z.strictObject`:
 * platforms send many claims the broker has no use for (Canvas alone adds a dozen), and refusing
 * them would refuse every real launch. Stripping also means the name, email and role claims never
 * reach the caller, so nothing downstream can be tempted to authorize with them.
 */
export const LaunchClaims = z.object({
  iss: HttpsUrl,
  sub: LtiId,
  aud: z.union([z.string(), z.array(z.string()).min(1)]),
  azp: z.string().optional(),
  nonce: z.string().min(1),
  [LTI_CLAIM.messageType]: LaunchMessageType,
  [LTI_CLAIM.version]: z.literal(LTI_VERSION),
  [LTI_CLAIM.deploymentId]: LtiId,
  [LTI_CLAIM.targetLinkUri]: HttpsUrl,
  [LTI_CLAIM.context]: z.object({ id: LtiId }).optional(),
  [LTI_CLAIM.resourceLink]: z.object({ id: LtiId }).optional(),
  [LTI_CLAIM.deepLinkingSettings]: DeepLinkingSettings.optional(),
  // Platforms may substitute non-string values into custom parameters, so only the one string the
  // broker reads is checked, where it is read.
  [LTI_CLAIM.custom]: z.record(z.string(), z.unknown()).optional(),
});

/**
 * The Assignment and Grade Services endpoint claim. `scope` lists what the platform lets the tool
 * do in this context; `lineitems` is the context's line item container and `lineitem` the line
 * item of the launching resource link, when it has one.
 */
const AgsEndpointClaim = z.object({
  scope: z.array(z.string().max(512)).max(16),
  lineitems: HttpsUrl.optional(),
  lineitem: HttpsUrl.optional(),
});

/** The Names and Role Provisioning Services claim. Only version 2.0 is spoken. */
const NrpsServiceClaim = z.object({
  context_memberships_url: HttpsUrl,
  service_versions: z.array(z.string()).refine((versions) => versions.includes("2.0"), "NRPS 2.0 is required"),
});

/**
 * Where the platform offers LTI Advantage services for the launch's context. Read only from a
 * verified launch, so every URL is one the platform signed.
 */
export interface LaunchServiceClaims {
  /** AGS: the line item container, the launching link's line item, and the granted scopes. */
  readonly ags: { readonly scopes: readonly string[]; readonly lineItemsUrl?: string; readonly lineItemUrl?: string } | undefined;
  /** NRPS: the context membership URL. */
  readonly nrps: { readonly membershipsUrl: string } | undefined;
}

/** The facts the broker takes from a verified launch. */
export interface ParsedLaunchClaims {
  /** The platform issuer. */
  readonly issuer: string;
  /** The platform's stable user ID. */
  readonly subject: string;
  /** The `aud` claim, normalized to a list. */
  readonly audience: readonly string[];
  /** The authorized party, when the platform sent one. */
  readonly authorizedParty: string | undefined;
  /** The nonce the tool sent in the authentication request. */
  readonly nonce: string;
  /** What the platform is asking for. */
  readonly messageType: LaunchMessageType;
  /** The deployment of the tool the launch came through. */
  readonly deploymentId: string;
  /** Where the platform says the launch is going. */
  readonly targetLinkUri: string;
  /** The LTI context (the course), when present. */
  readonly contextId: string | undefined;
  /** The resource link, present on every resource link launch. */
  readonly resourceLinkId: string | undefined;
  /** The deep linking settings, present on every deep linking request. */
  readonly deepLinking: DeepLinkingSettings | undefined;
  /**
   * The `educateos_link` custom parameter: the link ID EducateOS wrote into a deep-linked content
   * item. A key into the registration's activity links, never an activity ID.
   */
  readonly educateosLinkId: string | undefined;
  /** The LTI Advantage services the platform offers for this context. */
  readonly services: LaunchServiceClaims;
}

/** The custom parameter that carries a deep-linked item's EducateOS link ID. */
export const EDUCATEOS_LINK_PARAMETER = "educateos_link";

/**
 * SCHO-232: the same parameter as content items deep-linked before the EducateOS rename name it.
 * The LMS keeps those items as they were written, so launches from them still carry it.
 */
export const LEGACY_LINK_PARAMETER = "schoolos_link"; // rename-educateos: keep

/**
 * Parses a verified payload. Returns `undefined` when a required claim is missing or malformed,
 * when the message type or version is not one the broker accepts, or when a message lacks the claim
 * its type requires (a resource link, or deep linking settings).
 */
export function parseLaunchClaims(payload: unknown): ParsedLaunchClaims | undefined {
  const parsed = LaunchClaims.safeParse(payload);
  if (!parsed.success) return undefined;
  const claims = parsed.data;
  const messageType = claims[LTI_CLAIM.messageType];
  const resourceLinkId = claims[LTI_CLAIM.resourceLink]?.id;
  const deepLinking = claims[LTI_CLAIM.deepLinkingSettings];
  if (messageType === "LtiResourceLinkRequest" && resourceLinkId === undefined) return undefined;
  if (messageType === "LtiDeepLinkingRequest" && deepLinking === undefined) return undefined;
  const custom = claims[LTI_CLAIM.custom];
  const linkParameter = custom?.[EDUCATEOS_LINK_PARAMETER] ?? custom?.[LEGACY_LINK_PARAMETER];
  return {
    educateosLinkId: typeof linkParameter === "string" && linkParameter.length > 0 ? linkParameter : undefined,
    issuer: claims.iss,
    subject: claims.sub,
    audience: typeof claims.aud === "string" ? [claims.aud] : claims.aud,
    authorizedParty: claims.azp,
    nonce: claims.nonce,
    messageType,
    deploymentId: claims[LTI_CLAIM.deploymentId],
    targetLinkUri: claims[LTI_CLAIM.targetLinkUri],
    contextId: claims[LTI_CLAIM.context]?.id,
    resourceLinkId,
    deepLinking,
    services: parseServiceClaims(payload as Record<string, unknown>),
  };
}

/**
 * Reads the AGS and NRPS claims. A malformed service claim is dropped rather than failing the
 * launch: the person can still use EducateOS, and the service is simply not offered for the context.
 */
function parseServiceClaims(payload: Record<string, unknown>): LaunchServiceClaims {
  const ags = AgsEndpointClaim.safeParse(payload[LTI_CLAIM.agsEndpoint]);
  const nrps = NrpsServiceClaim.safeParse(payload[LTI_CLAIM.nrpsService]);
  return {
    ags: ags.success
      ? {
          scopes: ags.data.scope,
          ...(ags.data.lineitems === undefined ? {} : { lineItemsUrl: ags.data.lineitems }),
          ...(ags.data.lineitem === undefined ? {} : { lineItemUrl: ags.data.lineitem }),
        }
      : undefined,
    nrps: nrps.success ? { membershipsUrl: nrps.data.context_memberships_url } : undefined,
  };
}
