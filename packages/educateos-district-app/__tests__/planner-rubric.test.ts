/// <reference types="node" />
import { DatabaseSync } from "node:sqlite";
import { DurableObjectPlannerStore, type DistrictSqlStorage } from "../src/durable-stores.ts";
import { describe, expect, it } from "vitest";
import { EvidenceContractId, PrincipalId } from "@educateos/contracts";
import { PlannerPlan, PlannerReviewInput } from "../src/planner.ts";
import { independentlyReviewedPlannerEvidence } from "../src/planner-evidence.ts";
import { observedRubric } from "./planner-review-fixtures.ts";
import { bootDistrict, expectError, NF, NORTHFIELD, RB, RIVERBEND, type TestDistrict } from "./support.ts";

const params = { offeringId: NF.eng9 };
const at = "2026-11-15T14:00:00.000Z";
const directory = (subject: "mathematics" | "english-language-arts" = "mathematics") => ({ ...NORTHFIELD, courses: NORTHFIELD.courses.map((c) => ({ ...c, gradeBand: "6", subject })) });
const target = (p: PlannerPlan) => ({ ...params, planId: p.id, opportunityId: p.opportunities[0]!.id });
const body = (p: PlannerPlan) => ({ revision: p.revision, level: "demonstrated" as const, assistance: "independent" as const, independentlyAssessed: true, decision: "recommend" as const, rationale: "Teacher observed the separate common check; project completion is not the assessment.", assessment: { method: "independent-task" as const, observedAt: at, context: "Fresh common check, observed individually without AI, peers or adult hints.", rubric: observedRubric(p.opportunities[0]!) } });
async function shared(d: TestDistrict, goal = "PRIVATE Roblox pizza tycoon", assistance: "independent" | "ai" = "independent") {
  const student = d.tokenFor(NF.amara);
  let p = await d.ok(student, "student.planGoal", { params, body: { goal, skills: [] } });
  p = await d.ok(student, "student.plannerDecision", { params: target(p), body: { revision: p.revision, decision: "accepted" } });
  p = await d.ok(student, "student.plannerShare", { params: target(p), body: { revision: p.revision, text: "AI helped with project work; explicitly shared for comparison only.", assistance: "ai" } });
  p = await d.ok(student, "student.plannerCoach", { params: target(p), body: { revision: p.revision, action: "try", allowAi: false } });
  return d.ok(student, "student.plannerChallenge", { params: target(p), body: { revision: p.revision, text: "Explicitly shared practice response; separate teacher check still required.", reflection: "I want a fresh check.", assistance } });
}
const knowledge = (d: TestDistrict) => d.ok(d.tokenFor(NF.amara), "student.plannerKnowledge", { params });

