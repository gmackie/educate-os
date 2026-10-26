// How the district Worker verifies a request: the Cloudflare Access assertion the deployment's
// Access application adds, checked as the kernel checks it (`verifyCfAccessJwt` in
// workshop-backend's access.ts: signature against the team's certs, issuer, audience, expiry), then
// read by `@educateos/identity`'s `identityFromAccessPayload`. The district then resolves the
// identity to a principal through its own directory, so Access proves who signed in and the
// district alone decides who that is.
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { VerifiedIdentity } from "@educateos/contracts";
import type { RequestVerifier } from "@educateos/district-app";
import { identityFromAccessPayload, type CleverSsoConfig } from "@educateos/identity";

/** The request header Access puts its signed assertion in. */
export const ACCESS_ASSERTION_HEADER = "cf-access-jwt-assertion";

/** What an {@link accessRequestVerifier} checks assertions against. */
export interface AccessVerifierOptions {
  /** The Access team domain, `https://<team>.cloudflareaccess.com`: the kernel's `CF_ACCESS_ISS`. */
  issuer: string;
  /**
   * The audience tags of the Access applications whose assertions the district accepts, at least
   * one: its own application's, and the instance's Workshop application's when the instance's
   * EducateOS connector forwards sign-ins from the Workshop's hostname. See {@link accessAudiences}.
   */
  audiences: readonly string[];
  /** The signing keys. Defaults to the team's published certs; tests pass a local key set. */
  keys?: JWTVerifyGetKey;
  /** Set when the district signs people in through Clever, behind Access (SCHO-203). */
  clever?: CleverSsoConfig;
}

/**
 * The audiences `CF_ACCESS_AUD` lists: comma-separated, each trimmed, empty entries dropped. One
 * tag (the district's own application) is the common case; a second is the instance's Workshop
 * application, whose sign-in the EducateOS connector's connect page carries (SCHO-218).
 */
export function accessAudiences(text: string | undefined): string[] {
  return (text ?? "").split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
}

// One remote key set per team, so its keys are fetched once per isolate rather than per request.
const remoteKeys = new Map<string, JWTVerifyGetKey>();

function teamKeys(issuer: string): JWTVerifyGetKey {
  let keys = remoteKeys.get(issuer);
  if (keys === undefined) {
    keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    remoteKeys.set(issuer, keys);
  }
  return keys;
}

/**
 * A {@link RequestVerifier} over Cloudflare Access. A request without an assertion, or with one
 * that fails verification (including one for an application not in `audiences`), proves no
 * identity. Access signs with RS256, so no other algorithm is
 * accepted. A verified token whose claims do not name exactly one user or service token is refused
 * with `unauthenticated` (see `identityFromAccessPayload`).
 */
export function accessRequestVerifier(options: AccessVerifierOptions): RequestVerifier {
  const { issuer } = options;
  const audience = [...options.audiences];
  if (issuer === "" || audience.length === 0 || audience.some((entry) => entry.trim() === "")) {
    throw new Error("Cloudflare Access issuer and audience must both be configured.");
  }
  const keys = options.keys ?? teamKeys(issuer);
  return async (request: Request): Promise<VerifiedIdentity | undefined> => {
    const token = request.headers.get(ACCESS_ASSERTION_HEADER);
    if (token === null || token === "") return undefined;
    let payload;
    try {
      ({ payload } = await jwtVerify(token, keys, { issuer, audience, algorithms: ["RS256"] }));
    } catch {
      return undefined;
    }
    return identityFromAccessPayload(payload, { issuer, ...(options.clever === undefined ? {} : { clever: options.clever }) });
  };
}
