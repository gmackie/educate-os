// Clever Instant Login in the demo (SCHO-276): what happens when a Cedar Valley person clicks
// EducateOS in their district portal, run for real in the page. Clever is the OIDC fake's Clever
// preset (authorize, codes, tokens, the id_token and its JWKS) and the Clever Data API fake, with a
// `/me` beside them; the launch is the control plane's own `cleverLaunch`; the sign-in verifies the
// id_token with jose and maps it with `identityFromCleverClaims`, as a district's Access sign-in
// would, then starts a session in the district. Every request goes to those fakes: nothing here
// reaches the network.
//
// Each hop is recorded with what was sent and answered, codes and tokens cut to a prefix, so the
// "Under the hood" drawer can show the flow as it ran.
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";
import {
  CLEVER_LAUNCH_REDIRECT_URI,
  CLEVER_ME_URL,
  CLEVER_TOKEN_URL,
  CLEVER_USERS_URL,
  cleverLaunch,
  configuredLaunchDistricts,
} from "@educateos/control-plane/clever-launch";
import type { VerifiedIdentity } from "@educateos/contracts";
import { CLEVER_ISSUER, identityFromCleverClaims } from "@educateos/identity";
import { cleverDistrictId, cleverUserId, OidcFake, type CleverDataFake, type PlatformKey } from "@educateos/provider-fakes";
import type { CedarValleyDistrict } from "../districts/cedarvalley.ts";

/**
 * The demo's stand-in for the educateos.io Clever app, the OAuth client both the shared launch and
 * the district's sign-in use. Clever-shaped, but not a credential anywhere.
 */
export const DEMO_CLEVER_APP = { clientId: "d3m0c1e7e2b4a6f8e0c2", clientSecret: "demo-only-not-a-clever-secret" } as const;

/** The managed hostname the launch registry sends Cedar Valley's Clever district to. */
export const CEDARVALLEY_HOSTNAME = "cedarvalley.educateos.io";

/** Clever's Instant Login link, which a district portal's tile opens. */
export const CLEVER_INSTANT_LOGIN_URL = "https://clever.com/oauth/instant-login";

const AUTHORIZE_URL = "https://clever.com/oauth/authorize";
const JWKS_URL = "https://clever.com/oauth/certs";
// Where the district's sign-in (its Cloudflare Access application) has Clever send the browser back.
const SIGN_IN_CALLBACK = `https://${CEDARVALLEY_HOSTNAME}/cdn-cgi/access/callback`;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Clever, in the page: its sign-in, its Data API, and a browser's way of reaching them. */
export interface InPageClever {
  /** Clever's sign-in for the district: authorize, tokens, id_tokens and their keys. */
  readonly oidc: OidcFake;
  /** The district's Clever Data API. */
  readonly data: CleverDataFake;
  /** The Clever district ID of everyone here. */
  readonly districtId: string;
  /**
   * Reaches Clever as a browser signed in to the Clever portal as `subject` (a Clever user ID), so
   * an authorization request needs no sign-in page: Clever already knows who it is for.
   */
  fetchAs(subject: string | undefined): Fetch;
}

/**
 * Clever for the district `data` serves. Clever signs every district's id_tokens with the same
 * keys, so a second district's Clever, to show a sign-in from elsewhere, passes the same `signingKey`.
 */
