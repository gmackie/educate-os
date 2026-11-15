/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { PrincipalId } from "@educateos/contracts";
import { EvidenceContract } from "@educateos/registry";
import { DurableObjectPlannerStore, type DistrictSqlStorage } from "../src/durable-stores.ts";
import { InMemoryPlannerStore, PlannerPlan, plannerTeacherView } from "../src/planner.ts";
import { bootDistrict, expectError, NF, NORTHFIELD, RIVERBEND, type TestDistrict } from "./support.ts";

const params = { offeringId: NF.eng9 };
const gradeSix = () => ({ ...NORTHFIELD, courses: NORTHFIELD.courses.map((c) => ({ ...c, gradeBand: "6" })) });
const setup = () => bootDistrict(gradeSix());
const propose = (d: TestDistrict, goal = "Build a Roblox Pizza Tycoon") => d.ok(d.tokenFor(NF.amara), "student.planGoal", { params, body: { goal, skills: ["planning"] } });
const target = (p: PlannerPlan, index = 0) => ({ ...params, planId: p.id, opportunityId: p.opportunities[index]!.id });
const accept = (d: TestDistrict, p: PlannerPlan) => d.ok(d.tokenFor(NF.amara), "student.plannerDecision", { params: target(p), body: { revision: p.revision, decision: "accepted" } });
const share = (d: TestDistrict, p: PlannerPlan, assistance: "independent" | "ai" = "independent") => d.ok(d.tokenFor(NF.amara), "student.plannerShare", { params: target(p), body: { revision: p.revision, text: "Oven A: 4 pizzas/minute; B: 3. After 20 minutes: 80 and 60. I explained my units and solved a fresh problem.", assistance } });

