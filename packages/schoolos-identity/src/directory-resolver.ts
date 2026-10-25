import {
  checkDirectoryIntegrity,
  externalIdentityKey,
  SchoolOsError,
  UnlinkedSignInError,
  VerifiedIdentity,
  type DistrictDirectorySnapshot,
  type Principal,
} from "@schoolos/contracts";
import {
  credentialMatchesPrincipal,
  type PrincipalResolver,
  type ResolvedPrincipal,
} from "./verified-identity.ts";

const UNMATCHED = "This sign-in is not linked to a principal in this district.";

/**
 * A {@link PrincipalResolver} over one district directory snapshot. It indexes the snapshot's
 * identity links once; to pick up a changed directory (a roster import, an approved link), build a
 * new resolver from the new snapshot.
 *
 * Throws `SchoolOsError("unavailable")` if the snapshot fails `checkDirectoryIntegrity`, because a
 * directory in which two principals share a link cannot say which of them a caller is.
 */
export function createDirectoryPrincipalResolver(directory: DistrictDirectorySnapshot): PrincipalResolver {
  if (checkDirectoryIntegrity(directory).length > 0) {
    throw new SchoolOsError("unavailable", "The district directory failed its integrity checks.");
  }
  const districtId = directory.district.id;
  const trustedIssuers = new Set(directory.district.trustedIssuers);
  const byLink = new Map<string, Principal>();
  for (const principal of directory.principals) {
    for (const identity of principal.externalIdentities) byLink.set(externalIdentityKey(identity), principal);
  }

  return {
    districtId,
    async resolve(claims): Promise<ResolvedPrincipal> {
      // Copy out exactly the fields resolution uses, so whatever else a caller's object carries
      // (email, roles, groups) is ignored rather than rejected or, worse, consulted.
      const parsed = VerifiedIdentity.safeParse({
        issuer: claims.issuer,
        subject: claims.subject,
        credential: claims.credential,
      });
      if (!parsed.success) throw new SchoolOsError("unauthenticated", "The sign-in did not carry a usable identity.");
      const { issuer, subject, credential } = parsed.data;

      if (!trustedIssuers.has(issuer)) {
        throw new SchoolOsError("unauthenticated", "This district does not trust the sign-in's issuer.");
      }
      const identity = { districtId, issuer, subject };
      const principal = byLink.get(externalIdentityKey(identity));
      // Only a sign-in nobody is linked to shows the caller their own issuer and subject, to give
      // to an administrator. A linked one of the wrong credential kind has nothing to add.
      if (principal === undefined) throw new UnlinkedSignInError({ issuer, subject }, UNMATCHED);
      if (!credentialMatchesPrincipal(credential, principal.kind)) throw new SchoolOsError("unauthenticated", UNMATCHED);
      return { districtId, principalId: principal.id, kind: principal.kind, identity };
    },
  };
}