export function inPageClever(data: CleverDataFake, signingKey?: PlatformKey): InPageClever {
  const oidc = new OidcFake({
    seed: data.seed,
    preset: "clever",
    clients: [{ ...DEMO_CLEVER_APP, redirectUris: [CLEVER_LAUNCH_REDIRECT_URI, SIGN_IN_CALLBACK] }],
    ...(signingKey === undefined ? {} : { signingKey }),
  });
  const districtId = cleverDistrictId(oidc.seed);

  // `/me`, which the Data API fake leaves out: who a user token belongs to, as Clever's OAuth guide
  // shows it (https://dev.clever.com/docs/oauth-implementation#the-authorized_by-field).
  const me = (request: Request): Response => {
    const grant = oidc.accessGrant(/^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]);
    if (grant === undefined) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const id = cleverUserId(oidc.seed, grant.personId);
    return Response.json({
      type: "user",
      data: { id, district: districtId, type: "user", authorized_by: "district" },
      links: [
        { rel: "self", uri: "/me" },
        { rel: "canonical", uri: `/v3.0/users/${id}` },
        { rel: "district", uri: `/v3.0/districts/${districtId}` },
      ],
    });
  };

  // A user's token reads only their own record; the Data API fake knows district tokens, so the
  // read is passed on under the district's.
  const ownRecord = (request: Request, url: URL): Response | Promise<Response> => {
    const grant = oidc.accessGrant(/^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]);
    if (grant === undefined) return data.handle(request);
    if (url.pathname !== `/v3.0/users/${cleverUserId(oidc.seed, grant.personId)}`) return Response.json({ error: "Forbidden" }, { status: 403 });
    return data.handle(new Request(url, { headers: { authorization: `Bearer ${data.districtToken}`, accept: "application/json" } }));
  };

  const handle = async (request: Request, subject: string | undefined): Promise<Response> => {
    const url = new URL(request.url);
    if (url.origin === "https://clever.com" && url.pathname === "/oauth/instant-login") {
      // Instant Login: for this app and this district, start the app's sign-in flow at its first
      // redirect URI, as the portal tile does.
      if (url.searchParams.get("client_id") !== DEMO_CLEVER_APP.clientId || url.searchParams.get("district_id") !== districtId) {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      const authorize = new URL(AUTHORIZE_URL);
      authorize.search = new URLSearchParams({ response_type: "code", client_id: DEMO_CLEVER_APP.clientId, redirect_uri: CLEVER_LAUNCH_REDIRECT_URI, scope: "openid" }).toString();
      return new Response(null, { status: 302, headers: { location: authorize.toString() } });
    }
    if (url.origin === "https://clever.com" && url.pathname === "/oauth/authorize" && subject !== undefined && !url.searchParams.has("login_hint")) {
      // The portal session: Clever knows who is signed in, so it asks nobody.
      url.searchParams.set("login_hint", subject);
      return oidc.handle(new Request(url, request));
    }
    if (url.origin === "https://api.clever.com" && url.pathname === new URL(CLEVER_ME_URL).pathname) return me(request);
    if (url.origin === "https://api.clever.com" && url.pathname.startsWith(new URL(CLEVER_USERS_URL).pathname)) return ownRecord(request, url);
    if (url.origin === "https://api.clever.com" && url.pathname.startsWith("/v3.")) return data.handle(request);
    if (url.origin === "https://clever.com" || url.origin === "https://api.clever.com") return oidc.handle(request);
    throw new TypeError(`fetch failed: the demo reaches only its in-page Clever, not ${url.origin}`);
  };

  return {
    oidc,
    data,
    districtId,
    fetchAs: (subject) => async (input, init = {}) => {
      // The signal is left behind: nothing here waits on a network, and a page's AbortSignal
      // need not be the one its Request accepts (jsdom's is not undici's).
      const { signal: _signal, ...rest } = init;
      return handle(new Request(input, rest), subject);
    },
  };
}

/** The steps of an Instant Login, in order, for a tour or a test to follow. */
export type HopId =
  | "portal-link"
  | "portal-authorize"
  | "launch-code-exchange"
  | "launch-me"
  | "launch-user"
  | "launch-district"
  | "launch-redirect"
  | "sign-in-authorize"
  | "sign-in-code-exchange"
  | "id-token"
  | "user-record"
  | "district-match"
  | "principal";

/** One HTTP request a hop made, with codes, tokens and client secrets cut to a prefix. */
export interface HopExchange {
  method: string;
  url: string;
  /** The request's headers and form fields worth showing. */
  sent?: Record<string, string>;
  status: number;
  /** Where a redirect sent the browser. */
  location?: string;
  /** The JSON answered. */
  body?: unknown;
}

