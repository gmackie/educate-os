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

/** How long each call to Clever may take. A launch is a person waiting on a redirect. */
export const CLEVER_REQUEST_TIMEOUT_MS = 10_000;

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

/** What {@link cleverLaunch} is given. */
export interface CleverLaunchDeps {
  shell: SiteShell;
  /** Undefined when the Worker has no Clever secrets: every launch is then refused. */
  credentials: CleverAppCredentials | undefined;
  /** The hostname of the registered installation for a Clever district ID, if any. */
  hostnameFor: (cleverDistrictId: string) => Promise<string | undefined>;
  /** Reaches Clever. Tests stand a fake in its place. */
  fetch: (input: string, init: RequestInit) => Promise<Response>;
}

// Clever's object IDs: 24 hex characters.
const CleverId = z.string().regex(/^[0-9a-f]{24}$/);
// Clever's codes are opaque; this only keeps an absurd one from being sent on.
const Code = z.string().regex(/^[\x21-\x7e]{1,512}$/);
const TokenResponse = z.object({ access_token: z.string().min(1) });
const MeResponse = z.object({ data: z.object({ district: CleverId }) });

/** Why a launch was turned away, as logged. Never the code, the token, or anyone's IDs. */
export type CleverLaunchFailure = "missing-code" | "unconfigured" | "exchange-failed" | "identity-failed" | "unknown-district";

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
};

function refuse(shell: SiteShell, failure: CleverLaunchFailure): Response {
  console.warn("clever launch refused", { event: "clever.launch.refused", reason: failure });
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

async function readJson<T>(response: Response, schema: z.ZodType<T>): Promise<T | undefined> {
  // A redirect counts as a failure like any other non-2xx: `redirect: "manual"` keeps it unfollowed.
  if (!response.ok) {
    await response.body?.cancel();
    return undefined;
  }
  try {
    const parsed = schema.safeParse(await response.json());
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

// Exchanges the code for an access token (HTTP Basic with the app's client, as Clever documents).
async function exchange(code: string, deps: CleverLaunchDeps, credentials: CleverAppCredentials): Promise<string | undefined> {
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
    return (await readJson(response, TokenResponse))?.access_token;
  } catch {
    return undefined;
  }
}

// Reads the signed-in user's Clever district with the token, the token's one use.
async function districtOf(token: string, deps: CleverLaunchDeps): Promise<string | undefined> {
  try {
    const response = await deps.fetch(CLEVER_ME_URL, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(CLEVER_REQUEST_TIMEOUT_MS),
    });
    return (await readJson(response, MeResponse))?.data.district;
  } catch {
    return undefined;
  }
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
  if (token === undefined) return refuse(deps.shell, "exchange-failed");
  const district = await districtOf(token, deps);
  if (district === undefined) return refuse(deps.shell, "identity-failed");

  const hostname = await deps.hostnameFor(district);
  if (hostname === undefined) return refuse(deps.shell, "unknown-district");
  console.info("clever launch redirected", { event: "clever.launch.redirected" });
  return new Response(null, { status: 303, headers: { ...LAUNCH_HEADERS, location: `https://${hostname}/` } });
}
