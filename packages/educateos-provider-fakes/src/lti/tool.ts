// An LTI 1.3 tool fake, for testing EducateOS as an LTI Platform (SCHO-179). It does what a
// third-party tool does, from 1EdTech LTI Core 1.3 (§5.1.1 third-party-initiated login, §5.3 the
// resource link launch) and the LTI Security Framework 1.0 (§5.1.1.1–5.1.1.3 the authentication
// request and the id_token it is answered with, §5.1.3 the checks a tool makes on it): it answers a
// login initiation with an authentication request carrying a fresh `state` and `nonce`, and
// verifies the launch it receives against the platform's JWKS, its issuer, its own client ID, the
// nonce, the state, and the LTI message claims. It holds its own RS256 keys and publishes them.
// As a tool's server does, it gets an LTI Advantage access token with a `private_key_jwt` client
// assertion (LTI Security Framework 1.0 §4.1, RFC 7523) and calls the platform's Assignment and
// Grade Services (AGS 2.0 §3.2–3.4) with it. Everything is in memory.
import { createLocalJWKSet, jwtVerify, type JWK, type JWTPayload } from "jose";
import { LTI_CLAIMS, LTI_MEDIA_TYPES, LTI_VERSION } from "./claims.ts";
import { PlatformKeyRing } from "./keys.ts";

/** What the tool fake trusts: the one platform it is registered with. */
export interface FakeLtiToolOptions {
  /** The tool's origin. Its login, launch and JWKS URLs are paths on it. */
  readonly origin: string;
  /** The platform's issuer. A login initiation or launch from any other is refused. */
  readonly platformIssuer: string;
  /** The platform's OIDC authorization endpoint. */
  readonly platformAuthUrl: string;
  /** The platform's JWKS, as the tool would fetch it. */
  readonly platformJwks: () => { keys: JWK[] } | Promise<{ keys: JWK[] }>;
  readonly name?: string;
  /** Milliseconds since the epoch, for verifying `exp` and `iat`. */
  readonly now?: () => number;
  /** The platform's OAuth 2 token endpoint, which service tokens come from. */
  readonly platformTokenUrl?: string;
  /** How the tool's server reaches the platform's token endpoint and services. */
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

/** The AGS endpoint claim of a launch (AGS 2.0 §3.1). */
export interface FakeLtiToolAgsEndpoint {
  readonly scope: readonly string[];
  readonly lineitems?: string;
  readonly lineitem?: string;
}

/** A score as the tool sends it (AGS 2.0 §3.4). */
export interface FakeLtiToolScore {
  readonly userId: string;
  readonly scoreGiven?: number;
  readonly scoreMaximum?: number;
  readonly comment?: string;
  readonly activityProgress: string;
  readonly gradingProgress: string;
  readonly timestamp: string;
}

/** Why the tool fake refused a login initiation or a launch. */
export class FakeLtiToolError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`The fake LTI tool refused: ${reason}`);
    this.reason = reason;
  }
}

/** A launch the tool fake accepted: its verified claims. */
export interface FakeLtiToolLaunch {
  readonly claims: JWTPayload & Record<string, unknown>;
  readonly deploymentId: string;
  readonly contextId: string | undefined;
  readonly roles: readonly string[];
  /** The launch's AGS endpoint claim, if it carried one. */
  readonly ags: FakeLtiToolAgsEndpoint | undefined;
}

/**
 * A third-party LTI 1.3 tool. Register it with {@link registration}, then set {@link clientId}
 * and {@link deploymentIds} to what the platform assigned.
 */
export class FakeLtiTool {
  readonly origin: string;
  readonly keys: PlatformKeyRing;
  /** The client ID the platform assigned. Set it after registering. */
  clientId: string | undefined;
  /** The deployment IDs the tool accepts launches through. */
  deploymentIds: string[] = [];
  /** Every launch it accepted, oldest first. */
  readonly launches: FakeLtiToolLaunch[] = [];
  readonly #options: FakeLtiToolOptions;
  readonly #pending = new Map<string, { nonce: string }>();

  private constructor(options: FakeLtiToolOptions, keys: PlatformKeyRing) {
    this.#options = options;
    this.origin = new URL(options.origin).origin;
    this.keys = keys;
  }

  /** A tool fake with `keys`, or a freshly generated signing key. */
  static async create(options: FakeLtiToolOptions, keys?: PlatformKeyRing): Promise<FakeLtiTool> {
    return new FakeLtiTool(options, keys ?? await PlatformKeyRing.create());
  }