/** One step of an Instant Login, as it ran. */
export interface InstantLoginHop {
  id: HopId;
  title: string;
  /** What happened, in a sentence. */
  summary: string;
  /** Whether the step went the way a successful sign-in needs. */
  ok: boolean;
  exchange?: HopExchange;
  /** What the step worked out: decoded claims, the district match, the principal. */
  data?: Record<string, unknown>;
}

/** Who signed in to EducateOS, as the district resolved them. */
export interface SignedInPrincipal {
  principalId: string;
  displayName: string;
}

/** How an Instant Login ended. */
export type InstantLoginResult =
  | {
    outcome: "signed-in";
    /** Where the launch sent the browser: the district's EducateOS. */
    redirect: string;
    identity: VerifiedIdentity;
    /** The district session the sign-in started, the bearer of the person's requests. */
    session: string;
    /** Who the district resolved the identity to; undefined while its roster has not brought them in. */
    principal: SignedInPrincipal | undefined;
    hops: InstantLoginHop[];
  }
  | {
    outcome: "refused";
    /** The step that refused. */
    at: HopId;
    /** Why, as the refusing side put it. */
    reason: string;
    hops: InstantLoginHop[];
  };

/** What an Instant Login signs in to: the district's Clever sign-in settings, sessions and API. */
export type InstantLoginDistrict = Pick<CedarValleyDistrict, "cleverSso" | "sessions" | "clientFor">;

/** Hooks for the tour (SCHO-279) and the drawer: each hop as it is recorded. */
export interface InstantLoginOptions {
  onHop?: (hop: InstantLoginHop) => void;
}

// Codes, tokens and nonces, cut so they can be shown but not used.
const cut = (secret: string) => (secret.length <= 8 ? "…" : `${secret.slice(0, 6)}…`);

/** A URL with its code (and any token-like parameters) cut. */
function shown(url: string): string {
  const parsed = new URL(url);
  for (const key of ["code", "state", "nonce"]) {
    const value = parsed.searchParams.get(key);
    if (value !== null) parsed.searchParams.set(key, cut(value));
  }
  return decodeURIComponent(parsed.toString());
}

/** A JSON body with its tokens cut. */
function shownBody(body: unknown): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return body;
  return Object.fromEntries(Object.entries(body).map(([key, value]) =>
    [key, typeof value === "string" && /token|secret|code|nonce/.test(key) ? cut(value) : shownBody(value)]));
}

/** The headers and form fields of a request worth showing, with credentials cut. */
function shownRequest(init: RequestInit): Record<string, string> | undefined {
  const sent: Record<string, string> = {};
  const authorization = new Headers(init.headers).get("authorization");
  if (authorization !== null) {
    sent["authorization"] = authorization.startsWith("Basic ") ? "Basic (the app's client ID and secret)" : `Bearer ${cut(authorization.slice("Bearer ".length))}`;
  }
  if (typeof init.body === "string") {
    for (const [key, value] of new URLSearchParams(init.body)) sent[key] = key === "code" ? cut(value) : value;
  }
  return Object.keys(sent).length === 0 ? undefined : sent;
}

/** A fetch that records each request and its answer as an exchange. */
async function exchange(fetch: Fetch, url: string, init: RequestInit = {}): Promise<{ response: Response; exchange: HopExchange }> {
  const response = await fetch(url, { redirect: "manual", ...init });
  let body: unknown;
  if ((response.headers.get("content-type") ?? "").includes("json")) body = shownBody(await response.clone().json());
  const location = response.headers.get("location");
  const sent = shownRequest(init);
  return {
    response,
    exchange: {
      method: init.method ?? "GET",
      url: shown(url),
      ...(sent === undefined ? {} : { sent }),
      status: response.status,
      ...(location === null ? {} : { location: shown(location) }),
      ...(body === undefined ? {} : { body }),
    },
  };
}

const LAUNCH_HOPS: { id: HopId; matches: (url: string) => boolean; title: string }[] = [
  { id: "launch-code-exchange", matches: (url) => url === CLEVER_TOKEN_URL, title: "The launch exchanges the code" },
  { id: "launch-me", matches: (url) => url === CLEVER_ME_URL, title: "The launch asks Clever who signed in" },
  { id: "launch-district", matches: (url) => url.startsWith(CLEVER_USERS_URL) && url.endsWith("/district"), title: "The launch reads the user's district" },
  { id: "launch-user", matches: (url) => url.startsWith(CLEVER_USERS_URL), title: "The launch reads the user's record" },
];

