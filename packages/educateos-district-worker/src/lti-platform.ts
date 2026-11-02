// EducateOS as an LTI 1.3 Platform (SCHO-179, IF-10): the district hosting third-party tools. It is
// served beside the district's LTI Tool (lti.ts), under `/lti/platform/`, and only when the
// deployment turns it on (`LTI_PLATFORM=on`); off, every platform path is 404 and its
// administrators' routes do not exist. Like lti.ts it imports nothing Workers-only (ADR-0009).
//
// Its public endpoints are under the Access-exempt `/lti/` paths: `GET /lti/platform/jwks` and
// `POST /lti/platform/token`, which tools call from their own servers (the token endpoint
// authenticates a tool by a client assertion signed with its registered keys), and
// `/lti/platform/auth`, the OIDC authorization endpoint a tool sends the browser back to during a
// launch, and the LTI Advantage services tools call with a service token: the membership service
// (NRPS, lti-platform-nrps.ts) and the Assignment and Grade Services under `/lti/platform/ags/`
// (lti-platform-ags.ts). Its `/api/lti/` routes, behind Access and decided
// by the policy engine, rotate the platform's keys, register, deploy and revoke third-party tools,
// start a launch for a signed-in person in an offering they are enrolled in, and let a teacher
// approve or decline the scores tools send.
//
// A launch (see docs/educateos/lti.md): `POST /api/lti/platform-launches` mints a single-use ticket
// and sets a cookie only the starting browser holds, then the browser goes to the tool's login
// initiation URL; the tool's authentication request comes back to `/lti/platform/auth` with that
// cookie, and is answered with a page that posts the signed id_token to the tool's registered
// redirect URI. A refused request is answered on EducateOS, never redirected to the tool.
import { ERROR_STATUS } from "@educateos/academics";
import { EducateOsError, type Caller, type DistrictDirectorySnapshot, type DistrictId, type Authorizer } from "@educateos/contracts";
import { PlatformJwksCache, PlatformTokenEndpoint, randomToken, type PlatformServiceGrant } from "@educateos/lti";
import {
  LtiPlatformKeyService,
  LtiPlatformLaunchService,
  LtiPlatformToolService,
  PLATFORM_LAUNCH_TICKET_TTL_MS,
  type LtiDistrictStores,
  type PlatformLaunchForm,
} from "@educateos/lti-district";
import type { PolicyDecider } from "@educateos/policy";
import { createLogger } from "@gadgets/observability/logger";
import { startPlatformAgs } from "./lti-platform-ags.ts";
import { startPlatformNrps } from "./lti-platform-nrps.ts";

/** What the platform logs beside each event: never a token, ticket, cookie or body. */
interface PlatformLogFields {
  districtId: string;
  /** The refusal's error code. */
  code?: string;
  toolId?: string;
  oauthError?: string;
  scopes?: number;
}

const logger = createLogger<PlatformLogFields>({ component: "educateos.lti.platform" });

/** The path prefix of the platform's public endpoints. */
export const LTI_PLATFORM_PREFIX = "/lti/platform/";

/**
 * Whether `LTI_PLATFORM` turns the platform on. Only the exact value `on` does: unset, empty or
 * anything else leaves it off, which is what every production configuration does until a live
 * enablement.
 */
export function ltiPlatformEnabled(setting: string | undefined): boolean {
  return setting === "on";
}

/**
 * The cookie that binds a launch to the browser that started it. It is sent only to the platform's
 * public endpoints, and cross-site, because the tool's authentication request reaches
 * `/lti/platform/auth` as a top-level navigation (a redirect, or a form post) from the tool's site.
 */
export const LTI_LAUNCH_COOKIE = "__Secure-educateos-lti-launch";

const LAUNCH_COOKIE_ATTRIBUTES = `Path=${LTI_PLATFORM_PREFIX}; Secure; HttpOnly; SameSite=None`;

/**
 * One signed-in route, as lti.ts serves them under `/api/lti/`. Its result is sent as JSON, unless
 * it is already a `Response`.
 */
export interface LtiAdminRoute {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly run: (caller: Caller, request: Request, params: Record<string, string>) => Promise<unknown>;
}

/** The district's LTI Platform: its public endpoints and its signed-in routes. */
export interface DistrictLtiPlatform {
  /** Serves a path under {@link LTI_PLATFORM_PREFIX}, or returns `undefined` for no such endpoint. */
  serve(request: Request): Promise<Response | undefined>;
  /** The signed-in routes, relative to `/api/lti/`: its administrators' and the launch's. */
  readonly adminRoutes: readonly LtiAdminRoute[];
  /**
   * What the request's `Authorization: Bearer` access token lets its tool do, or `undefined` if it
   * carries none that is current: the check every LTI Advantage service call starts with.
   */
  verifyServiceRequest(request: Request): Promise<PlatformServiceGrant | undefined>;
}

