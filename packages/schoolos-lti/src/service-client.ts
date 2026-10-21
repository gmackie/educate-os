// The token request is extracted from PlayTrek `packages/lti/src/ags/oauth2.ts` and the NRPS token
// helper in `packages/lti/src/nrps/client.ts` at commit 7258e4347. PlayTrek delegated signing to
// `@gmacko/lti`, cached one token per platform whatever scopes it carried (so an NRPS token could
// be handed to AGS and the reverse), and kept the cache in Redis. Here the client assertion is
// signed with the tool key, tokens are cached per (registration, scope set) in the isolate, and a
// bearer token is only ever sent to the origin of the service URL the platform signed.
import { SignJWT } from "jose";
import { z } from "zod";
import { SchoolOsError } from "@schoolos/contracts";
import type { PlatformRegistration, RegistrationKey } from "./registration.ts";
import { randomToken, type Clock } from "./stores.ts";
import type { ToolKeySet } from "./tool-keys.ts";

const LtiId = z.string().min(1).max(255);
const HttpsUrl = z.url({ protocol: /^https$/ });

/** The LTI Advantage OAuth 2 scopes SchoolOS requests. */
export const LTI_SCOPES = {
  /** AGS: create and manage line items. */
  lineItem: "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem",
  /** AGS: read line items. */
  lineItemReadonly: "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem.readonly",
  /** AGS: read results. */
  resultReadonly: "https://purl.imsglobal.org/spec/lti-ags/scope/result.readonly",
  /** AGS: publish scores. */
  score: "https://purl.imsglobal.org/spec/lti-ags/scope/score",
  /** NRPS: read a context's membership. */
  contextMembershipReadonly: "https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly",
} as const;

/** One of {@link LTI_SCOPES}. */
export type LtiScope = (typeof LTI_SCOPES)[keyof typeof LTI_SCOPES];

/** The AGS scopes, in the order they are requested. */
export const AGS_SCOPES: readonly LtiScope[] = [
  LTI_SCOPES.lineItem,
  LTI_SCOPES.lineItemReadonly,
  LTI_SCOPES.resultReadonly,
  LTI_SCOPES.score,
];

/**
 * The LTI Advantage services a platform offers for one context, as a verified launch reported them.
 * The host records this per offering; the AGS and NRPS clients and the grade route are built from
 * it. Every URL came from a launch the platform signed.
 */
export const LtiContextServices = z.strictObject({
  registration: z.strictObject({ issuer: HttpsUrl, clientId: LtiId }),
  /** The platform context (course) the services belong to. */
  contextId: LtiId,
  ags: z
    .strictObject({
      /** The AGS scopes the platform grants the tool in this context. */
      scopes: z.array(z.string().max(512)).max(16),
      lineItemsUrl: HttpsUrl.optional(),
      lineItemUrl: HttpsUrl.optional(),
    })
    .optional(),
  nrps: z.strictObject({ membershipsUrl: HttpsUrl }).optional(),
});
/** The LTI Advantage services of one context. */
export type LtiContextServices = z.infer<typeof LtiContextServices>;

/** The client assertion's lifetime. It is used once, immediately. */
const ASSERTION_LIFETIME_SECONDS = 5 * 60;
/** A cached token is renewed this long before it expires, so a request never carries a dying one. */
const TOKEN_RENEWAL_MARGIN_MS = 60_000;
/** The longest a token is cached, whatever lifetime the platform claims. */
const MAX_TOKEN_CACHE_MS = 60 * 60_000;
/** The largest service response body read, in bytes. */
export const MAX_SERVICE_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * The token endpoint's response. A stripping `z.object`: OAuth servers add members (`refresh_token`
 * is never issued for client credentials, but Canvas adds others), and the token is all SchoolOS
 * reads.
 */
const TokenResponse = z.object({
  access_token: z.string().min(1).max(8192),
  token_type: z.string().refine((type) => type.toLowerCase() === "bearer", "expected a bearer token"),
  expires_in: z.number().int().positive(),
  scope: z.string().optional(),
});

interface CachedToken {
  readonly accessToken: string;
  readonly renewAt: number;
}

/** What {@link LtiServiceClient} is built from. */
export interface LtiServiceClientOptions {
  /** The fetch to use for token requests and service calls. */
  readonly fetch: typeof fetch;
  /** The tool's current keys. Read on every token request, so a rotation takes effect at once. */
  readonly toolKeys: () => ToolKeySet;
  readonly now?: Clock;
}

/**
 * Authenticated calls to a platform's LTI Advantage services.
 *
 * Tokens come from the OAuth 2 client credentials grant with a JWT client assertion signed by the
 * tool key (LTI Security Framework §4.1). Each service requests only its own scopes, and a token is
 * cached per (registration, token URL, scope set) until shortly before it expires; a 401 from a
 * service drops the cached token and retries once with a fresh one.
 *
 * A bearer token is sent only to an https URL with the origin the caller names, which is the
 * origin of a service URL taken from a verified launch. Paging links and line item IDs that point
 * anywhere else are refused, so a platform response cannot redirect the token to another host.
 */
export class LtiServiceClient {
  readonly #fetch: typeof fetch;
  readonly #toolKeys: () => ToolKeySet;
  readonly #now: Clock;
  readonly #tokens = new Map<string, CachedToken>();
  readonly #inFlight = new Map<string, Promise<CachedToken>>();

  constructor(options: LtiServiceClientOptions) {
    this.#fetch = options.fetch;
    this.#toolKeys = options.toolKeys;
    this.#now = options.now ?? Date.now;
  }