const LAUNCH_SUMMARY: Partial<Record<HopId, (exchange: HopExchange) => string>> = {
  "launch-code-exchange": ({ status }) => status === 200 ? "Clever traded the single-use code for an access token, used once and dropped." : `Clever refused the code (${status}).`,
  "launch-me": ({ status, body }) => {
    const district = (body as { data?: { district?: string } } | undefined)?.data?.district;
    return status === 200 ? `Clever named the user and their district${district === undefined ? "" : `, ${district}`}.` : `Clever didn't say who signed in (${status}).`;
  },
  "launch-user": ({ status }) => `The user's record answered ${status}.`,
  "launch-district": ({ status }) => `The user's district record answered ${status}.`,
};

/** The hops of one Instant Login, recorded as they run. */
export class Hops {
  readonly list: InstantLoginHop[] = [];
  readonly #onHop: InstantLoginOptions["onHop"];
  constructor(onHop?: InstantLoginOptions["onHop"]) {
    this.#onHop = onHop;
  }
  add(hop: InstantLoginHop): void {
    this.list.push(hop);
    this.#onHop?.(hop);
  }
}

/** What a refused launch's page says: its heading. */
const headingOf = (page: string) => new DOMParser().parseFromString(page, "text/html").querySelector("h1")?.textContent ?? "The launch was refused.";

/**
 * The portal half: the person clicks the EducateOS tile, Clever sends their browser to the shared
 * launch URL with a code, and the control plane's `cleverLaunch` learns their Clever district and
 * redirects to the district registered for it. Returns where it redirected, or the refusal.
 */
export async function portalLaunch(
  clever: InPageClever,
  subject: string,
  district: Pick<InstantLoginDistrict, "cleverSso">,
  hops: Hops,
): Promise<{ redirect: string } | { at: HopId; reason: string }> {
  const browser = clever.fetchAs(subject);
  const link = `${CLEVER_INSTANT_LOGIN_URL}?${new URLSearchParams({ client_id: DEMO_CLEVER_APP.clientId, district_id: clever.districtId })}`;
  const tile = await exchange(browser, link);
  const toAuthorize = tile.response.headers.get("location");
  hops.add({
    id: "portal-link",
    title: "The portal tile opens Clever's Instant Login link",
    summary: toAuthorize === null ? "Clever didn't recognise the link." : "Clever starts EducateOS's sign-in at its first redirect URI, the shared launch.",
    ok: toAuthorize !== null,
    exchange: tile.exchange,
  });
  if (toAuthorize === null) return { at: "portal-link", reason: "Clever didn't recognise the Instant Login link." };

  const authorize = await exchange(browser, toAuthorize);
  const toLaunch = authorize.response.headers.get("location") ?? "";
  const code = toLaunch.startsWith(`${CLEVER_LAUNCH_REDIRECT_URI}?`) ? new URL(toLaunch).searchParams.get("code") : null;
  hops.add({
    id: "portal-authorize",
    title: "Clever sends the browser to the launch with a code",
    summary: code === null ? "Clever didn't issue a code." : "The person is already signed in to Clever, so Clever issues a one-minute code without asking anything.",
    ok: code !== null,
    exchange: authorize.exchange,
  });
  if (code === null) return { at: "portal-authorize", reason: "Clever didn't issue a code." };

  // The control plane's launch, with its calls to Clever answered in the page.
  const registry = configuredLaunchDistricts(JSON.stringify({ [district.cleverSso.districtId]: CEDARVALLEY_HOSTNAME }));
  const response = await cleverLaunch(new Request(toLaunch), {
    shell: { header: "", footer: "" },
    credentials: DEMO_CLEVER_APP,
    hostnameFor: async (id) => registry.get(id),
    fetch: async (url, init) => {
      const recorded = await exchange(browser, url, init);
      const kind = LAUNCH_HOPS.find((hop) => hop.matches(url))!;
      hops.add({ id: kind.id, title: kind.title, summary: LAUNCH_SUMMARY[kind.id]!(recorded.exchange), ok: recorded.response.ok, exchange: recorded.exchange });
      return recorded.response;
    },
  });
  const location = response.headers.get("location");
  const redirected = response.status === 303 && location !== null;
  const reason = redirected ? "" : headingOf(await response.text());
  hops.add({
    id: "launch-redirect",
    title: "The launch sends the browser to the district",
    summary: redirected ? `The Clever district is registered to ${new URL(location).hostname}, so the launch redirects there and keeps nothing.` : `The launch refused: ${reason}`,
    ok: redirected,
    exchange: { method: "GET", url: shown(toLaunch), status: response.status, ...(location === null ? {} : { location }) },
  });
  return redirected ? { redirect: location } : { at: "launch-redirect", reason };
}

