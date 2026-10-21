import { z } from "zod";
import { DistrictId, ExternalIdentity, PrincipalId, PrincipalKind, type CredentialKind, type VerifiedIdentity } from "@schoolos/contracts";

/** The principal a verified identity resolved to, and the link that matched. */
export const ResolvedPrincipal = z.strictObject({
  districtId: DistrictId,
  principalId: PrincipalId,
  kind: PrincipalKind,
  /** The district identity link the verified identity matched. */
  identity: ExternalIdentity,
});
/** A resolved principal. */
export type ResolvedPrincipal = z.infer<typeof ResolvedPrincipal>;

/**
 * Turns a verified identity into a district principal. One resolver serves one district. Every
 * failure is `SchoolOsError("unauthenticated")`: an untrusted issuer, an identity no principal is
 * linked to, or a credential of the wrong kind for the linked principal.
 *
 * The local harness, future HTTP routes and the kernel sign-in seam all resolve through this
 * interface, so they cannot disagree about who a caller is. It is asynchronous because a
 * production resolver will read the directory from storage.
 */
export interface PrincipalResolver {
  /** The district this resolver resolves into. */
  readonly districtId: DistrictId;
  /** Resolves `identity`, reading only its `issuer`, `subject` and `credential`. */
  resolve(identity: VerifiedIdentity): Promise<ResolvedPrincipal>;
}

/**
 * Whether a credential kind may act as a principal kind: service credentials only as `service`
 * principals, person credentials only as students or staff.
 */
export function credentialMatchesPrincipal(credential: CredentialKind, kind: PrincipalKind): boolean {
  return (credential === "service") === (kind === "service");
}
