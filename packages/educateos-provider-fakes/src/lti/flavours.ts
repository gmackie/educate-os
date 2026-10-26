// The two LTI 1.3 platforms the fake can be: Canvas and Schoology. A flavour is the platform's URL
// layout, how it derives identifiers, and its documented deviations from the plain specs.
//
// Canvas, from the canvas-lms source (github.com/instructure/canvas-lms, master, read 2026-10-25):
// `config/routes.rb` (every URL below), `app/controllers/lti/ims/authentication_controller.rb` (the
// two-hop OIDC authorization and its error codes), `app/controllers/security_controller.rb` (the
// JWKS and the OpenID configuration, which reads `registration_token` from the query string),
// `app/controllers/lti/ims/dynamic_registration_controller.rb` (the registration answer, which puts
// `deployment_id` at the top level), `lib/lti/messages/{jwt_message,resource_link_request,
// deep_linking_request}.rb` (claims, per-placement deep linking settings, `data` in the return URL's
// query), `app/controllers/lti/ims/concerns/lti_services.rb` (the `{"errors":{"type","message"}}`
// body, 401 for insufficient scope), `scores_controller.rb` (200 with `resultUrl`) and
// `names_and_roles_controller.rb` (limit defaults to 50); and the API docs
// (canvas.instructure.com/doc/api/file.throttling.html: `429 Forbidden (Rate Limit Exceeded)`).
//
// Schoology, from developers.schoology.com/app-platform/lti-apps (issuer, authorization, token and
// JWKS URLs; NRPS pages of at most 100; deep linking only `ltiResourceLink` and HTML links;
// lower-cased custom parameter keys; deep-linked links not inheriting tool custom parameters) and
// ltiaas.com/guides/lms/schoology ("only supports manual tool registration": no Dynamic
// Registration). Schoology does not document its AGS, NRPS or deep linking return URLs, its error
// bodies or its identifier formats; those here are labelled as assumptions.
import { hexId, numericId } from "../ids.ts";
import type { DistrictSeed, PersonSeed, SectionSeed } from "../types.ts";

/** Which platform a flavour fakes. */
export type LtiFlavourName = "canvas" | "schoology";

/** A section's identifiers on the platform. */
export interface LtiContextIds {
  /** The LTI `context.id`. */
  readonly contextId: string;
  /** The identifier the platform's service URLs carry: Canvas's course ID, Schoology's section ID. */
  readonly serviceId: string;
}

/** A person's identifiers on the platform. */
export interface LtiUserIds {
  /** The id_token `sub` and the NRPS `user_id`. */
  readonly sub: string;
  /** The `login_hint` the platform sends in login initiation. */
  readonly loginHint: string;
  /** Canvas's LTI 1.1 user ID (`lti11_legacy_user_id`), when the platform has one. */
  readonly legacyUserId?: string;
}

/** Deep linking settings a placement sends (Deep Linking 2.0 §4.4.1), before the return URL. */
export interface DeepLinkPlacement {
  readonly accept_types: readonly string[];
  readonly accept_presentation_document_targets: readonly string[];
  readonly accept_media_types?: string;
  readonly accept_multiple: boolean;
  readonly auto_create: boolean;
}

