// Access tokens for a Google service account with domain-wide delegation: the account signs a JWT
// naming the Workspace user it acts as (`sub`) and the scopes it wants, and trades it at Google's
// token endpoint for that user's access token (RFC 7523, the `jwt-bearer` grant). New for SCHO-77.
// https://developers.google.com/identity/protocols/oauth2/service-account#delegatingauthority
//
// Signing uses WebCrypto, so the same code runs on Workers and Node. The private key never leaves
// this module: it is imported as a non-extractable CryptoKey, and no error or log names it.
import { z } from "zod";
import { RosterSyncError } from "../sync-run.ts";
import { DEFAULT_RETRY_POLICY, fetchWithRetry, realSleep } from "../oneroster/rest/retry.ts";
import type { RetryPolicy, Sleep } from "../oneroster/rest/retry.ts";
import { discard, readBoundedJson } from "./http.ts";

/** Google's OAuth 2.0 token endpoint, the audience of every assertion. */
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

const SCOPE_PREFIX = "https://www.googleapis.com/auth/";

/** The Classroom and Admin SDK scopes a district grants EducateOS's service account. */
export const GOOGLE_SCOPES = {
  courses: `${SCOPE_PREFIX}classroom.courses`,
  coursesReadonly: `${SCOPE_PREFIX}classroom.courses.readonly`,
  rosters: `${SCOPE_PREFIX}classroom.rosters`,
  rostersReadonly: `${SCOPE_PREFIX}classroom.rosters.readonly`,
  profileEmails: `${SCOPE_PREFIX}classroom.profile.emails`,
  courseworkStudents: `${SCOPE_PREFIX}classroom.coursework.students`,
} as const;

/** What a roster sync reads with: courses, rosters, and members' Workspace emails. Read-only. */
export const CLASSROOM_ROSTER_SCOPES: readonly string[] = [
  GOOGLE_SCOPES.coursesReadonly,
  GOOGLE_SCOPES.rostersReadonly,
  GOOGLE_SCOPES.profileEmails,
];

/**
 * A delegated token may ask only for scopes the domain delegated: a broader scope does not cover
 * its `.readonly` form. A domain that delegated `classroom.courses` and `classroom.rosters` (as the
 * demo tenant's did) gets these instead of {@link CLASSROOM_ROSTER_SCOPES}; the calls made are
 * the same reads.
 */
export const CLASSROOM_ROSTER_SCOPES_READ_WRITE: readonly string[] = [
  GOOGLE_SCOPES.courses,
  GOOGLE_SCOPES.rosters,
  GOOGLE_SCOPES.profileEmails,
];

/** What grade sync adds: creating coursework and grading its submissions. */
export const CLASSROOM_GRADE_SCOPES: readonly string[] = [...CLASSROOM_ROSTER_SCOPES, GOOGLE_SCOPES.courseworkStudents];

/**
 * The fields of a service account's JSON key that signing reads. Google's key file carries more
 * (`project_id`, `client_id`, the certificate URLs), which are ignored. Its `token_uri` is ignored
 * too: assertions only ever go to {@link GOOGLE_TOKEN_URL}.
 */
export const ServiceAccountKey = z.object({
  type: z.literal("service_account"),
  client_email: z.email(),
  private_key_id: z.string().min(1).max(200).optional(),
  private_key: z.string().regex(/^-----BEGIN PRIVATE KEY-----\s[\s\S]+\s-----END PRIVATE KEY-----\s*$/, "is not a PKCS #8 PEM private key"),
});
/** A service account key. */
export type ServiceAccountKey = z.infer<typeof ServiceAccountKey>;

/**
 * Access tokens for Workspace users, one per user the service account acts as. A domain-wide
 * delegation grant lets the account act as any user in the domain, within the scopes the domain's
 * administrator delegated.
 */
export interface DelegatedTokens {
  /** An access token acting as the Workspace user with this primary email. */
  token(subject: string): Promise<string>;
  /** Forgets the subject's cached token, after Google refused it. */
  invalidate(subject: string, token: string): void;
}

/** Everything {@link serviceAccountTokens} needs. */
export interface ServiceAccountTokenOptions {
  /** The service account's JSON key, parsed or as text. */
  key: unknown;
  /** The scopes every token asks for. The domain must have delegated each of them. */
  scopes: readonly string[];
  /** The fetch token requests go through. */
  fetch: typeof fetch;
  /** The token endpoint. Only tests change it. */
  tokenUrl?: string;
  /** The time in milliseconds, for assertion and token lifetimes. */
  clock?: () => number;
  /** The retry policy, when not {@link DEFAULT_RETRY_POLICY}. */
  retry?: RetryPolicy;
  /** How to wait between attempts. */
  sleep?: Sleep;
}

const TokenResponse = z.object({
  access_token: z.string().min(1),
  token_type: z.string().regex(/^bearer$/i),
  expires_in: z.number().int().positive(),
});

