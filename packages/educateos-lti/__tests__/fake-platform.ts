// A stand-in LTI 1.3 platform. It signs RS256 id_tokens with keys generated through Web Crypto and
// serves its JWKS through a fake fetch, so tests can rotate, withdraw and forge keys.
import { SignJWT, type JWK } from "jose";
import { LTI_CLAIM, LTI_VERSION } from "../src/index.ts";

export interface PlatformKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly publicJwk: JWK;
}

let kidCounter = 0;

/** Generates an RS256 key pair with a fresh `kid`. */
export async function generatePlatformKey(modulusLength = 2048): Promise<PlatformKey> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", modulusLength, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  kidCounter += 1;
  return { kid: `platform-key-${kidCounter}`, privateKey: pair.privateKey, publicJwk };
}

/** Claims a test launch may set or override. `undefined` removes a claim. */
export type ClaimOverrides = Record<string, unknown>;

export interface LaunchClaimsInput {
  readonly nonce: string;
  readonly sub: string;
  readonly contextId?: string;
  readonly resourceLinkId?: string;
  readonly messageType?: "LtiResourceLinkRequest" | "LtiDeepLinkingRequest";
  readonly targetLinkUri: string;
  readonly deploymentId?: string;
  readonly overrides?: ClaimOverrides;
}

/** A fake platform: one issuer, one client ID, a JWKS URL and the keys it publishes. */
export class FakePlatform {
  readonly issuer: string;
  readonly clientId: string;
  readonly deploymentId: string;
  readonly jwksUrl: string;
  readonly authLoginUrl: string;
  /** The key it signs with. */
  signingKey: PlatformKey;
  /** The keys its JWKS publishes. */
  published: PlatformKey[];
  readonly #now: () => number;

  constructor(issuer: string, clientId: string, deploymentId: string, key: PlatformKey, now: () => number) {
    this.issuer = issuer;
    this.clientId = clientId;
    this.deploymentId = deploymentId;
    this.jwksUrl = `${issuer}/api/lti/security/jwks`;
    this.authLoginUrl = `${issuer}/api/lti/authorize_redirect`;
    this.signingKey = key;
    this.published = [key];
    this.#now = now;
  }

  static async create(issuer: string, clientId: string, deploymentId: string, now: () => number): Promise<FakePlatform> {
    return new FakePlatform(issuer, clientId, deploymentId, await generatePlatformKey(), now);
  }

  /** The JWKS body its endpoint serves. */
  jwks(): { keys: JWK[] } {
    return { keys: this.published.map((key) => ({ ...key.publicJwk, kid: key.kid, alg: "RS256", use: "sig" })) };
  }

  /** Rotates to a new signing key. With `withdrawOld`, the old key is no longer published. */
  async rotate(withdrawOld: boolean): Promise<PlatformKey> {
    const next = await generatePlatformKey();
    this.published = withdrawOld ? [next] : [next, ...this.published];
    this.signingKey = next;
    return next;
  }

  /** The claims of a launch, before overrides are applied. */
  claims(input: LaunchClaimsInput): Record<string, unknown> {
    const now = Math.floor(this.#now() / 1000);
    const messageType = input.messageType ?? "LtiResourceLinkRequest";
    const claims: Record<string, unknown> = {
      iss: this.issuer,
      aud: this.clientId,
      sub: input.sub,
      iat: now,
      exp: now + 300,
      nonce: input.nonce,
      [LTI_CLAIM.messageType]: messageType,
      [LTI_CLAIM.version]: LTI_VERSION,
      [LTI_CLAIM.deploymentId]: input.deploymentId ?? this.deploymentId,
      [LTI_CLAIM.targetLinkUri]: input.targetLinkUri,
      [LTI_CLAIM.context]: { id: input.contextId ?? "ctx-unknown", label: "BIO", title: "Biology" },
    };
    if (messageType === "LtiResourceLinkRequest") {
      claims[LTI_CLAIM.resourceLink] = { id: input.resourceLinkId ?? "rl-course-nav", title: "EducateOS" };
    } else {
      claims[LTI_CLAIM.deepLinkingSettings] = {
        deep_link_return_url: `${this.issuer}/courses/1/deep_linking_response`,
        accept_types: ["ltiResourceLink"],
        accept_presentation_document_targets: ["iframe", "window"],
        accept_multiple: true,
        data: "opaque-platform-data",
      };
    }
    for (const [name, value] of Object.entries(input.overrides ?? {})) {
      if (value === undefined) delete claims[name];
      else claims[name] = value;
    }
    return claims;
  }

  /** Signs a launch id_token. `key` defaults to the current signing key. */
  async idToken(input: LaunchClaimsInput, key: PlatformKey = this.signingKey): Promise<string> {
    return new SignJWT(this.claims(input)).setProtectedHeader({ alg: "RS256", kid: key.kid, typ: "JWT" }).sign(key.privateKey);
  }
}

/** A fetch that serves the JWKS of the given platforms and counts requests per URL. */
export function platformFetch(platforms: readonly FakePlatform[]): { fetch: typeof fetch; calls: Map<string, number> } {
  const calls = new Map<string, number>();
  const fake = async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.set(url, (calls.get(url) ?? 0) + 1);
    const platform = platforms.find((candidate) => candidate.jwksUrl === url);
    if (platform === undefined) return new Response("not found", { status: 404 });
    return Response.json(platform.jwks());
  };
  return { fetch: fake as typeof fetch, calls };
}