/** A platform's URL layout, identifiers and quirks. */
export interface LtiFlavour {
  readonly name: LtiFlavourName;
  /** The `product_family_code` of the `tool_platform` claim and the platform configuration. */
  readonly productFamilyCode: string;
  /** The `iss` of every id_token. */
  readonly issuer: string;
  /** Every origin the fake serves, for {@link routeFetch}. */
  readonly origins: readonly string[];
  /** Where the tool sends the OIDC authentication request. */
  readonly authorizationEndpoint: string;
  /**
   * Canvas answers the authentication request with a redirect to this second endpoint on the
   * institution's own domain, which posts the id_token. Undefined: the first endpoint answers.
   */
  readonly authorizeEndpoint: string | undefined;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  /** The OpenID configuration (Dynamic Registration §3.4). Undefined: no Dynamic Registration. */
  readonly openidConfigurationUrl: string | undefined;
  /** The Dynamic Registration endpoint. Undefined: no Dynamic Registration. */
  readonly registrationEndpoint: string | undefined;
  /** A section's line item container, for one tool. */
  lineItemsUrl(context: LtiContextIds, clientId: string): string;
  /** A section's NRPS membership URL, for one tool. */
  membershipsUrl(context: LtiContextIds, clientId: string): string;
  /** A section's deep linking return URL, for one tool, before any query. */
  deepLinkReturnUrl(context: LtiContextIds, clientId: string): string;
  /** Where the platform returns the browser after a launch (`launch_presentation.return_url`). */
  returnUrl(context: LtiContextIds): string;
  /** A section's identifiers. */
  contextIds(section: SectionSeed): LtiContextIds;
  /** A person's identifiers. */
  userIds(person: PersonSeed): LtiUserIds;
  /** A new tool client ID, the `n`th registered. */
  clientId(n: number): string;
  /** A new deployment ID, the `n`th created. */
  deploymentId(seed: DistrictSeed, n: number): string;
  /** A resource link ID for a link created by deep linking, the `n`th. */
  resourceLinkId(section: SectionSeed, n: number): string;
  /** The resource link ID of a placement launch that is not of a created link (course navigation). */
  placementResourceLinkId(context: LtiContextIds): string;
  /** The deep linking settings of a placement. */
  deepLinkPlacement(placement: string): DeepLinkPlacement;
  /** The placement a launch defaults to, per message type. */
  readonly defaultPlacements: { readonly LtiResourceLinkRequest: string; readonly LtiDeepLinkingRequest: string };
  /** The NRPS page size when the tool sends no `limit`, and the largest it honours. */
  readonly nrpsLimits: { readonly default: number; readonly max: number };
  /** The AGS line item and result page size when the tool sends no `limit`, and the largest. */
  readonly agsLimits: { readonly default: number; readonly max: number };
  /** How long an id_token lives, in seconds. */
  readonly idTokenLifetimeSeconds: number;
  /** Whether id_tokens carry `azp`. */
  readonly sendsAzp: boolean;
  /**
   * Where a deep linking request's opaque `data` travels: in the settings claim, to be echoed in the
   * response JWT (the spec), or in the return URL's query (Canvas).
   */
  readonly deepLinkData: "claim" | "return-url";
  /** Whether custom parameter keys are lower-cased (Schoology loses their case). */
  readonly lowercaseCustomKeys: boolean;
  /** Whether a link created by deep linking also gets the tool's own custom parameters. */
  readonly deepLinkedLinksGetToolCustom: boolean;
  /** The status of a request whose token lacks the scope. Canvas answers 401. */
  readonly insufficientScopeStatus: 401 | 403;
  /** How a score post is answered: Canvas 200 with `resultUrl`, Schoology 201 (assumed empty). */
  readonly scoreAnswer: "result-url" | "created";
  /** Where Dynamic Registration puts the new `deployment_id`: Canvas puts it at the top level. */
  readonly registrationDeploymentId: "top-level" | "tool-configuration";
  /** Extra id_token claims the platform adds. */
  extraClaims(input: FlavourClaimsInput): Record<string, unknown>;
  /** The platform's error body for an LTI service request. */
  serviceError(status: number, message: string): Response;
  /** The platform's answer to a rate-limited request (before the fake adds `Retry-After`). */
  rateLimited(): Response;
  /** The platform's answer during an outage. */
  outage(status: number): Response;
}

/** What {@link LtiFlavour.extraClaims} is given. */
export interface FlavourClaimsInput {
  readonly seed: DistrictSeed;
  readonly person: PersonSeed;
  readonly user: LtiUserIds;
  readonly placement: string;
}

/** The real Canvas Cloud origins, for reference only: fakes and tests use `.example` origins. */
export const CANVAS_CLOUD_ORIGINS = {
  issuer: "https://canvas.instructure.com",
  sso: "https://sso.canvaslms.com",
} as const;

/** The real Schoology origins, for reference only: fakes and tests use `.example` origins. */
export const SCHOOLOGY_ORIGINS = {
  issuer: "https://schoology.schoology.com",
  service: "https://lti-service.svc.schoology.com",
} as const;

/**
 * Where a Canvas fake lives. Canvas Cloud has three: the issuer (`canvas.instructure.com`, which
 * also serves the registration OpenID configuration), the OIDC/OAuth host (`sso.canvaslms.com`)
 * and the institution's own domain (`district.instructure.com`), which serves AGS, NRPS, the second
 * authorization hop and deep linking returns. A self-hosted Canvas uses one origin for all three.
 */
export interface CanvasOrigins {
  readonly issuer?: string;
  readonly sso?: string;
  readonly domain?: string;
}

const uuidOf = (hex: string): string => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;

const LTI_LINK = "application/vnd.ims.lti.v1.ltilink";

/** Canvas's deep linking settings by placement (`deep_linking_request.rb` DEEP_LINKING_DETAILS). */
const CANVAS_DEEP_LINK_PLACEMENTS: Readonly<Record<string, DeepLinkPlacement>> = {
  link_selection: { accept_types: ["ltiResourceLink"], accept_presentation_document_targets: ["iframe", "window"], accept_media_types: LTI_LINK, accept_multiple: true, auto_create: false },
  assignment_selection: { accept_types: ["ltiResourceLink"], accept_presentation_document_targets: ["iframe", "window"], accept_media_types: LTI_LINK, accept_multiple: false, auto_create: false },
  course_assignments_menu: { accept_types: ["ltiResourceLink"], accept_presentation_document_targets: ["iframe", "window"], accept_media_types: LTI_LINK, accept_multiple: true, auto_create: false },
  editor_button: {
    accept_types: ["link", "file", "html", "ltiResourceLink", "image"],
    accept_presentation_document_targets: ["embed", "iframe", "window"],
    accept_media_types: ["image/*", "text/html", LTI_LINK, "*/*"].join(","),
    accept_multiple: true,
    auto_create: false,
  },
};