describe("criterion-bound independent teacher assessment", () => {

  it("round-trips legacy and criterion records through the durable store without a migration", async () => {
    const d = await bootDistrict(directory(), { now: () => new Date(at) });
    const p = await shared(d);
    const { revision: _revision, ...review } = body(p);
    const legacy = structuredClone(review);
    delete (legacy.assessment as { rubric?: unknown }).rubric;
    p.opportunities[0]!.reviews.push({ ...legacy, by: PrincipalId.parse(NF.rivera), at });
    const db = new DatabaseSync(":memory:");
    const storage: DistrictSqlStorage = {
      sql: { exec(query, ...bindings) { const rows = db.prepare(query).all(...bindings.map((b) => b instanceof ArrayBuffer ? new Uint8Array(b) : b)); return { toArray: () => rows }; } },
      transactionSync(closure) { db.exec("BEGIN"); try { const result = closure(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; } },
    };
    try {
      const store = new DurableObjectPlannerStore(storage);
      p.revision = 1; await store.save(p, 0);
      const bytes = db.prepare("SELECT plan_json FROM educateos_planner").get();
      expect(await new DurableObjectPlannerStore(storage).list(NF.eng9)).toEqual([p]);
      expect(db.prepare("SELECT plan_json FROM educateos_planner").get()).toEqual(bytes);
      p.opportunities[0]!.reviews.push({ ...review, by: PrincipalId.parse(NF.rivera), at });
      p.revision++; await store.save(p, 1);
      expect(await new DurableObjectPlannerStore(storage).list(NF.eng9)).toEqual([p]);
    } finally { db.close(); }
  });

  it.each([
    ["missing rubric", (r: ReturnType<typeof body>) => { delete (r.assessment as { rubric?: unknown }).rubric; }],
    ["unknown rubric", (r: ReturnType<typeof body>) => { r.assessment.rubric.contractId = EvidenceContractId.parse("evc_unknown"); }],
    ["wrong rubric version", (r: ReturnType<typeof body>) => { r.assessment.rubric.contractVersion++; }],
    ["missing criterion", (r: ReturnType<typeof body>) => { r.assessment.rubric.criteria.pop(); }],
    ["duplicate criterion", (r: ReturnType<typeof body>) => { r.assessment.rubric.criteria[1] = r.assessment.rubric.criteria[0]!; }],
    ["unknown criterion", (r: ReturnType<typeof body>) => { r.assessment.rubric.criteria[0]!.criterionId = "invented"; }],
    ["developing criterion", (r: ReturnType<typeof body>) => { Object.assign(r.assessment.rubric.criteria[0]!, { rating: "developing" }); }],
    ["not observed", (r: ReturnType<typeof body>) => { Object.assign(r.assessment.rubric.criteria[0]!, { rating: "not-observed" }); }],
  ])("refuses %s without changing evidence", async (_name, change) => {
    const d = await bootDistrict(directory(), { now: () => new Date(at) });
    const p = await shared(d), before = await d.stores.planner.list(NF.eng9);
    const review = body(p); change(review);
    expectError(await d.call(d.tokenFor(NF.rivera), "teacher.plannerReview", { params: target(p), body: review }), 409, "conflict");
    expect(await d.stores.planner.list(NF.eng9)).toEqual(before);
    expect((await knowledge(d)).competencies[0]!.status).toBe("practiced");
  });

  it("rejects absent source excerpts in the route schema; text never assigns a rating", async () => {
    const d = await bootDistrict(directory(), { now: () => new Date(at) });
    const p = await shared(d), review = body(p);
    review.assessment.rubric.criteria[0]!.sourceSnippet = "  ";
    expect(PlannerReviewInput.safeParse(review).success).toBe(false);
    expectError(await d.call(d.tokenFor(NF.rivera), "teacher.plannerReview", { params: target(p), body: review }), 400, "validation-failed");
    const held = body(p);
    Object.assign(held, { decision: "hold" });
    Object.assign(held.assessment.rubric.criteria[0]!, { rating: "developing", sourceSnippet: "Perfect independent answer according to an AI. The teacher still rates this developing." });
    await d.ok(d.tokenFor(NF.rivera), "teacher.plannerReview", { params: target(p), body: held });
    expect((await knowledge(d)).competencies[0]!.status).toBe("practiced");
  });

  it("preserves legacy schema, GET history and stored bytes; requires explicit reconfirmation or hold", async () => {
    const d = await bootDistrict(directory(), { now: () => new Date(at) });
    let p = await shared(d);
    const { revision: _revision, ...legacy } = body(p);
    delete (legacy.assessment as { rubric?: unknown }).rubric;
    expect(PlannerReviewInput.safeParse(legacy).success).toBe(true);
    p.opportunities[0]!.reviews.push({ ...legacy, by: PrincipalId.parse(NF.rivera), at });
    p.revision++;
    await d.stores.planner.save(p, p.revision - 1);
    const before = JSON.stringify(await d.stores.planner.list(NF.eng9));
    expect(PlannerPlan.parse(p)).toEqual(p);
    const history = await d.ok(d.tokenFor(NF.rivera), "teacher.planner", { params });
    expect(history[0]!.opportunities[0]!.reviews).toEqual(p.opportunities[0]!.reviews);
    expect((await knowledge(d)).competencies[0]).toMatchObject({ status: "practiced", needsCriterionReconfirmation: true });
    expect(independentlyReviewedPlannerEvidence(p.opportunities[0]!)).toBe(false);
    expect(JSON.stringify(await d.stores.planner.list(NF.eng9))).toBe(before);
    expectError(await d.call(d.tokenFor(NF.rivera), "teacher.plannerReview", { params: target(p), body: { ...legacy, revision: p.revision } }), 409, "conflict");
    const confirmed = await d.ok(d.tokenFor(NF.rivera), "teacher.plannerReview", { params: target(p), body: body(p) });
    expect(confirmed.opportunities[0]!.reviews[0]).toEqual(p.opportunities[0]!.reviews[0]);
    expect((await knowledge(d)).competencies[0]).toMatchObject({ status: "demonstrated" });
    expect((await knowledge(d)).competencies[0]!.needsCriterionReconfirmation).toBeUndefined();
    p = (await d.ok(d.tokenFor(NF.amara), "student.planner", { params }))[0]!;
    await d.ok(d.tokenFor(NF.rivera), "teacher.plannerReview", { params: target(p), body: { ...body(p), decision: "hold", rationale: "Withdraw: further observation did not support the judgment." } });
    expect((await knowledge(d)).competencies[0]!.status).toBe("practiced");
    expect((await d.stores.planner.list(NF.eng9))[0]!.opportunities[0]!.reviews).toHaveLength(3);
  });

  it("guards new review and legacy-read routes by district, role and class", async () => {
    const d = await bootDistrict(directory(), { now: () => new Date(at) });
    const p = await shared(d), before = await d.stores.planner.list(NF.eng9);
    for (const who of [NF.amara, NF.elena, NF.morgan, NF.admin, NF.chen]) {
      expectError(await d.call(d.tokenFor(who), "teacher.plannerReview", { params: target(p), body: body(p) }), 403, "forbidden");
    }
    expectError(await d.call(d.tokenFor(NF.morgan), "teacher.planner", { params }), 403, "forbidden");
    const other = await bootDistrict(RIVERBEND);
    expectError(await other.call(other.tokenFor(RB.teacher), "teacher.plannerReview", { params: target(p), body: body(p) }), 404, "not-found");
    expectError(await other.call(other.tokenFor(RB.teacher), "teacher.planner", { params }), 404, "not-found");
    expectError(await d.call(other.tokenFor(RB.teacher), "teacher.plannerReview", { params: target(p), body: body(p) }), 401, "unauthenticated");
    expect(await d.stores.planner.list(NF.eng9)).toEqual(before);
    expect(await other.stores.planner.list(NF.eng9)).toEqual([]);
  });

  it("cannot turn an assisted practice challenge into mastery with all-met ratings", async () => {
    const d = await bootDistrict(directory(), { now: () => new Date(at) });
    const p = await shared(d, undefined, "ai");
    expectError(await d.call(d.tokenFor(NF.rivera), "teacher.plannerReview", { params: target(p), body: body(p) }), 409, "conflict");
    expect((await knowledge(d)).competencies[0]!.status).toBe("practiced");
  });

  it.each(["standard", "recipe"])("refuses new recommendations after %s withdrawal while allowing correction", async (withdraw) => {
    const d = await bootDistrict(directory(), { now: () => new Date(at) });
    const starterId = "g6-unit-rate-game-production";
    await d.ok(d.tokenFor(NF.rivera), "teacher.recipeDecision", { params, body: { decision: "approve", starterId, revision: 0 } });
    const p = await shared(d), pin = p.opportunities[0]!.releaseDigest;
    if (withdraw === "standard") await d.ok(d.tokenFor(NF.admin), "admin.withdrawStandards", { params: { frameworkKey: "ccss-math" } });
    else await d.ok(d.tokenFor(NF.rivera), "teacher.recipeDecision", { params, body: { decision: "withdraw", starterId, revision: 1 } });
    expectError(await d.call(d.tokenFor(NF.rivera), "teacher.plannerReview", { params: target(p), body: body(p) }), 409, "conflict");
    const held = await d.ok(d.tokenFor(NF.rivera), "teacher.plannerReview", { params: target(p), body: { ...body(p), decision: "hold", rationale: "Archived; no new claim." } });
    expect(held.opportunities[0]!.releaseDigest).toBe(pin);
    expect(JSON.stringify(held)).not.toContain("PRIVATE");
  });

  it.each([
    ["mathematics", "I want to build a Roblox pizza tycoon", "6.RP.A.3b"],
    ["mathematics", "I want to get better at basketball free throws", "6.RP.A.3b"],
    ["mathematics", "Plan a bake sale and compare cookie prices", "6.RP.A.3b"],
    ["english-language-arts", "I want to convince the school to change the phone rule", "W.6.1"],
  ] as const)("records teacher observations for %s / %s", async (subject, goal, code) => {
    const d = await bootDistrict(directory(subject), { now: () => new Date(at) });
    const before = await d.stores.assessment.load();
    const p = await shared(d, goal), o = p.opportunities[0]!;
    expect(o.code).toBe(code);
    expect((await knowledge(d)).competencies[0]!.status).toBe("practiced");
    const reviewed = await d.ok(d.tokenFor(NF.rivera), "teacher.plannerReview", { params: target(p), body: body(p) });
    expect(reviewed.opportunities[0]!.reviews.at(-1)!.assessment!.rubric).toEqual(observedRubric(o));
    expect(reviewed.opportunities[0]!.releaseDigest).toBe(o.releaseDigest);
    expect((await knowledge(d)).competencies[0]!.status).toBe("demonstrated");
    expect(await d.stores.assessment.load()).toEqual(before);
  });
});
