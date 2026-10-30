// Clever portal launches (SCHO-249, ADR-0013 addendum A2). Clever's portal and Instant Login links
// send the browser to the app's first redirect URI with `?code=` and no `state`
// (https://dev.clever.com/docs/getting-started-with-clever-sso,
// https://dev.clever.com/docs/oauth-implementation). Cloudflare Access refuses a callback for a
// sign-in it didn't start, so that URI can't be a district's own Access callback. It is this one
// shared URL instead, which learns the user's Clever district, sends the browser to the district
// registered for it, and keeps nothing. The district's Access application then starts its own
// Clever sign-in, which Clever completes without asking, since the user is already signed in.
//
// What passes through here: the code, and for the length of one request an access token and the
// user's Clever IDs. The token is used for one `/me` read and dropped. None of it is stored, logged
// or sent anywhere but Clever; the only thing that leaves is the district's hostname.
import { z } from "zod";
import { html, page, PAGE_HEADERS, type SiteShell } from "./pages.ts";

/** The path portal launches arrive at. */
export const CLEVER_LAUNCH_PATH = "/clever/launch";

/**
 * The redirect URI the Clever app lists first. The code exchange must name it exactly, so it is a
 * constant rather than the request's own URL.
 */
export const CLEVER_LAUNCH_REDIRECT_URI = `https://educateos.io${CLEVER_LAUNCH_PATH}`;

/** Clever's token endpoint. */
export const CLEVER_TOKEN_URL = "https://clever.com/oauth/tokens";
/** Clever's identity endpoint, at an explicit API version as Clever asks. */
export const CLEVER_ME_URL = "https://api.clever.com/v3.0/me";
/** Clever's user records, read by ID when `/me` leaves out the user's district. */
export const CLEVER_USERS_URL = "https://api.clever.com/v3.0/users";

/** How long each call to Clever may take. A launch is a person waiting on a redirect. */
export const CLEVER_REQUEST_TIMEOUT_MS = 10_000;
/** Clever's OpenID Connect userinfo endpoint, which an OIDC sign-in (Cloudflare Access) reads. */
export const CLEVER_USERINFO_URL = "https://api.clever.com/userinfo";

/** The educateos.io Clever app's OAuth client, from the site Worker's secrets. */
export interface CleverAppCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Reads the site Worker's `CLEVER_LAUNCH_DISTRICTS` var: a JSON object from Clever district ID to
 * the managed hostname of a district the project runs itself (the demo districts), which are not
 * control-plane installations and so are not in the registry. Entries that aren't a Clever ID
 * mapped to a `<slug>.educateos.io` hostname are dropped, and so is a var that isn't JSON.
 */
export function configuredLaunchDistricts(value: string | undefined): ReadonlyMap<string, string> {
  if (value === undefined || value.trim() === "") return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return new Map();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return new Map();
  return new Map(Object.entries(parsed).filter((entry): entry is [string, string] =>
    CleverId.safeParse(entry[0]).success && typeof entry[1] === "string" && MANAGED_HOSTNAME.test(entry[1])));
}

// A managed hostname, as the control plane stores one.
const MANAGED_HOSTNAME = /^[a-z][a-z0-9-]{1,30}[a-z0-9]\.educateos\.io$/;

/**
 * Reads the site Worker's `CLEVER_LAUNCH_UNAFFILIATED` var: the managed hostname a launch goes to
 * when Clever places its user in no district, as it does a teacher who authorized the app
 * themselves (the sandbox's demo logins among them). Undefined, or not a `<slug>.educateos.io`
 * hostname, refuses such launches.
 */
export function configuredUnaffiliatedHostname(value: string | undefined): string | undefined {
  const hostname = value?.trim();
  return hostname !== undefined && MANAGED_HOSTNAME.test(hostname) ? hostname : undefined;
}

