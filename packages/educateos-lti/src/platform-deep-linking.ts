// EducateOS as an LTI 1.3 Platform (SCHO-179, IF-10): Deep Linking 2.0, the wire protocol. A teacher
// asks a deployed tool for content; the platform launches the tool with an `LtiDeepLinkingRequest`
// whose `deep_linking_settings` (Deep Linking 2.0 §4.4.1) name a return URL and opaque `data`, both
// bound to one flow; the tool sends the teacher's browser back to that URL with a signed
// `LtiDeepLinkingResponse` (§4.5). This module holds the parts with no state: the settings claim,
// the flow record, the resource link record, and the verification of the response. See
// docs/educateos/lti.md.
import { decodeJwt, decodeProtectedHeader, errors as joseErrors, jwtVerify, type JWTPayload } from "jose";
import { z } from "zod";
import { DistrictId, EducateOsError, OfferingId, PrincipalId, UtcTimestamp } from "@educateos/contracts";
import { LTI_CLAIM, LTI_VERSION } from "./claims.ts";
import { PlatformDeploymentId, PlatformToolId, type PlatformTool } from "./platform-tools.ts";
import { randomToken } from "./stores.ts";

const HttpsUrl = z.url({ protocol: /^https$/ }).max(2048);

/** The only content item type the platform accepts: a resource link launched later (§3.1). */
export const PLATFORM_DEEP_LINKING_ACCEPT_TYPES = ["ltiResourceLink"] as const;
/** How a created link may be shown: in a frame of EducateOS's page, or in a window of its own. */
export const PLATFORM_DEEP_LINKING_PRESENTATION_TARGETS = ["iframe", "window"] as const;

/** The most resource links one response may return. A response with more creates nothing. */
export const MAX_PLATFORM_DEEP_LINK_ITEMS = 10;
/** The most content items of any type a response may carry before it is refused unread. */
const MAX_CONTENT_ITEMS = 50;
/** The largest response JWT read, in characters. */
export const MAX_PLATFORM_DEEP_LINKING_RESPONSE_LENGTH = 64 * 1024;
/** How far the tool's clock may differ from EducateOS's, as client assertions allow. */
export const DEEP_LINKING_RESPONSE_CLOCK_SKEW_SECONDS = 30;
/** How long a teacher has to choose content in the tool, from the start of the flow. */
export const PLATFORM_DEEP_LINK_FLOW_TTL_MS = 30 * 60_000;

/**
 * The `deep_linking_settings` claim of a deep linking request (Deep Linking 2.0 §4.4.1): resource
 * links only, any number of them, nothing created without the teacher seeing it (`auto_create`
 * false), no line items (`accept_lineitem` false: not implemented), and the flow's return URL and
 * `data`.
 */
export function platformDeepLinkingSettings(flow: { readonly returnUrl: string; readonly data: string }): Record<string, unknown> {
  return {
    deep_link_return_url: flow.returnUrl,
    accept_types: [...PLATFORM_DEEP_LINKING_ACCEPT_TYPES],
    accept_presentation_document_targets: [...PLATFORM_DEEP_LINKING_PRESENTATION_TARGETS],
    accept_multiple: true,
    accept_lineitem: false,
    auto_create: false,
    data: flow.data,
  };
}

/**
 * One deep linking flow, kept from the moment a teacher starts it until the tool's response is
 * posted to its return URL, once. `bindingHash` is the SHA-256 of the value the starting browser
 * holds, as for a launch ticket, and `data` is the opaque value the response must echo exactly.
 */
export const PlatformDeepLinkFlow = z.strictObject({
  districtId: DistrictId,
  toolId: PlatformToolId,
  deploymentId: PlatformDeploymentId,
  offeringId: OfferingId,
  /** The teacher who started it: the drafts are created as their action. */
  principalId: PrincipalId,
  data: z.string().min(1).max(255),
  bindingHash: z.string().min(1),
});
/** A deep linking flow. */
export type PlatformDeepLinkFlow = z.infer<typeof PlatformDeepLinkFlow>;

