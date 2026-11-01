// EducateOS as an LTI 1.3 Platform (SCHO-179, IF-10): the token endpoint third-party tools get LTI
// Advantage access tokens from. A tool authenticates with a `private_key_jwt` client assertion
// (RFC 7523, LTI Security Framework §4.1) signed by a key from its registered JWKS, and receives a
// short-lived, opaque access token for the scopes its deployments allow. The NRPS and AGS services
// verify that token with `PlatformTokenEndpoint.verify`. See docs/educateos/lti.md.
import { decodeJwt, decodeProtectedHeader, errors as joseErrors, jwtVerify, type JWTPayload } from "jose";
import { z } from "zod";
import { EducateOsError } from "@educateos/contracts";
import {
  PlatformToolId,
  type PlatformDeployment,
  type PlatformTool,
  type PlatformToolService,
} from "./platform-tools.ts";
import { LTI_SCOPES, type LtiScope } from "./service-client.ts";
import { randomToken, sha256Base64Url, type Clock } from "./stores.ts";

/** The `client_assertion_type` of a JWT client assertion (RFC 7523 §2.2). */
export const CLIENT_ASSERTION_TYPE_JWT_BEARER = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

/**
 * The deployment service each LTI Advantage scope needs. Reading a line item's results is part of
 * the line items service; posting scores is its own. Deep Linking needs no token.
 */
export const PLATFORM_SCOPE_SERVICES: Readonly<Record<LtiScope, PlatformToolService>> = {
  [LTI_SCOPES.contextMembershipReadonly]: "nrps",
  [LTI_SCOPES.lineItem]: "agsLineItems",
  [LTI_SCOPES.lineItemReadonly]: "agsLineItems",
  [LTI_SCOPES.resultReadonly]: "agsLineItems",
  [LTI_SCOPES.score]: "agsScores",
};

const SCOPES = Object.keys(PLATFORM_SCOPE_SERVICES) as LtiScope[];
const isScope = (scope: string): scope is LtiScope => (SCOPES as string[]).includes(scope);

/** How long an access token lives: 15 minutes. A tool asks for another when it expires. */
export const PLATFORM_SERVICE_TOKEN_LIFETIME_SECONDS = 15 * 60;
/** The longest a client assertion may live, from its `iat` to its `exp`. */
export const MAX_CLIENT_ASSERTION_LIFETIME_SECONDS = 5 * 60;
/** How far the tool's clock may differ from EducateOS's, as SCHO-174's resource tokens allow. */
export const CLIENT_ASSERTION_CLOCK_SKEW_SECONDS = 30;

/** The largest token request body read, in bytes. A client assertion is a few kilobytes. */
const MAX_TOKEN_REQUEST_BYTES = 16 * 1024;
const MAX_ASSERTION_LENGTH = 8 * 1024;
const ACCESS_TOKEN = /^lst_[A-Za-z0-9_-]{43}$/;

/** What an access token was issued for: a tool and the scopes it was granted. */
export const PlatformServiceTokenRecord = z.strictObject({
  toolId: PlatformToolId,
  scopes: z.array(z.enum(SCOPES as [LtiScope, ...LtiScope[]])).min(1),
});
/** An issued access token's record. */
export type PlatformServiceTokenRecord = z.infer<typeof PlatformServiceTokenRecord>;

/**
 * Where the token endpoint keeps the client assertions it has accepted and the access tokens it has
 * issued. In the district Worker it is the district's Durable Object (`TablePlatformServiceTokenStore`).
 */
export interface PlatformServiceTokenStore {
  /**
   * Records that the tool's assertion `jti` was used, until `expiresAt` (milliseconds since the
   * epoch). Returns `false` if it was already recorded and has not expired. Atomic: of any number
   * of concurrent claims of one `jti`, exactly one returns `true`.
   */
  claimAssertion(toolId: PlatformToolId, jti: string, expiresAt: number): Promise<boolean>;
  /** Stores an issued token's record under the SHA-256 digest of the token, until `expiresAt`. */
  putToken(digest: string, record: PlatformServiceTokenRecord, expiresAt: number): Promise<void>;
  /** The record of the token with this digest, or `undefined` if there is none or it expired. */
  getToken(digest: string): Promise<{ record: PlatformServiceTokenRecord; expiresAt: number } | undefined>;
}

/** An in-memory {@link PlatformServiceTokenStore}, for tests and single-isolate development. */
export class InMemoryPlatformServiceTokenStore implements PlatformServiceTokenStore {
  readonly #assertions = new Map<string, number>();
  readonly #tokens = new Map<string, { record: PlatformServiceTokenRecord; expiresAt: number }>();
  readonly #now: Clock;

