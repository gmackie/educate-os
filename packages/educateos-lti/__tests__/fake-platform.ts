// A stand-in LTI 1.3 platform for the broker's unit tests: one issuer, one client ID and the keys
// it publishes, with no seed behind it. Its keys, signing, rotation and forging come from the
// promoted platform fake in `@educateos/provider-fakes` (`src/lti`); this keeps the small claim
// defaults the broker's tests were written against. For full OIDC, Deep Linking, AGS, NRPS and
// Dynamic Registration against Canvas- or Schoology-flavoured platforms, use `LtiPlatformFake`
// (see `provider-fakes.test.ts`).
import type { JWK } from "jose";
import {
  applyClaimOverrides,
  generatePlatformKey,
  LTI_CLAIMS,
  LTI_VERSION,
  PlatformKeyRing,
  type ClaimOverrides,
  type PlatformKey,
} from "@educateos/provider-fakes";

export { generatePlatformKey, type ClaimOverrides, type PlatformKey };

/** What a test launch is made of. */
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
  readonly keys: PlatformKeyRing;
  readonly #now: () => number;

  constructor(issuer: string, clientId: string, deploymentId: string, key: PlatformKey, now: () => number) {
    this.issuer = issuer;
    this.clientId = clientId;
    this.deploymentId = deploymentId;
    this.jwksUrl = `${issuer}/api/lti/security/jwks`;
    this.authLoginUrl = `${issuer}/api/lti/authorize_redirect`;
    this.keys = new PlatformKeyRing(key);
    this.#now = now;
  }

  static async create(issuer: string, clientId: string, deploymentId: string, now: () => number): Promise<FakePlatform> {
    return new FakePlatform(issuer, clientId, deploymentId, await generatePlatformKey(), now);
  }

  /** The key it signs with. */
  get signingKey(): PlatformKey {
    return this.keys.signingKey;
  }

  set signingKey(key: PlatformKey) {
    this.keys.signingKey = key;
  }

  /** The keys its JWKS publishes. */
  get published(): PlatformKey[] {
    return this.keys.published;
  }

  set published(keys: PlatformKey[]) {
    this.keys.published = keys;
  }

  /** The JWKS body its endpoint serves. */
  jwks(): { keys: JWK[] } {
    return this.keys.jwks();
  }

  /** Rotates to a new signing key. With `withdrawOld`, the old key is no longer published. */
  rotate(withdrawOld: boolean): Promise<PlatformKey> {
    return this.keys.rotate(withdrawOld);
  }

  /** The claims of a launch, with overrides applied. */
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
      [LTI_CLAIMS.messageType]: messageType,
      [LTI_CLAIMS.version]: LTI_VERSION,
      [LTI_CLAIMS.deploymentId]: input.deploymentId ?? this.deploymentId,
      [LTI_CLAIMS.targetLinkUri]: input.targetLinkUri,
      [LTI_CLAIMS.context]: { id: input.contextId ?? "ctx-unknown", label: "BIO", title: "Biology" },
    };
    if (messageType === "LtiResourceLinkRequest") {
      claims[LTI_CLAIMS.resourceLink] = { id: input.resourceLinkId ?? "rl-course-nav", title: "EducateOS" };
    } else {
      claims[LTI_CLAIMS.deepLinkingSettings] = {
        deep_link_return_url: `${this.issuer}/courses/1/deep_linking_response`,
        accept_types: ["ltiResourceLink"],
        accept_presentation_document_targets: ["iframe", "window"],
        accept_multiple: true,
        data: "opaque-platform-data",
      };
    }
    return applyClaimOverrides(claims, input.overrides);
  }

  /** Signs a launch id_token. `key` defaults to the current signing key. */
  idToken(input: LaunchClaimsInput, key: PlatformKey = this.signingKey): Promise<string> {
    return this.keys.sign(this.claims(input), { key });
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