/** A resource link's ID: the `resource_link.id` claim of every launch of it. */
export const PlatformResourceLinkId = z.string().regex(/^lrl_[A-Za-z0-9_-]{22}$/, "expected a platform resource link ID (lrl_…)");
/** A platform resource link ID. */
export type PlatformResourceLinkId = z.infer<typeof PlatformResourceLinkId>;
/** A new resource link ID. */
export const newPlatformResourceLinkId = (): PlatformResourceLinkId => `lrl_${randomToken().slice(0, 22)}`;

/**
 * A resource link a teacher added to an offering by deep linking: a draft activity of the offering,
 * launched through its deployment with its own ID as the resource link. A draft is staff material
 * (`teacher-only`): students never see or launch it.
 */
export const PlatformResourceLink = z.strictObject({
  id: PlatformResourceLinkId,
  districtId: DistrictId,
  toolId: PlatformToolId,
  deploymentId: PlatformDeploymentId,
  offeringId: OfferingId,
  title: z.string().min(1).max(200),
  text: z.string().min(1).max(1000).optional(),
  /** The URL the tool asked the link to launch, on the tool's own origin. */
  url: HttpsUrl.optional(),
  status: z.literal("draft"),
  /** Where the tool placed it in its response, from 0: links added together keep the tool's order. */
  position: z.int().nonnegative(),
  createdBy: PrincipalId,
  createdAt: UtcTimestamp,
});
/** A platform resource link. */
export type PlatformResourceLink = z.infer<typeof PlatformResourceLink>;

/** One resource link a tool returned, as kept: its title, text and URL, nothing else. */
export interface PlatformDeepLinkItem {
  readonly title: string;
  readonly text?: string;
  readonly url?: string;
}

/** A verified deep linking response. */
export interface VerifiedPlatformDeepLinkingResponse {
  /** The response's `nonce`, which the caller records as used until {@link expiresAt}. */
  readonly nonce: string;
  /** When the response could no longer be accepted, skew included, in milliseconds since the epoch. */
  readonly expiresAt: number;
  /** The resource links it returned, in order. */
  readonly items: readonly PlatformDeepLinkItem[];
  /** How many content items of other types it carried, which were dropped. */
  readonly ignored: number;
}

/** What a deep linking response is verified against: its flow, its tool and the platform. */
export interface PlatformDeepLinkingExpectation {
  /** The flow's tool: the only `iss` the response may carry, publishing the only keys it may be signed by. */
  readonly tool: PlatformTool;
  readonly deploymentId: PlatformDeploymentId;
  /** The platform's issuer: the only `aud` the response may carry. */
  readonly issuer: string;
  /** The flow's `data`, which the response must echo exactly. */
  readonly data: string;
  readonly nowMs: number;
  /** The tool's published keys (`PlatformJwksCache.getKey`). RS256 only. */
  readonly getKey: (jwksUrl: string, kid: string) => Promise<CryptoKey>;
}

const ResourceLinkItem = z.object({
  type: z.literal("ltiResourceLink"),
  title: z.string().trim().max(200).optional(),
  text: z.string().trim().max(1000).optional(),
  url: HttpsUrl.optional(),
});

/** Why a deep linking response was refused: the reason is for the log, never for the page. */
export class PlatformDeepLinkingError extends EducateOsError {
  readonly reason: string;

  constructor(reason: string) {
    super("forbidden", "That content cannot be added.");
    this.reason = reason;
  }
}

/**
 * Verifies a tool's `LtiDeepLinkingResponse` (Deep Linking 2.0 §4.5): RS256 only, signed by a key
 * the tool publishes at its registered JWKS URL; `iss` the tool's client ID; `aud` exactly the
 * platform; `exp` and `iat` current within thirty seconds; a `nonce`; the LTI version and message
 * type; the flow's deployment; and the flow's `data`, exactly. Only `ltiResourceLink` items are
 * kept, each with its title, text and URL alone (custom parameters, line items, icons and windows
 * are dropped), and each URL must be on the tool's registered origin. More than
 * {@link MAX_PLATFORM_DEEP_LINK_ITEMS} links, or one that does not parse, refuses the whole
 * response. Throws {@link PlatformDeepLinkingError}.
 */