  constructor(now: Clock = Date.now) {
    this.#now = now;
  }

  async claimAssertion(toolId: PlatformToolId, jti: string, expiresAt: number): Promise<boolean> {
    const key = JSON.stringify([toolId, jti]);
    const recorded = this.#assertions.get(key);
    if (recorded !== undefined && recorded > this.#now()) return false;
    this.#assertions.set(key, expiresAt);
    return true;
  }

  async putToken(digest: string, record: PlatformServiceTokenRecord, expiresAt: number): Promise<void> {
    this.#tokens.set(digest, { record: PlatformServiceTokenRecord.parse(record), expiresAt });
  }

  async getToken(digest: string): Promise<{ record: PlatformServiceTokenRecord; expiresAt: number } | undefined> {
    const stored = this.#tokens.get(digest);
    return stored !== undefined && stored.expiresAt > this.#now() ? stored : undefined;
  }
}

/** The registered tools and deployments the endpoint reads (`TablePlatformToolStore`). */
export interface PlatformToolLookup {
  tool(id: PlatformToolId): Promise<PlatformTool | undefined>;
  deployments(): Promise<readonly PlatformDeployment[]>;
}

/** The OAuth 2 error codes the token endpoint answers with (RFC 6749 §5.2). */
export type PlatformTokenErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "invalid_scope";

/** A refused token request: its OAuth 2 error code and a description safe to send to the tool. */
export class PlatformTokenError extends Error {
  override readonly name = "PlatformTokenError";
  readonly code: PlatformTokenErrorCode;
  readonly description: string;

  constructor(code: PlatformTokenErrorCode, description: string) {
    super(description);
    this.code = code;
    this.description = description;
  }
}

/** What a verified access token lets its bearer do, as of the moment it was verified. */
export interface PlatformServiceGrant {
  /** The tool the token was issued to, which is active. */
  readonly tool: PlatformTool;
  /** The tool's active deployments: a service call must still be allowed by one (`deploymentAllows`). */
  readonly deployments: readonly PlatformDeployment[];
  /** The token's scopes its deployments still allow. Never empty. */
  readonly scopes: readonly LtiScope[];
  /** When the token expires, in milliseconds since the epoch. */
  readonly expiresAt: number;
}

/** What one token request came to, for the caller to log. Holds no token, assertion or body. */
export type PlatformTokenOutcome =
  | { readonly issued: true; readonly toolId: PlatformToolId; readonly scopes: readonly LtiScope[] }
  | { readonly issued: false; readonly error: PlatformTokenErrorCode; readonly toolId?: PlatformToolId };

/** What {@link PlatformTokenEndpoint} is built from. */
export interface PlatformTokenEndpointOptions {
  /** The endpoint's own URL: the only `aud` a client assertion may carry. */
  readonly tokenUrl: string;
  readonly tools: PlatformToolLookup;
  readonly store: PlatformServiceTokenStore;
  /** The tools' published keys, fetched from each tool's registered JWKS URL. RS256 only. */
  readonly keys: { getKey(jwksUrl: string, kid: string): Promise<CryptoKey> };
  readonly now?: Clock;
}

const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" } as const;

/**
 * The LTI Platform's OAuth 2 token endpoint (client credentials with a `private_key_jwt` client
 * assertion) and the verifier for the access tokens it issues.
 *
 * An assertion counts only if its `iss` and `sub` are an active tool's client ID, its `aud` is
 * exactly this endpoint's URL, it is RS256-signed by a key the tool publishes at its registered JWKS
 * URL, it lives no longer than five minutes, and its `jti` has not been used: each `jti` is
 * recorded durably until the assertion expires, so a replay fails even across restarts. The
 * requested scopes must all be ones the tool's active deployments allow.
 *
 * An access token is opaque and stored only as its digest. Verifying one re-reads the tool and its
 * deployments, so revoking a tool, a deployment or a service ends a token's use at its next call.
 */
export class PlatformTokenEndpoint {
  readonly #options: PlatformTokenEndpointOptions;
  readonly #now: Clock;

