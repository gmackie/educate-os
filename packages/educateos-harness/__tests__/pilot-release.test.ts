// Combined release acceptance over invented people and the real authenticated district routes.
import { expect, it, vi } from "vitest";
import { PL, RIVERBEND } from "@educateos/fixtures";
import type { PlannerAiProvider } from "@educateos/district-app";
import { bootPilotDistrict, onboardGuardian, outcomeOf } from "../src/pilot/index.ts";

it("keeps opted-in family suggestions, shared evidence and subject/district boundaries separate", async () => {
  const d = await bootPilotDistrict();
  const student = d.tokenFor(PL.jules), teacher = d.tokenFor(PL.okoye), admin = d.tokenFor(PL.admin);
  const params = { offeringId: PL.grade6 as never };
  const guardian = await onboardGuardian(d, PL.jules, "release-guardian", "Release guardian (synthetic)");
  const child = { studentId: PL.jules as never };
  expect((await d.ok(guardian.token, "guardian.guidance", { params: child })).capabilities).toEqual({ suggest: false, progress: false });
  await d.ok(admin, "admin.setGuardianGuidance", { params: { relationshipId: guardian.relationshipId as never }, body: { revision: 0, capabilities: ["suggest", "progress"] } });
  await d.ok(guardian.token, "guardian.guidanceSuggest", { params: { ...child, ...params }, body: { kind: "curiosity", topic: "Compare basketball practice rates" } });
  expect((await d.ok(student, "student.guidance", { params })).invitations).toEqual([]);
  const suggestion = (await d.ok(teacher, "teacher.guidance", { params })).suggestions[0]!;
  await d.ok(teacher, "teacher.guidanceSuggestionReview", { params: { ...params, suggestionId: suggestion.id }, body: { revision: suggestion.revision, decision: "share" } });
  expect((await d.ok(student, "student.guidance", { params })).invitations[0]).toMatchObject({ required: false, isAssignment: false });

  let plan = await d.ok(student, "student.planGoal", { params, body: { goal: "PRIVATE basketball practice rates", skills: [] } });
  const target = { ...params, planId: plan.id, opportunityId: plan.opportunities[0]!.id };
  plan = await d.ok(student, "student.plannerDecision", { params: target, body: { revision: plan.revision, decision: "accepted" } });
  plan = await d.ok(student, "student.plannerShare", { params: target, body: { revision: plan.revision, text: "Synthetic helped project", assistance: "ai" } });
  const evidence = { ...params, frameworkKey: "ccss-math", code: "6.RP.A.3" };
  const detail = await d.ok(teacher, "teacher.guidanceEvidence", { params: evidence });
  expect(JSON.stringify(detail)).toContain('"assistance":"ai"');
  expect(JSON.stringify(detail)).not.toContain("PRIVATE");
  expect(outcomeOf(await d.call(teacher, "teacher.guidanceEvidence", { params: { ...evidence, frameworkKey: "ccss-ela" } }))).toBe("404 not-found");
  expect(outcomeOf(await d.call(d.tokenFor(PL.vance), "teacher.guidanceEvidence", { params: evidence }))).toBe("403 forbidden");
  const foreign = await bootPilotDistrict({ directory: RIVERBEND });
  expect(outcomeOf(await d.call(foreign.tokenFor(RIVERBEND.principals.find((p) => p.kind === "staff")!.id), "teacher.guidanceEvidence", { params: evidence }))).toBe("401 unauthenticated");
  expect((await d.ok(student, "student.plannerKnowledge", { params })).competencies[0]!.status).toBe("practiced");
  expect(JSON.stringify(await d.ok(guardian.token, "guardian.guidance", { params: child }))).not.toMatch(/PRIVATE|Synthetic helped project|"assistance"/);
  await d.ok(admin, "admin.setGuardianGuidance", { params: { relationshipId: guardian.relationshipId as never }, body: { revision: 1, capabilities: [] } });
  expect((await d.ok(guardian.token, "guardian.guidance", { params: child })).offerings).toEqual([]);
});