  /** The URL that receives third-party-initiated logins. */
  get loginUrl(): string {
    return `${this.origin}/lti/login`;
  }

  /** The URL launches are posted to. */
  get launchUrl(): string {
    return `${this.origin}/lti/launch`;
  }

  /** What an administrator registers the tool with. */
  registration(): { name: string; loginInitiationUrl: string; redirectUris: string[]; targetLinkUri: string; jwksUrl: string } {
    return {
      name: this.#options.name ?? "Fake LTI tool",
      loginInitiationUrl: this.loginUrl,
      redirectUris: [this.launchUrl],
      targetLinkUri: this.launchUrl,
      jwksUrl: `${this.origin}/.well-known/jwks.json`,
    };
  }

  /** The tool's JWKS. */
  jwks(): { keys: JWK[] } {
    return this.keys.jwks();
  }

  /**
   * Answers a third-party-initiated login (LTI Core 1.3 §5.1.1.1) with the URL of the
   * authentication request it redirects the browser to. Pass `redirectUri` to ask for a launch
   * somewhere else, as a misbehaving or compromised tool would.
   */
  initiateLogin(loginUrl: string, options: { redirectUri?: string } = {}): string {
    const params = new URL(loginUrl).searchParams;
    if (params.get("iss") !== this.#options.platformIssuer) throw new FakeLtiToolError("unknown issuer");
    if (this.clientId !== undefined && params.has("client_id") && params.get("client_id") !== this.clientId) throw new FakeLtiToolError("wrong client_id");
    const deploymentId = params.get("lti_deployment_id");
    if (deploymentId !== null && !this.deploymentIds.includes(deploymentId)) throw new FakeLtiToolError("unknown deployment");
    const loginHint = params.get("login_hint");
    if (loginHint === null || loginHint === "") throw new FakeLtiToolError("no login_hint");
    const targetLinkUri = params.get("target_link_uri");
    if (targetLinkUri === null || new URL(targetLinkUri).origin !== this.origin) throw new FakeLtiToolError("target_link_uri is not the tool's");

    const state = crypto.randomUUID();
    const nonce = crypto.randomUUID();
    this.#pending.set(state, { nonce });
    const auth = new URL(this.#options.platformAuthUrl);
    for (const [name, value] of Object.entries({
      scope: "openid",
      response_type: "id_token",
      response_mode: "form_post",
      prompt: "none",
      client_id: this.clientId ?? params.get("client_id") ?? "",
      redirect_uri: options.redirectUri ?? this.launchUrl,
      login_hint: loginHint,
      state,
      nonce,
    })) {
      auth.searchParams.set(name, value);
    }
    const messageHint = params.get("lti_message_hint");
    if (messageHint !== null) auth.searchParams.set("lti_message_hint", messageHint);
    return auth.toString();
  }

  /**
   * Receives the platform's form post (LTI Security Framework 1.0 §5.1.1.3) and verifies it
   * (§5.1.3): a known, unused `state`; the id_token's signature by a key in the platform's JWKS;
   * `iss` the platform; `aud` the tool's client ID; `nonce` the one sent with that state; and the
   * LTI version, message type and a known deployment.
   */
  async receiveLaunch(fields: { id_token?: string; state?: string }): Promise<FakeLtiToolLaunch> {
    const pending = fields.state === undefined ? undefined : this.#pending.get(fields.state);
    if (pending === undefined) throw new FakeLtiToolError("unknown state");
    this.#pending.delete(fields.state!);
    if (fields.id_token === undefined || this.clientId === undefined) throw new FakeLtiToolError("no id_token");
    let claims: JWTPayload & Record<string, unknown>;
    try {
      const verified = await jwtVerify(fields.id_token, createLocalJWKSet(await this.#options.platformJwks()), {
        issuer: this.#options.platformIssuer,
        audience: this.clientId,
        algorithms: ["RS256"],
        ...this.#options.now === undefined ? {} : { currentDate: new Date(this.#options.now()) },
      });
      claims = verified.payload as JWTPayload & Record<string, unknown>;
    } catch (err) {
      throw new FakeLtiToolError(`id_token did not verify (${err instanceof Error ? err.name : "error"})`);
    }
    if (claims.nonce !== pending.nonce) throw new FakeLtiToolError("wrong nonce");
    if (claims[LTI_CLAIMS.version] !== LTI_VERSION) throw new FakeLtiToolError("wrong LTI version");
    if (claims[LTI_CLAIMS.messageType] !== "LtiResourceLinkRequest") throw new FakeLtiToolError("unexpected message type");
    const deploymentId = claims[LTI_CLAIMS.deploymentId];
    if (typeof deploymentId !== "string" || !this.deploymentIds.includes(deploymentId)) throw new FakeLtiToolError("unknown deployment");
    if (typeof claims.sub !== "string" || claims.sub === "") throw new FakeLtiToolError("no sub");
    const context = claims[LTI_CLAIMS.context] as { id?: unknown } | undefined;
    const roles = claims[LTI_CLAIMS.roles];
    const ags = claims[LTI_CLAIMS.agsEndpoint] as FakeLtiToolAgsEndpoint | undefined;
    const launch: FakeLtiToolLaunch = {
      claims,
      deploymentId,
      contextId: typeof context?.id === "string" ? context.id : undefined,
      roles: Array.isArray(roles) ? roles.filter((role): role is string => typeof role === "string") : [],
      ags,
    };
    this.launches.push(launch);
    return launch;
  }

  /**
   * Gets an access token for `scopes` from the platform's token endpoint: the client credentials
   * grant, authenticated by a fresh, single-use client assertion signed with the tool's key. Throws
   * if the platform refuses.
   */
  async serviceToken(scopes: readonly string[]): Promise<string> {
    const tokenUrl = this.#options.platformTokenUrl;
    if (tokenUrl === undefined || this.clientId === undefined) throw new FakeLtiToolError("no token endpoint or client ID");
    const now = Math.floor((this.#options.now?.() ?? Date.now()) / 1000);
    const assertion = await this.keys.sign({ iss: this.clientId, sub: this.clientId, aud: tokenUrl, iat: now, exp: now + 60, jti: crypto.randomUUID() });
    const response = await this.#fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: assertion,
        scope: scopes.join(" "),
      }).toString(),
    });
    const body = (await response.json()) as { access_token?: unknown; error?: unknown };
    if (!response.ok || typeof body.access_token !== "string") throw new FakeLtiToolError(`token refused (${response.status} ${String(body.error)})`);
    return body.access_token;
  }

