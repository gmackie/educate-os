// How a harness district signs a request in: the same path a district behind Cloudflare Access
// takes (ADR-0003), with the fake IdP standing in for Access's verifier. The bearer token is
// verified, its payload goes through `identityFromAccessPayload`, and the identity it yields is
// resolved by `createDirectoryPrincipalResolver`. Nothing here picks a principal itself.
import { SchoolOsError, type VerifiedIdentity } from "@schoolos/contracts";
import { identityFromAccessPayload } from "@schoolos/identity";
import type { FakeIdentityProvider } from "./fake-identity.ts";

/**
 * The verified identity a request's bearer token proves at `idp`, or undefined if it proves none:
 * no token, a token `idp` did not sign or that has expired, or a payload the Access adapter
 * refuses (a missing subject, say). A service-token payload (`common_name`, empty `sub`) yields a
 * `service` credential, which resolves only to a service principal.
 */
export async function identityFromBearer(request: Request, idp: FakeIdentityProvider): Promise<VerifiedIdentity | undefined> {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return undefined;
  const payload = await idp.verifyPayload(header.slice("Bearer ".length));
  if (payload === null) return undefined;
  try {
    return identityFromAccessPayload(payload, { issuer: idp.issuer });
  } catch (error) {
    if (error instanceof SchoolOsError && error.code === "unauthenticated") return undefined;
    throw error;
  }
}
