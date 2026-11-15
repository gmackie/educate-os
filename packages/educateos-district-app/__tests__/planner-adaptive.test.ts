import { describe, expect, it } from "vitest";
import type { RouteInput } from "../src/routes.ts";
import type { PlannerPlan } from "../src/planner.ts";
import { bootDistrict, expectError, NF, NORTHFIELD, type TestDistrict } from "./support.ts";

const params = { offeringId: NF.eng9 };
const directory = (gradeBand = "6") => ({ ...NORTHFIELD, courses: NORTHFIELD.courses.map((c) => ({ ...c, gradeBand })) });
const target = (p: PlannerPlan) => ({ ...params, planId: p.id, opportunityId: p.opportunities[0]!.id });
const goal = (d: TestDistrict, focus?: "6.RP.A.3b" | "7.RP.A.1") => d.ok(d.tokenFor(NF.amara), "student.planGoal", { params, body: { goal: focus ? "Build a garden" : "Build a pizza game", skills: [], ...(focus ? { focus } : {}) } });
const coach = (d: TestDistrict, p: PlannerPlan, action: RouteInput<"student.plannerCoach">["body"]["action"]) => d.ok(d.tokenFor(NF.amara), "student.plannerCoach", { params: target(p), body: { revision: p.revision, action, allowAi: false } });
async function practice(d: TestDistrict, p: PlannerPlan) {
  const student = d.tokenFor(NF.amara);
  p = await d.ok(student, "student.plannerDecision", { params: target(p), body: { revision: p.revision, decision: "accepted" } });
  p = await coach(d, p, "show");
  p = await d.ok(student, "student.plannerShare", { params: target(p), body: { revision: p.revision, text: "AI helped with my project explanation.", assistance: "ai" } });
  p = await coach(d, p, "try");
  p = await coach(d, p, "reflect");
  return d.ok(student, "student.plannerChallenge", { params: target(p), body: { revision: p.revision, text: "6 and 5 cards/minute. In seven minutes: 42 and 35; assumes constant rates.", reflection: "I could compare watering rates, but would check for leaks.", assistance: "independent" } });
}
const assessment = (observedAt: string, level: "demonstrated" | "retained" | "transferred" = "demonstrated", context = "Unseen teacher-selected garden problem: correct division, units and prediction observed.") => ({ level, assistance: "independent" as const, independentlyAssessed: true, decision: "recommend" as const, rationale: "Observed the learner independently satisfy every contract criterion on a fresh unseen problem.", assessment: { observedAt, context, method: level === "retained" ? "delayed-check" as const : level === "transferred" ? "new-context" as const : "independent-task" as const } });
const knowledge = (d: TestDistrict) => d.ok(d.tokenFor(NF.amara), "student.plannerKnowledge", { params });