/** What {@link cleverLaunch} is given. */
export interface CleverLaunchDeps {
  shell: SiteShell;
  /** Undefined when the Worker has no Clever secrets: every launch is then refused. */
  credentials: CleverAppCredentials | undefined;
  /** The hostname of the registered installation for a Clever district ID, if any. */
  hostnameFor: (cleverDistrictId: string) => Promise<string | undefined>;
  /** Where a user Clever places in no district goes, from {@link configuredUnaffiliatedHostname}. */
  unaffiliatedHostname?: string;
  /** Reaches Clever. Tests stand a fake in its place. */
  fetch: (input: string, init: RequestInit) => Promise<Response>;
}

// Clever's object IDs: 24 hex characters.
const CleverId = z.string().regex(/^[0-9a-f]{24}$/);
// Clever's codes are opaque; this only keeps an absurd one from being sent on.
const Code = z.string().regex(/^[\x21-\x7e]{1,512}$/);
const TokenResponse = z.object({ access_token: z.string().min(1), id_token: z.string().optional() });
// A teacher-authorized sign-in's /me carries no district: only the user's ID, read from /users next.
const MeResponse = z.object({ data: z.object({ id: CleverId, district: CleverId.optional() }) });
// A v3.0 user record names its district under each of its roles (`roles.teacher.district`), not at
// the top. One user belongs to one district, so a record whose roles disagree is refused.
// The district record itself, as /users/{id}/district answers it.
const DistrictResponse = z.object({ data: z.object({ id: CleverId }) });
const UserResponse = z.object({
  data: z.object({ roles: z.record(z.string(), z.object({ district: CleverId }).partial()) }),
}).transform(({ data }, ctx) => {
  const districts = new Set(Object.values(data.roles).flatMap((role) => (role.district === undefined ? [] : [role.district])));
  if (districts.size !== 1) {
    ctx.addIssue({ code: "custom", message: "user record names no single district" });
    return z.NEVER;
  }
  return [...districts][0]!;
});
// An OAuth error reply's code (RFC 6749 §5.2): a short token, safe to log, unlike the rest of the body.
const OAuthError = z.object({ error: z.string().regex(/^[a-z_]{1,64}$/) });

/** Why a launch was turned away, as logged. Never the code, the token, or anyone's IDs. */
export type CleverLaunchFailure =
  "missing-code" | "unconfigured" | "exchange-failed" | "identity-failed" | "unknown-district" | "no-district";

/**
 * What Clever answered when a call to it failed, as logged beside the failure: its HTTP status
 * (absent when Clever was never reached) and its OAuth error code, if it sent one.
 */
export interface CleverReply {
  cleverStatus?: number;
  cleverError?: string;
  /** The shape of a 2xx reply that didn't parse, from {@link shapeOf}. */
  cleverShape?: string;
}

/**
 * Describes a JSON value by field names and types alone, four levels deep: `{data:{district:string(24)}}`.
 * Strings show only their length and arrays their count, so no value Clever sent is logged. Field
 * names that aren't plain words are dropped, in case a reply is keyed by IDs.
 */
export function shapeOf(value: unknown, depth = 0): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === "string") return `string(${value.length})`;
  if (typeof value !== "object") return typeof value;
  if (depth >= 4) return "object";
  const fields = Object.entries(value).filter(([key]) => /^[A-Za-z_]{1,32}$/.test(key)).slice(0, 20);
  return `{${fields.map(([key, field]) => `${key}:${shapeOf(field, depth + 1)}`).join(",")}}`;
}

// A call to Clever: what it was asked for, or what it answered instead.
type CleverResult<T> = { ok: true; value: T } | { ok: false; reply: CleverReply };

// Every launch response: never cached, and no Referer, since the launch URL carries the code.
const LAUNCH_HEADERS = { "cache-control": "no-store", "referrer-policy": "no-referrer" } as const;

