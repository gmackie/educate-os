// Operator sign-in (SCHO-206). educateos.io/app sits behind a Cloudflare Access application whose
// policy admits anyone who proves an email address (one-time PIN or GitHub), so Access does the
// sign-in and this Worker never handles a password, a PIN or a session of its own. Access still
// isn't trusted blindly: every request's assertion is verified here as the district Worker verifies
// its own (`packages/educateos-district-worker/src/access.ts`): the signature against the team's
// published certs, RS256 only, the issuer, this application's audience and the expiry. Then
// `@educateos/identity` reads the subject, which keys the operator.
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";
import { identityFromAccessPayload } from "@educateos/identity";
import { z } from "zod";

/** The request header Access puts its signed assertion in. */
export const ACCESS_ASSERTION_HEADER = "cf-access-jwt-assertion";

/** Where an operator ends their Access session. Access serves it on every protected hostname. */
export const ACCESS_LOGOUT_PATH = "/cdn-cgi/access/logout";

/** Who signed in: the Access subject that keys the operator, and the email Access verified. */
export interface OperatorIdentity {
  /** The Access team domain that issued the assertion, `https://<team>.cloudflareaccess.com`. */
  issuer: string;
  /** Access's stable user ID. Opaque, and compared exactly. */
  subject: string;
  /** The verified email address, lowercased. Shown to the operator; never used as a key. */
  email: string;
}

/** What {@link operatorVerifier} checks assertions against. */
export interface OperatorVerifierOptions {
  /** The Access team domain, `https://<team>.cloudflareaccess.com`. */
  issuer: string;
  /** The audience tag of the control plane's Access application. */
  audience: string;
  /** The signing keys. Defaults to the team's published certs; tests pass a local key set. */
  keys?: JWTVerifyGetKey;
}

/**
 * Verifies a request's Access assertion. Resolves to the operator, or undefined if it proves no one.
 * Rejects with {@link AccessUnavailableError} when the team's keys can't be fetched, which says
 * nothing about the assertion.
 */
export type OperatorVerifier = (request: Request) => Promise<OperatorIdentity | undefined>;

/** The team's signing keys couldn't be fetched, so no assertion can be checked right now. */
export class AccessUnavailableError extends Error {
  override readonly name = "AccessUnavailableError";
}

// jose's verdicts on the assertion itself, which are all subclasses of JOSEError. The base class
// (a certs response that isn't 200 or isn't JSON), a timeout, an invalid key set and anything that
// isn't jose's (a failed fetch) are about reaching the keys, not about who signed in.
function isVerdict(error: unknown): error is errors.JOSEError {
  return error instanceof errors.JOSEError && error.code !== errors.JOSEError.code &&
    !(error instanceof errors.JWKSTimeout) && !(error instanceof errors.JWKSInvalid);
}

const Email = z.email().max(320);

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
 * An {@link OperatorVerifier} over Cloudflare Access. A request without an assertion, or with one
 * that fails verification (including one for another Access application), proves no one. So does a
 * service token: operators are people, and a service token carries no email.
 */
export function operatorVerifier(options: OperatorVerifierOptions): OperatorVerifier {
  const { issuer, audience } = options;
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) || audience.trim() === "") {
    throw new Error("The control plane's Cloudflare Access issuer and audience must both be configured.");
  }
  const keys = options.keys ?? teamKeys(issuer);
  return async (request) => {
    const token = request.headers.get(ACCESS_ASSERTION_HEADER);
    if (token === null || token === "") return undefined;
    let payload;
    try {
      ({ payload } = await jwtVerify(token, keys, { issuer, audience, algorithms: ["RS256"] }));
    } catch (error) {
      if (!isVerdict(error)) throw new AccessUnavailableError("the Access team's signing keys could not be fetched", { cause: error });
      // The code only (e.g. ERR_JWT_EXPIRED), never the token or its claims.
      console.warn("access assertion refused", { code: error.code });
      return undefined;
    }
    try {
      const identity = identityFromAccessPayload(payload, { issuer });
      const email = Email.safeParse(payload.email);
      if (identity.credential !== "person" || !email.success) return undefined;
      return { issuer: identity.issuer, subject: identity.subject, email: email.data.toLowerCase() };
    } catch {
      return undefined;
    }
  };
}