function canvasJson(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

/** A Canvas-flavoured platform. Origins default to `.example` stand-ins for Canvas Cloud's. */
export function canvasFlavour(origins: CanvasOrigins = {}): LtiFlavour {
  const issuer = origins.issuer ?? "https://canvas.instructure.example";
  const sso = origins.sso ?? "https://sso.canvaslms.example";
  const domain = origins.domain ?? "https://district.instructure.example";
  const course = (context: LtiContextIds) => `${domain}/api/lti/courses/${context.serviceId}`;
  return {
    name: "canvas",
    productFamilyCode: "canvas",
    issuer,
    origins: [...new Set([issuer, sso, domain].map((origin) => new URL(origin).origin))],
    authorizationEndpoint: `${sso}/api/lti/authorize_redirect`,
    authorizeEndpoint: `${domain}/api/lti/authorize`,
    tokenEndpoint: `${sso}/login/oauth2/token`,
    jwksUri: `${sso}/api/lti/security/jwks`,
    openidConfigurationUrl: `${issuer}/api/lti/security/openid-configuration`,
    registrationEndpoint: `${sso}/api/lti/registrations`,
    lineItemsUrl: (context) => `${course(context)}/line_items`,
    membershipsUrl: (context) => `${course(context)}/names_and_roles`,
    deepLinkReturnUrl: (context) => `${domain}/courses/${context.serviceId}/deep_linking_response`,
    returnUrl: (context) => `${domain}/courses/${context.serviceId}/external_content/success/external_tool_redirect`,
    // Canvas's `context.id` and `login_hint` are its 40-hex-digit opaque identifiers; `sub` is the
    // user's `lti_id`, a UUID; course IDs are small integers.
    contextIds: (section) => ({ contextId: hexId("canvas:context", section.id, 40), serviceId: String(Number(numericId("canvas:course", section.id, 5))) }),
    userIds: (person) => {
      const legacy = hexId("canvas:lti11-user", person.id, 40);
      return { sub: uuidOf(hexId("canvas:user", person.id, 32)), loginHint: legacy, legacyUserId: legacy };
    },
    clientId: (n) => String(10000000000000 + n),
    // `dynamic_registration_controller.rb` documents deployment IDs as `1:abc123def456`.
    deploymentId: (seed, n) => `${n}:${hexId("canvas:deployment", `${seed.id}:${n}`, 40)}`,
    resourceLinkId: (section, n) => uuidOf(hexId("canvas:resource-link", `${section.id}:${n}`, 32)),
    // `resource_link_request.rb`: a launch without a resource link uses the context's opaque ID.
    placementResourceLinkId: (context) => context.contextId,
    deepLinkPlacement: (placement) => CANVAS_DEEP_LINK_PLACEMENTS[placement] ?? CANVAS_DEEP_LINK_PLACEMENTS.link_selection!,
    defaultPlacements: { LtiResourceLinkRequest: "course_navigation", LtiDeepLinkingRequest: "link_selection" },
    nrpsLimits: { default: 50, max: 50 },
    // Canvas paginates line items and results with its API default page size (10, at most 50).
    agsLimits: { default: 10, max: 50 },
    idTokenLifetimeSeconds: 3600,
    sendsAzp: true,
    deepLinkData: "return-url",
    lowercaseCustomKeys: false,
    deepLinkedLinksGetToolCustom: true,
    insufficientScopeStatus: 401,
    scoreAnswer: "result-url",
    registrationDeploymentId: "top-level",
    extraClaims: ({ seed, user, placement }) => ({
      [`https://purl.imsglobal.org/spec/lti/claim/lti11_legacy_user_id`]: user.legacyUserId,
      [`https://purl.imsglobal.org/spec/lti/claim/lti1p1`]: { user_id: user.legacyUserId },
      locale: "en",
      "https://www.instructure.com/placement": placement,
      [`https://purl.imsglobal.org/spec/lti/claim/tool_platform`]: {
        guid: `${hexId("canvas:account", seed.id, 40)}:canvas-lms`,
        name: seed.name,
        version: "cloud",
        product_family_code: "canvas",
      },
    }),
    serviceError: (status, message) => canvasJson(status, { errors: { type: statusType(status), message } }),
    // Canvas's documented throttle answer, with the header it sends when throttling applies.
    rateLimited: () => new Response("429 Forbidden (Rate Limit Exceeded)", { status: 429, headers: { "content-type": "text/plain; charset=utf-8", "x-rate-limit-remaining": "0" } }),
    outage: (status) => canvasJson(status, { errors: [{ message: "An error occurred." }] }),
  };
}

/** Where a Schoology fake lives: the issuer, and the LTI service host that serves everything else. */
export interface SchoologyOrigins {
  readonly issuer?: string;
  readonly service?: string;
}

/** A Schoology-flavoured platform. Origins default to `.example` stand-ins for Schoology's. */
export function schoologyFlavour(origins: SchoologyOrigins = {}): LtiFlavour {
  const issuer = origins.issuer ?? "https://schoology.schoology.example";
  const service = origins.service ?? "https://lti-service.svc.schoology.example";
  const base = `${service}/lti-service`;
  // Assumed layout: Schoology documents only the three URLs above, and hands service URLs to the
  // tool in launch claims. This follows the `tool/{client_id}/services/...` shape tool vendors report.
  const tool = (clientId: string) => `${base}/tool/${clientId}`;
  return {
    name: "schoology",
    productFamilyCode: "schoology",
    issuer,
    origins: [...new Set([issuer, service].map((origin) => new URL(origin).origin))],
    authorizationEndpoint: `${base}/authorize-redirect`,
    authorizeEndpoint: undefined,
    tokenEndpoint: `${base}/access-token`,
    jwksUri: `${base}/.well-known/jwks`,
    openidConfigurationUrl: undefined,
    registrationEndpoint: undefined,
    lineItemsUrl: (context, clientId) => `${tool(clientId)}/services/assignment-grade/v2p0/sections/${context.serviceId}/lineitems`,
    membershipsUrl: (context, clientId) => `${tool(clientId)}/services/names-roles/v2p0/sections/${context.serviceId}/memberships`,
    deepLinkReturnUrl: (context, clientId) => `${tool(clientId)}/sections/${context.serviceId}/deep-linking-response`,
    returnUrl: (context) => `https://app.schoology.example/course/${context.serviceId}/materials`,
    // Schoology's IDs are numeric; the section ID doubles as the context ID (assumed).
    contextIds: (section) => {
      const id = numericId("schoology:section", section.id, 10);
      return { contextId: id, serviceId: id };
    },
    userIds: (person) => {
      const id = numericId("schoology:user", person.id, 9);
      return { sub: id, loginHint: id };
    },
    clientId: (n) => String(7000000000 + n),
    deploymentId: (seed, n) => `${numericId("schoology:school", seed.id, 10)}-${numericId("schoology:deployment", `${seed.id}:${n}`, 10)}`,
    resourceLinkId: (section, n) => numericId("schoology:link", `${section.id}:${n}`, 10),
    placementResourceLinkId: (context) => numericId("schoology:link", `${context.serviceId}:nav`, 10),
    // Deep linking launches come only from "Add Materials" (course materials): resource links and
    // HTML links; document targets are not documented.
    deepLinkPlacement: () => ({ accept_types: ["ltiResourceLink", "link"], accept_presentation_document_targets: ["iframe", "window"], accept_multiple: true, auto_create: false }),
    defaultPlacements: { LtiResourceLinkRequest: "course_materials", LtiDeepLinkingRequest: "course_materials" },
    nrpsLimits: { default: 100, max: 100 },
    agsLimits: { default: 100, max: 100 },
    idTokenLifetimeSeconds: 3600,
    sendsAzp: false,
    deepLinkData: "claim",
    lowercaseCustomKeys: true,
    deepLinkedLinksGetToolCustom: false,
    insufficientScopeStatus: 403,
    scoreAnswer: "created",
    registrationDeploymentId: "tool-configuration",
    extraClaims: ({ seed }) => ({
      [`https://purl.imsglobal.org/spec/lti/claim/tool_platform`]: { guid: numericId("schoology:school", seed.id, 10), name: seed.name, product_family_code: "schoology" },
    }),
    serviceError: (status, message) => Response.json({ error: statusType(status), error_description: message }, { status }),
    rateLimited: () => Response.json({ error: "too_many_requests", error_description: "Rate limit exceeded." }, { status: 429 }),
    outage: (status) => Response.json({ error: "server_error", error_description: "Service unavailable." }, { status }),
  };
}

function statusType(status: number): string {
  const names: Record<number, string> = {
    400: "bad_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    409: "conflict",
    415: "unsupported_media_type",
    422: "unprocessable_entity",
    429: "too_many_requests",
    500: "internal_server_error",
    502: "bad_gateway",
    503: "service_unavailable",
    504: "gateway_timeout",
  };
  return names[status] ?? "error";
}
