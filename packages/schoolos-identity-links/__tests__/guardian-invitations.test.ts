import { describe, expect, it } from "vitest";
import type { DistrictDirectorySnapshot, VerifiedIdentity } from "@schoolos/contracts";
import { InMemoryAcademicStore } from "@schoolos/academics";
import { createDirectoryPrincipalResolver } from "@schoolos/identity";
import {
  directoryPolicyInformation,
  guardianRelationships,
  GuardianRelationships,
  InMemoryGuardianRelationshipStore,
  PolicyEngine,
} from "@schoolos/policy";
import {
  GuardianInvitations,
  IdentityLinkAdminService,
  InMemoryGuardianInvitationStore,
  InMemoryIdentityLinkStore,
} from "../src/index.ts";
import { caller, NF, NF_ACCESS, northfieldWithAccess, P } from "./support.ts";

const ADMIN = caller(P.admin);
const gina: VerifiedIdentity = { issuer: NF_ACCESS, subject: "access-gina", credential: "person" };

function onboarding(snapshot: DistrictDirectorySnapshot = northfieldWithAccess()) {
  const clock = { now: new Date("2026-10-23T12:00:00.000Z") };
  const now = () => clock.now;
  const directory = InMemoryAcademicStore.seeded(snapshot);
  const relationshipStore = new InMemoryGuardianRelationshipStore();
  const identityLinks = new InMemoryIdentityLinkStore(NF);
  const policy = new PolicyEngine({
    information: directoryPolicyInformation(directory, { effectivePolicy: async () => ({}) as never }, {
      relationships: [guardianRelationships(relationshipStore, directory, now)],
      now,
    }),
    audit: { record: async () => {} },
    now,
  });
  const relationships = new GuardianRelationships({ store: relationshipStore, directory, policy, now });
  const store = new InMemoryGuardianInvitationStore();
  const invitations = new GuardianInvitations({ store, relationships, relationshipStore, identityLinks, directory, now });
  const links = new IdentityLinkAdminService({ store: identityLinks, directory, policy, now });
  return { clock, directory, relationshipStore, identityLinks, relationships, invitations, links, store };
}

