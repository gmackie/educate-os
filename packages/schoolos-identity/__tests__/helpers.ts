import type { DistrictDirectorySnapshot, PrincipalId } from "@schoolos/contracts";
import { NORTHFIELD, RIVERBEND } from "@schoolos/fixtures";
import { accessServiceTokenSubject } from "../src/index.ts";

/**
 * Northfield's Access team domain. Real ones are `https://<team>.cloudflareaccess.com`; tests keep
 * to reserved `.example` names, and nothing in the adapter depends on the host.
 */
export const NF_ACCESS = "https://northfield.cloudflareaccess.example";
/** Riverbend's Access team domain. */
export const RB_ACCESS = "https://riverbend.cloudflareaccess.example";
/** Northfield's fixture IdP issuer. */
export const NF_IDP = NORTHFIELD.district.trustedIssuers[0]!;
/** Riverbend's fixture IdP issuer. */
export const RB_IDP = RIVERBEND.district.trustedIssuers[0]!;

/** Northfield's district administrator. */
export const NF_ADMIN = "prn_nf-district-admin" as PrincipalId;
/** Riverbend's district administrator. */
export const RB_ADMIN = "prn_rb-district-admin" as PrincipalId;
/** The service principal {@link northfieldWithAccess} adds. */
export const NF_SERVICE = "prn_nf-svc-roster" as PrincipalId;
/** The Access service token client ID linked to {@link NF_SERVICE}. */
export const NF_SERVICE_CLIENT_ID = "0a1b2c3d4e5f.access";
/** A fixed timestamp for requests and decisions. */
export const AT = "2026-10-20T15:00:00Z";

/**
 * A fixture district that has also enabled Cloudflare Access: it trusts the team domain, and each
 * listed principal holds an Access link with the given Access user ID. Built by hand rather than
 * through the linker so the resolver tests do not depend on it.
 */
export function withAccess(
  directory: DistrictDirectorySnapshot,
  teamDomain: string,
  accessSubjects: Record<string, string>,
): DistrictDirectorySnapshot {
  const districtId = directory.district.id;
  return {
    ...directory,
    district: { ...directory.district, trustedIssuers: [...directory.district.trustedIssuers, teamDomain] },
    principals: directory.principals.map((p) => {
      const subject = accessSubjects[p.id];
      return subject === undefined
        ? p
        : { ...p, externalIdentities: [...p.externalIdentities, { districtId, issuer: teamDomain, subject }] };
    }),
  };
}

/** Northfield with Access enabled, plus a roster-sync service principal linked to a service token. */
export function northfieldWithAccess(): DistrictDirectorySnapshot {
  const base = withAccess(NORTHFIELD, NF_ACCESS, {
    "prn_nf-district-admin": "access-uuid-nf-admin",
    "prn_nf-morgan-lee": "access-uuid-1042",
    "prn_nf-student-amara": "access-uuid-amara",
    "prn_nf-student-chidi": "access-uuid-chidi",
  });
  return {
    ...base,
    principals: [
      ...base.principals,
      {
        id: NF_SERVICE,
        districtId: base.district.id,
        kind: "service",
        displayName: "Roster sync",
        externalIdentities: [
          { districtId: base.district.id, issuer: NF_ACCESS, subject: accessServiceTokenSubject(NF_SERVICE_CLIENT_ID) },
        ],
      },
    ],
  };
}

/**
 * Riverbend with Access enabled. Morgan Lee's Access user ID is deliberately the same as in
 * Northfield, the worst case for a deployment that keyed on subject alone.
 */
export function riverbendWithAccess(): DistrictDirectorySnapshot {
  return withAccess(RIVERBEND, RB_ACCESS, {
    "prn_rb-district-admin": "access-uuid-rb-admin",
    "prn_rb-morgan-lee": "access-uuid-1042",
  });
}

/** A verified Access user-token payload, shaped like what `verifyCfAccessJwt` returns. */
export function accessUserPayload(iss: string, sub: string, extra: Record<string, unknown> = {}) {
  return { iss, sub, aud: ["aud-tag"], type: "app", iat: 1, exp: 2, ...extra };
}

/** A verified Access service-token payload: `common_name` and an empty `sub`. */
export function accessServicePayload(iss: string, commonName: string, extra: Record<string, unknown> = {}) {
  return { iss, sub: "", common_name: commonName, aud: ["aud-tag"], type: "app", iat: 1, exp: 2, ...extra };
}
