import { z } from "zod";
import { DistrictId, ExternalIdentity, PrincipalId, PrincipalKind } from "@schoolos/contracts";

/**
 * What kind of credential proved an identity. A person signs in through an IdP; a service presents
 * a machine credential such as an Access service token. The two never resolve to each other's
 * principals, so a leaked service credential cannot act as a person and a person's sign-in cannot
 * pick up a service's grants.
 */
export const CredentialKind = z.enum(["person", "service"]);
/** A credential kind. */
export type CredentialKind = z.infer<typeof CredentialKind>;

/**
 * The only facts a principal resolver accepts from a token whose signature, issuer, audience and
 * expiry a verifier has already checked. Everything else a token carries (email, name, roles,
 * groups) is deliberately absent: it is not trusted for identity or authorization (ADR-0003).
 */
export const VerifiedIdentity = z.strictObject({
  /** The verified `iss`, exactly as the token carried it. */
  issuer: ExternalIdentity.shape.issuer,
  /** The verified stable subject. Opaque; never parsed or compared case-insensitively. */
  subject: ExternalIdentity.shape.subject,
  /** Which kind of credential produced the identity. */
  credential: CredentialKind,
});
/** A verified identity. */
export type VerifiedIdentity = z.infer<typeof VerifiedIdentity>;

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