export async function verifyPlatformDeepLinkingResponse(jwt: string, expected: PlatformDeepLinkingExpectation): Promise<VerifiedPlatformDeepLinkingResponse> {
  const { tool } = expected;
  if (jwt.length > MAX_PLATFORM_DEEP_LINKING_RESPONSE_LENGTH) throw new PlatformDeepLinkingError("too-large");
  let header: ReturnType<typeof decodeProtectedHeader>;
  let unverified: JWTPayload;
  try {
    header = decodeProtectedHeader(jwt);
    unverified = decodeJwt(jwt);
  } catch {
    throw new PlatformDeepLinkingError("not-a-jwt");
  }
  // RS256 only: never a symmetric or unsigned algorithm, whatever the header asks for.
  if (header.alg !== "RS256") throw new PlatformDeepLinkingError("algorithm");
  if (typeof header.kid !== "string" || header.kid === "") throw new PlatformDeepLinkingError("no-kid");
  if (unverified.iss !== tool.id) throw new PlatformDeepLinkingError("issuer");

  let key: CryptoKey;
  try {
    key = await expected.getKey(tool.jwksUrl, header.kid);
  } catch (error) {
    if (!(error instanceof EducateOsError)) throw error;
    throw new PlatformDeepLinkingError(error.code === "unavailable" ? "jwks-unavailable" : "unknown-key");
  }
  let payload: JWTPayload & Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(jwt, key, {
      algorithms: ["RS256"],
      issuer: tool.id,
      requiredClaims: ["iss", "aud", "exp", "iat", "nonce"],
      clockTolerance: DEEP_LINKING_RESPONSE_CLOCK_SKEW_SECONDS,
      currentDate: new Date(expected.nowMs),
    }));
  } catch (error) {
    if (error instanceof joseErrors.JOSEError) throw new PlatformDeepLinkingError("signature-or-expiry");
    throw error;
  }

  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (audiences.length !== 1 || audiences[0] !== expected.issuer) throw new PlatformDeepLinkingError("audience");
  const { exp, iat, nonce } = payload as { exp: number; iat: number; nonce: unknown };
  if (iat > expected.nowMs / 1000 + DEEP_LINKING_RESPONSE_CLOCK_SKEW_SECONDS) throw new PlatformDeepLinkingError("issued-in-future");
  if (typeof nonce !== "string" || nonce === "" || nonce.length > 255) throw new PlatformDeepLinkingError("nonce");
  if (payload[LTI_CLAIM.version] !== LTI_VERSION || payload[LTI_CLAIM.messageType] !== "LtiDeepLinkingResponse") throw new PlatformDeepLinkingError("message-type");
  if (payload[LTI_CLAIM.deploymentId] !== expected.deploymentId) throw new PlatformDeepLinkingError("deployment");
  if (payload[LTI_CLAIM.data] !== expected.data) throw new PlatformDeepLinkingError("data");

  const raw = payload[LTI_CLAIM.contentItems] ?? [];
  if (!Array.isArray(raw) || raw.length > MAX_CONTENT_ITEMS) throw new PlatformDeepLinkingError("content-items");
  const origin = new URL(tool.loginInitiationUrl).origin;
  const items: PlatformDeepLinkItem[] = [];
  let ignored = 0;
  for (const item of raw as unknown[]) {
    if (typeof item !== "object" || item === null || (item as { type?: unknown }).type !== "ltiResourceLink") {
      ignored += 1;
      continue;
    }
    const link = ResourceLinkItem.safeParse(item);
    if (!link.success) throw new PlatformDeepLinkingError("content-item");
    if (link.data.url !== undefined && new URL(link.data.url).origin !== origin) throw new PlatformDeepLinkingError("foreign-url");
    items.push({
      title: link.data.title === undefined || link.data.title === "" ? tool.name : link.data.title,
      ...link.data.text === undefined || link.data.text === "" ? {} : { text: link.data.text },
      ...link.data.url === undefined ? {} : { url: link.data.url },
    });
  }
  if (items.length > MAX_PLATFORM_DEEP_LINK_ITEMS) throw new PlatformDeepLinkingError("too-many-items");
  return { nonce, expiresAt: (exp + DEEP_LINKING_RESPONSE_CLOCK_SKEW_SECONDS) * 1000, items, ignored };
}