describe("Personalized Learning Planner", () => {
  it("pins real approved catalog records and native evidence contracts, without invented CASE identities", async () => {
    const d = await setup();
    const p = await propose(d);
    expect(p.opportunities.map((o) => o.code)).toEqual(["6.RP.A.3b", "W.6.1"]);
    const math = p.opportunities[0]!;
    const release = await d.app.catalog.approvedRelease("ccss-math");
    expect(math.releaseDigest).toBe(release!.contentDigest);
    expect(math.node).toEqual(release!.content.nodes!.find((n) => n.humanCodingScheme === "6.RP.A.3"));
    expect(math.node.provenance.source).toBe("derived");
    expect(math.framework.publisher).toBe("NGA Center and CCSSO");
    expect(math.task).toContain("12 pizzas in 3 minutes");
    expect(EvidenceContract.parse(math.contract).competencies[0]!.competencyUri).toBe(math.node.uri);
    expect(math.priorEvidence).toContain("No shared planner evidence");
    expect(p.opportunities[1]!.node.humanCodingScheme).toBe("W.6.1");
    const cookie = await propose(d, "Compare cookie prices and persuade our club to choose a recipe");
    expect(cookie.opportunities[0]!.task).toContain("12 cookies for $6");
    expect(cookie.opportunities[1]!.contract.criteria.length).toBeGreaterThan(1);
  });

  it("never reveals private goals, skills or unshared responses to adults or other students", async () => {
    const d = await setup();
    let p = await propose(d, "PRIVATE INTENT Roblox pizza surprise");
    const teacher = d.tokenFor(NF.rivera);
    expect(await d.ok(teacher, "teacher.planner", { params })).toEqual([]);
    expectError(await d.call(d.tokenFor(NF.dmitri), "student.planner", { params }), 404, "not-found");
    expect(await d.ok(d.tokenFor(NF.elena), "student.planner", { params })).toEqual([]);
    expectError(await d.call(teacher, "student.planner", { params }), 403, "forbidden");
    p = await accept(d, p);
    expect(await d.ok(teacher, "teacher.planner", { params })).toEqual([]);
    p = await share(d, p);
    const visible = await d.ok(teacher, "teacher.planner", { params });
    expect(visible).toHaveLength(1);
    expect(JSON.stringify(visible)).not.toContain("PRIVATE INTENT");
    expect(visible[0]!.skills).toEqual([]);
    expect(visible[0]!.opportunities).toHaveLength(1);
    expect(visible[0]!.opportunities[0]!.response!.assistance).toBe("independent");
    const next = await propose(d);
    expect(next.opportunities[0]!.priorEvidence).toContain("awaits teacher review");
  });

  it("offers attributed teacher invitations that students can skip, without creating assignments", async () => {
    const d = await setup();
    const before = await d.stores.assessment.load();
    const invite = await d.ok(d.tokenFor(NF.rivera), "teacher.plannerInvite", { params, body: { studentId: PrincipalId.parse(NF.amara), goal: "Compare cookie unit prices", skills: [] } });
    expect(invite).toMatchObject({ source: "teacher", authorId: NF.rivera, invitation: "Compare cookie unit prices" });
    expect(invite).not.toHaveProperty("goal");
    const mine = await d.ok(d.tokenFor(NF.amara), "student.planner", { params });
    const p = mine[0]!;
    const skipped = await d.ok(d.tokenFor(NF.amara), "student.plannerDecision", { params: target(p), body: { revision: p.revision, decision: "skipped" } });
    expect(skipped.opportunities[0]!.decision).toBe("skipped");
    expect(await d.stores.assessment.load()).toEqual(before);
    expect((await d.ok(d.tokenFor(NF.rivera), "teacher.planner", { params }))[0]!.opportunities[0]!.decision).toBe("skipped");
  });

  it("requires independent teacher assessment, preserves corrections, and never makes an official grade", async () => {
    const d = await setup();
    const assessmentBefore = await d.stores.assessment.load();
    let p = await share(d, await accept(d, await propose(d)));
    p = await d.ok(d.tokenFor(NF.amara), "student.plannerCoach", { params: target(p), body: { revision: p.revision, action: "try", allowAi: false } });
    p = await d.ok(d.tokenFor(NF.amara), "student.plannerChallenge", { params: target(p), body: { revision: p.revision, text: "Printer A: 6 cards/min; B: 5; after 7 minutes: 42 and 35. Constant rates assumed.", reflection: "Use rates to compare garden watering systems.", assistance: "independent" } });
    const teacher = d.tokenFor(NF.rivera);
    const review = { revision: p.revision, level: "demonstrated" as const, assistance: "independent" as const, independentlyAssessed: false, decision: "recommend" as const, rationale: "Fresh problem and oral explanation observed.", assessment: { method: "independent-task" as const, context: "Unseen garden task: Amara calculated rates and explained units against all contract criteria.", observedAt: p.opportunities[0]!.challenge!.sharedAt } };
    expectError(await d.call(teacher, "teacher.plannerReview", { params: target(p), body: review }), 409, "conflict");
    expectError(await d.call(d.tokenFor(NF.amara), "teacher.plannerReview", { params: target(p), body: review }), 403, "forbidden");
    const assessed = await d.ok(teacher, "teacher.plannerReview", { params: target(p), body: { ...review, independentlyAssessed: true } });
    expect(assessed.opportunities[0]!.reviews.at(-1)).toMatchObject({ by: NF.rivera, decision: "recommend", level: "demonstrated" });
    const corrected = await d.ok(teacher, "teacher.plannerReview", { params: target(p), body: { ...review, revision: assessed.revision, level: "practiced", decision: "hold", rationale: "Follow-up revealed the explanation still needed support." } });
    expect(corrected.opportunities[0]!.reviews.map((r) => r.decision)).toEqual(["recommend", "hold"]);
    p = await share(d, await accept(d, await propose(d)), "ai");
    expectError(await d.call(teacher, "teacher.plannerReview", { params: target(p), body: { ...review, revision: p.revision, independentlyAssessed: true } }), 409, "conflict");
    const next = await propose(d);
    expect(next.opportunities[0]!.priorEvidence).toContain("awaits teacher review");
    expect(await d.stores.assessment.load()).toEqual(assessmentBefore);
  });

  it("fails closed for unapproved, hidden, withdrawn, unmatched and non-grade-6 standards", async () => {
    const d = await bootDistrict(gradeSix(), { standards: [] });
    expect((await propose(d)).opportunities).toEqual([]);
    const approved = await setup();
    expect((await propose(approved, "explore astronomy")).opportunities).toEqual([]);
    const p = await propose(approved);
    await approved.app.catalog.setOverlay("ccss-ela", { nodeUri: p.opportunities[1]!.node.uri, hidden: true, author: PrincipalId.parse(NF.admin), updatedAt: "2026-11-15T12:00:00Z" });
    expect((await propose(approved)).opportunities.map((o) => o.code)).toEqual(["6.RP.A.3b"]);
    await approved.ok(approved.tokenFor(NF.admin), "admin.withdrawStandards", { params: { frameworkKey: "ccss-math" } });
    expectError(await approved.call(approved.tokenFor(NF.amara), "student.plannerDecision", { params: target(p), body: { revision: p.revision, decision: "accepted" } }), 409, "conflict");
    expect((await propose(approved)).opportunities).toEqual([]);
    const older = await bootDistrict();
    expectError(await older.call(older.tokenFor(NF.amara), "student.planGoal", { params, body: { goal: "pizza", skills: [] } }), 409, "conflict");
  });

  it("enforces course roles, student ownership, district isolation and optimistic revisions", async () => {
    const d = await setup();
    const p = await propose(d);
    expectError(await d.call(undefined, "student.planner", { params }), 401, "unauthenticated");
    expectError(await d.call(d.tokenFor(NF.morgan), "teacher.planner", { params }), 403, "forbidden");
    expectError(await d.call(d.tokenFor(NF.admin), "teacher.planner", { params }), 403, "forbidden");
    expectError(await d.call(d.tokenFor(NF.elena), "student.plannerDecision", { params: target(p), body: { revision: 1, decision: "accepted" } }), 404, "not-found");
    expectError(await d.call(d.tokenFor(NF.rivera), "teacher.plannerInvite", { params, body: { studentId: PrincipalId.parse(NF.morgan), goal: "pizza", skills: [] } }), 404, "not-found");
    const rb = await bootDistrict(RIVERBEND);
    expectError(await rb.call(rb.tokenFor("prn_rb-student-kai"), "student.planner", { params }), 404, "not-found");
    const calls = await Promise.all(["accepted", "skipped"].map((decision) => d.call(d.tokenFor(NF.amara), "student.plannerDecision", { params: target(p), body: { revision: 1, decision: decision as "accepted" | "skipped" } })));
    expect(calls.map((c) => c.status).toSorted()).toEqual([200, 409]);
    const current = (await d.ok(d.tokenFor(NF.amara), "student.planner", { params }))[0]!;
    if (current.opportunities[0]!.decision === "skipped") expectError(await d.call(d.tokenFor(NF.amara), "student.plannerShare", { params: target(current), body: { revision: current.revision, text: "Not accepted", assistance: "independent" } }), 409, "conflict");
  });
});

