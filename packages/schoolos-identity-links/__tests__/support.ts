import type { Caller, DistrictDirectorySnapshot, DistrictId, PolicySettings, PrincipalId, WorkshopUserId } from "@schoolos/contracts";
import { InMemoryAcademicStore } from "@schoolos/academics";
import { NORTHFIELD } from "@schoolos/fixtures";
import type { PendingIdentityLink, PendingWorkshopUserAdoption } from "@schoolos/identity";
import { directoryPolicyInformation, PolicyEngine, type PolicyAuditEvent } from "@schoolos/policy";
import { IdentityLinkAdminService, InMemoryIdentityLinkStore, type IdentityLinkStore } from "../src/index.ts";

/** Northfield's district. */
export const NF = "dst_northfield" as DistrictId;
/** Northfield's Access team domain, which the test directory trusts alongside the fixture IdP. */
export const NF_ACCESS = "https://northfield.cloudflareaccess.example";
/** A fixed time for requests and decisions. */
export const AT = "2026-10-21T09:00:00.000Z";

/** Northfield's principals the tests name. */
export const P = {
  admin: "prn_nf-district-admin" as PrincipalId,
  schoolAdmin: "prn_nf-principal-high" as PrincipalId,
  morgan: "prn_nf-morgan-lee" as PrincipalId,
  rivera: "prn_nf-teacher-rivera" as PrincipalId,
  amara: "prn_nf-student-amara" as PrincipalId,
} as const;

/** Two email-keyed Workshop users, as Durable Object IDs. */
export const WU = {
  morgan: "0a1b2c3d4e5f60718293a4b5c6d7e8f9" as WorkshopUserId,
  rivera: "f9e8d7c6b5a4938271605f4e3d2c1b0a" as WorkshopUserId,
} as const;

/** A caller over HTTP. */
export const caller = (principalId: PrincipalId, districtId: DistrictId = NF): Caller => ({
  principal: { principalId, districtId },
  channel: "http",
});

/** Northfield, also trusting its Access team domain. Nobody holds an Access link yet. */
export function northfieldWithAccess(): DistrictDirectorySnapshot {
  return { ...NORTHFIELD, district: { ...NORTHFIELD.district, trustedIssuers: [...NORTHFIELD.district.trustedIssuers, NF_ACCESS] } };
}

/** A pending link of an Access identity to a Northfield principal. */
export function accessLink(principalId: PrincipalId, subject: string, workshopUserId?: WorkshopUserId): PendingIdentityLink {
  return {
    districtId: NF,
    principalId,
    identity: { districtId: NF, issuer: NF_ACCESS, subject },
    credential: "person",
    requestedAt: AT,
    ...(workshopUserId === undefined ? {} : { workshopUserId }),
  };
}

/** A pending adoption of a Workshop user into a Northfield principal. */
export function adoption(principalId: PrincipalId, workshopUserId: WorkshopUserId): PendingWorkshopUserAdoption {
  return { districtId: NF, principalId, workshopUserId, requiresAdminConfirmation: true };
}

const FLOOR: PolicySettings = {
  aiSpending: "capped",
  promptsInGatewayLogs: "prohibited",
  studentPersonalConversations: "private",
  teacherObservation: "assigned-work-only",
  automatedSelProfiling: "prohibited",
  aiMonthlyCapCentsPerPrincipal: 500,
};

/** A Northfield admin service over fresh in-memory stores and the default policy rules. */
export function northfieldControl(store: IdentityLinkStore = new InMemoryIdentityLinkStore(NF)) {
  const directory = InMemoryAcademicStore.seeded(northfieldWithAccess());
  const policyAudit: PolicyAuditEvent[] = [];
  const policy = new PolicyEngine({
    information: directoryPolicyInformation(directory, { effectivePolicy: async () => FLOOR }),
    audit: { record: async (event) => void policyAudit.push(event) },
  });
  const service = new IdentityLinkAdminService({ store, directory, policy, now: () => new Date(AT) });
  return { store, directory, policy, policyAudit, service };
}