it("requires a model grant, learner opt-in and funded model before releasing help, then honors revocation", async () => {
  const grants = new Set<string>();
  const model = { provider: "cloudflare" as const, modelId: "synthetic-release-model" };
  const completeGuarded = vi.fn<PlannerAiProvider["completeGuarded"]>(async (input) => ({
    released: await input.authorize(),
    output: { competencyUri: input.competencyUri, releaseDigest: input.releaseDigest, step: input.step, explanation: "Compare baskets per minute using matching units." },
    settlement: { actualUsdNano: "1000" as never, usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } },
  }));
  const d = await bootPilotDistrict({
    plannerAi: { model, estimatedMaxUsdNano: "1000000" as never, enabledFor: async (offering, student) => offering === PL.grade6 && grants.has(student), provider: { completeGuarded } },
    aiHelp: { layersFor: async () => ({ district: "full" }) },
    modelCatalog: [{ ...model, mode: "enabled" }],
    fundingPools: [{ id: "fpl_release" as never, name: "Synthetic release", purpose: "course", scope: { level: "district", districtId: "dst_pilot-lakes" as never }, monthlyAllocationUsdNano: "1000000000" as never, allowedModels: [model] }],
  });
  const student = d.tokenFor(PL.jules), params = { offeringId: PL.grade6 as never };
  let plan = await d.ok(student, "student.planGoal", { params, body: { goal: "PRIVATE basketball practice", skills: [] } });
  const target = { ...params, planId: plan.id, opportunityId: plan.opportunities[0]!.id };
  plan = await d.ok(student, "student.plannerDecision", { params: target, body: { revision: plan.revision, decision: "accepted" } });
  const show = async (allowAi: boolean) => {
    plan = await d.ok(student, "student.plannerCoach", { params: target, body: { revision: plan.revision, action: "show", allowAi } });
    return plan.opportunities[0]!.coaching!;
  };
  expect((await show(true)).aiStatus).toBe("policy-denied");
  grants.add(PL.jules);
  expect((await show(false)).aiStatus).toBe("not-requested");
  expect(completeGuarded).not.toHaveBeenCalled();
  expect(await show(true)).toMatchObject({ aiStatus: "used", source: "governed-ai" });
  expect(completeGuarded).toHaveBeenCalledOnce();
  expect((await d.ok(student, "student.plannerKnowledge", { params })).competencies[0]!.status).toBe("unverified");
  expect(await d.ok(d.tokenFor(PL.okoye), "teacher.planner", { params })).toEqual([]);
  grants.clear();
  expect(await show(true)).toMatchObject({ aiStatus: "policy-denied", source: "curriculum" });
  expect(completeGuarded).toHaveBeenCalledOnce();
  const ledger = await d.app.ledger.report();
  expect(ledger.district.usageUsdNano).toBe("1000");
  expect(JSON.stringify(ledger)).not.toContain("PRIVATE");
  // Lifecycle erasure does not remove deployment-owned AI grants. Even with a retained grant,
  // stale/fresh planner actions must be fenced before another provider call can occur.
  grants.add(PL.jules);
  const admin = d.tokenFor(PL.admin), child = { studentId: PL.jules as never };
  await d.ok(admin, "admin.studentLearningDisposition", { params: child, body: { revision: 0, legalHold: false, deletionAuthorized: true, archiveSatisfied: true } });
  await d.ok(admin, "admin.purgeStudentLearning", { params: child, body: { revision: 1, confirmStudentId: child.studentId } });
  expect(grants.has(PL.jules)).toBe(true);
  expect(outcomeOf(await d.call(student, "student.plannerCoach", { params: target, body: { revision: plan.revision, action: "show", allowAi: true } }))).toBe("404 not-found");
  expect(outcomeOf(await d.call(student, "student.planGoal", { params, body: { goal: "basketball", skills: [] } }))).toBe("409 conflict");
  expect(completeGuarded).toHaveBeenCalledOnce();
  expect((await d.app.ledger.report()).district.usageUsdNano).toBe("1000");
});

