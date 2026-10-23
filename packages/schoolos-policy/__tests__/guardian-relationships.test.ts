import { describe, expect, it } from "vitest";
import { GuardianRelationship, type Caller, type DistrictDirectorySnapshot } from "@schoolos/contracts";
import { InMemoryAcademicStore } from "@schoolos/academics";
import { NORTHFIELD } from "@schoolos/fixtures";
import {
  directoryPolicyInformation,
  guardianRelationships,
  GuardianRelationships,
  InMemoryGuardianRelationshipStore,
  InMemoryPolicyAuditSink,
  PolicyEngine,
} from "../src/index.ts";
import { courseResource, P, req, SHARING_FLOOR, subject, withChanges } from "./setup.ts";

const BIO = "off_nf-bio-fall-p2";
const MATH7 = "off_nf-math7-fall-p1"; // Amara is not enrolled
const AMARA = P.amara.principalId;
const GINA = subject("prn_nf-guardian-gina");
const INVITED = subject("prn_g-invited");

/** Northfield with Gina as a guardian principal. */
const WITH_GINA = withChanges(NORTHFIELD, (d) => {
  d.principals.push({
    id: GINA.principalId,
    districtId: d.district.id,
    kind: "guardian",
    status: "active",
    displayName: "Gina Okafor",
    externalIdentities: [{ districtId: d.district.id, issuer: d.district.trustedIssuers[0]!, subject: "guardian-gina" }],
  });
});

const caller = (principal: { principalId: string; districtId: string }): Caller => ({ principal: principal as Caller["principal"], channel: "http" });
const ADMIN = caller(P.nfAdmin);

function harness(snapshot: DistrictDirectorySnapshot = WITH_GINA) {
  const clock = { now: new Date("2026-10-23T12:00:00Z") };
  const now = () => clock.now;
  const store = new InMemoryGuardianRelationshipStore();
  const directory = InMemoryAcademicStore.seeded(snapshot);
  const audit = new InMemoryPolicyAuditSink();
  const engine = new PolicyEngine({
    information: directoryPolicyInformation(directory, { effectivePolicy: async () => SHARING_FLOOR }, {
      relationships: [guardianRelationships(store, directory, now)],
      now,
    }),
    audit,
    now,
  });
  const service = new GuardianRelationships({ store, directory, policy: engine, now });
  const reads = async (target = courseResource(BIO, "official-grade", "course", { id: "grd_amara-bio", owner: AMARA })) =>
    (await engine.decide(req(GINA, "read", target))).decision.effect;
  return { clock, store, directory, audit, engine, service, reads };
}