describe("adaptive coaching and trusted knowledge", () => {
  it("supports direct instruction, bounded hints, learner choice and immutable independent practice", async () => {
    const d = await bootDistrict(directory());
    let p = await goal(d);
    expect((await knowledge(d)).competencies[0]!.status).toBe("unverified");
    expectError(await d.call(d.tokenFor(NF.amara), "student.plannerCoach", { params: target(p), body: { revision: p.revision, action: "hint", allowAi: false } }), 409, "conflict");
    p = await d.ok(d.tokenFor(NF.amara), "student.plannerDecision", { params: target(p), body: { revision: p.revision, decision: "accepted" } });
    p = await coach(d, p, "show");
    expect(p.opportunities[0]!.coaching!.guidance).toContain("10 tiles");
    p = await coach(d, p, "hint");
    expect(p.opportunities[0]!.coaching!.guidance).toContain("per one");
    p = await coach(d, p, "hint");
    expect(p.opportunities[0]!.coaching!.guidance).toContain("divide dollars");
    p = await coach(d, p, "next");
    expect(p.opportunities[0]!.coaching).toMatchObject({ step: 1, hints: 0 });
    p = await coach(d, p, "try");
    expectError(await d.call(d.tokenFor(NF.amara), "student.plannerCoach", { params: target(p), body: { revision: p.revision, action: "show", allowAi: false } }), 409, "conflict");
    expect((await knowledge(d)).competencies[0]!.status).toBe("unverified");
    expect(await d.ok(d.tokenFor(NF.rivera), "teacher.planner", { params })).toEqual([]);
  });

  it("advances only after separate unseen teacher assessment and retracts after a teacher hold", async () => {
    let time = new Date("2026-11-15T14:00:00Z");
    const d = await bootDistrict(directory(), { now: () => time });
    const before = await d.stores.assessment.load();
    let p = await practice(d, await goal(d));
    expect((await knowledge(d)).competencies[0]!.status).toBe("practiced");
    const review = assessment(time.toISOString());
    const reviewParams = target(p);
    expectError(await d.call(d.tokenFor(NF.amara), "teacher.plannerReview", { params: reviewParams, body: { ...review, revision: p.revision } }), 403, "forbidden");
    expectError(await d.call(d.tokenFor(NF.rivera), "teacher.plannerReview", { params: reviewParams, body: { ...review, revision: p.revision, assessment: { ...review.assessment, observedAt: "2026-11-16T00:00:00Z" } } }), 409, "conflict");
    const reviewed = await d.ok(d.tokenFor(NF.rivera), "teacher.plannerReview", { params: reviewParams, body: { ...review, revision: p.revision } });
    expect((await knowledge(d)).competencies[0]!.status).toBe("demonstrated");
    expect(reviewed.opportunities[0]).not.toHaveProperty("coaching");
    expect(JSON.stringify(reviewed)).not.toContain("Build a pizza game");
    expect((await goal(d)).opportunities[0]!.priorEvidence).toContain("test this skill in a new setting");
    time = new Date("2026-11-15T14:01:00Z");
    await d.ok(d.tokenFor(NF.rivera), "teacher.plannerReview", { params: reviewParams, body: { ...review, revision: reviewed.revision, level: "practiced", decision: "hold", rationale: "Follow-up did not support independent reasoning." } });
    expect((await knowledge(d)).competencies[0]!.status).toBe("practiced");
    expect(await d.stores.assessment.load()).toEqual(before);
    p = (await d.ok(d.tokenFor(NF.amara), "student.planner", { params }))[0]!;
    expectError(await d.call(d.tokenFor(NF.amara), "student.plannerChallenge", { params: target(p), body: { revision: p.revision, text: "replacement", reflection: "replacement", assistance: "independent" } }), 409, "conflict");
  });

  it("requires elapsed time for retention and a prior demonstration in another context for transfer", async () => {
    let time = new Date("2026-11-15T14:00:00Z");
    const d = await bootDistrict(directory(), { now: () => time });
    const first = await practice(d, await goal(d));
    expectError(await d.call(d.tokenFor(NF.rivera), "teacher.plannerReview", { params: target(first), body: { ...assessment(time.toISOString(), "retained"), revision: first.revision } }), 409, "conflict");
    await d.ok(d.tokenFor(NF.rivera), "teacher.plannerReview", { params: target(first), body: { ...assessment(time.toISOString()), revision: first.revision } });
    time = new Date("2026-11-16T14:00:00Z");
    const second = await practice(d, await goal(d));
    expectError(await d.call(d.tokenFor(NF.rivera), "teacher.plannerReview", { params: target(second), body: { ...assessment(time.toISOString(), "retained"), revision: second.revision } }), 409, "conflict");
    expectError(await d.call(d.tokenFor(NF.rivera), "teacher.plannerReview", { params: target(second), body: { ...assessment(time.toISOString(), "transferred"), revision: second.revision } }), 409, "conflict");
    await d.ok(d.tokenFor(NF.rivera), "teacher.plannerReview", { params: target(second), body: { ...assessment(time.toISOString(), "transferred", "Unseen map-making task: independently used rates to calculate walking time with units and check assumptions."), revision: second.revision } });
    expect((await knowledge(d)).competencies[0]!.status).toBe("transferred");
    time = new Date("2026-11-23T14:00:00Z");
    const third = await practice(d, await goal(d));
    await d.ok(d.tokenFor(NF.rivera), "teacher.plannerReview", { params: target(third), body: { ...assessment(time.toISOString(), "retained"), revision: third.revision } });
    expect((await knowledge(d)).competencies[0]!.status).toBe("retained");
  });

  it("uses only approved grade 7 records and adapts instruction and contract to fraction rates and opposing claims", async () => {
    const d = await bootDistrict(directory("7"));
    const p = await goal(d);
    expect(p.opportunities.map((o) => o.code)).toEqual(["7.RP.A.1", "W.7.1"]);
    expect(p.opportunities[0]!.coaching!.lesson.steps[1]!.example).toContain("(1/2) ÷ (1/4)");
    expect(p.opportunities[1]!.contract.criteria.at(-1)!.description).toContain("opposing claims");
    const release = await d.app.catalog.approvedRelease("ccss-math");
    expect(p.opportunities[0]!.node).toEqual(release!.content.nodes!.find((n) => n.humanCodingScheme === "7.RP.A.1"));
    const chosen = await goal(d, "7.RP.A.1");
    expect(chosen.opportunities).toHaveLength(1);
    expect(chosen.opportunities[0]!.reason).toContain("You chose");
    expectError(await d.call(d.tokenFor(NF.amara), "student.planGoal", { params, body: { goal: "pizza", skills: [], focus: "6.RP.A.3b" } }), 409, "conflict");
    const multi = await bootDistrict(directory("6-7"));
    expect((await goal(multi, "7.RP.A.1")).opportunities[0]!.code).toBe("7.RP.A.1");
  });

  it("enforces identity, enrollment, current approval, revisions and knowledge isolation on new routes", async () => {
    const d = await bootDistrict(directory());
    const p = await practice(d, await goal(d));
    expectError(await d.call(undefined, "student.plannerKnowledge", { params }), 401, "unauthenticated");
    expectError(await d.call(d.tokenFor(NF.dmitri), "student.plannerKnowledge", { params }), 404, "not-found");
    expect((await d.ok(d.tokenFor(NF.elena), "student.plannerKnowledge", { params })).competencies).toEqual([]);
    expectError(await d.call(d.tokenFor(NF.elena), "student.plannerCoach", { params: target(p), body: { revision: p.revision, action: "show", allowAi: false } }), 404, "not-found");
    let next = await goal(d);
    next = await d.ok(d.tokenFor(NF.amara), "student.plannerDecision", { params: target(next), body: { revision: next.revision, decision: "accepted" } });
    const calls = await Promise.all(["show", "hint"].map((action) => d.call(d.tokenFor(NF.amara), "student.plannerCoach", { params: target(next), body: { revision: next.revision, action: action as "show" | "hint", allowAi: false } })));
    expect(calls.map((r) => r.status).toSorted()).toEqual([200, 409]);
    next = (await d.ok(d.tokenFor(NF.amara), "student.planner", { params })).find((plan) => plan.id === next.id)!;
    await d.ok(d.tokenFor(NF.admin), "admin.withdrawStandards", { params: { frameworkKey: "ccss-math" } });
    expectError(await d.call(d.tokenFor(NF.amara), "student.plannerCoach", { params: target(next), body: { revision: next.revision, action: "hint", allowAi: false } }), 409, "conflict");
  });
});
