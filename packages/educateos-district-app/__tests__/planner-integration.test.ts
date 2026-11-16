import { observedRubric } from "./planner-review-fixtures.ts";
import { expect, it } from "vitest";
import { ActivityRuntime, MemoryReplayStore } from "@educateos/activity-adapters/runtime";
import type { ActivityRequest } from "@educateos/activity-adapters/contracts";
import { digestJson } from "@educateos/assessment-sdk";
import type { PlannerPlan } from "../src/planner.ts";
import { bootDistrict, expectError, NF, NORTHFIELD } from "./support.ts";

it("binds adapter evidence to its learner and contract, preserves assistance, and requires a separate teacher assessment", async () => {
  const at = "2026-11-15T14:00:00.000Z";
  let request: ActivityRequest;
  let bundle: unknown;
  const replay = new MemoryReplayStore();
  const d = await bootDistrict({ ...NORTHFIELD, courses: NORTHFIELD.courses.map((c) => ({ ...c, gradeBand: "7" })) }, {
    now: () => new Date(at),
    plannerActivityEvidence: { resolve: async () => ({ bundle, expected: request, inbox: { replay, authenticate: async (e) => e.digest === await digestJson((bundle as typeof e).body) } }) },
  });
  const student = d.tokenFor(NF.amara), teacher = d.tokenFor(NF.rivera);
  const params = { offeringId: NF.eng9 };
  const before = await d.stores.assessment.load();
  let plan = await d.ok(student, "student.planGoal", { params, body: { goal: "PRIVATE pizza game", skills: [] } });
  const target = (p: PlannerPlan) => ({ ...params, planId: p.id, opportunityId: p.opportunities[0]!.id });
  plan = await d.ok(student, "student.plannerDecision", { params: target(plan), body: { revision: plan.revision, decision: "accepted" } });
  request = { runId: crypto.randomUUID(), sessionId: "paired-session", adapterId: "fixture", actionId: "collect", operation: "collect-evidence",
    scope: { districtId: NORTHFIELD.district.id, offeringId: NF.eng9, studentId: NF.elena, projectId: "private-project", sourceId: "paired-source", revision: "source-v1" },
    contract: plan.opportunities[0]!.contract, requiredSurfaces: ["test"], assistance: ["ai"] };
  const runtime = new ActivityRuntime({ now: () => new Date(at), producerId: "trusted-host", replay: new MemoryReplayStore(), authority: { approve: async () => ({ actorId: NF.amara, decisionId: "consent" }) } });
  runtime.register({ descriptor: { id: "fixture", version: "1", actions: [{ id: "collect", operation: "collect-evidence", surfaces: ["test"] }] },
    execute: async (r) => [{ surface: "test", sourceId: r.scope.sourceId, revision: r.scope.revision, observedAt: at, status: "observed", code: "ok", measurements: [{ name: "scenario-completed", value: true, unit: "boolean" }], artifacts: [] }] });
  const share = (assistance: "independent" | "ai") => d.call(student, "student.plannerShare", { params: target(plan), body: { revision: plan.revision, text: "Shared project explanation", assistance, activityEvidenceId: "paired-evidence" } });
  bundle = await runtime.run(request);
  expectError(await share("ai"), 409, "conflict");
  request = { ...request, runId: crypto.randomUUID(), scope: { ...request.scope, studentId: NF.amara } };
  bundle = await runtime.run(request);
  expectError(await share("independent"), 409, "conflict");
  plan = await d.ok(student, "student.plannerShare", { params: target(plan), body: { revision: plan.revision, text: "Shared project explanation", assistance: "ai", activityEvidenceId: "paired-evidence" } });
  expect(plan.opportunities[0]!.response!.activityEvidence).toMatchObject({ status: "complete", assistance: ["ai"], learningClaim: "requires-teacher-verification" });
  let dashboard = await d.ok(teacher, "teacher.guidance", { params });
  expect(dashboard.coverage[0]).toMatchObject({ evidencePathway: "planner", mastery: { encountered: 1, "independent-reviewed": 0 } });
  const review = { level: "demonstrated" as const, assistance: "independent" as const, independentlyAssessed: true, decision: "recommend" as const, rationale: "Separate unseen assessment", assessment: { rubric: observedRubric(plan.opportunities[0]!), method: "independent-task" as const, observedAt: at, context: "Teacher observed independent fraction-rate reasoning on an unseen cycling problem." } };
  expectError(await d.call(teacher, "teacher.plannerReview", { params: target(plan), body: { revision: plan.revision, ...review } }), 409, "conflict");
  plan = await d.ok(student, "student.plannerCoach", { params: target(plan), body: { revision: plan.revision, action: "try", allowAi: false } });
  plan = await d.ok(student, "student.plannerChallenge", { params: target(plan), body: { revision: plan.revision, text: "Six miles/hour, three miles in half an hour.", reflection: "I can use labeled rates elsewhere.", assistance: "independent" } });
  await d.ok(teacher, "teacher.plannerReview", { params: target(plan), body: { revision: plan.revision, ...review } });
  dashboard = await d.ok(teacher, "teacher.guidance", { params });
  expect(dashboard.coverage[0]!.mastery["independent-reviewed"]).toBe(1);
  const detail = await d.ok(teacher, "teacher.guidanceEvidence", { params: { ...params, frameworkKey: "ccss-math", code: "7.RP.A.1" } });
  expect(detail.students[0]!.evidence[0]!.response!.activityEvidence!.assistance).toEqual(["ai"]);
  expect(JSON.stringify(detail)).not.toMatch(/PRIVATE|private-project|paired-source/);
  // A hold on another plan retracts the earlier recommendation on every surface.
  let next = await d.ok(student, "student.planGoal", { params, body: { goal: "pizza rates", skills: [] } });
  next = await d.ok(student, "student.plannerDecision", { params: target(next), body: { revision: next.revision, decision: "accepted" } });
  expectError(await d.call(student, "student.plannerShare", { params: target(next), body: { revision: next.revision, text: "Reused evidence", assistance: "ai", activityEvidenceId: "paired-evidence" } }), 409, "conflict");
  next = await d.ok(student, "student.plannerShare", { params: target(next), body: { revision: next.revision, text: "New practice", assistance: "ai" } });
  await d.ok(teacher, "teacher.plannerReview", { params: target(next), body: { revision: next.revision, level: "practiced", assistance: "ai", independentlyAssessed: false, decision: "hold", rationale: "Needs another independent check." } });
  expect((await d.ok(teacher, "teacher.guidance", { params })).coverage[0]!.mastery["independent-reviewed"]).toBe(0);
  expect((await d.ok(student, "student.plannerKnowledge", { params })).competencies[0]!.status).toBe("practiced");
  expect(await d.stores.assessment.load()).toEqual(before);
});