it("refuses an otherwise consented model request with no district model or funding admission", async () => {
  const completeGuarded = vi.fn<PlannerAiProvider["completeGuarded"]>(async () => { throw new Error("must not reach provider"); });
  const d = await bootPilotDistrict({
    plannerAi: { model: { provider: "cloudflare", modelId: "unfunded-model" }, estimatedMaxUsdNano: "1000000" as never, enabledFor: async () => true, provider: { completeGuarded } },
    aiHelp: { layersFor: async () => ({ district: "full" }) },
  });
  const student = d.tokenFor(PL.jules), params = { offeringId: PL.grade6 as never };
  let plan = await d.ok(student, "student.planGoal", { params, body: { goal: "basketball practice", skills: [] } });
  const target = { ...params, planId: plan.id, opportunityId: plan.opportunities[0]!.id };
  plan = await d.ok(student, "student.plannerDecision", { params: target, body: { revision: plan.revision, decision: "accepted" } });
  plan = await d.ok(student, "student.plannerCoach", { params: target, body: { revision: plan.revision, action: "show", allowAi: true } });
  expect(plan.opportunities[0]!.coaching).toMatchObject({ aiStatus: "budget-denied", source: "curriculum" });
  expect(completeGuarded).not.toHaveBeenCalled();
});

it("blocks a legal hold then purges only the selected learner and revokes their guardian guidance", async () => {
  const d = await bootPilotDistrict();
  const params = { offeringId: PL.grade6 as never }, child = { studentId: PL.jules as never };
  const admin = d.tokenFor(PL.admin), student = d.tokenFor(PL.jules);
  const guardian = await onboardGuardian(d, PL.jules, "purge-guardian", "Purge guardian (synthetic)");
  await d.ok(admin, "admin.setGuardianGuidance", { params: { relationshipId: guardian.relationshipId as never }, body: { revision: 0, capabilities: ["suggest", "progress"] } });
  await d.ok(guardian.token, "guardian.guidanceSuggest", { params: { ...params, ...child }, body: { kind: "curiosity", topic: "Basketball rates" } });
  let plan = await d.ok(student, "student.planGoal", { params, body: { goal: "PRIVATE basketball rates", skills: [] } });
  const target = { ...params, planId: plan.id, opportunityId: plan.opportunities[0]!.id };
  plan = await d.ok(student, "student.plannerDecision", { params: target, body: { revision: plan.revision, decision: "accepted" } });
  await d.ok(student, "student.plannerShare", { params: target, body: { revision: plan.revision, text: "DELETE synthetic response", assistance: "independent" } });
  const peer = d.tokenFor(PL.maribel);
  const peerPlan = await d.ok(peer, "student.planGoal", { params, body: { goal: "cookie prices", skills: [] } });
  await d.ok(admin, "admin.studentLearningDisposition", { params: child, body: { revision: 0, legalHold: true, deletionAuthorized: true, archiveSatisfied: true } });
  expect(outcomeOf(await d.call(admin, "admin.purgeStudentLearning", { params: child, body: { revision: 1, confirmStudentId: child.studentId } }))).toBe("409 conflict");
  expect((await d.ok(admin, "admin.studentLearningPreview", { params: child })).counts).toMatchObject({ plans: 1, guidance: 1, guardianGrants: 1 });
  await d.ok(admin, "admin.studentLearningDisposition", { params: child, body: { revision: 1, legalHold: false, deletionAuthorized: true, archiveSatisfied: true } });
  const receipt = await d.ok(admin, "admin.purgeStudentLearning", { params: child, body: { revision: 2, confirmStudentId: child.studentId } });
  expect(receipt.counts).toEqual({ plans: 1, guidance: 1, guardianGrants: 1 });
  expect(await d.ok(admin, "admin.purgeStudentLearning", { params: child, body: { revision: 2, confirmStudentId: child.studentId } })).toEqual(receipt);
  expect(await d.ok(student, "student.planner", { params })).toEqual([]);
  expect(await d.ok(peer, "student.planner", { params })).toEqual([peerPlan]);
  expect(await d.ok(d.tokenFor(PL.okoye), "teacher.planner", { params })).toEqual([]);
  expect((await d.ok(d.tokenFor(PL.okoye), "teacher.guidance", { params })).suggestions).toEqual([]);
  expect((await d.ok(guardian.token, "guardian.guidance", { params: child })).capabilities).toEqual({ suggest: false, progress: false });
  expect(outcomeOf(await d.call(student, "student.planGoal", { params, body: { goal: "basketball", skills: [] } }))).toBe("409 conflict");
  expect(JSON.stringify(receipt)).not.toMatch(/PRIVATE|DELETE/);
});
