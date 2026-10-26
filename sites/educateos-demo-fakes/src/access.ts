// Defence in depth for the admin surface. `/_admin/*` sits behind a Cloudflare Access application
// whose policy admits a service token; the Worker also verifies the assertion Access adds, as the
// kernel's `verifyCfAccessJwt` (packages/workshop-backend/src/access.ts) and the district Worker's
// `accessRequestVerifier` (packages/educateos-district-worker/src/access.ts) do: RS256 against the
// team's published certs, the team issuer, the application's audience, and expiry. Neither is an
// importable package, so this follows the same few lines. Without a configured audience nothing is
// admitted.
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

/** The Cloudflare Access team the admin application belongs to. */
export const ACCESS_ISSUER = "https://gmacko.cloudflareaccess.com";

/** The request header Access puts its signed assertion in. */
export const ACCESS_ASSERTION_HEADER = "cf-access-jwt-assertion";

// One remote key set per isolate, so the team's certs are fetched once rather than per request.
let teamKeys: JWTVerifyGetKey | undefined;

function defaultKeys(): JWTVerifyGetKey {
  teamKeys ??= createRemoteJWKSet(new URL(`${ACCESS_ISSUER}/cdn-cgi/access/certs`));
  return teamKeys;
}

/**
 * The verified claims of the request's Access assertion, or null: no audience configured, no
 * assertion, or one that fails verification. `keys` defaults to the team's published certs; the
 * tests pass a local key set.
 */
export async function verifyAdminAssertion(request: Request, audience: string | undefined, keys: JWTVerifyGetKey = defaultKeys()): Promise<JWTPayload | null> {
  if (audience === undefined || audience.trim() === "") return null;
  const token = request.headers.get(ACCESS_ASSERTION_HEADER);
  if (token === null || token === "") return null;
  try {
    return (await jwtVerify(token, keys, { issuer: ACCESS_ISSUER, audience: audience.trim(), algorithms: ["RS256"], requiredClaims: ["exp"] })).payload;
  } catch {
    return null;
  }
}