describe("guardian onboarding (ADR-0012 §8)", () => {
  it("takes three separate decisions: invite, approve the sign-in (creating the guardian), confirm the relationship", async () => {
    const { invitations, links, relationships, directory, relationshipStore } = onboarding();
    const issued = await invitations.invite(ADMIN, { studentPrincipalId: P.amara, guardianDisplayName: "Gina Okafor" });
    expect(issued.relationship).toMatchObject({ status: "pending", studentPrincipalId: P.amara, guardianPrincipalId: issued.invitation.reservedGuardianPrincipalId });
    expect(issued.invitation).not.toHaveProperty("tokenDigest");
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    expect(await invitations.redeem(gina, issued.token)).toEqual({ outcome: "awaiting-approval" });
    // Redeeming creates no one and grants nothing.
    await expect(createDirectoryPrincipalResolver((await directory.load()).snapshot).resolve(gina)).rejects.toMatchObject({ code: "unauthenticated" });
    const [request] = await links.listPending(ADMIN);
    const [listed] = await invitations.listForStudent(ADMIN, P.amara);
    expect(listed!.redeemed).toMatchObject({ outcome: "awaiting-approval", requestId: request!.requestId });
    await expect(relationships.confirm(ADMIN, issued.relationship.id)).rejects.toMatchObject({ code: "conflict" });

    await links.approve(ADMIN, request!.requestId);
    const resolved = await createDirectoryPrincipalResolver((await directory.load()).snapshot).resolve(gina);
    expect(resolved).toMatchObject({ principalId: issued.invitation.reservedGuardianPrincipalId, kind: "guardian" });
    expect((await relationshipStore.get(issued.relationship.id))!.status).toBe("pending");

    expect((await relationships.confirm(ADMIN, issued.relationship.id)).status).toBe("active");
  });

  it("is single-use, expires, and dies with its relationship, answering every refusal alike", async () => {
    const { invitations, relationships, clock } = onboarding();
    const used = await invitations.invite(ADMIN, { studentPrincipalId: P.amara, guardianDisplayName: "Gina Okafor" });
    await invitations.redeem(gina, used.token);
    await expect(invitations.redeem({ ...gina, subject: "someone-else" }, used.token)).rejects.toMatchObject({ code: "not-found" });

    const revoked = await invitations.invite(ADMIN, { studentPrincipalId: "prn_nf-student-elena", guardianDisplayName: "Gus" });
    await relationships.revoke(ADMIN, revoked.relationship.id);
    await expect(invitations.redeem(gina, revoked.token)).rejects.toMatchObject({ code: "not-found" });

    const expiring = await invitations.invite(ADMIN, { studentPrincipalId: "prn_nf-student-dmitri", guardianDisplayName: "Dee", expiresInHours: 1 });
    clock.now = new Date(clock.now.getTime() + 3_600_000);
    await expect(invitations.redeem(gina, expiring.token)).rejects.toMatchObject({ code: "not-found" });
    await expect(invitations.redeem(gina, "not-a-token")).rejects.toMatchObject({ code: "not-found" });
    await expect(invitations.redeem(gina, "A".repeat(43))).rejects.toMatchObject({ code: "not-found" });
  });

  it("does not spend the link on a sign-in that cannot be linked", async () => {
    const { invitations } = onboarding();
    const issued = await invitations.invite(ADMIN, { studentPrincipalId: P.amara, guardianDisplayName: "Gina Okafor" });
    await expect(invitations.redeem({ ...gina, issuer: "https://untrusted.example" }, issued.token)).rejects.toMatchObject({ code: "forbidden" });
    await expect(invitations.redeem({ ...gina, credential: "service" }, issued.token)).rejects.toMatchObject({ code: "validation-failed" });
    // A student's own sign-in (Amara signing in for herself) is never turned into a guardian.
    const amara: VerifiedIdentity = { issuer: northfieldWithAccess().district.trustedIssuers[0]!, subject: "nf-s-2001", credential: "person" };
    await expect(invitations.redeem(amara, issued.token)).rejects.toMatchObject({ code: "forbidden" });
    expect(await invitations.redeem(gina, issued.token)).toEqual({ outcome: "awaiting-approval" });
  });

  it("joins an existing guardian to a sibling's relationship without a second sign-in approval", async () => {
    const { invitations, links, relationships, relationshipStore } = onboarding();
    const first = await invitations.invite(ADMIN, { studentPrincipalId: P.amara, guardianDisplayName: "Gina Okafor" });
    await invitations.redeem(gina, first.token);
    await links.approve(ADMIN, (await links.listPending(ADMIN))[0]!.requestId);

    const sibling = await invitations.invite(ADMIN, { studentPrincipalId: "prn_nf-student-elena", guardianDisplayName: "Gina Okafor" });
    expect(await invitations.redeem(gina, sibling.token)).toEqual({ outcome: "joined" });
    expect(await links.listPending(ADMIN)).toEqual([]);
    const joined = (await relationshipStore.get(sibling.relationship.id))!;
    expect(joined).toMatchObject({ status: "pending", guardianPrincipalId: first.invitation.reservedGuardianPrincipalId });
    expect((await relationshipStore.history(sibling.relationship.id)).map((e) => e.action)).toEqual([
      "guardian-relationship.recorded",
      "guardian-relationship.guardian-joined",
    ]);
    expect((await relationships.confirm(ADMIN, sibling.relationship.id)).status).toBe("active");

    // Inviting them again for a child they already have is refused at redemption.
    const again = await invitations.invite(ADMIN, { studentPrincipalId: P.amara, guardianDisplayName: "Gina Okafor" });
    await expect(invitations.redeem(gina, again.token)).rejects.toMatchObject({ code: "conflict" });
  });

  it("lets only a district admin invite or list invitations", async () => {
    const { invitations } = onboarding();
    for (const someone of [P.schoolAdmin, P.rivera, P.amara]) {
      await expect(invitations.invite(caller(someone), { studentPrincipalId: P.amara, guardianDisplayName: "Gina" })).rejects.toMatchObject({ code: "forbidden" });
      await expect(invitations.listForStudent(caller(someone), P.amara)).rejects.toMatchObject({ code: "forbidden" });
    }
  });
});
