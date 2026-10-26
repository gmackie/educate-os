// An LTI 1.3 platform fake, Canvas- or Schoology-flavoured (see `flavours.ts` for the vendor
// sources). Built from 1EdTech LTI Core 1.3 (§5.1 OIDC third-party login, §5.3 launch claims),
// the LTI Security Framework 1.0 (§5.1.1 the OIDC authentication request and form_post answer,
// §4.1 the client_credentials grant with a JWT `client_assertion`), Deep Linking 2.0 (§4.4 the
// request settings, §4.5 the response JWT and content items), AGS 2.0 (§3.2 line item container
// with filters and Link paging, §3.3 line items, §3.4 scores, §3.5 results), NRPS 2.0 (§2 the
// membership container, `role`/`limit` filters, Link `rel="next"`) and Dynamic Registration 1.0
// (§3.3 initiation, §3.4 the OpenID configuration, §3.5–3.6 the client registration).
//
// Launch users and contexts come from a `DistrictSeed`: sections are contexts, their teachers and
// students the members, with LIS roles. Seeded assignments made by the integration are the tool's
// AGS line items; teacher-made ones are not visible through AGS (Canvas serves a tool only its own
// line items). Everything is in memory and deterministic apart from token values.
import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, errors as joseErrors, jwtVerify, type JWK, type JWTPayload, type JWTVerifyOptions } from "jose";
import { Fake, TokenIssuer, bearer, formOf, setBounded, type FakeOptions } from "../fake.ts";
import { hexId } from "../ids.ts";
import { enrollmentsOf, studentsToRemove, validateSeed, withoutPeople } from "../seed.ts";
import type { DistrictSeed, PersonSeed, SectionSeed } from "../types.ts";
import {
  AGS_SCOPES,
  ALL_LTI_SCOPES,
  COURSE_OFFERING_TYPE,
  LIS_ROLES,
  LTI_CLAIMS,
  LTI_MEDIA_TYPES,
  LTI_SCOPES,
  LTI_VERSION,
  applyClaimOverrides,
  roleMatches,
  type ClaimOverrides,
} from "./claims.ts";
import type { DeepLinkPlacement, LtiContextIds, LtiFlavour, LtiUserIds } from "./flavours.ts";
import { PlatformKeyRing } from "./keys.ts";

/** A JWKS document. */
export interface JwksDocument {
  readonly keys: JWK[];
}

/** How much of a person the platform shares with a tool (Canvas's privacy levels). */
export type LtiPrivacyLevel = "anonymous" | "name_only" | "email_only" | "public";

/** A tool to register with the platform, as an administrator would enter it. */
export interface LtiToolInput {
  /** Defaults to the flavour's next client ID. */
  readonly clientId?: string;
  /** Defaults to the flavour's next deployment ID. */
  readonly deploymentId?: string;
  readonly name?: string;
  /** The tool's OIDC login initiation URL. */
  readonly initiateLoginUri: string;
  /** The registered launch (redirect) URLs. */
  readonly redirectUris: readonly string[];
  /** The default launch target. Defaults to the first redirect URI. */
  readonly targetLinkUri?: string;
  /** Where the platform fetches the tool's keys, through the fake's injected `fetch`. */
  readonly jwksUri?: string;
  /** The tool's keys, supplied directly instead of fetched. */
  readonly jwks?: () => JwksDocument | Promise<JwksDocument>;
  /** The LTI Advantage scopes the tool may be granted. Defaults to all of them. */
  readonly scopes?: readonly string[];
  /** Tool-level custom parameters, sent with every launch. */
  readonly custom?: Readonly<Record<string, string>>;
  /** Defaults to `anonymous`: `sub` only, no name or email. */
  readonly privacyLevel?: LtiPrivacyLevel;
}

/** A registered tool. */
export interface LtiTool {
  readonly clientId: string;
  readonly deploymentIds: string[];
  readonly name: string;
  readonly initiateLoginUri: string;
  readonly redirectUris: readonly string[];
  readonly targetLinkUri: string;
  readonly jwksUri: string | undefined;
  readonly jwks: (() => JwksDocument | Promise<JwksDocument>) | undefined;
  readonly scopes: readonly string[];
  readonly custom: Readonly<Record<string, string>>;
  readonly privacyLevel: LtiPrivacyLevel;
}

/** A resource link placed in a section: by deep linking, or added directly. */
export interface LtiResourceLink {
  readonly id: string;
  readonly sectionId: string;
  readonly clientId: string;
  readonly title: string;
  readonly text?: string;
  /** The launch URL. Defaults to the tool's target link URI. */
  readonly url?: string;
  readonly custom: Readonly<Record<string, string>>;
  /** The line item the link is graded in, when it has one. */
  readonly lineItemId?: string;
  readonly createdBy: "deep-linking" | "direct";
}

/** An AGS line item, as the platform serves it (AGS 2.0 §3.2). */
export interface LtiLineItem {
  id: string;
  label: string;
  scoreMaximum: number;
  resourceLinkId?: string;
  resourceId?: string;
  tag?: string;
  startDateTime?: string;
  endDateTime?: string;
  gradesReleased?: boolean;
}

/** An AGS result (AGS 2.0 §3.5). */
export interface LtiResult {
  readonly id: string;
  readonly scoreOf: string;
  readonly userId: string;
  readonly resultScore?: number;
  readonly resultMaximum?: number;
  readonly comment?: string;
}

interface StoredLineItem {
  readonly item: LtiLineItem;
  readonly sectionId: string;
  readonly clientId: string;
  readonly results: Map<string, { result: LtiResult; timestamp: number }>;
}

/** What a launch is: who, where, and what message. */
export interface LtiLaunchInput {
  /** Defaults to the first registered tool. */
  readonly clientId?: string;
  /** A seeded person: a member of the section, or an administrator or staff member. */
  readonly personId: string;
  readonly sectionId: string;
  /** Defaults to `LtiResourceLinkRequest`. */
  readonly messageType?: "LtiResourceLinkRequest" | "LtiDeepLinkingRequest";
  /** The placement the launch comes from. Defaults to the flavour's for the message type. */
  readonly placement?: string;
  /** A resource link the launch opens. Defaults to the placement's own link. */
  readonly resourceLinkId?: string;
  /** Defaults to the tool's first deployment. */
  readonly deploymentId?: string;
  /** Defaults to the resource link's URL, or the tool's target link URI. */
  readonly targetLinkUri?: string;
  /** Claims to set or remove on the id_token. */
  readonly overrides?: ClaimOverrides;
}

/** The platform's third-party login initiation (LTI Core 1.3 §5.1.1), aimed at the tool. */
export interface LtiLoginInitiation {
  /** The tool's login initiation URL with the parameters as a query string, for a GET. */
  readonly url: string;
  /** The parameters, for a form POST. */
  readonly params: Readonly<Record<string, string>>;
  readonly messageHint: string;
}

/** An auto-submitting form, parsed. */
export interface ParsedForm {
  readonly action: string;
  readonly method: string;
  readonly fields: Readonly<Record<string, string>>;
}

/** What the authorization endpoint answered. */
export interface LtiAuthorizationResult {
  /** The final response's status. */
  readonly status: number;
  /** The form_post page, when there was one: where it posts, and its fields. */
  readonly form: ParsedForm | undefined;
  /** The id_token, on success. */
  readonly idToken: string | undefined;
  /** Its claims, decoded (not verified). */
  readonly claims: JWTPayload | undefined;
  /** The OIDC error code, on failure posted back to the tool. */
  readonly error: string | undefined;
  /** The body of a final response that was not a form. */
  readonly body: string | undefined;
}

/** A deep linking request the platform issued, waiting for the tool's response. */
export interface LtiDeepLinkRequest {
  readonly data: string;
  readonly clientId: string;
  readonly deploymentId: string;
  readonly sectionId: string;
  readonly personId: string;
  readonly placement: string;
  readonly settings: Readonly<Record<string, unknown>>;
}

/** A deep linking response the platform accepted. */
export interface LtiDeepLinkResult {
  readonly request: LtiDeepLinkRequest;
  readonly contentItems: readonly Record<string, unknown>[];
  /** The resource links created from `ltiResourceLink` items. */
  readonly links: readonly LtiResourceLink[];
  readonly message?: string;
  readonly errorMessage?: string;
}

/** A Dynamic Registration the platform started (Dynamic Registration 1.0 §3.3). */
export interface LtiRegistrationInitiation {
  /** The tool's registration URL with `openid_configuration` and `registration_token` added. */
  readonly url: string;
  readonly openidConfiguration: string;
  readonly registrationToken: string;
}

/** Options of {@link LtiPlatformFake}. */
export interface LtiPlatformFakeOptions extends FakeOptions {
  readonly flavour: LtiFlavour;
  readonly seed: DistrictSeed;
  /** The signing keys. Defaults to a ring with one fresh key. */
  readonly keys?: PlatformKeyRing;
  /** Tools registered from the start. */
  readonly tools?: readonly LtiToolInput[];
  /** Used only to fetch tools' JWKS from their `jwksUri`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Seconds an access token lives. Default 3600. */
  readonly tokenLifetimeSeconds?: number;
  /**
   * Whether login initiation offers platform storage (`lti_storage_target`, the LTI Client Side
   * postMessages spec). Default off. Canvas names its frame `post_message_forwarding`.
   */
  readonly platformStorage?: boolean;
  /** Overrides where Dynamic Registration puts `deployment_id`. Defaults to the flavour's. */
  readonly registrationDeploymentId?: "top-level" | "tool-configuration";
  /**
   * Seconds a launch stays redeemable after {@link LtiPlatformFake.initiateLogin}, and a deep
   * linking request answerable after its launch. Default 600 for launches; deep linking requests
   * live an hour, as a teacher may browse the tool's picker for a while.
   */
  readonly launchLifetimeSeconds?: number;
}