describe("planner persistence", () => {
  it("survives SQLite store reconstruction and atomically refuses stale writes", async () => {
    const db = new DatabaseSync(":memory:");
    const storage: DistrictSqlStorage = {
      sql: { exec(query, ...bindings) { const rows = db.prepare(query).all(...bindings.map((b) => b instanceof ArrayBuffer ? new Uint8Array(b) : b)); return { toArray: () => rows }; } },
      transactionSync(closure) { db.exec("BEGIN"); try { const result = closure(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; } },
    };
    try {
      const d = await setup();
      const p = await share(d, await accept(d, await propose(d)));
      const first = new DurableObjectPlannerStore(storage);
      await first.save({ ...p, revision: 1 }, 0);
      const restarted = new DurableObjectPlannerStore(storage);
      expect(await restarted.list(p.offeringId)).toEqual([{ ...p, revision: 1 }]);
      await restarted.save({ ...p, revision: 2 }, 1);
      await expect(first.save({ ...p, revision: 2 }, 1)).rejects.toMatchObject({ code: "conflict" });
      expect((await first.list(p.offeringId))[0]!.revision).toBe(2);
      expect(await restarted.list("off_other-district")).toEqual([]);
      expect(plannerTeacherView((await restarted.list(p.offeringId))[0]!)).not.toHaveProperty("goal");
      const memory = new InMemoryPlannerStore();
      await memory.save({ ...p, revision: 1 }, 0);
      const copy = (await memory.list(p.offeringId))[0]!;
      copy.goal = "mutated";
      expect((await memory.list(p.offeringId))[0]!.goal).toBe(p.goal);
    } finally { db.close(); }
  });
});
