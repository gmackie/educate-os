// OAuth 2.0 authorization-code flow with PKCE for the root's public Cloudflare client (roadmap
// §3.1 step 2). A public client has no secret: PKCE binds the code to the browser session that
// started the flow. The scope names and endpoints are those Wrangler's own `wrangler login` uses;
// docs/educateos/installer-permissions.md records which installer operation needs which scope and
// how much of that has been verified.
import { EducateOsError } from "@educateos/contracts";
import { toBase64Url } from "@educateos/fleet";
import { z } from "zod";
import type { TokenProvider } from "./token.ts";

/** Cloudflare's OAuth endpoints, as used by Wrangler. */
export const CLOUDFLARE_OAUTH_ENDPOINTS = {
  authorization: "https://dash.cloudflare.com/oauth2/auth",
  token: "https://dash.cloudflare.com/oauth2/token",
  revocation: "https://dash.cloudflare.com/oauth2/revoke",
} as const;

/**
 * How sure we are that a scope does what the installer needs. `wrangler-requested` means the
 * scope name exists (Wrangler requests it) but its coverage of the operation is inferred;
 * `unverified` means even the scope name is a guess.
 */
export type ScopeEvidence = "wrangler-requested" | "unverified";

/** One OAuth scope the installer requests, what it is for, and the evidence for it. */
export interface InstallerScope {
  scope: string;
  purpose: string;
  evidence: ScopeEvidence;
}

/**
 * The scopes the installer's OAuth client requests. Kept to what the reconciler calls; see the
 * permissions doc for the per-operation mapping. Access and AI Gateway have no scope Wrangler
 * requests, so OAuth mode may be unable to manage them; district-run mode is the fallback.
 */
export const INSTALLER_SCOPES: readonly InstallerScope[] = [
  { scope: "account:read", purpose: "account lookup and plan subscriptions", evidence: "wrangler-requested" },
  { scope: "user:read", purpose: "identify the consenting account owner", evidence: "wrangler-requested" },
  { scope: "zone:read", purpose: "find the district zone and its DNS records", evidence: "wrangler-requested" },
  { scope: "workers_scripts:write", purpose: "upload Workers, assets, secrets, versions and deployments", evidence: "wrangler-requested" },
  { scope: "workers_routes:write", purpose: "attach the custom domain", evidence: "wrangler-requested" },
  { scope: "workers_kv:write", purpose: "create KV namespaces", evidence: "wrangler-requested" },
  { scope: "workers:write", purpose: "create R2 buckets", evidence: "wrangler-requested" },
  { scope: "d1:write", purpose: "create D1 databases and run release migrations", evidence: "wrangler-requested" },
  { scope: "ai:write", purpose: "create the optional AI Gateway", evidence: "unverified" },
  { scope: "access:write", purpose: "create the Access application and policy", evidence: "unverified" },
  { scope: "offline_access", purpose: "refresh tokens, so a long install survives token expiry", evidence: "wrangler-requested" },
];

/** A PKCE verifier and its S256 challenge. Keep the verifier server-side until the code returns. */
export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

/** The S256 challenge for a PKCE verifier (RFC 7636 §4.2). */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}

/** A fresh PKCE pair: a 43-character verifier from 32 random bytes, and its challenge. */
export async function createPkcePair(): Promise<PkcePair> {
  const verifier = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, challenge: await pkceChallenge(verifier), method: "S256" };
}

/** A random `state` value to tie the redirect back to the session that started the flow. */
export function createOAuthState(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(24)));
}

/** What an authorization URL needs. */
export interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  state: string;
  pkce: PkcePair;
  /** Defaults to every {@link INSTALLER_SCOPES} scope. */
  scopes?: readonly string[];
}