/**
 * Verifies a Clever id_token as a district's sign-in does: Clever's signature from its JWKS, its
 * issuer, this app as the audience, its expiry, and the nonce the sign-in sent.
 */
export async function verifyCleverIdToken(idToken: string, jwks: JSONWebKeySet, expected: { nonce: string }): Promise<JWTPayload> {
  const { payload } = await jwtVerify(idToken, createLocalJWKSet(jwks), { issuer: CLEVER_ISSUER, audience: DEMO_CLEVER_APP.clientId, algorithms: ["RS256"] });
  if (payload["nonce"] !== expected.nonce) throw new Error("The id_token's nonce isn't this sign-in's.");
  return payload;
}

const randomToken = () => crypto.randomUUID().replaceAll("-", "");

/**
 * The district half: the district's sign-in starts its own Clever sign-in, which Clever completes
 * without asking, exchanges the code, verifies the id_token and maps its claims to an identity in
 * the district. Only a sign-in from the district's own Clever district gets a session.
 */
export async function districtSignIn(
  clever: InPageClever,
  subject: string,
  district: InstantLoginDistrict,
  hops: Hops,
): Promise<{ identity: VerifiedIdentity; session: string; principal: SignedInPrincipal | undefined } | { at: HopId; reason: string }> {
  const browser = clever.fetchAs(subject);
  const state = randomToken();
  const nonce = randomToken();
  const authorizeUrl = `${AUTHORIZE_URL}?${new URLSearchParams({ response_type: "code", client_id: DEMO_CLEVER_APP.clientId, redirect_uri: SIGN_IN_CALLBACK, scope: "openid", state, nonce })}`;
  const authorize = await exchange(browser, authorizeUrl);
  const back = new URL(authorize.response.headers.get("location") ?? SIGN_IN_CALLBACK);
  const code = back.searchParams.get("state") === state ? back.searchParams.get("code") : null;
  hops.add({
    id: "sign-in-authorize",
    title: "The district starts its own Clever sign-in",
    summary: code === null ? "Clever didn't complete the district's sign-in." : "Clever completes it at once, since the person is still signed in to Clever.",
    ok: code !== null,
    exchange: authorize.exchange,
  });
  if (code === null) return { at: "sign-in-authorize", reason: "Clever didn't complete the district's sign-in." };

  const token = await exchange(browser, CLEVER_TOKEN_URL, {
    method: "POST",
    headers: { authorization: `Basic ${btoa(`${DEMO_CLEVER_APP.clientId}:${DEMO_CLEVER_APP.clientSecret}`)}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, grant_type: "authorization_code", redirect_uri: SIGN_IN_CALLBACK }).toString(),
  });
  const tokens = token.response.ok ? await token.response.json() as { access_token?: string; id_token?: string } : {};
  hops.add({
    id: "sign-in-code-exchange",
    title: "The district exchanges the code for an id_token",
    summary: tokens.id_token === undefined ? "Clever issued no id_token." : "Clever answers with an access token and a signed id_token.",
    ok: tokens.id_token !== undefined,
    exchange: token.exchange,
  });
  if (tokens.id_token === undefined) return { at: "sign-in-code-exchange", reason: "Clever issued no id_token." };

  let claims: JWTPayload;
  try {
    const jwks = await (await browser(JWKS_URL)).json() as JSONWebKeySet;
    claims = await verifyCleverIdToken(tokens.id_token, jwks, { nonce });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "The id_token didn't verify.";
    hops.add({ id: "id-token", title: "The district verifies the id_token", summary: reason, ok: false });
    return { at: "id-token", reason };
  }
  hops.add({
    id: "id-token",
    title: "The district verifies the id_token",
    summary: `Signed by Clever's key ${decodeProtectedHeader(tokens.id_token).kid ?? ""} from ${JWKS_URL}, issued to this app, unexpired, with this sign-in's nonce.`,
    ok: true,
    data: { header: decodeProtectedHeader(tokens.id_token), claims: shownBody(claims) as Record<string, unknown> },
  });

  if (tokens.access_token !== undefined && typeof claims.sub === "string") {
    const record = await exchange(browser, `${CLEVER_USERS_URL}/${claims.sub}`, { headers: { authorization: `Bearer ${tokens.access_token}`, accept: "application/json" } });
    hops.add({
      id: "user-record",
      title: "Clever's record of the person",
      summary: "The record the district's Clever roster sync imports, read here to show it. The launch didn't need it: /me named the district.",
      ok: record.response.ok,
      exchange: record.exchange,
    });
  }

  let identity: VerifiedIdentity;
  try {
    identity = identityFromCleverClaims(claims, district.cleverSso);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "The Clever sign-in was refused.";
    hops.add({
      id: "district-match",
      title: "The district checks the Clever district",
      summary: `Refused: ${reason}`,
      ok: false,
      data: { claimed: claims["district"] ?? claims["district_id"], expected: district.cleverSso.districtId },
    });
    return { at: "district-match", reason };
  }
  hops.add({
    id: "district-match",
    title: "The district checks the Clever district",
    summary: "The sign-in's district is this district's Clever district, so its Clever user ID becomes the person's identity here.",
    ok: true,
    data: { claimed: claims["district"] ?? claims["district_id"], expected: district.cleverSso.districtId, identity },
  });

  const session = district.sessions.start(identity);
  let principal: SignedInPrincipal | undefined;
  try {
    const me = await district.clientFor(session).call("me.get");
    principal = { principalId: me.principalId, displayName: me.displayName };
  } catch {
    principal = undefined;
  }
  hops.add({
    id: "principal",
    title: "EducateOS resolves the person",
    summary: principal === undefined
      ? "The sign-in is valid, but nobody in the district is linked to it yet: the district's Clever roster hasn't brought this person in."
      : `${identity.issuer} · ${identity.subject} is ${principal.displayName} (${principal.principalId}).`,
    ok: principal !== undefined,
    data: { identity, ...(principal === undefined ? {} : { principal }) },
  });
  return { identity, session, principal };
}

/**
 * Clever Instant Login for the person whose Clever user ID is `subject`, from their portal tile to
 * a session in `district`: {@link portalLaunch}, then {@link districtSignIn}.
 */
export async function instantLogin(
  clever: InPageClever,
  subject: string,
  district: InstantLoginDistrict,
  options: InstantLoginOptions = {},
): Promise<InstantLoginResult> {
  const hops = new Hops(options.onHop);
  const launch = await portalLaunch(clever, subject, district, hops);
  if ("at" in launch) return { outcome: "refused", ...launch, hops: hops.list };
  const signIn = await districtSignIn(clever, subject, district, hops);
  if ("at" in signIn) return { outcome: "refused", ...signIn, hops: hops.list };
  return { outcome: "signed-in", redirect: launch.redirect, ...signIn, hops: hops.list };
}

const cleverOf = new WeakMap<CleverDataFake, InPageClever>();

/** The district's Clever, made once per booted district so its keys and codes last as long as it does. */
export function cleverFor(district: Pick<CedarValleyDistrict, "clever">): InPageClever {
  let clever = cleverOf.get(district.clever);
  if (clever === undefined) {
    clever = inPageClever(district.clever);
    cleverOf.set(district.clever, clever);
  }
  return clever;
}