const MESSAGES: Record<CleverLaunchFailure, { status: number; title: string; message: string }> = {
  "missing-code": {
    status: 400,
    title: "Open EducateOS from Clever",
    message: "This address is where Clever sends you when you open EducateOS from your Clever portal. Open it from there to sign in.",
  },
  "unconfigured": {
    status: 503,
    title: "Clever sign-in is unavailable",
    message: "We couldn't take you to your district just now. Try again shortly, or open your district's EducateOS address directly.",
  },
  "exchange-failed": {
    status: 502,
    title: "Clever sign-in didn't finish",
    message: "We couldn't confirm your Clever sign-in. Go back to your Clever portal and open EducateOS again.",
  },
  "identity-failed": {
    status: 502,
    title: "Clever sign-in didn't finish",
    message: "We couldn't confirm your Clever sign-in. Go back to your Clever portal and open EducateOS again.",
  },
  "unknown-district": {
    status: 404,
    title: "Your district isn't set up for Clever launch",
    message: "Your district hasn't connected its EducateOS to Clever's portal yet. Open your district's EducateOS address directly, or ask your district's technology team.",
  },
  "no-district": {
    status: 404,
    title: "Your Clever account isn't part of a district",
    message: "EducateOS opens from Clever for districts that use it. Your Clever account isn't linked to a district, so open your district's EducateOS address directly.",
  },
};

function refuse(shell: SiteShell, failure: CleverLaunchFailure, reply: CleverReply = {}): Response {
  console.warn("clever launch refused", { event: "clever.launch.refused", reason: failure, ...reply });
  const { status, title, message } = MESSAGES[failure];
  const body = page(shell, title, html`<section class="page-hero">
    <div class="wrap">
      <div class="eyebrow">Clever</div>
      <h1>${title}</h1>
      <p class="lede">${message}</p>
      <p><a class="btn" href="https://clever.com/">Clever</a> <a class="btn" href="/">educateos.io</a></p>
    </div>
  </section>`);
  return new Response(body, { status, headers: { ...PAGE_HEADERS, ...LAUNCH_HEADERS } });
}

async function readJson<T>(response: Response, schema: z.ZodType<T>): Promise<CleverResult<T>> {
  const cleverStatus = response.status;
  // A redirect counts as a failure like any other non-2xx: `redirect: "manual"` keeps it unfollowed.
  if (!response.ok) {
    try {
      return { ok: false, reply: { cleverStatus, cleverError: OAuthError.safeParse(await response.json()).data?.error } };
    } catch {
      return { ok: false, reply: { cleverStatus } };
    }
  }
  try {
    const body: unknown = await response.json();
    const parsed = schema.safeParse(body);
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reply: { cleverStatus, cleverShape: shapeOf(body).slice(0, 1000) } };
  } catch {
    return { ok: false, reply: { cleverStatus } };
  }
}

// Exchanges the code for an access token (HTTP Basic with the app's client, as Clever documents).
async function exchange(
  code: string, deps: CleverLaunchDeps, credentials: CleverAppCredentials,
): Promise<CleverResult<{ accessToken: string; idToken?: string }>> {
  try {
    const response = await deps.fetch(CLEVER_TOKEN_URL, {
      method: "POST",
      headers: {
        "authorization": `Basic ${btoa(`${credentials.clientId}:${credentials.clientSecret}`)}`,
        "content-type": "application/x-www-form-urlencoded",
        "accept": "application/json",
      },
      body: new URLSearchParams({ code, grant_type: "authorization_code", redirect_uri: CLEVER_LAUNCH_REDIRECT_URI }).toString(),
      // workerd refuses `redirect: "error"`.
      redirect: "manual",
      signal: AbortSignal.timeout(CLEVER_REQUEST_TIMEOUT_MS),
    });
    const read = await readJson(response, TokenResponse);
    return read.ok ? { ok: true, value: { accessToken: read.value.access_token, idToken: read.value.id_token } } : read;
  } catch {
    return { ok: false, reply: {} };
  }
}

// Reads one of Clever's identity endpoints with the user's token.
async function readClever<T>(url: string, token: string, deps: CleverLaunchDeps, schema: z.ZodType<T>): Promise<CleverResult<T>> {
  try {
    const response = await deps.fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(CLEVER_REQUEST_TIMEOUT_MS),
    });
    return await readJson(response, schema);
  } catch {
    return { ok: false, reply: {} };
  }
}