const SCORE_ACTIVITY = new Set(["Initialized", "Started", "InProgress", "Submitted", "Completed"]);
const SCORE_GRADING = new Set(["FullyGraded", "Pending", "PendingManual", "Failed", "NotReady"]);
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
const CANVAS_VARIABLES = [
  "ResourceLink.id",
  "ResourceLink.title",
  "Context.id",
  "Context.title",
  "CourseSection.sourcedId",
  "Person.sourcedId",
  "User.id",
  "Canvas.course.id",
  "Canvas.user.id",
  "Canvas.placement",
];
const CANVAS_PLACEMENTS = {
  LtiResourceLinkRequest: ["course_navigation", "assignment_view", "link_selection", "ContentArea"],
  LtiDeepLinkingRequest: ["assignment_selection", "link_selection", "editor_button", "course_assignments_menu", "ContentArea", "RichTextEditor"],
};

const escape = (value: string): string => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const unescape = (value: string): string => value.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

/** An auto-submitting form_post page (OAuth 2.0 Form Post Response Mode), as platforms answer. */
export function autoSubmitForm(action: string, fields: Readonly<Record<string, string>>): string {
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8"><title>Launching</title></head><body>',
    `<form id="lti-form" method="post" action="${escape(action)}">`,
    ...Object.entries(fields).map(([name, value]) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`),
    '<noscript><button type="submit">Continue</button></noscript>',
    "</form>",
    '<script>document.getElementById("lti-form").submit();</script>',
    "</body></html>",
  ].join("");
}

/** Parses the first form of an auto-submitting page: its action, method and hidden fields. */
export function parseAutoSubmitForm(html: string): ParsedForm | undefined {
  const form = /<form\b([^>]*)>([\s\S]*?)<\/form>/i.exec(html);
  if (form === null) return undefined;
  const attribute = (tag: string, name: string) => {
    const found = new RegExp(`\\b${name}="([^"]*)"`, "i").exec(tag)?.[1];
    return found === undefined ? undefined : unescape(found);
  };
  const fields: Record<string, string> = {};
  for (const input of form[2]!.matchAll(/<input\b[^>]*>/gi)) {
    const name = attribute(input[0], "name");
    if (name !== undefined) fields[name] = attribute(input[0], "value") ?? "";
  }
  return { action: attribute(form[1]!, "action") ?? "", method: (attribute(form[1]!, "method") ?? "get").toUpperCase(), fields };
}

function mediaJson(body: unknown, mediaType: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": mediaType, ...headers } });
}

