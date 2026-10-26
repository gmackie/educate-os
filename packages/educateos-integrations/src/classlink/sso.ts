// ClassLink sign-in: the OpenID Connect authorization-code flow with PKCE (OIDC Core 1.0 §3.1,
// RFC 7636) against ClassLink's published endpoints, ending in a `VerifiedIdentity` that the
// district resolves through `(district, issuer, subject)` like any other trusted issuer.
//
// ClassLink uses one issuer for every tenant, so the issuer alone cannot say which district a
// sign-in belongs to: a token from another tenant is refused on its tenant claim before its subject
// is read. Nothing else in the token (name, email, role, `classLink_role`) is read; the district's
// directory alone decides who the person is and what they may do.
//
// Errors carry no token, code or secret. A provider that is down is `unavailable`, so the person is
// told to try again rather than that their sign-in is not linked.
import { ClassLinkSso, EducateOsError, VerifiedIdentity, type ClassLinkSsoInput } from "@educateos/contracts";
import { createRemoteJWKSet, customFetch, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { discard, readJson } from "../http.ts";

const REFUSED = "ClassLink did not confirm this sign-in. Try signing in again.";
const UNAVAILABLE = "ClassLink sign-in is unavailable right now. Try again in a few minutes.";
const MISCONFIGURED = "ClassLink sign-in is misconfigured for this district. Ask an administrator to check it.";
// A token response is a few kilobytes at most, even with a long id_token.
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
// Leeway for the IdP's clock, as OIDC Core §3.1.3.7 allows.
const CLOCK_TOLERANCE_SECONDS = 60;

function parseSso(sso: ClassLinkSsoInput): ClassLinkSso {
  const parsed = ClassLinkSso.safeParse(sso);
  if (!parsed.success) throw new EducateOsError("unavailable", MISCONFIGURED);
  return parsed.data;
}

/** What one sign-in attempt carries from the authorization request to the callback. */
export interface ClassLinkAuthorizationRequest {
  /** Where ClassLink sends the person back. Must be registered with the app. */
  redirectUri: string;
  /** The CSRF `state`, checked by the caller when the person comes back. */
  state: string;
  /** The `nonce` the id_token must carry. */
  nonce: string;
  /** The PKCE S256 challenge of the verifier the callback sends. */
  codeChallenge: string;
  /** Who is expected to sign in, if known. */
  loginHint?: string;
}

/** The URL that starts a ClassLink sign-in. */
export function classLinkAuthorizationUrl(sso: ClassLinkSsoInput, request: ClassLinkAuthorizationRequest): URL {
  const config = parseSso(sso);
  const url = new URL(config.endpoints.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", request.redirectUri);
  url.searchParams.set("scope", config.scopes.join(" "));
  url.searchParams.set("state", request.state);
  url.searchParams.set("nonce", request.nonce);
  url.searchParams.set("code_challenge", request.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (request.loginHint !== undefined) url.searchParams.set("login_hint", request.loginHint);
  return url;
}

/**
 * ClassLink's signing keys, fetched through `fetch` and cached as `jose` caches a remote key set
 * (refetched for an unknown `kid`, so a rotated key is picked up). Build one per isolate.
 */
export function classLinkKeys(sso: ClassLinkSsoInput, fetch: typeof globalThis.fetch): JWTVerifyGetKey {
  const config = parseSso(sso);
  return createRemoteJWKSet(new URL(config.endpoints.jwksUri), {
    timeoutDuration: DEFAULT_TIMEOUT_MS,
    [customFetch]: (url: string, init: RequestInit) => fetch(url, { ...init, redirect: "error" }),
  });
}

/** Everything one callback needs. */
export interface ClassLinkSignInOptions {
  /** The district's ClassLink sign-in, from its configuration revision. */
  sso: ClassLinkSsoInput;
  /** The relying party's client secret (`CLASSLINK_SSO_CLIENT_SECRET`). */
  clientSecret: string;
  /** The `code` ClassLink sent back. */
  code: string;
  /** The redirect URI the authorization request named. */
  redirectUri: string;
  /** The PKCE verifier of the request's challenge. */
  codeVerifier: string;
  /** The nonce the request sent. */
  nonce: string;
  /** The fetch the token request goes through. */
  fetch: typeof globalThis.fetch;
  /** The signing keys, normally {@link classLinkKeys}. */
  keys: JWTVerifyGetKey;
  /** The time in milliseconds, for token expiry. */
  clock?: () => number;
}

/**
 * Completes a ClassLink sign-in: redeems the code, verifies the id_token and reads the identity.
 *
 * @throws EducateOsError `unauthenticated` when ClassLink refuses the code or the token fails any
 *   check; `unavailable` when ClassLink cannot be reached, fails, or rate limits.
 */
export async function classLinkSignIn(options: ClassLinkSignInOptions): Promise<VerifiedIdentity> {
  const config = parseSso(options.sso);
  const idToken = await redeemCode(config, options);
  const payload = await verifyClassLinkIdToken(idToken, { sso: config, keys: options.keys, nonce: options.nonce, ...(options.clock === undefined ? {} : { clock: options.clock }) });
  return identityFromClassLinkClaims(payload, config);
}

async function redeemCode(config: ClassLinkSso, options: ClassLinkSignInOptions): Promise<string> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: options.code,
    redirect_uri: options.redirectUri,
    code_verifier: options.codeVerifier,
  });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (config.clientAuthentication === "client_secret_post") {
    form.set("client_id", config.clientId);
    form.set("client_secret", options.clientSecret);
  } else {
    headers["authorization"] = `Basic ${btoa(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(options.clientSecret)}`)}`;
  }
  let response: Response;
  try {
    response = await options.fetch(config.endpoints.tokenEndpoint, {
      method: "POST",
      headers,
      body: form.toString(),
      redirect: "error",
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch {
    throw new EducateOsError("unavailable", UNAVAILABLE);
  }
  if (!response.ok) {
    if (response.status !== 400 && response.status !== 401) {
      await discard(response);
      throw new EducateOsError("unavailable", UNAVAILABLE);
    }
    // RFC 6749 §5.2: `invalid_client` (or any 401) means our client ID or secret is wrong, which no
    // retry by the person fixes; anything else (`invalid_grant`: a used, expired or mismatched code
    // or verifier) is this sign-in's fault.
    const error = (await readCappedJson(response) as { error?: unknown } | undefined)?.error;
    if (response.status === 401 || error === "invalid_client") throw new EducateOsError("unavailable", MISCONFIGURED);
    throw new EducateOsError("unauthenticated", REFUSED);
  }
  const body = await readCappedJson(response);
  // A 200 that is oversized or not JSON is ClassLink failing; a JSON answer without an id_token is a refusal.
  if (body === undefined) throw new EducateOsError("unavailable", UNAVAILABLE);
  const idToken = (body as { id_token?: unknown } | null)?.id_token;
  if (typeof idToken !== "string" || idToken.length === 0) throw new EducateOsError("unauthenticated", REFUSED);
  return idToken;
}

/** The body as JSON, or `undefined` when it is oversized or not JSON. */
async function readCappedJson(response: Response): Promise<unknown> {
  try {
    return await readJson("ClassLink token", response, MAX_TOKEN_RESPONSE_BYTES);
  } catch {
    return undefined;
  }
}

// Marks a key set that could not be read, as against a key that did not verify.
class KeysUnavailable extends Error {}

/**
 * Verifies a ClassLink id_token: RS256 signature against `keys`, `iss`, `aud`, `exp`/`iat` with
 * {@link CLOCK_TOLERANCE_SECONDS} of leeway, and `nonce`. Returns its payload.
 *
 * @throws EducateOsError `unauthenticated` for a token that fails a check; `unavailable` when the
 *   keys could not be fetched.
 */
export async function verifyClassLinkIdToken(
  idToken: string,
  options: { sso: ClassLinkSsoInput; keys: JWTVerifyGetKey; nonce: string; clock?: () => number },
): Promise<JWTPayload> {
  const config = parseSso(options.sso);
  const keys: JWTVerifyGetKey = async (header, token) => {
    try {
      return await options.keys(header, token);
    } catch (error) {
      // No key matching the token's `kid` is the token's fault; anything else is the key set's.
      if (error instanceof errors.JWKSNoMatchingKey || error instanceof errors.JWKSMultipleMatchingKeys) throw error;
      throw new KeysUnavailable();
    }
  };
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, keys, {
      issuer: config.issuer,
      audience: config.clientId,
      algorithms: ["RS256"],
      requiredClaims: ["iss", "aud", "exp", "iat", "sub"],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      ...(options.clock === undefined ? {} : { currentDate: new Date(options.clock()) }),
    }));
  } catch (error) {
    if (error instanceof KeysUnavailable) throw new EducateOsError("unavailable", UNAVAILABLE);
    throw new EducateOsError("unauthenticated", REFUSED);
  }
  if (payload.nonce !== options.nonce) throw new EducateOsError("unauthenticated", REFUSED);
  return payload;
}

/**
 * Reads the identity from a verified ClassLink id_token payload: the configured issuer, the
 * district's tenant, and the configured subject claim. Only those three claims are read.
 *
 * @throws EducateOsError `unauthenticated` for another issuer or tenant, or a missing subject.
 */
export function identityFromClassLinkClaims(payload: Readonly<Record<string, unknown>>, sso: ClassLinkSsoInput): VerifiedIdentity {
  const config = parseSso(sso);
  if (payload.iss !== config.issuer) throw new EducateOsError("unauthenticated", REFUSED);
  // ClassLink sends the tenant as a number; a string of the same digits is accepted too.
  const tenant = payload[config.tenantClaim];
  if ((typeof tenant !== "number" && typeof tenant !== "string") || String(tenant) !== config.tenantId) {
    throw new EducateOsError("unauthenticated", "This ClassLink account belongs to another organization.");
  }
  const parsed = VerifiedIdentity.safeParse({ issuer: config.issuer, subject: payload[config.subjectClaim], credential: "person" });
  if (!parsed.success) throw new EducateOsError("unauthenticated", "ClassLink did not say who signed in.");
  return parsed.data;
}