  constructor(options: PlatformTokenEndpointOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /** Answers a token request, with the outcome for the caller to log. */
  async handle(request: Request): Promise<{ response: Response; outcome: PlatformTokenOutcome }> {
    let toolId: PlatformToolId | undefined;
    try {
      const form = await tokenRequestForm(request);
      const issued = await this.#issue(form, (id) => (toolId = id));
      return {
        response: Response.json(
          { access_token: issued.token, token_type: "Bearer", expires_in: PLATFORM_SERVICE_TOKEN_LIFETIME_SECONDS, scope: issued.scopes.join(" ") },
          { headers: NO_STORE },
        ),
        outcome: { issued: true, toolId: issued.toolId, scopes: issued.scopes },
      };
    } catch (error) {
      if (!(error instanceof PlatformTokenError)) throw error;
      return {
        response: Response.json(
          { error: error.code, error_description: error.description },
          { status: error.code === "invalid_client" ? 401 : 400, headers: NO_STORE },
        ),
        outcome: { issued: false, error: error.code, ...toolId === undefined ? {} : { toolId } },
      };
    }
  }

  /**
   * What the access token lets its bearer do now, or `undefined` if it is unknown, expired, its
   * tool is revoked, or no scope it was granted is still allowed.
   */
  async verify(accessToken: string): Promise<PlatformServiceGrant | undefined> {
    if (!ACCESS_TOKEN.test(accessToken)) return undefined;
    const stored = await this.#options.store.getToken(await sha256Base64Url(accessToken));
    if (stored === undefined) return undefined;
    const tool = await this.#options.tools.tool(stored.record.toolId);
    if (tool === undefined || tool.status !== "active") return undefined;
    const deployments = await this.#activeDeployments(tool);
    const allowed = allowedScopes(deployments);
    const scopes = stored.record.scopes.filter((scope) => allowed.has(scope));
    return scopes.length === 0 ? undefined : { tool, deployments, scopes, expiresAt: stored.expiresAt };
  }

  /** {@link verify} for the request's `Authorization: Bearer` token. */
  async verifyRequest(request: Request): Promise<PlatformServiceGrant | undefined> {
    const match = /^Bearer ([^\s]+)$/i.exec(request.headers.get("authorization") ?? "");
    return match === null ? undefined : this.verify(match[1]!);
  }

  async #issue(form: URLSearchParams, identified: (id: PlatformToolId) => void): Promise<{ token: string; toolId: PlatformToolId; scopes: LtiScope[] }> {
    const grantType = form.get("grant_type");
    if (grantType === null) throw new PlatformTokenError("invalid_request", "grant_type is required.");
    if (grantType !== "client_credentials") throw new PlatformTokenError("unsupported_grant_type", "Only the client_credentials grant is supported.");
    if (form.has("client_secret")) throw new PlatformTokenError("invalid_client", "Authenticate with a private_key_jwt client assertion.");
    const assertion = form.get("client_assertion");
    if (form.get("client_assertion_type") !== CLIENT_ASSERTION_TYPE_JWT_BEARER || assertion === null) {
      throw new PlatformTokenError("invalid_client", "Authenticate with a private_key_jwt client assertion.");
    }

    const tool = await this.#authenticate(assertion, form.get("client_id"), identified);

    const requested = [...new Set((form.get("scope") ?? "").split(" ").filter((scope) => scope !== ""))];
    if (requested.length === 0) throw new PlatformTokenError("invalid_scope", "Name the scopes the token is for.");
    if (!requested.every(isScope)) throw new PlatformTokenError("invalid_scope", "A requested scope is not an LTI Advantage scope this platform offers.");
    const allowed = allowedScopes(await this.#activeDeployments(tool));
    if (allowed.size === 0) throw new PlatformTokenError("unauthorized_client", "The tool has no deployment that allows a service.");
    if (!requested.every((scope) => allowed.has(scope))) throw new PlatformTokenError("invalid_scope", "A requested scope is not allowed by the tool's deployments.");

    const token = `lst_${randomToken()}`;
    const expiresAt = this.#now() + PLATFORM_SERVICE_TOKEN_LIFETIME_SECONDS * 1000;
    await this.#options.store.putToken(await sha256Base64Url(token), { toolId: tool.id, scopes: requested }, expiresAt);
    return { token, toolId: tool.id, scopes: requested };
  }

  /** The active tool the client assertion authenticates, its `jti` now used. */
  async #authenticate(assertion: string, clientId: string | null, identified: (id: PlatformToolId) => void): Promise<PlatformTool> {
    const refuse = (description: string) => new PlatformTokenError("invalid_client", description);
    if (assertion.length > MAX_ASSERTION_LENGTH) throw refuse("The client assertion is too large.");
    let header: ReturnType<typeof decodeProtectedHeader>;
    let unverified: JWTPayload;
    try {
      header = decodeProtectedHeader(assertion);
      unverified = decodeJwt(assertion);
    } catch {
      throw refuse("The client assertion is not a JWT.");
    }
    // RS256 only: never a symmetric or unsigned algorithm, whatever the header asks for.
    if (header.alg !== "RS256") throw refuse("The client assertion must be signed with RS256.");
    if (typeof header.kid !== "string" || header.kid === "") throw refuse("The client assertion must name its key (kid).");

    const toolId = PlatformToolId.safeParse(unverified.iss);
    if (!toolId.success) throw refuse("The client assertion's issuer is not a registered tool.");
    if (clientId !== null && clientId !== toolId.data) throw refuse("client_id does not match the client assertion.");
    const tool = await this.#options.tools.tool(toolId.data);
    if (tool === undefined || tool.status !== "active") throw refuse("The client assertion's issuer is not an active tool.");
    identified(tool.id);

    let key: CryptoKey;
    try {
      key = await this.#options.keys.getKey(tool.jwksUrl, header.kid);
    } catch (error) {
      if (!(error instanceof EducateOsError)) throw error;
      throw refuse(error.code === "unavailable" ? "The tool's key set could not be fetched." : "The client assertion was signed with a key the tool does not publish.");
    }

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(assertion, key, {
        algorithms: ["RS256"],
        issuer: tool.id,
        subject: tool.id,
        requiredClaims: ["iss", "sub", "aud", "exp", "iat", "jti"],
        clockTolerance: CLIENT_ASSERTION_CLOCK_SKEW_SECONDS,
        currentDate: new Date(this.#now()),
      }));
    } catch (error) {
      if (error instanceof joseErrors.JOSEError) throw refuse("The client assertion is invalid or expired.");
      throw error;
    }

