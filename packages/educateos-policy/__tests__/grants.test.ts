import { describe, expect, it } from "vitest";
import { SchoolId, type Caller, type PrincipalId, type ResourceRef, type TermState } from "@educateos/contracts";
import { InMemoryAcademicStore } from "@educateos/academics";
import { NORTHFIELD } from "@educateos/fixtures";
import {
  appealGrantRelationships,
  AppealGrants,
  directoryPolicyInformation,
  InMemoryAppealGrantStore,
  InMemoryPolicyAuditSink,
  PolicyEngine,
  type RelationshipSource,
} from "../src/index.ts";
import { courseResource, inOffering, P, personalResource, req, SHARING_FLOOR, withChanges } from "./setup.ts";

const HOUR_MS = 3_600_000;
const http = (principal: Caller["principal"]): Caller => ({ principal, channel: "http" });

/** Amara's Biology submission, and another of hers the grant does not name. */
const SUBMISSION = courseResource("off_nf-bio-fall-p2", "submission", "course", { id: "sub_amara-cells", owner: "prn_nf-student-amara" });
const OTHER_SUBMISSION = courseResource("off_nf-bio-fall-p2", "submission", "course", { id: "sub_amara-osmosis", owner: "prn_nf-student-amara" });

const REASON = "Amara appealed her Cells lab grade on 2026-10-19 (synthetic appeal 14).";

/** An engine whose information point reads appeal grants, an appeals service on it, and a movable clock. */
function appeals(snapshot = NORTHFIELD) {
  const clock = { now: new Date("2026-10-21T09:00:00Z") };
  const now = () => clock.now;
  const store = new InMemoryAppealGrantStore();
  const directory = InMemoryAcademicStore.seeded(snapshot);
  const audit = new InMemoryPolicyAuditSink();
  const engine = new PolicyEngine({
    information: directoryPolicyInformation(directory, { effectivePolicy: async () => SHARING_FLOOR }, { relationships: [appealGrantRelationships(store, now)] }),
    audit,
  });
  const grants = new AppealGrants({ store, directory, policy: engine, now });
  const issueToPrincipal = (overrides: object = {}) =>
    grants.issue(http(P.nfAdmin), {
      purpose: "grade-appeal",
      granteePrincipalId: P.highPrincipal.principalId,
      studentPrincipalId: P.amara.principalId,
      target: { kind: "submission", id: "sub_amara-cells" },
      reason: REASON,
      durationHours: 72,
      ...overrides,
    });
  return { clock, store, audit, engine, grants, issueToPrincipal };
}

