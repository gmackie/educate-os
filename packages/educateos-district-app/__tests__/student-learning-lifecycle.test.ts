/// <reference types="node" />
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { GuardianRelationshipId, PrincipalId } from "@educateos/contracts";
import { GuardianGuidanceGrant, PolicyAuditEvent } from "@educateos/policy";
import { createDistrictApp } from "../src/app.ts";
import { durableStudentLearningLifecycle, DurableObjectPlannerStore, DurableObjectGuidanceStore, DurableObjectGuardianGuidanceGrantStore, type DistrictSqlStorage } from "../src/durable-stores.ts";
import { bootDistrict, expectError, importFetch, NF, NORTHFIELD, RIVERBEND } from "./support.ts";
import type { GuidanceRecord } from "../src/guidance.ts";

const studentId = PrincipalId.parse(NF.amara);
const other = PrincipalId.parse(NF.elena);
const actor = PrincipalId.parse(NF.admin);
const params = { studentId };
const course = { offeringId: NF.eng9 };
const at = "2026-11-15T12:00:00.000Z";
const allowed = { legalHold: false, deletionAuthorized: true, archiveSatisfied: true };
const setup = () => bootDistrict({ ...NORTHFIELD, courses: NORTHFIELD.courses.map((c) => ({ ...c, gradeBand: "6" })) }, { now: () => new Date(at) });
const preference = (id = studentId): GuidanceRecord => ({ type: "preference", id: `pref:${id}`, scope: `student:${id}`, studentId: id, revision: 1, guardianSuggestions: "on", updatedAt: at });
const grant = GuardianGuidanceGrant.parse({ relationshipId: GuardianRelationshipId.parse("grl_lifecycle"), districtId: NORTHFIELD.district.id, studentPrincipalId: studentId, guardianPrincipalId: "prn_guardian-lifecycle", enabled: true, capabilities: ["suggest", "progress"], revision: 1, history: [{ action: "enabled", by: actor, at, capabilities: ["suggest", "progress"] }] });

it("authorizes district administrators only, rejects foreign/nonstudent subjects and never changes records on refusal", async () => {
  const d = await setup();
  const guardianToken = d.tokenFor("prn_nf-guardian-rosa");
  for (const token of [undefined, d.tokenFor(NF.rivera), d.tokenFor(NF.morgan), d.tokenFor(NF.amara), guardianToken]) {
    for (const route of ["admin.studentLearningPreview", "admin.studentLearningDisposition", "admin.purgeStudentLearning"] as const) {
      const result = route === "admin.studentLearningPreview" ? await d.call(token, route, { params }) : route === "admin.studentLearningDisposition" ? await d.call(token, route, { params, body: { ...allowed, revision: 0 } }) : await d.call(token, route, { params, body: { revision: 0, confirmStudentId: studentId } });
      expect([401, 403]).toContain(result.status);
    }
  }
  const rb = await bootDistrict(RIVERBEND);
  const rbAdmin = RIVERBEND.roleAssignments.find((r) => r.role === "district-admin")!.principalId;
  expectError(await rb.call(rb.tokenFor(rbAdmin), "admin.studentLearningPreview", { params }), 404, "not-found");
  expectError(await rb.call(rb.tokenFor(rbAdmin), "admin.purgeStudentLearning", { params, body: { revision: 0, confirmStudentId: studentId } }), 404, "not-found");
  expectError(await d.call(d.tokenFor(NF.admin), "admin.studentLearningPreview", { params: { studentId: actor } }), 404, "not-found");
  expect(d.stores.studentLearningLifecycle.state(studentId).revision).toBe(0);
});

