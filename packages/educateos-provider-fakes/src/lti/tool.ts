// An LTI 1.3 tool fake, for testing EducateOS as an LTI Platform (SCHO-179). It does what a
// third-party tool does, from 1EdTech LTI Core 1.3 (§5.1.1 third-party-initiated login, §5.3 the
// resource link launch) and the LTI Security Framework 1.0 (§5.1.1.1–5.1.1.3 the authentication
// request and the id_token it is answered with, §5.1.3 the checks a tool makes on it): it answers a
// login initiation with an authentication request carrying a fresh `state` and `nonce`, and
// verifies the launch it receives against the platform's JWKS, its issuer, its own client ID, the
// nonce, the state, and the LTI message claims. It holds its own RS256 keys and publishes them.
// From its own server it then calls the platform's LTI Advantage services: it gets a service token
// with a `private_key_jwt` client assertion (LTI Security Framework 1.0 §4.1, RFC 7523) and reads
// the offering's roster through the membership URL a launch advertised (NRPS 2.0 §2, §3.6.1).
// Everything but those calls is in memory.
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
  /** The platform's OAuth 2 token endpoint, the only `aud` of the tool's client assertions. */
  readonly platformTokenUrl?: string;
  /** The fetch the tool's server calls the platform's token endpoint and services with. */
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** The keys the tool signs and publishes. Defaults to a freshly generated one. */
  readonly keys?: PlatformKeyRing;
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
  /** The membership URL the launch advertised (its NRPS claim), if any. */
  readonly membershipsUrl: string | undefined;
}

/** One member of a roster the tool read: what the platform sent, unchanged. */
export interface FakeLtiToolMember {
  readonly user_id: string;
  readonly roles: readonly string[];
  readonly status?: string;
  readonly name?: string;
  readonly given_name?: string;
  readonly family_name?: string;
  readonly email?: string;
  readonly [field: string]: unknown;
}

/** One page of a roster the tool read, and where the next page is. */
export interface FakeLtiToolRoster {
  readonly id: string;
  readonly context: { readonly id: string; readonly label?: string; readonly title?: string };
  readonly members: readonly FakeLtiToolMember[];
  /** The `Link: rel="next"` URL, if the platform sent one. */
  readonly next: string | undefined;
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

  /** A tool fake, with a freshly generated signing key unless `options.keys` is given. */
  static async create(options: FakeLtiToolOptions): Promise<FakeLtiTool> {
    return new FakeLtiTool(options, options.keys ?? await PlatformKeyRing.create());
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
    const nrps = claims[LTI_CLAIMS.nrpsService] as { context_memberships_url?: unknown; service_versions?: unknown } | undefined;
    if (nrps !== undefined && (typeof nrps.context_memberships_url !== "string" || !Array.isArray(nrps.service_versions) || !nrps.service_versions.includes("2.0"))) {
      throw new FakeLtiToolError("malformed names and role service claim");
    }
    const launch: FakeLtiToolLaunch = {
      claims,
      deploymentId,
      contextId: typeof context?.id === "string" ? context.id : undefined,
      roles: Array.isArray(roles) ? roles.filter((role): role is string => typeof role === "string") : [],
      membershipsUrl: nrps?.context_memberships_url as string | undefined,
    };
    this.launches.push(launch);
    return launch;
  }

  /**
   * A client assertion (RFC 7523 §3) for the platform's token endpoint: signed with the tool's
   * key, `iss` and `sub` its client ID, `aud` the token endpoint, a fresh `jti`, valid one minute.
   */
  async clientAssertion(): Promise<string> {
    if (this.clientId === undefined || this.#options.platformTokenUrl === undefined) throw new FakeLtiToolError("no client ID or token endpoint");
    const now = Math.floor((this.#options.now?.() ?? Date.now()) / 1000);
    return this.keys.sign({ iss: this.clientId, sub: this.clientId, aud: this.#options.platformTokenUrl, iat: now, exp: now + 60, jti: crypto.randomUUID() });
  }

  /**
   * Gets a service token for `scopes` with the client credentials grant and a fresh client
   * assertion. A refusal throws, its reason the OAuth error.
   */
  async serviceToken(scopes: readonly string[]): Promise<string> {
    const response = await this.#fetch(this.#options.platformTokenUrl!, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: await this.clientAssertion(),
        scope: scopes.join(" "),
      }).toString(),
    });
    const body = (await response.json()) as { access_token?: unknown; error?: unknown };
    if (response.status !== 200 || typeof body.access_token !== "string") throw new FakeLtiToolError(`token refused (${String(body.error)})`);
    return body.access_token;
  }

  /**
   * Reads one page of a roster from `membershipsUrl` with `accessToken` (NRPS 2.0 §2). A refusal
   * throws, its reason the status and the bearer error, if the platform sent one.
   */
  async memberships(membershipsUrl: string, accessToken: string): Promise<FakeLtiToolRoster> {
    const response = await this.#fetch(membershipsUrl, {
      headers: { authorization: `Bearer ${accessToken}`, accept: LTI_MEDIA_TYPES.membershipContainer },
    });
    if (response.status !== 200) {
      const challenge = /error="([^"]+)"/.exec(response.headers.get("www-authenticate") ?? "")?.[1];
      await response.body?.cancel();
      throw new FakeLtiToolError(`memberships refused (${response.status}${challenge === undefined ? "" : ` ${challenge}`})`);
    }
    if (response.headers.get("content-type") !== LTI_MEDIA_TYPES.membershipContainer) throw new FakeLtiToolError("not a membership container");
    const body = (await response.json()) as Omit<FakeLtiToolRoster, "next">;
    if (typeof body.context?.id !== "string" || !Array.isArray(body.members)) throw new FakeLtiToolError("malformed membership container");
    const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1];
    return { ...body, next };
  }

  #fetch(input: string, init?: RequestInit): Promise<Response> {
    return (this.#options.fetch ?? ((url, options) => fetch(url, options)))(input, init);
  }
}