describe("GuardianRelationships", () => {
  it("records a pending relationship that grants nothing until a district admin confirms it, auditing every change", async () => {
    const { service, store, reads } = await harness();
    const recorded = await service.record(ADMIN, { guardianPrincipalId: GINA.principalId, studentPrincipalId: AMARA });
    expect(recorded).toMatchObject({ status: "pending", consent: "not-required", readableKinds: ["offering", "activity", "feedback", "official-grade", "announcement"] });
    expect(await reads()).toBe("deny");

    const confirmed = await service.confirm(ADMIN, recorded.id);
    expect(confirmed).toMatchObject({ status: "active", confirmed: { by: P.nfAdmin.principalId } });
    expect(await reads()).toBe("allow");
    expect(await service.confirm(ADMIN, recorded.id)).toEqual(confirmed);

    await service.suspend(ADMIN, recorded.id, "court-order-review");
    expect(await reads()).toBe("deny");
    await service.resume(ADMIN, recorded.id);
    expect(await reads()).toBe("allow");

    const narrowed = await service.updateScope(ADMIN, recorded.id, { readableKinds: ["offering", "activity"] });
    expect(narrowed.readableKinds).toEqual(["offering", "activity"]);
    expect(await reads()).toBe("deny");

    const revoked = await service.revoke(ADMIN, recorded.id);
    expect(revoked.status).toBe("revoked");
    await expect(service.resume(ADMIN, recorded.id)).rejects.toMatchObject({ code: "conflict" });
    await expect(service.confirm(ADMIN, recorded.id)).rejects.toMatchObject({ code: "conflict" });
    // Revoking keeps the record.
    expect(await store.get(recorded.id)).toEqual(revoked);

    expect((await service.history(ADMIN, recorded.id)).map((e) => [e.action, e.actor.principalId, e.reason])).toEqual([
      ["guardian-relationship.recorded", P.nfAdmin.principalId, undefined],
      ["guardian-relationship.confirmed", P.nfAdmin.principalId, undefined],
      ["guardian-relationship.suspended", P.nfAdmin.principalId, "court-order-review"],
      ["guardian-relationship.resumed", P.nfAdmin.principalId, undefined],
      ["guardian-relationship.scope-changed", P.nfAdmin.principalId, undefined],
      ["guardian-relationship.revoked", P.nfAdmin.principalId, undefined],
    ]);
  });

  it("lets only a district admin manage relationships, and audits each decision with the relationship", async () => {
    const { service, audit } = await harness();
    const recorded = await service.record(ADMIN, { guardianPrincipalId: GINA.principalId, studentPrincipalId: AMARA });
    for (const someone of [P.highPrincipal, P.morgan, P.amara, GINA, P.rbAdmin]) {
      await expect(service.record(caller(someone), { guardianPrincipalId: GINA.principalId, studentPrincipalId: AMARA })).rejects.toMatchObject({ code: "forbidden" });
      await expect(service.confirm(caller(someone), recorded.id)).rejects.toMatchObject({ code: "forbidden" });
      await expect(service.revoke(caller(someone), recorded.id)).rejects.toMatchObject({ code: "forbidden" });
      await expect(service.listForStudent(caller(someone), AMARA)).rejects.toMatchObject({ code: "forbidden" });
    }
    const gina = audit.events.filter((e) => e.principalId === GINA.principalId);
    expect(new Set(gina.map((e) => e.ruleId))).toEqual(new Set(["guard.guardian.child-records-only"]));
    expect(audit.events.find((e) => e.principalId === P.nfAdmin.principalId && e.action === "create")).toMatchObject({
      resourceKind: "guardian-relationship",
      ruleId: "admin.district.guardian-relationships",
    });
  });

  it("confirms an invited guardian only once their own sign-in has created their principal", async () => {
    const { service, directory } = await harness();
    const recorded = await service.record(ADMIN, { guardianPrincipalId: INVITED.principalId, studentPrincipalId: AMARA });
    await expect(service.confirm(ADMIN, recorded.id)).rejects.toMatchObject({ code: "conflict" });
    const { snapshot, version } = await directory.load();
    await directory.commit({
      ...snapshot,
      principals: [...snapshot.principals, {
        id: INVITED.principalId,
        districtId: snapshot.district.id,
        kind: "guardian",
        status: "active",
        displayName: "Invited Guardian",
        externalIdentities: [{ districtId: snapshot.district.id, issuer: snapshot.district.trustedIssuers[0]!, subject: "invited" }],
      }],
    }, version);
    expect((await service.confirm(ADMIN, recorded.id)).status).toBe("active");
  });

  it("refuses relationships that name the wrong principals, offerings the child never took, or a duplicate", async () => {
    const { service } = await harness();
    await expect(service.record(ADMIN, { guardianPrincipalId: P.morgan.principalId, studentPrincipalId: AMARA })).rejects.toMatchObject({ code: "validation-failed" });
    await expect(service.record(ADMIN, { guardianPrincipalId: GINA.principalId, studentPrincipalId: P.morgan.principalId })).rejects.toMatchObject({ code: "validation-failed" });
    await expect(service.record(ADMIN, { guardianPrincipalId: GINA.principalId, studentPrincipalId: AMARA, offeringIds: [MATH7] })).rejects.toMatchObject({ code: "validation-failed" });
    await expect(service.record(ADMIN, { guardianPrincipalId: GINA.principalId, studentPrincipalId: AMARA, readableKinds: ["submission"] })).rejects.toMatchObject({ code: "validation-failed" });
    await expect(service.record(ADMIN, { guardianPrincipalId: GINA.principalId, studentPrincipalId: AMARA, reason: "free text" })).rejects.toMatchObject({ code: "validation-failed" });
    const first = await service.record(ADMIN, { guardianPrincipalId: GINA.principalId, studentPrincipalId: AMARA, offeringIds: [BIO] });
    await expect(service.record(ADMIN, { guardianPrincipalId: GINA.principalId, studentPrincipalId: AMARA })).rejects.toMatchObject({ code: "conflict" });
    await expect(service.suspend(ADMIN, first.id, "Free text about the family")).rejects.toMatchObject({ code: "validation-failed" });
    // Once revoked, the guardian can be given a new relationship.
    await service.revoke(ADMIN, first.id);
    await service.record(ADMIN, { guardianPrincipalId: GINA.principalId, studentPrincipalId: AMARA });
  });

  it("refuses a stale change instead of overwriting another administrator's", async () => {
    const { service, store } = await harness();
    const recorded = await service.record(ADMIN, { guardianPrincipalId: GINA.principalId, studentPrincipalId: AMARA });
    const confirmed = await service.confirm(ADMIN, recorded.id);
    const revoked = GuardianRelationship.parse({ ...confirmed, status: "revoked", revoked: { by: P.nfAdmin.principalId, at: "2026-10-23T12:00:00Z" } });
    const event = {
      districtId: recorded.districtId,
      actor: { principalId: P.nfAdmin.principalId },
      action: "guardian-relationship.revoked" as const,
      target: { relationshipId: recorded.id, guardianPrincipalId: recorded.guardianPrincipalId, studentPrincipalId: recorded.studentPrincipalId },
      at: "2026-10-23T12:00:00Z",
    };
    // Planned against the pending record, which has since been confirmed.
    await expect(store.commit(revoked, event, recorded)).rejects.toMatchObject({ code: "conflict" });
    await expect(store.commit(revoked, { ...event, target: { ...event.target, studentPrincipalId: P.elena.principalId } }, confirmed)).rejects.toThrow();
    expect(await store.get(recorded.id)).toEqual(confirmed);
    expect(await store.history(recorded.id)).toHaveLength(2);
  });
});