  /** Lists a line items container (AGS 2.0 §3.2.4). */
  listLineItems(lineItemsUrl: string, token: string): Promise<Response> {
    return this.#agsCall("GET", lineItemsUrl, token, { accept: LTI_MEDIA_TYPES.lineItemContainer });
  }

  /** Creates a line item in a container (AGS 2.0 §3.2.5). */
  createLineItem(lineItemsUrl: string, token: string, item: Record<string, unknown>): Promise<Response> {
    return this.#agsCall("POST", lineItemsUrl, token, { body: item, contentType: LTI_MEDIA_TYPES.lineItem });
  }

  /** Posts a score to a line item (AGS 2.0 §3.4). */
  postScore(lineItemUrl: string, token: string, score: FakeLtiToolScore): Promise<Response> {
    return this.#agsCall("POST", below(lineItemUrl, "scores"), token, { body: score, contentType: LTI_MEDIA_TYPES.score });
  }

  /** Reads a line item's results (AGS 2.0 §3.3). */
  results(lineItemUrl: string, token: string): Promise<Response> {
    return this.#agsCall("GET", below(lineItemUrl, "results"), token, { accept: LTI_MEDIA_TYPES.resultContainer });
  }

  #agsCall(method: string, url: string, token: string, options: { body?: unknown; contentType?: string; accept?: string }): Promise<Response> {
    return this.#fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...options.accept === undefined ? {} : { accept: options.accept },
        ...options.contentType === undefined ? {} : { "content-type": options.contentType },
      },
      ...options.body === undefined ? {} : { body: JSON.stringify(options.body) },
    });
  }

  #fetch(url: string, init: RequestInit): Promise<Response> {
    if (this.#options.fetch === undefined) throw new FakeLtiToolError("no fetch for the platform's services");
    return this.#options.fetch(url, init);
  }
}

/** The URL of `segment` below a line item, keeping any query the platform gave it (AGS 2.0 §3.4.1). */
function below(lineItemUrl: string, segment: string): string {
  const url = new URL(lineItemUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${segment}`;
  return url.toString();
}