/** The URL to send the district's Cloudflare owner to for consent. */
export function buildAuthorizationUrl(request: AuthorizationRequest): URL {
  const url = new URL(CLOUDFLARE_OAUTH_ENDPOINTS.authorization);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", request.clientId);
  url.searchParams.set("redirect_uri", request.redirectUri);
  url.searchParams.set("scope", (request.scopes ?? INSTALLER_SCOPES.map((s) => s.scope)).join(" "));
  url.searchParams.set("state", request.state);
  url.searchParams.set("code_challenge", request.pkce.challenge);
  url.searchParams.set("code_challenge_method", request.pkce.method);
  return url;
}

// A third-party response, so unknown fields are stripped rather than rejected.
const TokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive(),
  token_type: z.string(),
  scope: z.string().optional(),
});

/** Tokens from Cloudflare's token endpoint. */
export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  scopes: string[];
}

/** What a token request needs besides its grant. */
export interface TokenRequestContext {
  clientId: string;
  fetch?: typeof fetch;
  now?: () => number;
}

async function requestTokens(context: TokenRequestContext, grant: Record<string, string>): Promise<OAuthTokens> {
  const doFetch = context.fetch ?? fetch;
  const body = new URLSearchParams({ ...grant, client_id: context.clientId });
  let response: Response;
  try {
    response = await doFetch(CLOUDFLARE_OAUTH_ENDPOINTS.token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch {
    throw new EducateOsError("unavailable", "Cloudflare token endpoint unreachable");
  }
  if (!response.ok) {
    // 400 invalid_grant is how a revoked grant, or a reused or expired code, presents.
    throw new EducateOsError(
      response.status === 400 || response.status === 401 ? "unauthenticated" : "unavailable",
      `Cloudflare token endpoint returned HTTP ${response.status}`,
    );
  }
  const parsed = TokenResponse.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new EducateOsError("unavailable", "Cloudflare token endpoint returned an unexpected body");
  const now = (context.now ?? Date.now)();
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    expiresAt: now + parsed.data.expires_in * 1000,
    scopes: parsed.data.scope?.split(" ").filter(Boolean) ?? [],
  };
}

/** Exchanges an authorization code (with its PKCE verifier) for tokens. */
export async function exchangeAuthorizationCode(
  context: TokenRequestContext & { redirectUri: string; code: string; verifier: string },
): Promise<OAuthTokens> {
  return await requestTokens(context, {
    grant_type: "authorization_code",
    code: context.code,
    redirect_uri: context.redirectUri,
    code_verifier: context.verifier,
  });
}

// Refresh this long before expiry so a call started just before expiry doesn't fail mid-flight.
const REFRESH_MARGIN_MS = 60_000;

/**
 * An OAuth-mode {@link TokenProvider}: hands out the access token and refreshes it before it
 * expires. Once Cloudflare refuses the refresh (the owner revoked the grant), every later call
 * fails with `unauthenticated` without contacting Cloudflare again.
 */
export class OAuthTokenProvider implements TokenProvider {
  readonly mode = "oauth";
  readonly #context: TokenRequestContext;
  #tokens: OAuthTokens;
  #revoked = false;

  constructor(tokens: OAuthTokens, context: TokenRequestContext) {
    this.#tokens = tokens;
    this.#context = context;
  }

  async accessToken(): Promise<string> {
    if (this.#revoked) throw new EducateOsError("unauthenticated", "the OAuth grant was revoked");
    const now = (this.#context.now ?? Date.now)();
    if (this.#tokens.expiresAt - now > REFRESH_MARGIN_MS) return this.#tokens.accessToken;
    const refreshToken = this.#tokens.refreshToken;
    if (!refreshToken) throw new EducateOsError("unauthenticated", "the OAuth access token expired and cannot be refreshed");
    try {
      this.#tokens = await requestTokens(this.#context, { grant_type: "refresh_token", refresh_token: refreshToken });
    } catch (error) {
      if (error instanceof EducateOsError && error.code === "unauthenticated") this.#revoked = true;
      throw error;
    }
    return this.#tokens.accessToken;
  }
}