  /**
   * An access token for `scopes` at `registration`'s platform, from the cache when it has one that
   * is not about to expire. Throws `SchoolOsError("unavailable")` if the platform refuses or cannot
   * be reached, and `forbidden` if it grants fewer scopes than requested.
   */
  async accessToken(registration: PlatformRegistration, scopes: readonly LtiScope[]): Promise<string> {
    const key = tokenCacheKey(registration, scopes);
    const cached = this.#tokens.get(key);
    if (cached !== undefined && cached.renewAt > this.#now()) return cached.accessToken;
    let pending = this.#inFlight.get(key);
    if (pending === undefined) {
      pending = this.#requestToken(registration, scopes).finally(() => this.#inFlight.delete(key));
      this.#inFlight.set(key, pending);
    }
    const token = await pending;
    this.#tokens.set(key, token);
    return token.accessToken;
  }

  /**
   * Calls a service URL with a bearer token for `scopes`. `url` must be https with origin
   * `origin`. Returns the response whatever its status, except that a 401 is retried once
   * with a new token.
   */
  async call(
    registration: PlatformRegistration,
    scopes: readonly LtiScope[],
    origin: string,
    url: string,
    init: { method: "GET" | "POST"; accept: string; contentType?: string; body?: string },
  ): Promise<Response> {
    assertServiceUrl(url, origin);
    const send = async (): Promise<Response> => {
      const headers: Record<string, string> = {
        authorization: `Bearer ${await this.accessToken(registration, scopes)}`,
        accept: init.accept,
      };
      if (init.contentType !== undefined) headers["content-type"] = init.contentType;
      try {
        return await this.#fetch(url, { method: init.method, headers, body: init.body, redirect: "error" });
      } catch {
        throw new SchoolOsError("unavailable", "The LTI platform could not be reached.");
      }
    };
    const response = await send();
    if (response.status !== 401) return response;
    this.#tokens.delete(tokenCacheKey(registration, scopes));
    return send();
  }

  async #requestToken(registration: PlatformRegistration, scopes: readonly LtiScope[]): Promise<CachedToken> {
    const signing = this.#toolKeys().signing;
    const issuedAt = Math.floor(this.#now() / 1000);
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: signing.kid, typ: "JWT" })
      .setIssuer(registration.clientId)
      .setSubject(registration.clientId)
      .setAudience(registration.authTokenUrl)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + ASSERTION_LIFETIME_SECONDS)
      .setJti(randomToken())
      .sign(signing.privateKey);
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: assertion,
      scope: scopes.join(" "),
    });

    let payload: unknown;
    try {
      const response = await this.#fetch(registration.authTokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: body.toString(),
        redirect: "error",
      });
      // The body of a refusal is not read: it is the platform's text and may echo the assertion.
      if (!response.ok) throw new Error(`status ${response.status}`);
      payload = await readJson(response);
    } catch {
      throw new SchoolOsError("unavailable", "The LTI platform did not issue a service token.");
    }
    const parsed = TokenResponse.safeParse(payload);
    if (!parsed.success) throw new SchoolOsError("unavailable", "The LTI platform's token response is malformed.");
    const token = parsed.data;
    // An omitted `scope` means the requested scopes were granted (RFC 6749 §5.1).
    if (token.scope !== undefined) {
      const granted = new Set(token.scope.split(" "));
      if (!scopes.every((scope) => granted.has(scope))) {
        throw new SchoolOsError("forbidden", "The LTI platform did not grant the service scopes SchoolOS needs.");
      }
    }
    const lifetimeMs = Math.min(token.expires_in * 1000, MAX_TOKEN_CACHE_MS);
    return { accessToken: token.access_token, renewAt: this.#now() + lifetimeMs - TOKEN_RENEWAL_MARGIN_MS };
  }
}

function tokenCacheKey(registration: PlatformRegistration, scopes: readonly LtiScope[]): string {
  return JSON.stringify([registration.issuer, registration.clientId, registration.authTokenUrl, scopes.toSorted()]);
}

/** Throws unless `url` is an https URL with origin `origin`. */
export function assertServiceUrl(url: string, origin: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SchoolOsError("validation-failed", "The LTI service URL is malformed.");
  }
  if (parsed.protocol !== "https:" || parsed.origin !== origin) {
    throw new SchoolOsError("forbidden", "The LTI service URL is outside the platform's service origin.");
  }
}

/** The origin of a service URL. */
export function serviceOrigin(url: string): string {
  return new URL(url).origin;
}

/**
 * Reads a JSON body of at most {@link MAX_SERVICE_RESPONSE_BYTES}. Throws a plain `Error` on an
 * oversized or unparsable body; callers turn it into their own `SchoolOsError`.
 */
export async function readJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_SERVICE_RESPONSE_BYTES) throw new Error("response too large");
  const text = await response.text();
  if (text.length > MAX_SERVICE_RESPONSE_BYTES) throw new Error("response too large");
  return JSON.parse(text);
}

/**
 * The URL of the next page from an RFC 8288 `Link` header, or `undefined`. Handles several links in
 * one header and `rel` values listing more than one relation.
 */
export function nextPageUrl(linkHeader: string | null, base: string): string | undefined {
  if (linkHeader === null) return undefined;
  for (const match of linkHeader.matchAll(/<([^>]*)>((?:\s*;\s*[^;,]+)*)/g)) {
    const rel = /;\s*rel\s*=\s*(?:"([^"]*)"|([^\s;,]+))/i.exec(match[2] ?? "");
    const relations = (rel?.[1] ?? rel?.[2] ?? "").toLowerCase().split(/\s+/);
    if (relations.includes("next")) return new URL(match[1]!, base).toString();
  }
  return undefined;
}

/** A registration key's JSON identity, for comparisons. */
export function sameRegistration(a: RegistrationKey, b: RegistrationKey): boolean {
  return a.issuer === b.issuer && a.clientId === b.clientId;
}