it("previews without mutation, fails closed until disposition review, and denies holds, archives, deadlines and stale confirmations", async () => {
  const d = await setup();
  const admin = d.tokenFor(NF.admin);
  await d.stores.guidance.records.save(preference(), 0);
  const preview = await d.ok(admin, "admin.studentLearningPreview", { params });
  expect(preview).toMatchObject({ counts: { plans: 0, guidance: 1, guardianGrants: 0 }, state: { revision: 0 }, blockers: ["disposition-unreviewed", "archive-required"] });
  expectError(await d.call(admin, "admin.purgeStudentLearning", { params, body: { revision: 0, confirmStudentId: studentId } }), 409, "conflict");
  let revision = 0;
  for (const disposition of [{ ...allowed, legalHold: true }, { ...allowed, retainUntil: "2027-01-01T00:00:00Z" }, { ...allowed, archiveSatisfied: false }]) {
    const state = await d.ok(admin, "admin.studentLearningDisposition", { params, body: { ...disposition, revision } });
    revision = state.revision;
    expectError(await d.call(admin, "admin.purgeStudentLearning", { params, body: { revision, confirmStudentId: studentId } }), 409, "conflict");
    expect((await d.ok(admin, "admin.studentLearningPreview", { params })).counts.guidance).toBe(1);
  }
  await d.ok(admin, "admin.studentLearningDisposition", { params, body: { ...allowed, retainUntil: "2025-01-01T00:00:00Z", revision } });
  expectError(await d.call(admin, "admin.purgeStudentLearning", { params, body: { revision, confirmStudentId: studentId } }), 409, "conflict");
  expectError(await d.call(admin, "admin.purgeStudentLearning", { params, body: { revision: revision + 1, confirmStudentId: other } }), 409, "conflict");
});

it("purges through the admin API, preserves identity links/audit and reroutes active plan requests to not-found", async () => {
  const d = await setup();
  const admin = d.tokenFor(NF.admin);
  const plan = await d.ok(d.tokenFor(NF.amara), "student.planGoal", { params: course, body: { goal: "PRIVATE pizza", skills: ["planning"] } });
  const invited = await d.ok(admin, "admin.inviteGuardian", { params, body: { guardianDisplayName: "Parent" } });
  const relationshipBefore = await d.stores.guardianRelationships.get(invited.relationship.id);
  const linksBefore = await d.stores.identityLinks.read();
  const auditBefore = d.audit.events();
  await d.ok(admin, "admin.studentLearningDisposition", { params, body: { ...allowed, revision: 0 } });
  const receipt = await d.ok(admin, "admin.purgeStudentLearning", { params, body: { revision: 1, confirmStudentId: studentId } });
  expect(receipt).toMatchObject({ studentId, actorId: actor, at, counts: { plans: 1, guidance: 0, guardianGrants: 0 } });
  expect(await d.ok(admin, "admin.purgeStudentLearning", { params, body: { revision: 1, confirmStudentId: studentId } })).toEqual(receipt);
  expect(await d.stores.guardianRelationships.get(invited.relationship.id)).toEqual(relationshipBefore);
  expect(await d.stores.identityLinks.read()).toEqual(linksBefore);
  expect(d.audit.events().slice(0, auditBefore.length)).toEqual(auditBefore);
  const deletion = d.audit.events().find((e) => e.studentLearningDeletion !== undefined)!;
  expect(PolicyAuditEvent.parse(deletion)).toMatchObject({ action: "delete", principalId: actor, resourceId: studentId, studentLearningDeletion: { receiptId: receipt.id, plans: 1 } });
  expect(JSON.stringify(deletion)).not.toContain("PRIVATE");
  expect(await d.ok(d.tokenFor(NF.amara), "student.planner", { params: course })).toEqual([]);
  expectError(await d.call(d.tokenFor(NF.amara), "student.plannerCoach", { params: { ...course, planId: plan.id, opportunityId: plan.opportunities[0]!.id }, body: { revision: plan.revision, action: "try", allowAi: false } }), 404, "not-found");
  expectError(await d.call(d.tokenFor(NF.amara), "student.planGoal", { params: course, body: { goal: "New pizza", skills: [] } }), 409, "conflict");
});