/** What the district's LTI Platform is built from. */
export interface DistrictLtiPlatformOptions {
  readonly districtId: DistrictId;
  /** The district's policy engine, which decides every route and service call. */
  readonly authorizer: Authorizer & PolicyDecider;
  readonly stores: LtiDistrictStores;
  /** The district directory, which a deployment's offerings are checked against. */
  readonly directory: () => Promise<DistrictDirectorySnapshot>;
  /** Reads a request's JSON body, refusing anything but `application/json` (lti.ts's `jsonBody`). */
  readonly jsonBody: (request: Request) => Promise<unknown>;
  /** The district's origin (`LTI_TOOL_ORIGIN`), which is also the platform's issuer. */
  readonly origin: string;
  /** The fetch tools' key sets are read with. */
  readonly fetch: typeof fetch;
}

/** Starts the district's LTI Platform over its LTI stores. */
export function startDistrictLtiPlatform(options: DistrictLtiPlatformOptions): DistrictLtiPlatform {
  const { districtId, authorizer, jsonBody, stores } = options;
  const log = logger.with({ districtId });
  const keys = new LtiPlatformKeyService({ districtId, authorizer, keys: stores.platformKeys });
  const tools = new LtiPlatformToolService({ districtId, authorizer, directory: options.directory, store: stores.platformTools });
  const tokens = new PlatformTokenEndpoint({
    tokenUrl: `${options.origin}${LTI_PLATFORM_PREFIX}token`,
    tools: stores.platformTools,
    store: stores.platformServiceTokens,
    keys: new PlatformJwksCache({ fetch: options.fetch }),
  });
  const ags = startPlatformAgs({
    districtId,
    policy: authorizer,
    stores,
    directory: options.directory,
    jsonBody,
    agsUrl: `${options.origin}${LTI_PLATFORM_PREFIX}ags`,
    verify: (request) => tokens.verifyRequest(request),
  });
  const nrps = startPlatformNrps({
    districtId,
    authorizer,
    stores,
    directory: options.directory,
    baseUrl: `${options.origin}${LTI_PLATFORM_PREFIX}`,
    verifyServiceRequest: (request) => tokens.verifyRequest(request),
  });
  const launches = new LtiPlatformLaunchService({
    districtId,
    issuer: options.origin,
    authorizer,
    directory: options.directory,
    tools: stores.platformTools,
    keys: stores.platformKeys,
    tickets: stores.platformLaunchTickets,
    subjects: stores.platformSubjects,
    membershipsUrl: nrps.membershipsUrl,
    serviceClaims: (launch) => ags.service.launchClaims(launch),
  });

  /** Starts a launch for the caller and binds it to their browser with {@link LTI_LAUNCH_COOKIE}. */
  async function startLaunch(caller: Caller, request: Request): Promise<Response> {
    try {
      const started = await launches.start(caller, await jsonBody(request));
      log.info("a launch was started", { event: "lti.platform.launch.started" });
      const maxAge = Math.floor(PLATFORM_LAUNCH_TICKET_TTL_MS / 1000);
      return Response.json({ loginUrl: started.loginUrl, expiresAt: started.expiresAt }, {
        headers: { "cache-control": "no-store", "set-cookie": `${LTI_LAUNCH_COOKIE}=${started.binding}; Max-Age=${maxAge}; ${LAUNCH_COOKIE_ATTRIBUTES}` },
      });
    } catch (error) {
      if (error instanceof EducateOsError) log.warn("a launch was refused at its start", { event: "lti.platform.launch.start-refused", code: error.code });
      throw error;
    }
  }

  /**
   * The OIDC authorization endpoint: the tool's authentication request, by GET (its query) or by
   * POST (an urlencoded form), from the browser that started the launch. The cookie is cleared
   * whatever the outcome, since the first attempt uses the ticket up.
   */
  async function authorizeLaunch(request: Request): Promise<Response> {
    try {
      const form = await launches.authorize(await authRequestParameters(request), launchCookie(request));
      log.info("a launch was answered with an id_token", { event: "lti.platform.launch.authorized" });
      return launchFormPage(form);
    } catch (error) {
      if (!(error instanceof EducateOsError)) throw error;
      log.warn("an authentication request was refused", { event: "lti.platform.launch.refused", code: error.code });
      return refusalPage(error);
    }
  }

  return {
    async serve(request) {
      const path = new URL(request.url).pathname.slice(LTI_PLATFORM_PREFIX.length);
      if (path === "jwks" && request.method === "GET") {
        // Short-lived: a rotation keeps the previous key published, so a tool that cached the set a
        // few minutes ago still verifies, and one that sees an unknown key ID refetches.
        return Response.json(await keys.jwks(), { headers: { "cache-control": "public, max-age=300" } });
      }
      if (path === "token" && request.method === "POST") {
        const { response, outcome } = await tokens.handle(request);
        // Only the outcome: never the assertion, the token or the request body.
        if (outcome.issued) log.info("issued an LTI service token", { event: "lti.platform.token.issued", toolId: outcome.toolId, scopes: outcome.scopes.length });
        else log.info("refused an LTI service token", { event: "lti.platform.token.refused", toolId: outcome.toolId, oauthError: outcome.error });
        return response;
      }
      if (path === "auth" && (request.method === "GET" || request.method === "POST")) return authorizeLaunch(request);
      if (path.startsWith("ags/")) return ags.serve(request, path.slice("ags/".length));
      return nrps.serve(request, path);
    },
    verifyServiceRequest: (request) => tokens.verifyRequest(request),
    adminRoutes: [
      { method: "GET", path: "platform-keys", run: async (caller) => ({ kids: await keys.keyIds(caller) }) },
      { method: "POST", path: "platform-keys/rotate", run: (caller) => keys.rotate(caller) },
      { method: "GET", path: "platform-tools", run: (caller) => tools.list(caller) },
      { method: "POST", path: "platform-tools", run: async (caller, request) => tools.registerTool(caller, await jsonBody(request)) },
      { method: "POST", path: "platform-tools/:id/revoke", run: (caller, _request, { id }) => tools.revokeTool(caller, id) },
      { method: "POST", path: "platform-deployments", run: async (caller, request) => tools.deploy(caller, await jsonBody(request)) },
      { method: "POST", path: "platform-deployments/:id", run: async (caller, request, { id }) => tools.changeDeployment(caller, id, await jsonBody(request)) },
      { method: "POST", path: "platform-deployments/:id/revoke", run: (caller, _request, { id }) => tools.revokeDeployment(caller, id) },
      // Any signed-in person may ask; the launch service and the policy engine decide.
      { method: "POST", path: "platform-launches", run: startLaunch },
      ...ags.adminRoutes,
    ],
  };
}