// Reads the signed-in user's Clever district with the token, the token's only use: from /me, else
// from the roles in the user's own record, else from the user's district record. Undefined when
// Clever has none for the user (its district record is a 404), as for a teacher who authorized the
// app themselves: their record's roles carry only a legacy ID.
async function districtOf(token: string, deps: CleverLaunchDeps): Promise<CleverResult<string | undefined>> {
  const me = await readClever(CLEVER_ME_URL, token, deps, MeResponse);
  if (!me.ok) return me;
  if (me.value.data.district !== undefined) return { ok: true, value: me.value.data.district };
  const userUrl = `${CLEVER_USERS_URL}/${me.value.data.id}`;
  const user = await readClever(userUrl, token, deps, UserResponse);
  if (user.ok) return user;
  // Kept for the record: this reply's shape is what tells the next fix where the district went.
  console.info("clever user record names no district", { event: "clever.launch.user-record", ...user.reply });
  const district = await readClever(`${userUrl}/district`, token, deps, DistrictResponse);
  if (district.ok) return { ok: true, value: district.value.data.id };
  return district.reply.cleverStatus === 404 ? { ok: true, value: undefined } : district;
}

// Diagnostics for SCHO-249, to remove once Access's Clever sign-in works for sandbox demo logins:
// Access fails them with "Failed to fetch user/group information", so log what an OIDC sign-in
// would see for the same user, by shape alone: the ID token's claims and Clever's userinfo reply.
async function logOidcView(accessToken: string, idToken: string | undefined, deps: CleverLaunchDeps): Promise<void> {
  let idTokenClaims = "absent";
  if (idToken !== undefined) {
    try {
      const payload = idToken.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/");
      idTokenClaims = shapeOf(JSON.parse(atob(payload))).slice(0, 1000);
    } catch {
      idTokenClaims = "unreadable";
    }
  }
  const userinfo = await readClever(CLEVER_USERINFO_URL, accessToken, deps, z.never());
  console.info("clever launch oidc view", { event: "clever.launch.oidc-view", idTokenClaims, ...(userinfo.ok ? {} : userinfo.reply) });
}

/**
 * Answers a Clever portal launch: a 303 to the root of the installation registered for the user's
 * Clever district, or a plain page saying why not. GET only does this; HEAD is answered without
 * spending the code (a code is single-use and valid for a minute), and any other method is refused.
 */
export async function cleverLaunch(request: Request, deps: CleverLaunchDeps): Promise<Response> {
  if (request.method === "HEAD") return new Response(null, { status: 200, headers: { ...PAGE_HEADERS, ...LAUNCH_HEADERS } });
  if (request.method !== "GET") {
    return new Response(null, { status: 405, headers: { ...LAUNCH_HEADERS, allow: "GET, HEAD" } });
  }
  const code = Code.safeParse(new URL(request.url).searchParams.get("code"));
  if (!code.success) return refuse(deps.shell, "missing-code");
  if (deps.credentials === undefined) return refuse(deps.shell, "unconfigured");

  const token = await exchange(code.data, deps, deps.credentials);
  if (!token.ok) return refuse(deps.shell, "exchange-failed", token.reply);
  const district = await districtOf(token.value.accessToken, deps);
  await logOidcView(token.value.accessToken, token.value.idToken, deps);
  if (!district.ok) return refuse(deps.shell, "identity-failed", district.reply);

  if (district.value === undefined) {
    if (deps.unaffiliatedHostname === undefined) return refuse(deps.shell, "no-district");
    console.info("clever launch redirected", { event: "clever.launch.redirected", unaffiliated: true });
    return new Response(null, { status: 303, headers: { ...LAUNCH_HEADERS, location: `https://${deps.unaffiliatedHostname}/` } });
  }
  const hostname = await deps.hostnameFor(district.value);
  if (hostname === undefined) return refuse(deps.shell, "unknown-district");
  console.info("clever launch redirected", { event: "clever.launch.redirected" });
  return new Response(null, { status: 303, headers: { ...LAUNCH_HEADERS, location: `https://${hostname}/` } });
}