for (const adapter of ["memory", "SQLite"] as const) describe(adapter, () => {
  it("atomically erases all subject learning records, preserves agendas/other students, fences stale and fresh writes across reconstruction", async () => {
    const d = await setup();
    const plan = await d.ok(d.tokenFor(NF.amara), "student.planGoal", { params: course, body: { goal: "pizza", skills: [] } });
    const db = new DatabaseSync(":memory:");
    const storage: DistrictSqlStorage = {
      sql: { exec(query, ...bindings) { const rows = db.prepare(query).all(...bindings.map((b) => b instanceof ArrayBuffer ? new Uint8Array(b) : b)); return { toArray: () => rows }; } },
      transactionSync(run) { db.exec("BEGIN"); try { const result = run(); db.exec("COMMIT"); return result; } catch (e) { db.exec("ROLLBACK"); throw e; } },
    };
    try {
      const lifecycle = adapter === "memory" ? d.stores.studentLearningLifecycle : durableStudentLearningLifecycle(storage);
      const planner = adapter === "memory" ? d.stores.planner : new DurableObjectPlannerStore(storage);
      const guidance = adapter === "memory" ? d.stores.guidance.records : new DurableObjectGuidanceStore(storage);
      const grants = adapter === "memory" ? d.stores.guidance.guardianGrants : new DurableObjectGuardianGuidanceGrantStore(storage);
      if (adapter === "SQLite") await planner.save(plan, 0);
      await planner.save({ ...plan, id: crypto.randomUUID(), offeringId: "off_removed" as never }, 0);
      const otherPlan = { ...plan, id: crypto.randomUUID(), studentId: other };
      await planner.save(otherPlan, 0);
      await guidance.save(preference(), 0);
      const otherPref = preference(other);
      await guidance.save(otherPref, 0);
      const agenda: GuidanceRecord = { type: "agenda", id: "agenda", scope: NF.eng9, offeringId: NF.eng9 as never, revision: 1, priorities: [], updated: { by: actor, byName: "Admin", at } };
      await guidance.save(agenda, 0);
      await guidance.save({ type: "suggestion", id: crypto.randomUUID(), scope: NF.eng9, offeringId: NF.eng9 as never, revision: 1, studentId, guardianId: grant.guardianPrincipalId, guardianName: "Parent", relationshipId: grant.relationshipId, kind: "hobby", topic: "PRIVATE interest", status: "shared", createdAt: at, expiresAt: "2027-01-01T00:00:00Z" }, 0);
      await guidance.save({ type: "practice", id: crypto.randomUUID(), scope: NF.eng9, offeringId: NF.eng9 as never, revision: 1, studentId, authorId: actor, authorName: "Admin", skill: "planning", createdAt: at }, 0);
      await grants.save(grant, 0);
      expect(lifecycle.preview(studentId, at).counts).toEqual({ plans: 2, guidance: 3, guardianGrants: 1 });
      lifecycle.configure(studentId, allowed, 0);
      // A hold committed after preview defeats a purge based on that preview.
      lifecycle.configure(studentId, { ...allowed, legalHold: true }, 1);
      expect(() => lifecycle.purge(studentId, actor, at, 1)).toThrow(/changed/);
      expect(() => lifecycle.purge(studentId, actor, at, 2)).toThrow(/blocked/);
      lifecycle.configure(studentId, allowed, 2);
      const receipt = lifecycle.purge(studentId, actor, at, 3);
      expect(receipt.counts).toEqual({ plans: 2, guidance: 3, guardianGrants: 1 });
      const restarted = adapter === "memory" ? lifecycle : durableStudentLearningLifecycle(storage);
      expect(restarted.purge(studentId, actor, at, 3)).toEqual(receipt);
      expect(restarted.preview(studentId, at).counts).toEqual({ plans: 0, guidance: 0, guardianGrants: 0 });
      const reopenedPlanner = adapter === "memory" ? planner : new DurableObjectPlannerStore(storage);
      expect(await reopenedPlanner.list(NF.eng9)).toEqual([otherPlan]);
      expect(await guidance.list(NF.eng9)).toEqual([agenda]);
      expect(await guidance.list(`student:${other}`)).toEqual([otherPref]);
      expect((await grants.get(grant.relationshipId))!).toMatchObject({ enabled: false, revision: 2, history: [{ action: "enabled" }, { action: "revoked", by: actor, at }] });
      await expect(reopenedPlanner.save({ ...plan, revision: 2 }, 1)).rejects.toMatchObject({ code: "conflict" });
      await expect(reopenedPlanner.save({ ...plan, id: crypto.randomUUID() }, 0)).rejects.toMatchObject({ code: "conflict" });
      await expect(guidance.save(preference(), 0)).rejects.toMatchObject({ code: "conflict" });
      await expect(grants.save({ ...grant, revision: 3 }, 2)).rejects.toMatchObject({ code: "conflict" });
      // Recreating the application over retained storage must not re-seed erased learner records.
      if (adapter === "memory") {
        await createDistrictApp({ stores: d.stores, verifyRequest: d.idp.verify, importFetch });
        expect(d.stores.studentLearningLifecycle.state(studentId).receipt).toEqual(receipt);
      }
    } finally { db.close(); }
  });
});