    const { aud, exp, iat, jti } = payload as JWTPayload & { exp: number; iat: number };
    const audiences = Array.isArray(aud) ? aud : [aud];
    if (audiences.length !== 1 || audiences[0] !== this.#options.tokenUrl) throw refuse("The client assertion's audience must be this token endpoint.");
    const nowSeconds = this.#now() / 1000;
    if (exp - iat > MAX_CLIENT_ASSERTION_LIFETIME_SECONDS || exp > nowSeconds + MAX_CLIENT_ASSERTION_LIFETIME_SECONDS + CLIENT_ASSERTION_CLOCK_SKEW_SECONDS) {
      throw refuse("The client assertion may live at most five minutes.");
    }
    if (iat > nowSeconds + CLIENT_ASSERTION_CLOCK_SKEW_SECONDS) throw refuse("The client assertion was issued in the future.");
    if (typeof jti !== "string" || jti === "" || jti.length > 256) throw refuse("The client assertion needs a jti.");
    // Kept until the assertion could no longer be accepted anyway, skew included.
    const claimed = await this.#options.store.claimAssertion(tool.id, jti, (exp + CLIENT_ASSERTION_CLOCK_SKEW_SECONDS) * 1000);
    if (!claimed) throw refuse("The client assertion was already used.");
    return tool;
  }

  async #activeDeployments(tool: PlatformTool): Promise<PlatformDeployment[]> {
    return (await this.#options.tools.deployments()).filter(
      (deployment) => deployment.toolId === tool.id && deployment.districtId === tool.districtId && deployment.status === "active",
    );
  }
}

/** The scopes some deployment allows a service for. */
function allowedScopes(deployments: readonly PlatformDeployment[]): Set<LtiScope> {
  return new Set(SCOPES.filter((scope) => deployments.some((deployment) => deployment.services[PLATFORM_SCOPE_SERVICES[scope]])));
}

/**
 * The token request's form parameters. It must be a form post no larger than 16 KiB, with each
 * parameter once (RFC 6749 §3.2) and no `Authorization` header: a client authenticates one way only.
 */
async function tokenRequestForm(request: Request): Promise<URLSearchParams> {
  if (!/^application\/x-www-form-urlencoded(;|$)/i.test(request.headers.get("content-type") ?? "")) {
    throw new PlatformTokenError("invalid_request", "Send the token request as application/x-www-form-urlencoded.");
  }
  if (request.headers.has("authorization")) throw new PlatformTokenError("invalid_request", "Authenticate with the client assertion only.");
  const body = await boundedText(request);
  if (body === undefined) throw new PlatformTokenError("invalid_request", "The token request is too large.");
  const form = new URLSearchParams(body);
  const names = [...form.keys()];
  if (new Set(names).size !== names.length) throw new PlatformTokenError("invalid_request", "A parameter is repeated.");
  return form;
}

/** The request body as text, or `undefined` if it exceeds {@link MAX_TOKEN_REQUEST_BYTES}. */
async function boundedText(request: Request): Promise<string | undefined> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_TOKEN_REQUEST_BYTES) {
    await request.body?.cancel();
    return undefined;
  }
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_TOKEN_REQUEST_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