function oauthError(error: string, description: string, status = 400): Response {
  return Response.json({ error, error_description: description }, { status, headers: { "cache-control": "no-store" } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.values(value).some((v) => typeof v !== "string")) return undefined;
  return value as Record<string, string>;
}

function httpsUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function mediaTypeOf(request: Request): string {
  return (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
}

/** A service URL the request matched: which tool and section it belongs to. */
interface ServiceMatch {
  readonly tool: LtiTool;
  readonly section: SectionSeed;
  readonly context: LtiContextIds;
  /** The path after the matched base, such as `/12/scores`. */
  readonly rest: string;
}

interface PendingLaunch {
  readonly tool: LtiTool;
  readonly deploymentId: string;
  readonly person: PersonSeed;
  readonly section: SectionSeed;
  readonly messageType: "LtiResourceLinkRequest" | "LtiDeepLinkingRequest";
  readonly placement: string;
  readonly resourceLink: LtiResourceLink | undefined;
  readonly targetLinkUri: string;
  readonly overrides: ClaimOverrides | undefined;
  used: boolean;
  /** When the launch stops being redeemable (ms); set when its login is initiated. */
  expiresAt: number;
}

/** How long a deep linking request stays answerable. */
const DEEP_LINK_LIFETIME_MS = 3600 * 1000;

/** The most launches, and deep linking requests, the platform remembers at once. */
const MAX_PENDING = 1000;

/** How long a tool's JWKS fetched from its URL is reused. */
const TOOL_JWKS_TTL_MS = 5 * 60 * 1000;

/** How soon a cached JWKS may be refetched for a signature whose key it lacks (a tool's rotation). */
const TOOL_JWKS_COOLDOWN_MS = 30 * 1000;

/** An unguessable token: launches and deep linking requests are bearer capabilities. */
function randomToken(): string {
  return crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
}

/** The services a URL may name, indexed by the URL their base is. */
interface ServiceIndex {
  readonly deepLink: Map<string, ServiceMatch[]>;
  readonly nrps: Map<string, ServiceMatch[]>;
  readonly ags: Map<string, ServiceMatch[]>;
}

/**
 * An LTI 1.3 platform: OIDC login and launch, signed id_tokens and their JWKS, the LTI Advantage
 * token endpoint, Deep Linking returns, AGS, NRPS and (Canvas) Dynamic Registration. Build it with
 * {@link LtiPlatformFake.create}; route a tool's `fetch` to it with `fetch` or `routeFetch` over
 * {@link LtiFlavour.origins}.
 */
export class LtiPlatformFake extends Fake {
  readonly flavour: LtiFlavour;
  readonly keys: PlatformKeyRing;
  /** Registered tools, by client ID. */
  readonly tools = new Map<string, LtiTool>();
  /** Resource links, by ID. */
  readonly resourceLinks = new Map<string, LtiResourceLink>();
  /** Every score accepted, in order: the line item URL and the posted body. */
  readonly scores: { lineItem: string; score: Record<string, unknown> }[] = [];
  /** Deep linking requests issued, by their `data`. */
  readonly deepLinkRequests = new Map<string, LtiDeepLinkRequest>();
  /** Deep linking responses accepted, in order. */
  readonly deepLinkResults: LtiDeepLinkResult[] = [];
  /** Tools registered through Dynamic Registration, in order, with the metadata they posted. */
  readonly dynamicRegistrations: { tool: LtiTool; metadata: Record<string, unknown> }[] = [];
  /** Whether login initiation offers platform storage. */
  platformStorage: boolean;
  #seed: DistrictSeed;
  readonly #fetch: typeof globalThis.fetch | undefined;
  readonly #tokenLifetime: number;
  readonly #tokens: TokenIssuer<{ clientId: string; scopes: readonly string[] }>;
  readonly #registrationTokens: TokenIssuer<{ initiatedAt: number }>;
  readonly #registrationDeploymentId: "top-level" | "tool-configuration";
  readonly #pending = new Map<string, PendingLaunch>();
  readonly #deepLinkExpiry = new Map<string, number>();
  /** Tools' JWKS fetched from their URLs, by client ID. */
  readonly #toolKeys = new Map<string, { uri: string; jwks: JwksDocument; fetchedAt: number }>();
  readonly #launchLifetimeMs: number;
  /** Service URLs by base, for every tool × section; rebuilt when either changes. */
  #index: ServiceIndex | undefined;
  readonly #lineItems = new Map<string, StoredLineItem>();
  readonly #usedJtis = new Set<string>();
  readonly #usedDeepLinkNonces = new Set<string>();
  #clients = 0;
  #deployments = 0;
  #links = 0;
  #lineItemCount = 0;
  #hints = 0;

  constructor(options: LtiPlatformFakeOptions & { readonly keys: PlatformKeyRing }) {
    super(options);
    this.flavour = options.flavour;
    this.keys = options.keys;
    this.#seed = validateSeed(options.seed);
    this.#fetch = options.fetch;
    this.#tokenLifetime = options.tokenLifetimeSeconds ?? 3600;
    this.#tokens = new TokenIssuer(`${options.flavour.name}-at-`, this.now);
    this.#registrationTokens = new TokenIssuer(`${options.flavour.name}-rt-`, this.now);
    this.#registrationDeploymentId = options.registrationDeploymentId ?? options.flavour.registrationDeploymentId;
    this.platformStorage = options.platformStorage ?? false;
    this.#launchLifetimeMs = (options.launchLifetimeSeconds ?? 600) * 1000;
    for (const tool of options.tools ?? []) this.registerTool(tool);
  }

  /** A platform with fresh signing keys unless `options.keys` gives some. */
  static async create(options: LtiPlatformFakeOptions): Promise<LtiPlatformFake> {
    return new LtiPlatformFake({ ...options, keys: options.keys ?? (await PlatformKeyRing.create()) });
  }

  /** The seed as currently served (after any `large-removal`). */
  get seed(): DistrictSeed {
    return this.#seed;
  }

  /** The `iss` of every id_token. */
  get issuer(): string {
    return this.flavour.issuer;
  }

  // ── Setup ────────────────────────────────────────────────────────

  /**
   * Registers a tool and creates its first deployment, as an administrator would. Seeded
   * integration-made assignments become its line items.
   */
  registerTool(input: LtiToolInput): LtiTool {
    const clientId = input.clientId ?? this.flavour.clientId(++this.#clients);
    if (this.tools.has(clientId)) throw new Error(`tool ${clientId} is already registered`);
    if (input.redirectUris.length === 0) throw new Error("a tool needs a redirect URI");
    const tool: LtiTool = {
      clientId,
      deploymentIds: [input.deploymentId ?? this.flavour.deploymentId(this.#seed, ++this.#deployments)],
      name: input.name ?? "Tool",
      initiateLoginUri: input.initiateLoginUri,
      redirectUris: [...input.redirectUris],
      targetLinkUri: input.targetLinkUri ?? input.redirectUris[0]!,
      jwksUri: input.jwksUri,
      jwks: input.jwks,
      scopes: [...(input.scopes ?? ALL_LTI_SCOPES)],
      custom: { ...input.custom },
      privacyLevel: input.privacyLevel ?? "anonymous",
    };
    this.tools.set(clientId, tool);
    this.#index = undefined;
    for (const assignment of this.#seed.assignments ?? []) {
      if (assignment.createdByIntegration !== true || !this.#seed.sections.some((s) => s.id === assignment.sectionId)) continue;
      const stored = this.#storeLineItem(tool, assignment.sectionId, {
        label: assignment.title,
        scoreMaximum: assignment.maxPoints ?? 100,
        resourceId: assignment.id,
        ...(assignment.dueAt === undefined ? {} : { endDateTime: assignment.dueAt }),
      });
      for (const submission of assignment.submissions ?? []) {
        const person = this.#person(submission.studentId);
        if (person === undefined || submission.assignedGrade === undefined) continue;
        const userId = this.flavour.userIds(person).sub;
        stored.results.set(userId, {
          result: { id: `${stored.item.id}/results/${userId}`, scoreOf: stored.item.id, userId, resultScore: submission.assignedGrade, resultMaximum: stored.item.scoreMaximum },
          timestamp: Date.parse(assignment.modified ?? this.#seed.modified),
        });
      }
    }
    return tool;
  }

  /** Adds another deployment of a tool and returns its ID. */
  addDeployment(clientId: string, deploymentId = this.flavour.deploymentId(this.#seed, ++this.#deployments)): string {
    this.#tool(clientId).deploymentIds.push(deploymentId);
    return deploymentId;
  }

  /** Places a resource link in a section directly, as a teacher configuring the course would. */
  addResourceLink(input: Omit<LtiResourceLink, "id" | "createdBy" | "custom"> & { id?: string; custom?: Record<string, string> }): LtiResourceLink {
    const section = this.#section(input.sectionId);
    const link: LtiResourceLink = { ...input, id: input.id ?? this.flavour.resourceLinkId(section, ++this.#links), custom: { ...input.custom }, createdBy: "direct" };
    this.resourceLinks.set(link.id, link);
    return link;
  }

  /** Adds a line item directly, as a teacher creating a gradebook column would. Returns its URL. */
  addLineItem(clientId: string, sectionId: string, item: Omit<LtiLineItem, "id">): string {
    return this.#storeLineItem(this.#tool(clientId), sectionId, item).item.id;
  }

  /** A line item and its results, by URL. */
  lineItem(url: string): { item: LtiLineItem; results: LtiResult[] } | undefined {
    const stored = this.#lineItems.get(url);
    return stored === undefined ? undefined : { item: { ...stored.item }, results: [...stored.results.values()].map((r) => r.result) };
  }

  /** The line items of a section for a tool. */
  lineItemsOf(clientId: string, sectionId: string): LtiLineItem[] {
    return [...this.#lineItems.values()].filter((s) => s.clientId === clientId && s.sectionId === sectionId).map((s) => ({ ...s.item }));
  }

  /** A section's LTI identifiers and, for a tool, its service URLs. */
  contextOf(sectionId: string, clientId = this.#defaultTool().clientId): LtiContextIds & { lineItemsUrl: string; membershipsUrl: string; deepLinkReturnUrl: string } {
    const context = this.flavour.contextIds(this.#section(sectionId));
    return {
      ...context,
      lineItemsUrl: this.flavour.lineItemsUrl(context, clientId),
      membershipsUrl: this.flavour.membershipsUrl(context, clientId),
      deepLinkReturnUrl: this.flavour.deepLinkReturnUrl(context, clientId),
    };
  }

  /** A seeded person's LTI identifiers. */
  userOf(personId: string): LtiUserIds {
    const person = this.#person(personId);
    if (person === undefined) throw new Error(`no person ${personId}`);
    return this.flavour.userIds(person);
  }

  /** The JWKS the platform serves. */
  jwks(): JwksDocument {
    return this.keys.jwks();
  }

  /** Withdraws every access token, as when the platform rotates its token signing key. */
  revokeTokens(): void {
    this.#tokens.revokeAll();
  }

  // ── Launches ─────────────────────────────────────────────────────

  /**
   * Starts a launch: the third-party initiated login the platform sends the browser to the tool
   * with (LTI Core 1.3 §5.1.1). The platform remembers the launch under `lti_message_hint`.
   */
  initiateLogin(input: LtiLaunchInput): LtiLoginInitiation {
    const pending = this.#pendingLaunch(input);
    // The hint is a bearer capability: whoever presents it with the person's login_hint gets the
    // signed launch. So it is random, and it expires; expired launches are forgotten.
    const messageHint = `${this.flavour.name}-hint-${++this.#hints}-${randomToken()}`;
    const now = this.now();
    pending.expiresAt = now + this.#launchLifetimeMs;
    setBounded(this.#pending, messageHint, pending, MAX_PENDING, (old) => old.expiresAt <= now);
    const user = this.flavour.userIds(pending.person);
    const params: Record<string, string> = {
      iss: this.issuer,
      login_hint: user.loginHint,
      target_link_uri: pending.targetLinkUri,
      lti_message_hint: messageHint,
      lti_deployment_id: pending.deploymentId,
      client_id: pending.tool.clientId,
    };
    if (this.flavour.name === "canvas") {
      params.canvas_region = "us-east-1";
      params.canvas_environment = "prod";
    }
    if (this.platformStorage) params.lti_storage_target = this.flavour.name === "canvas" ? "post_message_forwarding" : "_parent";
    const url = new URL(pending.tool.initiateLoginUri);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    return { url: url.toString(), params, messageHint };
  }

  /**
   * Sends the tool's authentication request (the URL its login redirected the browser to) to the
   * platform, follows the platform's own redirects, and parses the form_post page it answers with.
   */
  async authorize(request: string | URL | Request): Promise<LtiAuthorizationResult> {
    let response = await this.handle(request instanceof Request ? request : new Request(request));
    for (let hops = 0; response.status >= 300 && response.status < 400 && hops < 5; hops++) {
      const location = response.headers.get("location");
      if (location === null || !this.flavour.origins.includes(new URL(location).origin)) break;
      response = await this.handle(new Request(location));
    }
    const text = await response.text();
    const form = (response.headers.get("content-type") ?? "").includes("text/html") ? parseAutoSubmitForm(text) : undefined;
    const idToken = form?.fields.id_token;
    return {
      status: response.status,
      form,
      idToken,
      claims: idToken === undefined ? undefined : decodeJwt(idToken),
      error: form?.fields.error,
      body: form === undefined ? text : undefined,
    };
  }

  /**
   * The claims of a launch's id_token, for a given `nonce`. The authorization endpoint signs
   * exactly these; tests may also sign their own variations with {@link signIdToken}.
   */
  launchClaims(input: LtiLaunchInput, nonce: string): Record<string, unknown> {
    return this.#claims(this.#pendingLaunch(input), nonce);
  }

  /** Signs claims as an id_token with the current key (or the one given, to forge). */
  signIdToken(claims: Record<string, unknown>, options?: Parameters<PlatformKeyRing["sign"]>[1]): Promise<string> {
    return this.keys.sign(claims, options);
  }

  // ── Dynamic Registration ─────────────────────────────────────────

  /**
   * Starts Dynamic Registration of the tool at `toolRegistrationUrl`: the URL the platform opens,
   * with `openid_configuration` and a one-hour `registration_token` (§3.3). Canvas also puts the
   * token in the configuration URL's query, where its OpenID configuration endpoint reads it.
   */
  registrationInitiation(toolRegistrationUrl: string): LtiRegistrationInitiation {
    const configuration = this.flavour.openidConfigurationUrl;
    if (configuration === undefined) throw new Error(`${this.flavour.name} does not support LTI Dynamic Registration`);
    const registrationToken = this.#registrationTokens.issue({ initiatedAt: this.now() }, 3600);
    const openidConfiguration = new URL(configuration);
    openidConfiguration.searchParams.set("registration_token", registrationToken);
    const url = new URL(toolRegistrationUrl);
    url.searchParams.set("openid_configuration", openidConfiguration.toString());
    url.searchParams.set("registration_token", registrationToken);
    return { url: url.toString(), openidConfiguration: openidConfiguration.toString(), registrationToken };
  }

  // ── Serving ──────────────────────────────────────────────────────

  protected async serve(request: Request, body: string): Promise<Response> {
    const url = new URL(request.url);
    const here = `${url.origin}${url.pathname}`;
    const f = this.flavour;
    if (here === f.jwksUri && request.method === "GET") {
      return Response.json(this.jwks(), { headers: { "cache-control": "max-age=864000" } });
    }
    if (here === f.authorizationEndpoint && (request.method === "GET" || request.method === "POST")) {
      const params = request.method === "GET" ? url.searchParams : formOf(body);
      return f.authorizeEndpoint === undefined ? this.#authorizeLaunch(params) : this.#authorizeRedirect(params);
    }
    if (f.authorizeEndpoint !== undefined && here === f.authorizeEndpoint && request.method === "GET") return this.#authorizeLaunch(url.searchParams);
    if (here === f.tokenEndpoint && request.method === "POST") return this.#token(request, body);
    if (f.openidConfigurationUrl !== undefined && here === f.openidConfigurationUrl && request.method === "GET") return this.#openidConfiguration(url);
    if (f.registrationEndpoint !== undefined && here === f.registrationEndpoint && request.method === "POST") return this.#register(request, body);

    const deepLink = this.#match(here, "deepLink");
    if (deepLink.length > 0 && request.method === "POST") return this.#deepLinkReturn(url, body, deepLink);
    const nrps = this.#match(here, "nrps");
    if (nrps.length > 0) {
      if (request.method !== "GET") return f.serviceError(405, "Method not allowed");
      return this.#service(request, nrps, [LTI_SCOPES.contextMembershipReadonly], (match) => this.#memberships(request, url, match));
    }
    const ags = this.#match(here, "ags");
    if (ags.length > 0) return this.#ags(request, url, body, ags);
    return f.serviceError(404, "The specified resource does not exist.");
  }

  protected errorResponse(status: number, reason: "outage" | "rate-limit"): Response {
    return reason === "rate-limit" ? this.flavour.rateLimited() : this.flavour.outage(status);
  }

  protected removeLargeShare(fraction: number): void {
    this.#seed = withoutPeople(this.#seed, studentsToRemove(this.#seed, fraction));
    this.#index = undefined;
  }

  // ── OIDC ─────────────────────────────────────────────────────────

  /** Canvas's first hop: from the shared OIDC host to the institution's domain. */
  #authorizeRedirect(params: URLSearchParams): Response {
    const hint = params.get("lti_message_hint");
    const pending = hint === null ? undefined : this.#pending.get(hint);
    if (pending === undefined || pending.expiresAt <= this.now()) return this.flavour.serviceError(400, "Invalid lti_message_hint");
    const next = new URL(this.flavour.authorizeEndpoint!);
    // Canvas forwards only the OIDC parameters it permits.
    for (const name of ["client_id", "login_hint", "lti_message_hint", "nonce", "prompt", "redirect_uri", "response_mode", "response_type", "scope", "state"]) {
      const value = params.get(name);
      if (value !== null) next.searchParams.set(name, value);
    }
    return new Response(null, { status: 302, headers: { location: next.toString() } });
  }

  /** The authentication response (Security Framework §5.1.1.2–5.1.1.5): a form_post of the id_token. */
  async #authorizeLaunch(params: URLSearchParams): Promise<Response> {
    const canvas = this.flavour.name === "canvas";
    const required = ["client_id", "login_hint", "lti_message_hint", "nonce", "prompt", "redirect_uri", "response_mode", "response_type", "scope"];
    const tool = this.tools.get(params.get("client_id") ?? "");
    const redirectUri = params.get("redirect_uri");
    // Without a known client and a registered redirect URI there is nowhere safe to post an error.
    if (tool === undefined) return this.flavour.serviceError(400, "Unknown client_id");
    if (redirectUri === null || !tool.redirectUris.includes(redirectUri)) return this.flavour.serviceError(400, "Invalid redirect_uri");
    const state = params.get("state");
    const fail = (error: string, description: string) =>
      this.#formPost(redirectUri, { error, error_description: description, ...(state === null ? {} : { state }) });
    const invalid = canvas ? "invalid_request_object" : "invalid_request";
    const missing = required.filter((name) => !params.get(name));
    if (missing.length > 0) return fail(invalid, `The following parameters are missing: ${missing.join(",")}`);
    if (params.get("scope") !== "openid") return fail(invalid, "The 'scope' must be 'openid'");
    if (params.get("response_type") !== "id_token") return fail("unsupported_response_type", "The 'response_type' must be 'id_token'");
    if (params.get("response_mode") !== "form_post") return fail(invalid, "The 'response_mode' must be 'form_post'");
    if (params.get("prompt") !== "none") return fail(invalid, "The 'prompt' must be 'none'");
    const pending = this.#pending.get(params.get("lti_message_hint")!);
    if (pending === undefined) return this.flavour.serviceError(400, "Invalid lti_message_hint");
    if (pending.tool.clientId !== tool.clientId) return fail("unauthorized_client", "Client not authorized in requested context");
    if (this.flavour.userIds(pending.person).loginHint !== params.get("login_hint")) return fail("login_required", "Must have an active user session");
    if (pending.used || pending.expiresAt <= this.now()) return fail("launch_no_longer_valid", "The launch has either expired or already been consumed");
    pending.used = true;
    const idToken = await this.keys.sign(this.#claims(pending, params.get("nonce")!));
    return this.#formPost(redirectUri, {
      id_token: idToken,
      ...(state === null ? {} : { state }),
      ...(this.platformStorage ? { lti_storage_target: canvas ? "post_message_forwarding" : "_parent" } : {}),
    });
  }

  #formPost(action: string, fields: Record<string, string>): Response {
    return new Response(autoSubmitForm(action, fields), { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }

  #pendingLaunch(input: LtiLaunchInput): PendingLaunch {
    const tool = input.clientId === undefined ? this.#defaultTool() : this.#tool(input.clientId);
    const section = this.#section(input.sectionId);
    const person = this.#person(input.personId);
    if (person === undefined) throw new Error(`no person ${input.personId}`);
    const member = section.teacherIds.includes(person.id) || section.studentIds.includes(person.id);
    if (!member && person.role !== "administrator" && person.role !== "staff") throw new Error(`${person.id} is not in section ${section.id}`);
    const deploymentId = input.deploymentId ?? tool.deploymentIds[0]!;
    const messageType = input.messageType ?? "LtiResourceLinkRequest";
    const placement = input.placement ?? this.flavour.defaultPlacements[messageType];
    let resourceLink: LtiResourceLink | undefined;
    if (input.resourceLinkId !== undefined) {
      resourceLink = this.resourceLinks.get(input.resourceLinkId);
      if (resourceLink === undefined || resourceLink.sectionId !== section.id) throw new Error(`no resource link ${input.resourceLinkId} in ${section.id}`);
    }
    return {
      tool,
      deploymentId,
      person,
      section,
      messageType,
      placement,
      resourceLink,
      targetLinkUri: input.targetLinkUri ?? resourceLink?.url ?? tool.targetLinkUri,
      overrides: input.overrides,
      used: false,
      expiresAt: Number.POSITIVE_INFINITY,
    };
  }

  #claims(launch: PendingLaunch, nonce: string): Record<string, unknown> {
    const f = this.flavour;
    const { tool, person, section } = launch;
    const user = f.userIds(person);
    const context = f.contextIds(section);
    const course = this.#seed.courses.find((c) => c.id === section.courseId);
    const now = Math.floor(this.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: this.issuer,
      aud: tool.clientId,
      ...(f.sendsAzp ? { azp: tool.clientId } : {}),
      sub: user.sub,
      iat: now,
      exp: now + f.idTokenLifetimeSeconds,
      nonce,
      [LTI_CLAIMS.messageType]: launch.messageType,
      [LTI_CLAIMS.version]: LTI_VERSION,
      [LTI_CLAIMS.deploymentId]: launch.deploymentId,
      [LTI_CLAIMS.targetLinkUri]: launch.targetLinkUri,
      [LTI_CLAIMS.roles]: this.#roles(person, section, "launch"),
      [LTI_CLAIMS.context]: { id: context.contextId, ...(course?.courseCode === undefined ? {} : { label: course.courseCode }), title: section.title, type: [COURSE_OFFERING_TYPE] },
      [LTI_CLAIMS.launchPresentation]: { document_target: "iframe", return_url: f.returnUrl(context), locale: "en" },
      ...this.#personClaims(tool, person),
      ...f.extraClaims({ seed: this.#seed, person, user, placement: launch.placement }),
    };
    const link = launch.resourceLink;
    if (launch.messageType === "LtiResourceLinkRequest") {
      claims[LTI_CLAIMS.resourceLink] = link === undefined
        ? { id: f.placementResourceLinkId(context), title: section.title }
        : { id: link.id, title: link.title, ...(link.text === undefined ? {} : { description: link.text }) };
    } else {
      claims[LTI_CLAIMS.deepLinkingSettings] = this.#deepLinkSettings(launch, context);
    }
    const toolCustom = link?.createdBy === "deep-linking" && !f.deepLinkedLinksGetToolCustom ? {} : tool.custom;
    const custom = { ...toolCustom, ...link?.custom };
    if (Object.keys(custom).length > 0) {
      claims[LTI_CLAIMS.custom] = f.lowercaseCustomKeys ? Object.fromEntries(Object.entries(custom).map(([k, v]) => [k.toLowerCase(), v])) : custom;
    }
    const agsScopes = AGS_SCOPES.filter((scope) => tool.scopes.includes(scope));
    if (agsScopes.length > 0) {
      claims[LTI_CLAIMS.agsEndpoint] = {
        scope: agsScopes,
        lineitems: f.lineItemsUrl(context, tool.clientId),
        ...(link?.lineItemId === undefined ? {} : { lineitem: link.lineItemId }),
      };
    }
    if (tool.scopes.includes(LTI_SCOPES.contextMembershipReadonly)) {
      claims[LTI_CLAIMS.nrpsService] = { context_memberships_url: f.membershipsUrl(context, tool.clientId), service_versions: ["2.0"] };
    }
    return applyClaimOverrides(claims, launch.overrides);
  }

  #deepLinkSettings(launch: PendingLaunch, context: LtiContextIds): Record<string, unknown> {
    const placement: DeepLinkPlacement = this.flavour.deepLinkPlacement(launch.placement);
    const data = `dl-${randomToken()}`;
    const now = this.now();
    setBounded(this.#deepLinkExpiry, data, now + DEEP_LINK_LIFETIME_MS, MAX_PENDING, (expiresAt) => expiresAt <= now, (old) => this.deepLinkRequests.delete(old));
    const returnUrl = new URL(this.flavour.deepLinkReturnUrl(context, launch.tool.clientId));
    if (this.flavour.deepLinkData === "return-url") returnUrl.searchParams.set("data", data);
    const settings: Record<string, unknown> = {
      deep_link_return_url: returnUrl.toString(),
      accept_types: [...placement.accept_types],
      accept_presentation_document_targets: [...placement.accept_presentation_document_targets],
      ...(placement.accept_media_types === undefined ? {} : { accept_media_types: placement.accept_media_types }),
      accept_multiple: placement.accept_multiple,
      auto_create: placement.auto_create,
      ...(this.flavour.deepLinkData === "claim" ? { data } : {}),
    };
    this.deepLinkRequests.set(data, {
      data,
      clientId: launch.tool.clientId,
      deploymentId: launch.deploymentId,
      sectionId: launch.section.id,
      personId: launch.person.id,
      placement: launch.placement,
      settings,
    });
    return settings;
  }

  #roles(person: PersonSeed, section: SectionSeed, purpose: "launch" | "nrps"): string[] {
    const teaches = section.teacherIds.includes(person.id);
    const learns = section.studentIds.includes(person.id);
    const membership = teaches ? [LIS_ROLES.instructor] : learns ? [LIS_ROLES.learner] : [];
    if (purpose === "nrps") return membership;
    const institution =
      person.role === "student"
        ? [LIS_ROLES.institutionStudent]
        : person.role === "teacher"
          ? [LIS_ROLES.institutionInstructor]
          : person.role === "administrator"
            ? [LIS_ROLES.institutionAdministrator]
            : person.role === "staff"
              ? [LIS_ROLES.institutionStaff]
              : [LIS_ROLES.institutionMentor];
    const system = person.role === "administrator" ? [LIS_ROLES.systemAdministrator] : [LIS_ROLES.systemUser];
    return [...institution, ...membership, ...system];
  }

  #personClaims(tool: LtiTool, person: PersonSeed): Record<string, unknown> {
    const named = tool.privacyLevel === "name_only" || tool.privacyLevel === "public";
    const mailed = tool.privacyLevel === "email_only" || tool.privacyLevel === "public";
    return {
      ...(named
        ? {
            name: `${person.givenName} ${person.familyName}`,
            given_name: person.givenName,
            family_name: person.familyName,
            ...(person.localId === undefined ? {} : { [LTI_CLAIMS.lis]: { person_sourcedid: person.localId } }),
          }
        : {}),
      ...(mailed ? { email: person.email } : {}),
    };
  }

  // ── OAuth 2 ──────────────────────────────────────────────────────

  async #token(request: Request, body: string): Promise<Response> {
    if (mediaTypeOf(request) !== "application/x-www-form-urlencoded") return oauthError("invalid_request", "Expected a form body.");
    const form = formOf(body);
    if (form.get("grant_type") !== "client_credentials") return oauthError("unsupported_grant_type", "Only client_credentials is supported.");
    if (form.get("client_assertion_type") !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer") {
      return oauthError("invalid_request", "client_assertion_type must be urn:ietf:params:oauth:client-assertion-type:jwt-bearer.");
    }
    const assertion = form.get("client_assertion") ?? "";
    let clientId: unknown;
    try {
      clientId = decodeJwt(assertion).iss;
    } catch {
      return oauthError("invalid_request", "client_assertion is not a JWT.");
    }
    const tool = typeof clientId === "string" ? this.tools.get(clientId) : undefined;
    if (tool === undefined) return oauthError("invalid_client", "Unknown client.", 401);
    let payload: JWTPayload;
    try {
      payload = await this.#verifyFromTool(tool, assertion, {
        algorithms: ["RS256"],
        issuer: tool.clientId,
        subject: tool.clientId,
        audience: this.flavour.tokenEndpoint,
        currentDate: new Date(this.now()),
        requiredClaims: ["exp", "iat", "jti"],
      });
    } catch {
      return oauthError("invalid_client", "The client assertion could not be verified.", 401);
    }
    if (this.#usedJtis.has(payload.jti!)) return oauthError("invalid_grant", "The client assertion's jti has already been used.");
    this.#usedJtis.add(payload.jti!);
    const requested = (form.get("scope") ?? "").split(" ").filter((scope) => scope.length > 0);
    const granted = requested.filter((scope) => tool.scopes.includes(scope));
    if (granted.length === 0) return oauthError("invalid_scope", "None of the requested scopes is allowed for this client.");
    const accessToken = this.#tokens.issue({ clientId: tool.clientId, scopes: granted }, this.#tokenLifetime);
    return Response.json(
      { access_token: accessToken, token_type: "Bearer", expires_in: this.#tokenLifetime, scope: granted.join(" ") },
      { headers: { "cache-control": "no-store" } },
    );
  }

  /**
   * Verifies a JWT the tool signed. A JWKS fetched from the tool's URL is reused for a few minutes
   * rather than fetched per request; a signature by a key it lacks (the tool rotated) refetches it,
   * at most once per cooldown.
   */
  async #verifyFromTool(tool: LtiTool, jwt: string, options: JWTVerifyOptions): Promise<JWTPayload> {
    const { jwks, cached } = await this.#toolJwks(tool, false);
    try {
      return (await jwtVerify(jwt, createLocalJWKSet(jwks), options)).payload;
    } catch (error) {
      const entry = this.#toolKeys.get(tool.clientId);
      if (!cached || !(error instanceof joseErrors.JWKSNoMatchingKey) || entry === undefined || this.now() - entry.fetchedAt < TOOL_JWKS_COOLDOWN_MS) throw error;
      return (await jwtVerify(jwt, createLocalJWKSet((await this.#toolJwks(tool, true)).jwks), options)).payload;
    }
  }

  async #toolJwks(tool: LtiTool, refresh: boolean): Promise<{ jwks: JwksDocument; cached: boolean }> {
    if (tool.jwks !== undefined) return { jwks: await tool.jwks(), cached: false };
    if (tool.jwksUri === undefined || this.#fetch === undefined) throw new Error("the tool has no keys the platform can reach");
    const entry = this.#toolKeys.get(tool.clientId);
    if (!refresh && entry !== undefined && entry.uri === tool.jwksUri && this.now() - entry.fetchedAt < TOOL_JWKS_TTL_MS) return { jwks: entry.jwks, cached: true };
    const response = await this.#fetch(tool.jwksUri, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`tool JWKS answered ${response.status}`);
    const jwks = (await response.json()) as JwksDocument;
    this.#toolKeys.set(tool.clientId, { uri: tool.jwksUri, jwks, fetchedAt: this.now() });
    return { jwks, cached: false };
  }

  /** Runs `respond` for the service match whose tool the bearer token belongs to, after a scope check. */
  async #service(request: Request, matches: readonly ServiceMatch[], anyOf: readonly string[], respond: (match: ServiceMatch) => Response | Promise<Response>): Promise<Response> {
    const grant = this.#tokens.lookup(bearer(request));
    if (grant === undefined) return this.flavour.serviceError(401, bearer(request) === undefined ? "Missing access token" : "Invalid access token");
    const match = matches.find((m) => m.tool.clientId === grant.clientId);
    if (match === undefined) return this.flavour.serviceError(401, "Access Token not linked to a Tool associated with this Context");
    if (!anyOf.some((scope) => grant.scopes.includes(scope))) return this.flavour.serviceError(this.flavour.insufficientScopeStatus, "Insufficient permissions");
    return respond(match);
  }

  /**
   * The tools × sections whose service base of `kind` is `here` (exact) or a prefix of it (AGS,
   * whose line items and their scores and results live below the container). Looked up in an index
   * of every tool × section's bases, so a request costs a few map reads, not a scan of them all.
   */
  #match(here: string, kind: keyof ServiceIndex): ServiceMatch[] {
    const index = (this.#index ??= this.#buildIndex())[kind];
    const exact = index.get(here);
    if (exact !== undefined) return exact.map((m) => ({ ...m, rest: "" }));
    if (kind !== "ags") return [];
    // A line item is `<container>/<id>`, its scores and results one segment further down.
    for (let cut = here.lastIndexOf("/"), depth = 0; cut > 0 && depth < 2; cut = here.lastIndexOf("/", cut - 1), depth++) {
      const found = index.get(here.slice(0, cut));
      if (found !== undefined) return found.map((m) => ({ ...m, rest: here.slice(cut) }));
    }
    return [];
  }

  #buildIndex(): ServiceIndex {
    const index: ServiceIndex = { deepLink: new Map(), nrps: new Map(), ags: new Map() };
    const add = (map: Map<string, ServiceMatch[]>, url: string, match: ServiceMatch) => {
      const list = map.get(url);
      if (list === undefined) map.set(url, [match]);
      else list.push(match);
    };
    for (const tool of this.tools.values()) {
      for (const section of this.#seed.sections) {
        const context = this.flavour.contextIds(section);
        const match = { tool, section, context, rest: "" };
        add(index.deepLink, this.flavour.deepLinkReturnUrl(context, tool.clientId), match);
        add(index.nrps, this.flavour.membershipsUrl(context, tool.clientId), match);
        add(index.ags, this.flavour.lineItemsUrl(context, tool.clientId), match);
      }
    }
    return index;
  }

  // ── NRPS ─────────────────────────────────────────────────────────

  #memberships(request: Request, url: URL, match: ServiceMatch): Response {
    const { section, context, tool } = match;
    const role = url.searchParams.get("role");
    const enrollments = enrollmentsOf(this.#seed).filter((e) => e.section.id === section.id);
    let members = enrollments.flatMap((enrollment) => {
      const person = this.#person(enrollment.personId);
      return person === undefined ? [] : [this.#member(tool, person, section)];
    });
    if (role !== null) members = members.filter((member) => roleMatches(member.roles as string[], role));
    const { slice, links } = this.#page(members, url, this.flavour.nrpsLimits);
    const page = slice.map((member) => ({ ...member }));
    if (page.length > 0 && this.takeMalformed(request)) delete (page[0] as Record<string, unknown>).user_id;
    const course = this.#seed.courses.find((c) => c.id === section.courseId);
    return mediaJson(
      { id: url.toString(), context: { id: context.contextId, ...(course?.courseCode === undefined ? {} : { label: course.courseCode }), title: section.title }, members: page },
      LTI_MEDIA_TYPES.membershipContainer,
      200,
      links === undefined ? {} : { link: links },
    );
  }

  #member(tool: LtiTool, person: PersonSeed, section: SectionSeed): Record<string, unknown> {
    const user = this.flavour.userIds(person);
    const claims = this.#personClaims(tool, person);
    const lis = claims[LTI_CLAIMS.lis] as { person_sourcedid?: string } | undefined;
    delete claims[LTI_CLAIMS.lis];
    return {
      status: "Active",
      ...claims,
      ...(lis?.person_sourcedid === undefined ? {} : { lis_person_sourcedid: lis.person_sourcedid }),
      user_id: user.sub,
      ...(user.legacyUserId === undefined ? {} : { lti11_legacy_user_id: user.legacyUserId }),
      roles: this.#roles(person, section, "nrps"),
    };
  }

  /** A page of `items` by the `limit` and `page` parameters, and its RFC 8288 Link header. */
  #page<T>(items: readonly T[], url: URL, limits: { default: number; max: number }): { slice: T[]; links: string | undefined } {
    const asked = Number(url.searchParams.get("limit"));
    const limit = Number.isInteger(asked) && asked > 0 ? Math.min(asked, limits.max) : limits.default;
    const askedPage = Number(url.searchParams.get("page") ?? "1");
    const page = Number.isInteger(askedPage) && askedPage > 0 ? askedPage : 1;
    const slice = items.slice((page - 1) * limit, page * limit);
    const last = Math.max(1, Math.ceil(items.length / limit));
    const at = (n: number) => {
      const next = new URL(url);
      next.searchParams.set("page", String(n));
      next.searchParams.set("limit", String(limit));
      return next.toString();
    };
    if (last === 1 && page === 1) return { slice, links: undefined };
    const rels = [`<${at(page)}>; rel="current"`];
    if (page < last) rels.push(`<${at(page + 1)}>; rel="next"`);
    if (page > 1) rels.push(`<${at(page - 1)}>; rel="prev"`);
    rels.push(`<${at(1)}>; rel="first"`, `<${at(last)}>; rel="last"`);
    return { slice, links: rels.join(", ") };
  }

  // ── AGS ──────────────────────────────────────────────────────────

  async #ags(request: Request, url: URL, body: string, matches: ServiceMatch[]): Promise<Response> {
    const rest = matches[0]!.rest;
    const read = [LTI_SCOPES.lineItem, LTI_SCOPES.lineItemReadonly];
    if (rest === "") {
      if (request.method === "GET") return this.#service(request, matches, read, (m) => this.#listLineItems(request, url, m));
      if (request.method === "POST") return this.#service(request, matches, [LTI_SCOPES.lineItem], (m) => this.#createLineItem(request, body, m));
      return this.flavour.serviceError(405, "Method not allowed");
    }
    const item = /^\/([^/]+)(\/scores|\/results)?$/.exec(rest);
    if (item === null) return this.flavour.serviceError(404, "The specified resource does not exist.");
    const find = (m: ServiceMatch) => {
      const stored = this.#lineItems.get(`${this.flavour.lineItemsUrl(m.context, m.tool.clientId)}/${item[1]}`);
      return stored !== undefined && stored.clientId === m.tool.clientId ? stored : undefined;
    };
    const notFound = () => this.flavour.serviceError(404, "The specified LTI line item does not exist.");
    if (item[2] === "/scores") {
      if (request.method !== "POST") return this.flavour.serviceError(405, "Method not allowed");
      return this.#service(request, matches, [LTI_SCOPES.score], (m) => {
        const stored = find(m);
        return stored === undefined ? notFound() : this.#postScore(request, body, m, stored);
      });
    }
    if (item[2] === "/results") {
      if (request.method !== "GET") return this.flavour.serviceError(405, "Method not allowed");
      return this.#service(request, matches, [LTI_SCOPES.resultReadonly], (m) => {
        const stored = find(m);
        if (stored === undefined) return notFound();
        const userId = url.searchParams.get("user_id");
        const results = [...stored.results.values()].map((r) => r.result).filter((r) => userId === null || r.userId === userId);
        const { slice, links } = this.#page(results, url, this.flavour.agsLimits);
        return mediaJson(slice, LTI_MEDIA_TYPES.resultContainer, 200, links === undefined ? {} : { link: links });
      });
    }
    if (request.method === "GET") {
      return this.#service(request, matches, read, (m) => {
        const stored = find(m);
        return stored === undefined ? notFound() : mediaJson(stored.item, LTI_MEDIA_TYPES.lineItem);
      });
    }
    if (request.method === "PUT") {
      return this.#service(request, matches, [LTI_SCOPES.lineItem], (m) => {
        const stored = find(m);
        if (stored === undefined) return notFound();
        const parsed = this.#lineItemBody(request, body, LTI_MEDIA_TYPES.lineItem);
        if (parsed instanceof Response) return parsed;
        if (parsed.id !== undefined && parsed.id !== stored.item.id) return this.flavour.serviceError(400, "The line item id does not match the URL.");
        const { id: _ignored, ...fields } = parsed;
        const updated: LtiLineItem = { id: stored.item.id, ...fields, ...(stored.item.resourceLinkId === undefined ? {} : { resourceLinkId: stored.item.resourceLinkId }) };
        this.#lineItems.set(stored.item.id, { ...stored, item: updated });
        return mediaJson(updated, LTI_MEDIA_TYPES.lineItem);
      });
    }
    if (request.method === "DELETE") {
      return this.#service(request, matches, [LTI_SCOPES.lineItem], (m) => {
        const stored = find(m);
        if (stored === undefined) return notFound();
        this.#lineItems.delete(stored.item.id);
        return new Response(null, { status: 204 });
      });
    }
    return this.flavour.serviceError(405, "Method not allowed");
  }

  #listLineItems(request: Request, url: URL, match: ServiceMatch): Response {
    const filters = { resourceLinkId: url.searchParams.get("resource_link_id"), resourceId: url.searchParams.get("resource_id"), tag: url.searchParams.get("tag") };
    const items = this.lineItemsOf(match.tool.clientId, match.section.id).filter(
      (item) =>
        (filters.resourceLinkId === null || item.resourceLinkId === filters.resourceLinkId) &&
        (filters.resourceId === null || item.resourceId === filters.resourceId) &&
        (filters.tag === null || item.tag === filters.tag),
    );
    const { slice, links } = this.#page(items, url, this.flavour.agsLimits);
    if (slice.length > 0 && this.takeMalformed(request)) delete (slice[0] as Partial<LtiLineItem>).scoreMaximum;
    return mediaJson(slice, LTI_MEDIA_TYPES.lineItemContainer, 200, links === undefined ? {} : { link: links });
  }

  #createLineItem(request: Request, body: string, match: ServiceMatch): Response {
    const parsed = this.#lineItemBody(request, body, LTI_MEDIA_TYPES.lineItem);
    if (parsed instanceof Response) return parsed;
    const { id: _ignored, ...fields } = parsed;
    if (fields.resourceLinkId !== undefined) {
      const link = this.resourceLinks.get(fields.resourceLinkId);
      if (link === undefined || link.sectionId !== match.section.id || link.clientId !== match.tool.clientId) {
        return this.flavour.serviceError(404, "The specified resource link does not exist.");
      }
    }
    const stored = this.#storeLineItem(match.tool, match.section.id, fields);
    return mediaJson(stored.item, LTI_MEDIA_TYPES.lineItem, 201);
  }

  /** Parses and checks a line item body (AGS 2.0 §3.2.3). */
  #lineItemBody(request: Request, body: string, mediaType: string): Response | (Omit<LtiLineItem, "id"> & { id?: string }) {
    const type = mediaTypeOf(request);
    if (type !== mediaType && type !== "application/json") return this.flavour.serviceError(415, `Content-Type must be ${mediaType}`);
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      return this.flavour.serviceError(400, "The body is not JSON.");
    }
    if (!isRecord(value)) return this.flavour.serviceError(400, "The body must be a line item.");
    const problems: string[] = [];
    if (typeof value.label !== "string" || value.label.length === 0) problems.push("label is required");
    if (typeof value.scoreMaximum !== "number" || !(value.scoreMaximum > 0) || !Number.isFinite(value.scoreMaximum)) problems.push("scoreMaximum must be a positive number");
    for (const name of ["resourceLinkId", "resourceId", "tag", "id"] as const) {
      if (value[name] !== undefined && typeof value[name] !== "string") problems.push(`${name} must be a string`);
    }
    for (const name of ["startDateTime", "endDateTime"] as const) {
      if (value[name] !== undefined && (typeof value[name] !== "string" || !ISO_8601.test(value[name]))) problems.push(`${name} must be an ISO 8601 date-time`);
    }
    if (value.gradesReleased !== undefined && typeof value.gradesReleased !== "boolean") problems.push("gradesReleased must be a boolean");
    if (problems.length > 0) return this.flavour.serviceError(400, problems.join("; "));
    const pick = <K extends string>(name: K) => (value[name] === undefined ? {} : { [name]: value[name] });
    return {
      label: value.label as string,
      scoreMaximum: value.scoreMaximum as number,
      ...pick("id"),
      ...pick("resourceLinkId"),
      ...pick("resourceId"),
      ...pick("tag"),
      ...pick("startDateTime"),
      ...pick("endDateTime"),
      ...pick("gradesReleased"),
    } as Omit<LtiLineItem, "id"> & { id?: string };
  }

  #storeLineItem(tool: LtiTool, sectionId: string, fields: Omit<LtiLineItem, "id">): StoredLineItem {
    const context = this.flavour.contextIds(this.#section(sectionId));
    const id = `${this.flavour.lineItemsUrl(context, tool.clientId)}/${++this.#lineItemCount}`;
    const stored: StoredLineItem = { item: { id, ...fields }, sectionId, clientId: tool.clientId, results: new Map() };
    this.#lineItems.set(id, stored);
    return stored;
  }

  /** Accepts a score (AGS 2.0 §3.4): checks its media type and shape, and updates the result. */
  #postScore(request: Request, body: string, match: ServiceMatch, stored: StoredLineItem): Response {
    if (mediaTypeOf(request) !== LTI_MEDIA_TYPES.score) return this.flavour.serviceError(415, `Content-Type must be ${LTI_MEDIA_TYPES.score}`);
    let score: unknown;
    try {
      score = JSON.parse(body);
    } catch {
      return this.flavour.serviceError(400, "The body is not JSON.");
    }
    if (!isRecord(score)) return this.flavour.serviceError(400, "The body must be a score.");
    const problems: string[] = [];
    if (typeof score.userId !== "string" || score.userId.length === 0) problems.push("userId is required");
    if (typeof score.activityProgress !== "string" || !SCORE_ACTIVITY.has(score.activityProgress)) problems.push("activityProgress is invalid");
    if (typeof score.gradingProgress !== "string" || !SCORE_GRADING.has(score.gradingProgress)) problems.push("gradingProgress is invalid");
    if (typeof score.timestamp !== "string" || !ISO_8601.test(score.timestamp)) problems.push(`Provided timestamp of ${String(score.timestamp)} not a valid timestamp`);
    if (score.scoreGiven !== undefined) {
      if (typeof score.scoreGiven !== "number" || !Number.isFinite(score.scoreGiven) || score.scoreGiven < 0) problems.push("scoreGiven must be a non-negative number");
      if (typeof score.scoreMaximum !== "number" || !(score.scoreMaximum > 0)) problems.push("scoreMaximum is required with scoreGiven");
    }
    if (score.comment !== undefined && typeof score.comment !== "string") problems.push("comment must be a string");
    if (problems.length > 0) return this.flavour.serviceError(400, problems.join("; "));
    const userId = score.userId as string;
    const student = match.section.studentIds.map((id) => this.#person(id)).find((p) => p !== undefined && this.flavour.userIds(p).sub === userId);
    if (student === undefined) return this.flavour.serviceError(422, "User not found in course or is not a student");
    const timestamp = Date.parse(score.timestamp as string);
    const previous = stored.results.get(userId);
    if (previous !== undefined && previous.timestamp > timestamp) {
      return this.flavour.serviceError(400, `Provided timestamp of ${String(score.timestamp)} before last updated timestamp`);
    }
    const graded = score.gradingProgress === "FullyGraded" || score.gradingProgress === "PendingManual";
    // A score without scoreGiven clears the result: AGS 2.0 reads a missing scoreGiven as no score,
    // and Canvas then clears the submission's grade (from its scores controller; not verified
    // against a live Canvas). One with scoreGiven that is not yet graded keeps the previous result.
    const resultScore =
      typeof score.scoreGiven !== "number"
        ? undefined
        : graded
          ? (score.scoreGiven * stored.item.scoreMaximum) / (score.scoreMaximum as number)
          : previous?.result.resultScore;
    const result: LtiResult = {
      id: `${stored.item.id}/results/${userId}`,
      scoreOf: stored.item.id,
      userId,
      ...(resultScore === undefined ? {} : { resultScore }),
      resultMaximum: stored.item.scoreMaximum,
      ...(typeof score.comment === "string" ? { comment: score.comment } : {}),
    };
    stored.results.set(userId, { result, timestamp });
    this.scores.push({ lineItem: stored.item.id, score });
    return this.flavour.scoreAnswer === "result-url" ? mediaJson({ resultUrl: result.id }, LTI_MEDIA_TYPES.score) : new Response(null, { status: 201 });
  }

  // ── Deep Linking ─────────────────────────────────────────────────

  /** Verifies a Deep Linking response (Deep Linking 2.0 §4.5) and places what it carries. */
  async #deepLinkReturn(url: URL, body: string, matches: readonly ServiceMatch[]): Promise<Response> {
    const fail = (message: string) => this.flavour.serviceError(400, message);
    const jwt = formOf(body).get("JWT");
    if (jwt === null || jwt.length === 0) return fail("JWT is required");
    let header: ReturnType<typeof decodeProtectedHeader>;
    let unverified: JWTPayload;
    try {
      header = decodeProtectedHeader(jwt);
      unverified = decodeJwt(jwt);
    } catch {
      return fail("JWT format is invalid");
    }
    if (header.alg !== "RS256") return fail("JWT has unexpected alg");
    const tool = typeof unverified.iss === "string" ? this.tools.get(unverified.iss) : undefined;
    if (tool === undefined) return fail("Client not found");
    let payload: JWTPayload;
    try {
      payload = await this.#verifyFromTool(tool, jwt, {
        algorithms: ["RS256"],
        issuer: tool.clientId,
        audience: this.issuer,
        currentDate: new Date(this.now()),
        requiredClaims: ["iat", "exp", "nonce"],
      });
    } catch {
      return fail("JWT verification failure");
    }
    if (payload[LTI_CLAIMS.messageType] !== "LtiDeepLinkingResponse") return fail("message_type must be LtiDeepLinkingResponse");
    if (payload[LTI_CLAIMS.version] !== LTI_VERSION) return fail("version must be 1.3.0");
    const data = this.flavour.deepLinkData === "return-url" ? url.searchParams.get("data") : payload[LTI_CLAIMS.data];
    const request = typeof data === "string" ? this.deepLinkRequests.get(data) : undefined;
    if (request === undefined || request.clientId !== tool.clientId) return fail("data does not match a deep linking request");
    // The response must come back to the return URL of the course the request was issued in: a
    // response posted to another course's URL would place content where the teacher never chose.
    if (!matches.some((m) => m.section.id === request.sectionId && m.tool.clientId === tool.clientId)) {
      return fail("data does not match this course's deep linking request");
    }
    if (payload[LTI_CLAIMS.deploymentId] !== request.deploymentId) return fail("deployment_id does not match the request");
    const nonce = String(payload.nonce);
    if (this.#usedDeepLinkNonces.has(nonce)) return fail("nonce has already been used");
    this.#usedDeepLinkNonces.add(nonce);

    const raw = payload[LTI_CLAIMS.contentItems] ?? [];
    if (!Array.isArray(raw) || !raw.every(isRecord)) return fail("content_items must be an array of objects");
    const items = raw as Record<string, unknown>[];
    const accept = request.settings.accept_types as string[];
    if (items.length > 1 && request.settings.accept_multiple !== true) return fail("This placement accepts one content item");
    const problems: string[] = [];
    items.forEach((item, i) => {
      if (typeof item.type !== "string" || !accept.includes(item.type)) problems.push(`content_items[${i}].type ${String(item.type)} is not accepted`);
      if (item.url !== undefined && !httpsUrl(item.url)) problems.push(`content_items[${i}].url must be an https URL`);
      if (item.type === "link" && item.url === undefined) problems.push(`content_items[${i}].url is required`);
      if (item.custom !== undefined && stringMap(item.custom) === undefined) problems.push(`content_items[${i}].custom must map strings to strings`);
      if (item.lineItem !== undefined && (!isRecord(item.lineItem) || typeof item.lineItem.scoreMaximum !== "number" || !(item.lineItem.scoreMaximum > 0))) {
        problems.push(`content_items[${i}].lineItem.scoreMaximum must be a positive number`);
      }
    });
    if (problems.length > 0) return fail(problems.join("; "));

    const section = this.#section(request.sectionId);
    const links: LtiResourceLink[] = [];
    for (const item of items.filter((i) => i.type === "ltiResourceLink")) {
      const id = this.flavour.resourceLinkId(section, ++this.#links);
      const title = typeof item.title === "string" ? item.title : tool.name;
      let lineItemId: string | undefined;
      if (isRecord(item.lineItem)) {
        const li = item.lineItem;
        lineItemId = this.#storeLineItem(tool, section.id, {
          label: typeof li.label === "string" ? li.label : title,
          scoreMaximum: li.scoreMaximum as number,
          resourceLinkId: id,
          ...(typeof li.resourceId === "string" ? { resourceId: li.resourceId } : {}),
          ...(typeof li.tag === "string" ? { tag: li.tag } : {}),
        }).item.id;
      }
      const link: LtiResourceLink = {
        id,
        sectionId: section.id,
        clientId: tool.clientId,
        title,
        ...(typeof item.text === "string" ? { text: item.text } : {}),
        ...(typeof item.url === "string" ? { url: item.url } : {}),
        custom: stringMap(item.custom) ?? {},
        ...(lineItemId === undefined ? {} : { lineItemId }),
        createdBy: "deep-linking",
      };
      this.resourceLinks.set(id, link);
      links.push(link);
    }
    const message = payload[LTI_CLAIMS.message];
    const errorMessage = payload[LTI_CLAIMS.errorMessage];
    this.deepLinkResults.push({
      request,
      contentItems: items,
      links,
      ...(typeof message === "string" ? { message } : {}),
      ...(typeof errorMessage === "string" ? { errorMessage } : {}),
    });
    return new Response(
      `<!doctype html><html><head><meta charset="utf-8"><title>Content added</title></head><body><p>${links.length} item(s) added.</p></body></html>`,
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }

  // ── Dynamic Registration ─────────────────────────────────────────

  #openidConfiguration(url: URL): Response {
    // Canvas reads the token from the query string only (`security_controller.rb`).
    const token = url.searchParams.get("registration_token");
    if (token === null) return Response.json({ error: "Access token missing (You must include the registration_token parameter)." }, { status: 401 });
    if (this.#registrationTokens.lookup(token) === undefined) return Response.json({ error: "Invalid registration_token." }, { status: 401 });
    const f = this.flavour;
    return Response.json({
      issuer: f.issuer,
      authorization_endpoint: f.authorizationEndpoint,
      registration_endpoint: f.registrationEndpoint,
      jwks_uri: f.jwksUri,
      token_endpoint: f.tokenEndpoint,
      token_endpoint_auth_methods_supported: ["private_key_jwt"],
      token_endpoint_auth_signing_alg_values_supported: ["RS256"],
      scopes_supported: ["openid", ...ALL_LTI_SCOPES],
      response_types_supported: ["id_token"],
      id_token_signing_alg_values_supported: ["RS256"],
      claims_supported: ["sub", "picture", "email", "name", "given_name", "family_name", "locale"],
      subject_types_supported: ["public"],
      authorization_server: new URL(f.tokenEndpoint).host,
      "https://purl.imsglobal.org/spec/lti-platform-configuration": {
        product_family_code: f.productFamilyCode,
        version: "OpenSource",
        messages_supported: [
          { type: "LtiResourceLinkRequest", placements: CANVAS_PLACEMENTS.LtiResourceLinkRequest },
          { type: "LtiDeepLinkingRequest", placements: CANVAS_PLACEMENTS.LtiDeepLinkingRequest },
        ],
        variables: CANVAS_VARIABLES,
        "https://canvas.instructure.com/lti/account_name": this.#seed.name,
        "https://canvas.instructure.com/lti/account_lti_guid": `${hexId("canvas:account", this.#seed.id, 40)}:canvas-lms`,
        "https://canvas.instructure.com/lti/account_domain": new URL(f.returnUrl({ contextId: "", serviceId: "0" })).host,
      },
    });
  }

  /** The client registration request (§3.5) and its answer (§3.6), as Canvas validates and renders them. */
  #register(request: Request, body: string): Response {
    const token = bearer(request);
    if (token === undefined || this.#registrationTokens.lookup(token) === undefined) {
      return Response.json({ errorMessage: "JWT did not include expected contents" }, { status: 401 });
    }
    let metadata: unknown;
    try {
      metadata = JSON.parse(body);
    } catch {
      return Response.json({ errors: [{ message: "The body is not JSON." }] }, { status: 422 });
    }
    if (!isRecord(metadata)) return Response.json({ errors: [{ message: "The body must be client metadata." }] }, { status: 422 });
    const config = metadata["https://purl.imsglobal.org/spec/lti-tool-configuration"];
    const errors: string[] = [];
    const strings = (value: unknown) => Array.isArray(value) && value.every((v) => typeof v === "string");
    if (metadata.application_type !== "web") errors.push("application_type must be web");
    if (!strings(metadata.grant_types) || !(["implicit", "client_credentials"] as const).every((g) => (metadata.grant_types as string[]).includes(g))) {
      errors.push("grant_types must include implicit and client_credentials");
    }
    if (!strings(metadata.response_types) || !(metadata.response_types as string[]).includes("id_token")) errors.push("response_types must include id_token");
    if (!httpsUrl(metadata.initiate_login_uri)) errors.push("initiate_login_uri must be an https URL");
    if (!strings(metadata.redirect_uris) || (metadata.redirect_uris as string[]).length === 0 || !(metadata.redirect_uris as string[]).every(httpsUrl)) {
      errors.push("redirect_uris must be https URLs");
    }
    if (!httpsUrl(metadata.jwks_uri)) errors.push("jwks_uri must be an https URL");
    if (metadata.token_endpoint_auth_method !== "private_key_jwt") errors.push("token_endpoint_auth_method must be private_key_jwt");
    if (typeof metadata.client_name !== "string" || metadata.client_name.length === 0) errors.push("client_name is required");
    if (metadata.scope !== undefined && typeof metadata.scope !== "string") errors.push("scope must be a string");
    if (!isRecord(config)) errors.push("https://purl.imsglobal.org/spec/lti-tool-configuration is required");
    else {
      if (typeof config.domain !== "string" || config.domain.length === 0) errors.push("lti-tool-configuration.domain is required");
      if (config.target_link_uri !== undefined && !httpsUrl(config.target_link_uri)) errors.push("lti-tool-configuration.target_link_uri must be an https URL");
      if (config.claims !== undefined && !strings(config.claims)) errors.push("lti-tool-configuration.claims must be strings");
      if (config.messages !== undefined && (!Array.isArray(config.messages) || !config.messages.every((m) => isRecord(m) && typeof m.type === "string"))) {
        errors.push("lti-tool-configuration.messages must name their types");
      }
    }
    if (errors.length > 0) return Response.json({ errors: errors.map((message) => ({ message })) }, { status: 422 });
    // A registration token registers one tool: spent here, before anything else can await.
    this.#registrationTokens.revoke(token);
    const toolConfig = config as Record<string, unknown>;
    const requested = typeof metadata.scope === "string" ? metadata.scope.split(" ").filter((s) => s.length > 0) : [];
    const privacy = toolConfig["https://canvas.instructure.com/lti/privacy_level"];
    const tool = this.registerTool({
      name: metadata.client_name as string,
      initiateLoginUri: metadata.initiate_login_uri as string,
      redirectUris: metadata.redirect_uris as string[],
      ...(typeof toolConfig.target_link_uri === "string" ? { targetLinkUri: toolConfig.target_link_uri } : {}),
      jwksUri: metadata.jwks_uri as string,
      scopes: requested.filter((scope) => ALL_LTI_SCOPES.includes(scope)),
      ...(stringMap(toolConfig.custom_parameters) === undefined ? {} : { custom: stringMap(toolConfig.custom_parameters)! }),
      privacyLevel: privacy === "public" || privacy === "name_only" || privacy === "email_only" ? privacy : "anonymous",
    });
    this.dynamicRegistrations.push({ tool, metadata });
    const deploymentId = tool.deploymentIds[0]!;
    const topLevel = this.#registrationDeploymentId === "top-level";
    return Response.json({
      client_id: tool.clientId,
      application_type: "web",
      grant_types: ["client_credentials", "implicit"],
      initiate_login_uri: tool.initiateLoginUri,
      redirect_uris: tool.redirectUris,
      response_types: ["id_token"],
      client_name: tool.name,
      jwks_uri: tool.jwksUri,
      token_endpoint_auth_method: "private_key_jwt",
      scope: [...tool.scopes, "openid"].join(" "),
      "https://purl.imsglobal.org/spec/lti-tool-configuration": {
        ...toolConfig,
        ...(topLevel ? {} : { deployment_id: deploymentId }),
        "https://canvas.instructure.com/lti/registration_config_url": `${this.flavour.registrationEndpoint}/${tool.clientId}/view`,
      },
      registration_client_uri: `${this.flavour.registrationEndpoint}/${tool.clientId}`,
      ...(topLevel ? { deployment_id: deploymentId } : {}),
    });
  }

  // ── Lookups ──────────────────────────────────────────────────────

  #tool(clientId: string): LtiTool {
    const tool = this.tools.get(clientId);
    if (tool === undefined) throw new Error(`no tool ${clientId}`);
    return tool;
  }

  #defaultTool(): LtiTool {
    const first = this.tools.values().next();
    if (first.done === true) throw new Error("no tool is registered");
    return first.value;
  }

  #section(id: string): SectionSeed {
    const section = this.#seed.sections.find((s) => s.id === id);
    if (section === undefined) throw new Error(`no section ${id}`);
    return section;
  }

  #person(id: string): PersonSeed | undefined {
    return this.#seed.people.find((p) => p.id === id);
  }
}
