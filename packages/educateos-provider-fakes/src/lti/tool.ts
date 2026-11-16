// An LTI 1.3 tool fake, for testing EducateOS as an LTI Platform (SCHO-179). It does what a
// third-party tool does, from 1EdTech LTI Core 1.3 (§5.1.1 third-party-initiated login, §5.3 the
// resource link launch) and the LTI Security Framework 1.0 (§5.1.1.1–5.1.1.3 the authentication
// request and the id_token it is answered with, §5.1.3 the checks a tool makes on it): it answers a
// login initiation with an authentication request carrying a fresh `state` and `nonce`, and
// verifies the launch it receives against the platform's JWKS, its issuer, its own client ID, the
// nonce, the state, and the LTI message claims. It holds its own RS256 keys and publishes them.
// From its own server it then calls the platform's LTI Advantage services: it gets a service token
// with a `private_key_jwt` client assertion (LTI Security Framework 1.0 §4.1, RFC 7523), reads the
// offering's roster through the membership URL a launch advertised (NRPS 2.0 §2, §3.6.1), and calls
// the Assignment and Grade Services (AGS 2.0 §3.2–3.4). A deep linking request (Deep Linking 2.0
// §4.4) is verified like a launch, and answered with a signed `LtiDeepLinkingResponse` (§4.5) for
// the browser to post back to the platform's return URL. Everything but those calls is in memory.
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
  /** The membership URL the launch advertised (its NRPS claim), if any. */
  readonly membershipsUrl: string | undefined;
  /** The launch's resource link ID; a deep linking request has none. */
  readonly resourceLinkId: string | undefined;
  /** A deep linking request's settings (Deep Linking 2.0 §4.4.1); a resource link launch has none. */
  readonly deepLinking: FakeLtiToolDeepLinkingSettings | undefined;
}

/** The `deep_linking_settings` of a deep linking request (Deep Linking 2.0 §4.4.1). */
export interface FakeLtiToolDeepLinkingSettings {
  readonly deep_link_return_url: string;
  readonly accept_types: readonly string[];
  readonly accept_presentation_document_targets: readonly string[];
  readonly accept_multiple?: boolean;
  readonly accept_lineitem?: boolean;
  readonly auto_create?: boolean;
  readonly data?: string;
}

/**
 * What a tool's deep linking response may say differently from a well-behaved one, as a
 * misbehaving or compromised tool would: another `data`, `aud`, `nonce` or deployment, or a key
 * the tool does not publish.
 */
export interface FakeLtiToolDeepLinkingOverrides {
  readonly data?: string;
  readonly audience?: string;
  readonly nonce?: string;
  readonly deploymentId?: string;
  readonly issuedAt?: number;
  readonly sign?: (claims: Record<string, unknown>) => Promise<string>;
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
    const messageType = claims[LTI_CLAIMS.messageType];
    if (messageType !== "LtiResourceLinkRequest" && messageType !== "LtiDeepLinkingRequest") throw new FakeLtiToolError("unexpected message type");
    const settings = claims[LTI_CLAIMS.deepLinkingSettings] as FakeLtiToolDeepLinkingSettings | undefined;
    if (messageType === "LtiDeepLinkingRequest" && (typeof settings?.deep_link_return_url !== "string" || !Array.isArray(settings.accept_types))) {
      throw new FakeLtiToolError("malformed deep linking settings");
    }
    const resourceLink = claims[LTI_CLAIMS.resourceLink] as { id?: unknown } | undefined;
    const deploymentId = claims[LTI_CLAIMS.deploymentId];
    if (typeof deploymentId !== "string" || !this.deploymentIds.includes(deploymentId)) throw new FakeLtiToolError("unknown deployment");
    if (typeof claims.sub !== "string" || claims.sub === "") throw new FakeLtiToolError("no sub");
    const context = claims[LTI_CLAIMS.context] as { id?: unknown } | undefined;
    const roles = claims[LTI_CLAIMS.roles];
    const ags = claims[LTI_CLAIMS.agsEndpoint] as FakeLtiToolAgsEndpoint | undefined;
    const nrps = claims[LTI_CLAIMS.nrpsService] as { context_memberships_url?: unknown; service_versions?: unknown } | undefined;
    if (nrps !== undefined && (typeof nrps.context_memberships_url !== "string" || !Array.isArray(nrps.service_versions) || !nrps.service_versions.includes("2.0"))) {
      throw new FakeLtiToolError("malformed names and role service claim");
    }
    const launch: FakeLtiToolLaunch = {
      claims,
      deploymentId,
      contextId: typeof context?.id === "string" ? context.id : undefined,
      roles: Array.isArray(roles) ? roles.filter((role): role is string => typeof role === "string") : [],
      ags,
      membershipsUrl: nrps?.context_memberships_url as string | undefined,
      resourceLinkId: typeof resourceLink?.id === "string" ? resourceLink.id : undefined,
      deepLinking: messageType === "LtiDeepLinkingRequest" ? settings : undefined,
    };
    this.launches.push(launch);
    return launch;
  }

  /**
   * Answers the deep linking request `launch` with `items` (Deep Linking 2.0 §4.5): a response
   * signed with the tool's key, `iss` its client ID, `aud` the platform, a fresh `nonce`, the
   * request's deployment and its `data` echoed. Returns the form the browser posts back to the
   * request's return URL.
   */
  async deepLinkingResponse(
    launch: FakeLtiToolLaunch,
    items: readonly Record<string, unknown>[],
    overrides: FakeLtiToolDeepLinkingOverrides = {},
  ): Promise<{ action: string; fields: { JWT: string } }> {
    if (launch.deepLinking === undefined || this.clientId === undefined) throw new FakeLtiToolError("not a deep linking request");
    const iat = overrides.issuedAt ?? Math.floor((this.#options.now?.() ?? Date.now()) / 1000);
    const data = overrides.data ?? launch.deepLinking.data;
    const claims: Record<string, unknown> = {
      iss: this.clientId,
      aud: overrides.audience ?? this.#options.platformIssuer,
      iat,
      exp: iat + 300,
      nonce: overrides.nonce ?? crypto.randomUUID(),
      [LTI_CLAIMS.messageType]: "LtiDeepLinkingResponse",
      [LTI_CLAIMS.version]: LTI_VERSION,
      [LTI_CLAIMS.deploymentId]: overrides.deploymentId ?? launch.deploymentId,
      [LTI_CLAIMS.contentItems]: items,
      ...data === undefined ? {} : { [LTI_CLAIMS.data]: data },
    };
    const jwt = overrides.sign === undefined ? await this.keys.sign(claims) : await overrides.sign(claims);
    return { action: launch.deepLinking.deep_link_return_url, fields: { JWT: jwt } };
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

  #fetch(input: string, init?: RequestInit): Promise<Response> {
    return (this.#options.fetch ?? ((url, options) => fetch(url, options)))(input, init);
  }
}

/** The URL of `segment` below a line item, keeping any query the platform gave it (AGS 2.0 §3.4.1). */
function below(lineItemUrl: string, segment: string): string {
  const url = new URL(lineItemUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${segment}`;
  return url.toString();
}