describe("an appeal grant (SCHO-56)", () => {
  it("lets the named administrator read the one named piece of work, and audits each read with the grant", async () => {
    const { engine, audit, issueToPrincipal } = appeals();
    expect((await engine.decide(req(P.highPrincipal, "read", SUBMISSION))).decision.effect).toBe("deny");

    const grant = await issueToPrincipal();
    expect(grant).toMatchObject({ purpose: "grade-appeal", issuedBy: P.nfAdmin.principalId, expiresAt: "2026-10-24T09:00:00.000Z" });
    expect(await engine.decide(req(P.highPrincipal, "read", SUBMISSION))).toMatchObject({
      decision: { effect: "allow" },
      ruleId: "appeal.reviewer.read",
      grantId: grant.id,
    });
    expect(audit.events.at(-1)).toMatchObject({ resourceId: "sub_amara-cells", ruleId: "appeal.reviewer.read", grantId: grant.id });
    // Issuing was decided and audited too, and the reason stays out of the trail.
    expect(audit.events).toContainEqual(expect.objectContaining({ action: "create", resourceKind: "access-grant", resourceId: grant.id, effect: "allow" }));
    expect(JSON.stringify(audit.events)).not.toContain("appealed");
  });

  it("opens nothing else: another submission, another owner, a write, another administrator, personal work", async () => {
    const { engine, issueToPrincipal } = appeals();
    await issueToPrincipal();
    await issueToPrincipal({ target: { kind: "artifact", id: "art_amara-journal" } });
    const denied = async (who: Caller["principal"], action: "read" | "update" | "grade", target: { resource: ResourceRef; termState?: TermState }) =>
      expect((await engine.decide(req(who, action, target))).decision.effect).not.toBe("allow");

    await denied(P.highPrincipal, "read", OTHER_SUBMISSION);
    await denied(P.highPrincipal, "read", { ...SUBMISSION, resource: { ...SUBMISSION.resource, ownerPrincipalId: P.elena.principalId } });
    await denied(P.highPrincipal, "update", SUBMISSION);
    await denied(P.highPrincipal, "grade", SUBMISSION);
    await denied(P.nfAdmin, "read", SUBMISSION);
    // A grant naming personal-private work still meets the owner-only guard first.
    expect(await engine.decide(req(P.highPrincipal, "read", personalResource("artifact", "prn_nf-student-amara", { id: "art_amara-journal" })))).toMatchObject({
      decision: { effect: "deny", reason: "classification-restricted" },
      ruleId: "guard.personal-private.owner-only",
    });
  });

  it("stops allowing reads when it expires or is revoked", async () => {
    const { engine, clock, grants, issueToPrincipal } = appeals();
    const short = await issueToPrincipal({ durationHours: 1 });
    clock.now = new Date(clock.now.getTime() + HOUR_MS);
    expect((await engine.decide(req(P.highPrincipal, "read", SUBMISSION))).decision.effect).toBe("deny");

    const grant = await issueToPrincipal();
    expect((await engine.decide(req(P.highPrincipal, "read", SUBMISSION))).decision.effect).toBe("allow");
    const revoked = await grants.revoke(http(P.nfAdmin), grant.id);
    expect(revoked.revoked).toMatchObject({ by: P.nfAdmin.principalId });
    expect((await engine.decide(req(P.highPrincipal, "read", SUBMISSION))).decision.effect).toBe("deny");
    expect((await grants.list(http(P.nfAdmin))).map((g) => g.id)).toEqual([short.id, grant.id]);
  });

  it("ends with the grantee's administrator role, and with their status", async () => {
    const demoted = withChanges(NORTHFIELD, (d) => {
      d.roleAssignments = d.roleAssignments.filter((r) => r.principalId !== P.highPrincipal.principalId);
    });
    const { engine, store } = appeals(demoted);
    const { issueToPrincipal } = appeals();
    // A grant issued while they were an administrator, read after they no longer are.
    await store.put(await issueToPrincipal());
    expect((await engine.decide(req(P.highPrincipal, "read", SUBMISSION))).decision.effect).toBe("deny");
  });

  it("is issued only by a district admin, with a purpose, a reason, a named administrator and student, and a bounded duration", async () => {
    const { grants, issueToPrincipal } = appeals();
    for (const caller of [P.highPrincipal, P.morgan, P.amara, P.rbAdmin]) {
      await expect(grants.issue(http(caller), { purpose: "grade-appeal" })).rejects.toMatchObject({ code: "forbidden" });
      await expect(grants.list(http(caller))).rejects.toMatchObject({ code: "forbidden" });
    }
    for (const overrides of [
      { reason: "because" },
      { durationHours: 14 * 24 + 1 },
      { purpose: "curiosity" },
      { target: { kind: "personal-workspace", id: "wsp_x" } },
      { granteePrincipalId: P.morgan.principalId },
      { studentPrincipalId: P.morgan.principalId },
      { extra: true },
    ]) {
      await expect(issueToPrincipal(overrides)).rejects.toMatchObject({ code: "validation-failed" });
    }
    // A district admin may name themselves; the grant and every read it allows stay on record.
    expect(await issueToPrincipal({ granteePrincipalId: P.nfAdmin.principalId })).toMatchObject({ granteePrincipalId: P.nfAdmin.principalId });
  });
});

/** A source that says every subject holds `relationship` to every resource with an ID. */
const always = (relationship: "share-grantee" | "appeal-reviewer"): RelationshipSource => ({
  relationships: async (_subject: PrincipalId, resource: ResourceRef) => (resource.id === undefined ? [] : [{ relationship, grantId: "grant-1" }]),
});

describe("relationships in the engine", () => {
  it("holds none for an inactive principal, whatever the records say", async () => {
    const snapshot = withChanges(NORTHFIELD, (d) => {
      d.principals.find((p) => p.id === P.elena.principalId)!.status = "inactive";
    });
    const engine = new PolicyEngine({
      information: directoryPolicyInformation(InMemoryAcademicStore.seeded(snapshot), { effectivePolicy: async () => SHARING_FLOOR }, { relationships: [always("share-grantee")] }),
      audit: new InMemoryPolicyAuditSink(),
    });
    const journal = personalResource("artifact", "prn_nf-student-amara", { id: "art_amara-journal" });
    expect((await engine.decide(req(P.elena, "read", journal))).decision.effect).toBe("deny");
    expect(await engine.decide(req(P.chidi, "read", journal))).toMatchObject({ decision: { effect: "allow" }, ruleId: "share.grantee.read", grantId: "grant-1" });
  });

  it("refuses a scope naming an offering under a school it is not in", async () => {
    const engine = new PolicyEngine({
      information: directoryPolicyInformation(InMemoryAcademicStore.seeded(NORTHFIELD), { effectivePolicy: async () => SHARING_FLOOR }),
      audit: new InMemoryPolicyAuditSink(),
    });
    // Math 7 is at the middle school; a high-school principal must not reach it by renaming its school.
    const forged = { ...inOffering("off_nf-math7-fall-p1").scope, schoolId: SchoolId.parse("sch_nf-high") };
    expect(await engine.decide(req(P.highPrincipal, "read", { resource: { kind: "offering", id: "off_nf-math7-fall-p1", scope: forged, classification: "course" } })))
      .toMatchObject({ decision: { effect: "deny", reason: "no-matching-grant" }, ruleId: "scope.unknown" });
  });
});
