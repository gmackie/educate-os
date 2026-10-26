// A fake OpenID Connect provider: the authorization-code flow of OpenID Connect Core 1.0 §3.1 over
// RFC 6749 (errors §4.1.2.1 and §5.2, client authentication §2.3.1), PKCE (RFC 7636), discovery
// (OpenID Connect Discovery 1.0), a JWKS (RFC 7517) and userinfo (OIDC Core §5.3). The issuer's
// specifics come from a preset (see `presets.ts`). There is no sign-in UI: the person signing in
// is named by `login_hint` or the `selectUser` option.
import { SignJWT, type JWK } from "jose";
import { Fake, basicCredentials, bearer, formOf, TokenIssuer, type FakeOptions } from "../fake.ts";
import { studentsToRemove, validateSeed, withoutPeople } from "../seed.ts";
import type { DistrictSeed, PersonSeed } from "../types.ts";
import { OIDC_PRESETS, type OidcPreset, type OidcPresetName } from "./presets.ts";

/** A registered relying party. */
export interface OidcClient {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Exact-match redirect URIs. */
  readonly redirectUris: readonly string[];
}

/** Options of {@link OidcFake}. */
export interface OidcFakeOptions extends FakeOptions {
  readonly seed: DistrictSeed;
  /** A built-in preset's name, or a preset of one's own. */
  readonly preset: OidcPresetName | OidcPreset;
  readonly clients: readonly OidcClient[];
  /**
   * Chooses who signs in, from the authorization request's parameters: a seed person ID, an email
   * or the issuer's subject. Returning undefined falls back to `login_hint`.
   */
  readonly selectUser?: (params: URLSearchParams) => string | undefined;
}

interface PendingCode {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly personId: string;
  readonly scopes: readonly string[];
  readonly nonce: string | undefined;
  readonly challenge: { readonly value: string; readonly method: "S256" | "plain" } | undefined;
  readonly expiresAt: number;
  used: boolean;
  readonly accessTokens: string[];
}

interface AccessGrant {
  readonly personId: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };

/** An RFC 6749 §5.2 error response. */
function oauthError(error: string, description: string, status = 400, headers: Record<string, string> = {}): Response {
  return Response.json({ error, error_description: description }, { status, headers: { ...NO_STORE, ...headers } });
}

/**
 * An OpenID Connect provider fake for one issuer over a seed. It serves the issuer's discovery
 * document, authorization, token, JWKS and userinfo endpoints at the issuer's real URLs (which may
 * span hosts: route them all to it, see {@link origins}).
 */
export class OidcFake extends Fake {
  readonly preset: OidcPreset;
  readonly seed: DistrictSeed;
  /** The `kid` of the signing key. */
  readonly kid: string;
  readonly #clients: Map<string, OidcClient>;
  readonly #selectUser: OidcFakeOptions["selectUser"];
  readonly #codes = new Map<string, PendingCode>();
  readonly #tokens: TokenIssuer<AccessGrant>;
  readonly #revoked = new Set<string>();
  readonly #removed = new Set<string>();
  readonly #keys: Promise<{ privateKey: CryptoKey; publicJwk: JWK }>;