const ASSERTION_LIFETIME_S = 3600;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const REFRESH_MARGIN_MS = 60_000;
const SUBJECT = z.email();

/**
 * Delegated access tokens for a service account. Tokens are cached per subject until a minute
 * before they expire, and concurrent callers for one subject share a request.
 *
 * Failures are {@link RosterSyncError}s: `auth-failed` when Google refuses the assertion (the key
 * was revoked, delegation is missing, or a scope was not delegated: Google answers all of these
 * with `unauthorized_client` or `invalid_grant`), and `source-unavailable` or `rate-limited` when
 * the endpoint cannot be reached. No message names the key or includes a response body.
 */
export function serviceAccountTokens(options: ServiceAccountTokenOptions): DelegatedTokens {
  const raw = typeof options.key === "string" ? parseJson(options.key) : options.key;
  const parsed = ServiceAccountKey.safeParse(raw);
  if (!parsed.success) throw new RosterSyncError("internal-error", "the Google service account key is not a service account JSON key");
  const key = parsed.data;
  if (options.scopes.length === 0) throw new RosterSyncError("internal-error", "a delegated token needs at least one scope");
  const tokenUrl = options.tokenUrl ?? GOOGLE_TOKEN_URL;
  const clock = options.clock ?? Date.now;
  const retry = options.retry ?? DEFAULT_RETRY_POLICY;
  const sleep = options.sleep ?? realSleep;
  const scope = options.scopes.join(" ");
  let signingKey: Promise<CryptoKey> | undefined;
  const cache = new Map<string, { value: string; refreshAt: number }>();
  const pending = new Map<string, Promise<string>>();

  const request = async (subject: string): Promise<string> => {
    signingKey ??= importPrivateKey(key.private_key);
    const issuedAt = clock();
    const iat = Math.floor(issuedAt / 1000);
    const assertion = await signJwt(
      await signingKey,
      { alg: "RS256", typ: "JWT", ...(key.private_key_id === undefined ? {} : { kid: key.private_key_id }) },
      { iss: key.client_email, sub: subject, scope, aud: tokenUrl, iat, exp: iat + ASSERTION_LIFETIME_S },
    );
    let response: Response;
    try {
      response = await fetchWithRetry(
        () => options.fetch(tokenUrl, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
          // workerd refuses `redirect: "error"`; a 3xx is refused below instead.
          redirect: "manual",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }),
        retry,
        sleep,
        clock,
      );
    } catch {
      throw new RosterSyncError("source-unavailable", "the Google token request did not complete");
    }
    if (response.status >= 300 && response.status < 400) {
      await discard(response);
      throw new RosterSyncError("invalid-response", `the Google token endpoint redirected (HTTP ${response.status})`);
    }
    if (!response.ok) {
      await discard(response);
      // RFC 6749 section 5.2: a refused grant or client is a 400 or 401.
      const code = response.status === 400 || response.status === 401 || response.status === 403
        ? "auth-failed"
        : response.status === 429 ? "rate-limited" : "source-unavailable";
      throw new RosterSyncError(code, `Google refused a delegated token with HTTP ${response.status}; check the key and the domain-wide delegation of its scopes`);
    }
    const body = TokenResponse.safeParse(await readBoundedJson("token", response, MAX_TOKEN_RESPONSE_BYTES));
    if (!body.success) throw new RosterSyncError("invalid-response", "the Google token response is not a bearer token");
    const lifetime = body.data.expires_in * 1000;
    cache.set(subject, { value: body.data.access_token, refreshAt: issuedAt + lifetime - Math.min(REFRESH_MARGIN_MS, lifetime / 2) });
    return body.data.access_token;
  };

  return {
    token(subject) {
      if (!SUBJECT.safeParse(subject).success) {
        return Promise.reject(new RosterSyncError("internal-error", "a delegated token acts as a Workspace user, named by email"));
      }
      const cached = cache.get(subject);
      if (cached !== undefined && clock() < cached.refreshAt) return Promise.resolve(cached.value);
      let inFlight = pending.get(subject);
      if (inFlight === undefined) {
        inFlight = request(subject).finally(() => pending.delete(subject));
        pending.set(subject, inFlight);
      }
      return inFlight;
    },
    invalidate(subject, token) {
      if (cache.get(subject)?.value === token) cache.delete(subject);
    },
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  try {
    const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
    return await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch {
    throw new RosterSyncError("internal-error", "the Google service account key is not an RSA private key");
  }
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function signJwt(key: CryptoKey, header: object, claims: object): Promise<string> {
  const encode = (value: object) => base64url(new TextEncoder().encode(JSON.stringify(value)));
  const input = `${encode(header)}.${encode(claims)}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
  return `${input}.${base64url(new Uint8Array(signature))}`;
}