/** The refusal for a platform path on a district that runs no platform. */
export const NO_PLATFORM = (): EducateOsError => new EducateOsError("not-found", "This district runs no LTI Platform.");

/**
 * The authentication request's parameters, from the query of a GET or the urlencoded body of a
 * POST. A parameter given twice makes the request malformed (RFC 6749 §3.1).
 */
async function authRequestParameters(request: Request): Promise<Record<string, string>> {
  let params: URLSearchParams;
  if (request.method === "GET") {
    params = new URL(request.url).searchParams;
  } else {
    if (!/^application\/x-www-form-urlencoded(;|$)/i.test(request.headers.get("content-type") ?? "")) {
      throw new EducateOsError("validation-failed", "The authentication request is malformed.");
    }
    params = new URLSearchParams(new TextDecoder().decode(await request.arrayBuffer()));
  }
  const parameters: Record<string, string> = {};
  for (const [name, value] of params) {
    if (Object.hasOwn(parameters, name)) throw new EducateOsError("validation-failed", "The authentication request is malformed.");
    parameters[name] = value;
  }
  return parameters;
}

/** The launch cookie the request carries, if it carries exactly one. */
function launchCookie(request: Request): string | undefined {
  const values = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair.startsWith(`${LTI_LAUNCH_COOKIE}=`))
    .map((pair) => pair.slice(LTI_LAUNCH_COOKIE.length + 1));
  return values.length === 1 && values[0] !== "" ? values[0] : undefined;
}

/** Clears {@link LTI_LAUNCH_COOKIE}. */
const CLEAR_LAUNCH_COOKIE = `${LTI_LAUNCH_COOKIE}=; Max-Age=0; ${LAUNCH_COOKIE_ATTRIBUTES}`;

/** Headers every answer of the authorization endpoint carries. */
function authHeaders(csp: string): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": csp,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "set-cookie": CLEAR_LAUNCH_COOKIE,
  };
}

/**
 * The page that posts the id_token to the tool (OIDC form post response mode). Its one script, by
 * nonce, submits the form; without scripts the person presses the button. Forms may go only to the
 * redirect URI's origin.
 */
function launchFormPage(form: PlatformLaunchForm): Response {
  const nonce = randomToken();
  const fields = Object.entries(form.fields)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join("");
  const html = [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>EducateOS</title></head><body>',
    `<form method="post" action="${escapeHtml(form.action)}">${fields}`,
    "<noscript><p>Continue to the tool.</p><button type=\"submit\">Continue</button></noscript></form>",
    `<script nonce="${nonce}">document.forms[0].submit();</script>`,
    "</body></html>",
  ].join("");
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; form-action ${new URL(form.action).origin}; base-uri 'none'; frame-ancestors 'self'`;
  return new Response(html, { status: 200, headers: authHeaders(csp) });
}

/** The page a refused authentication request is answered with, on EducateOS. */
function refusalPage(error: EducateOsError): Response {
  const html = [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>EducateOS</title></head><body><main>',
    "<h1>This launch cannot be completed</h1>",
    "<p>Start it again from EducateOS.</p>",
    "</main></body></html>",
  ].join("");
  return new Response(html, { status: ERROR_STATUS[error.code], headers: authHeaders("default-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'") });
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