  constructor(options: OidcFakeOptions) {
    super(options);
    this.seed = validateSeed(options.seed);
    this.preset = typeof options.preset === "string" ? OIDC_PRESETS[options.preset] : options.preset;
    this.kid = `${this.preset.name}-${crypto.randomUUID().slice(0, 8)}`;
    this.#clients = new Map(options.clients.map((c) => [c.clientId, c]));
    this.#selectUser = options.selectUser;
    this.#tokens = new TokenIssuer(this.preset.accessTokenPrefix, this.now);
    this.#keys = crypto.subtle
      .generateKey({ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ["sign", "verify"])
      // Cast: Workers' typings overload `generateKey` as `CryptoKey | CryptoKeyPair`, and
      // `exportKey` as `ArrayBuffer | JsonWebKey`; an RSA pair exported as "jwk" is a pair and a JWK.
      .then(async (generated) => {
        const pair = generated as CryptoKeyPair;
        return { privateKey: pair.privateKey, publicJwk: (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JWK };
      });
  }

  /** The origins its endpoints live on, for `routeFetch`. */
  get origins(): string[] {
    const p = this.preset;
    return [...new Set([p.issuer, p.authorizationEndpoint, p.tokenEndpoint, p.jwksUri, p.userinfoEndpoint].map((u) => new URL(u).origin))];
  }

  /** The discovery document's URL. */
  get discoveryUrl(): string {
    return `${this.preset.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  }

  /** The issuer's subject for a seed person. */
  subjectOf(personId: string): string {
    return this.preset.subjectOf(this.seed, this.#person(personId)!);
  }

  /** The JWKS the issuer publishes. */
  async jwks(): Promise<{ keys: JWK[] }> {
    const { publicJwk } = await this.#keys;
    const { kty, n, e } = publicJwk;
    return { keys: [{ kty, n, e, kid: this.kid, alg: "RS256", use: "sig" }] };
  }

  #person(idOrEmailOrSub: string): PersonSeed | undefined {
    const wanted = idOrEmailOrSub.toLowerCase();
    return this.seed.people.find(
      (p) => p.id === idOrEmailOrSub || p.email.toLowerCase() === wanted || this.preset.subjectOf(this.seed, p) === idOrEmailOrSub,
    );
  }

  protected errorResponse(status: number, reason: "outage" | "rate-limit"): Response {
    return Response.json(
      { error: "temporarily_unavailable", error_description: reason === "outage" ? "The server is temporarily unavailable." : "Too many requests." },
      { status, headers: NO_STORE },
    );
  }

  /** Students a `large-removal` removes can no longer sign in (`access_denied`). */
  protected removeLargeShare(fraction: number): void {
    for (const id of studentsToRemove(withoutPeople(this.seed, this.#removed), fraction)) this.#removed.add(id);
  }

  protected async serve(request: Request, body: string): Promise<Response> {
    const url = new URL(request.url);
    const at = `${url.origin}${url.pathname}`;
    const p = this.preset;
    if (at === this.discoveryUrl && request.method === "GET") return this.#discovery();
    if (at === p.authorizationEndpoint && (request.method === "GET" || request.method === "POST")) {
      return this.#authorize(request.method === "GET" ? url.searchParams : formOf(body));
    }
    if (at === p.tokenEndpoint && request.method === "POST") return this.#token(request, body);
    if (at === p.jwksUri && request.method === "GET") return Response.json(await this.jwks());
    if (at === p.userinfoEndpoint && (request.method === "GET" || request.method === "POST")) return this.#userinfo(request);
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  #discovery(): Response {
    const p = this.preset;
    return Response.json({
      issuer: p.issuer,
      authorization_endpoint: p.authorizationEndpoint,
      token_endpoint: p.tokenEndpoint,
      userinfo_endpoint: p.userinfoEndpoint,
      jwks_uri: p.jwksUri,
      ...p.discovery,
    });
  }

  #authorize(params: URLSearchParams): Response {
    // RFC 6749 §4.1.2.1: a bad client or redirect URI must not redirect.
    const clientId = params.get("client_id");
    const client = clientId === null ? undefined : this.#clients.get(clientId);
    if (client === undefined) return oauthError("invalid_client", "Unknown client_id.", 400);
    const redirectUri = params.get("redirect_uri");
    if (redirectUri === null || !client.redirectUris.includes(redirectUri)) return oauthError("invalid_request", "redirect_uri does not match a registered URI.", 400);
    const state = params.get("state");
    const back = (query: Record<string, string>) => {
      const target = new URL(redirectUri);
      for (const [k, v] of Object.entries(query)) target.searchParams.set(k, v);
      if (state !== null) target.searchParams.set("state", state);
      if (this.preset.issInAuthorizationResponse) target.searchParams.set("iss", this.preset.issuer);
      return new Response(null, { status: 302, headers: { location: target.toString() } });
    };
    const fail = (error: string, description: string) => back({ error, error_description: description });
    if (params.get("response_type") !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
    const scopes = (params.get("scope") ?? "").split(" ").filter((s) => s !== "");
    if (!scopes.includes("openid")) return fail("invalid_scope", "The scope must include openid.");
    const supported = this.preset.discovery["scopes_supported"] as readonly string[] | undefined;
    const unknown = scopes.find((s) => supported !== undefined && !supported.includes(s));
    if (unknown !== undefined) return fail("invalid_scope", `Unsupported scope ${unknown}.`);
    const challenge = params.get("code_challenge");
    const method = params.get("code_challenge_method") ?? "plain";
    if (challenge !== null) {
      if (!(this.preset.pkceMethods as readonly string[]).includes(method)) return fail("invalid_request", `Unsupported code_challenge_method ${method}.`);
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(challenge)) return fail("invalid_request", "Malformed code_challenge.");
    }
    const hint = this.#selectUser?.(params) ?? params.get("login_hint");
    if (hint === null || hint === undefined) return fail("login_required", "No user is signed in.");
    const person = this.#person(hint);
    if (person === undefined || this.#removed.has(person.id) || (person.status ?? "active") !== "active") {
      return fail("access_denied", "The user is not authorized for this application.");
    }
    const code = `${crypto.randomUUID().replaceAll("-", "")}`;
    // Codes are short-lived; forgetting expired ones keeps a long-running fake's memory bounded.
    for (const [old, pending] of this.#codes) if (pending.expiresAt <= this.now()) this.#codes.delete(old);
    this.#codes.set(code, {
      clientId: client.clientId,
      redirectUri,
      personId: person.id,
      scopes,
      nonce: params.get("nonce") ?? undefined,
      challenge: challenge === null ? undefined : { value: challenge, method: method as "S256" | "plain" },
      expiresAt: this.now() + this.preset.codeLifetimeSeconds * 1000,
      used: false,
      accessTokens: [],
    });
    return back({ code, ...(this.preset.name === "google" ? { scope: scopes.join(" ") } : {}) });
  }

  async #token(request: Request, body: string): Promise<Response> {
    const type = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    let form: URLSearchParams;
    if (type === "application/x-www-form-urlencoded") form = formOf(body);
    else if (type === "application/json" && this.preset.acceptsJsonTokenRequest) {
      try {
        form = new URLSearchParams(Object.entries(JSON.parse(body) as Record<string, string>).map(([k, v]) => [k, String(v)]));
      } catch {
        return oauthError("invalid_request", "invalid content-type");
      }
    } else return oauthError("invalid_request", "invalid content-type");

    // RFC 6749 §2.3.1: one client authentication method per request.
    const basic = basicCredentials(request);
    const posted = form.get("client_secret");
    if (basic !== undefined && posted !== null) return oauthError("invalid_request", "Use one client authentication method.");
    const credentials = basic ?? (form.get("client_id") !== null && posted !== null ? { clientId: form.get("client_id")!, clientSecret: posted } : undefined);
    const client = credentials === undefined ? undefined : this.#clients.get(credentials.clientId);
    if (credentials === undefined || client === undefined || client.clientSecret !== credentials.clientSecret) {
      return oauthError("invalid_client", "Client authentication failed.", 401, basic !== undefined ? { "www-authenticate": `Basic realm="${this.preset.issuer}"` } : {});
    }
    const grantType = form.get("grant_type");
    if (grantType !== "authorization_code") return oauthError("unsupported_grant_type", `Unsupported grant_type ${grantType ?? "(none)"}.`);
    const code = form.get("code");
    const pending = code === null ? undefined : this.#codes.get(code);
    const invalid = () => oauthError("invalid_grant", this.preset.invalidGrantDescription);
    if (pending === undefined || pending.clientId !== client.clientId) return invalid();
    if (pending.used) {
      // RFC 6749 §4.1.2: a reused code is refused and the tokens issued from it revoked.
      for (const token of pending.accessTokens) this.#revoked.add(token);
      return invalid();
    }
    // Spent before any await, so two concurrent redemptions cannot both pass the check above. A
    // failed attempt spends the code too, as most IdPs do.
    pending.used = true;
    if (pending.expiresAt <= this.now()) return invalid();
    if (form.get("redirect_uri") !== pending.redirectUri) return invalid();
    if (pending.challenge !== undefined) {
      const verifier = form.get("code_verifier");
      if (verifier === null || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return invalid();
      const derived = pending.challenge.method === "S256" ? base64url(await sha256(verifier)) : verifier;
      if (derived !== pending.challenge.value) return invalid();
    } else if (form.get("code_verifier") !== null) return invalid();

    const person = this.#person(pending.personId)!;
    const p = this.preset;
    const accessToken = this.#tokens.issue({ personId: person.id, clientId: client.clientId, scopes: pending.scopes }, p.accessTokenLifetimeSeconds);
    pending.accessTokens.push(accessToken);
    const now = Math.floor(this.now() / 1000);
    const context = { seed: this.seed, person, clientId: client.clientId, scopes: pending.scopes };
    const hash = await sha256(accessToken);
    let claims: Record<string, unknown> = {
      ...p.idTokenClaims(context),
      at_hash: base64url(hash.slice(0, 16)),
      ...(pending.nonce === undefined ? {} : { nonce: pending.nonce }),
    };
    if (this.takeMalformed(request)) claims = p.malform(claims);
    const { privateKey } = await this.#keys;
    const idToken = await new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: this.kid, typ: "JWT" })
      .setIssuer(p.issuer)
      .setAudience(client.clientId)
      .setSubject(p.subjectOf(this.seed, person))
      .setIssuedAt(now)
      .setExpirationTime(now + p.idTokenLifetimeSeconds)
      .sign(privateKey);
    return Response.json(p.tokenResponse({ accessToken, idToken, expiresIn: p.accessTokenLifetimeSeconds, scope: pending.scopes.join(" ") }), { headers: NO_STORE });
  }

  #userinfo(request: Request): Response {
    const token = bearer(request);
    const grant = token === undefined || this.#revoked.has(token) ? undefined : this.#tokens.lookup(token);
    if (grant === undefined) {
      // RFC 6750 §3.1.
      return Response.json(
        { error: "invalid_token", error_description: "The access token is invalid or expired." },
        { status: 401, headers: { "www-authenticate": 'Bearer error="invalid_token"' } },
      );
    }
    const person = this.#person(grant.personId)!;
    let body = this.preset.userinfo({ seed: this.seed, person, clientId: grant.clientId, scopes: grant.scopes });
    if (this.takeMalformed(request)) body = this.preset.malform(body);
    return Response.json(body);
  }
}
