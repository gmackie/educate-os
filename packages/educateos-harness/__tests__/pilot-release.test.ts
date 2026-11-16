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

it("withholds an in-flight explanation after authorized purge without erasing billed usage, audit or a peer's plan", async () => {
  const model = { provider: "cloudflare" as const, modelId: "synthetic-purge-race" };
  const completeGuarded = vi.fn<PlannerAiProvider["completeGuarded"]>();
  const d = await bootPilotDistrict({
    plannerAi: { model, estimatedMaxUsdNano: "1000000" as never, enabledFor: async () => true, provider: { completeGuarded } },
    aiHelp: { layersFor: async () => ({ district: "full" }) },
    modelCatalog: [{ ...model, mode: "enabled" }],
    fundingPools: [{ id: "fpl_purge-race" as never, name: "Synthetic purge race", purpose: "course", scope: { level: "district", districtId: "dst_pilot-lakes" as never }, monthlyAllocationUsdNano: "1000000000" as never, allowedModels: [model] }],
  });
  const student = d.tokenFor(PL.jules), peer = d.tokenFor(PL.maribel), admin = d.tokenFor(PL.admin);
  const params = { offeringId: PL.grade6 as never }, child = { studentId: PL.jules as never };
  const peerPlan = await d.ok(peer, "student.planGoal", { params, body: { goal: "PRIVATE peer garden", skills: [] } });
  let plan = await d.ok(student, "student.planGoal", { params, body: { goal: "PRIVATE basketball rates", skills: [] } });
  const target = { ...params, planId: plan.id, opportunityId: plan.opportunities[0]!.id };
  plan = await d.ok(student, "student.plannerDecision", { params: target, body: { revision: plan.revision, decision: "accepted" } });
  const auditBefore = d.audit.events();
  completeGuarded.mockImplementationOnce(async (input) => {
    expect(await input.authorize()).toBe(true);
    await d.ok(admin, "admin.studentLearningDisposition", { params: child, body: { revision: 0, legalHold: false, deletionAuthorized: true, archiveSatisfied: true } });
    await d.ok(admin, "admin.purgeStudentLearning", { params: child, body: { revision: 1, confirmStudentId: child.studentId } });
    // Even an adapter returning text after deletion cannot resurrect or release the erased plan.
    return { released: true, output: { competencyUri: input.competencyUri, releaseDigest: input.releaseDigest, step: input.step, explanation: "WITHHOLD this late synthetic explanation" }, settlement: { actualUsdNano: "1000" as never, usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } } };
  });
  const response = await d.call(student, "student.plannerCoach", { params: target, body: { revision: plan.revision, action: "show", allowAi: true } });
  expect(completeGuarded).toHaveBeenCalledOnce();
  expect(outcomeOf(response)).toBe("409 conflict");
  expect(JSON.stringify(response)).not.toMatch(/PRIVATE|WITHHOLD/);
  expect(await d.ok(student, "student.planner", { params })).toEqual([]);
  expect(await d.ok(peer, "student.planner", { params })).toEqual([peerPlan]);
  expect((await d.app.ledger.report()).district).toMatchObject({ requests: 1, usageUsdNano: "1000" });
  expect(d.audit.events().slice(0, auditBefore.length)).toEqual(auditBefore);
  const deletion = d.audit.events().find((event) => event.studentLearningDeletion !== undefined);
  expect(deletion).toMatchObject({ principalId: PL.admin, resourceId: PL.jules, studentLearningDeletion: { plans: 1 } });
  expect(JSON.stringify(deletion)).not.toMatch(/PRIVATE|WITHHOLD/);
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
  expect(receipt.counts).toEqual({ plans: 1, guidance: 1, guardianGrants: 1, aiRuntimeCounters: 0 });
  expect(await d.ok(admin, "admin.purgeStudentLearning", { params: child, body: { revision: 2, confirmStudentId: child.studentId } })).toEqual(receipt);
  expect(await d.ok(student, "student.planner", { params })).toEqual([]);
  expect(await d.ok(peer, "student.planner", { params })).toEqual([peerPlan]);
  expect(await d.ok(d.tokenFor(PL.okoye), "teacher.planner", { params })).toEqual([]);
  expect((await d.ok(d.tokenFor(PL.okoye), "teacher.guidance", { params })).suggestions).toEqual([]);
  expect((await d.ok(guardian.token, "guardian.guidance", { params: child })).capabilities).toEqual({ suggest: false, progress: false });
  expect(outcomeOf(await d.call(student, "student.planGoal", { params, body: { goal: "basketball", skills: [] } }))).toBe("409 conflict");
  expect(JSON.stringify(receipt)).not.toMatch(/PRIVATE|DELETE/);
});

it("retires withdrawn recipe versions on existing student plans while preserving class recipes through a subject purge", async () => {
  const d = await bootPilotDistrict();
  const params = { offeringId: PL.grade6 as never };
  const student = d.tokenFor(PL.jules), teacher = d.tokenFor(PL.okoye), admin = d.tokenFor(PL.admin);
  const recipes = await d.ok(teacher, "teacher.recipes", { params });
  const starterId = "g6-unit-rate-basketball-practice";
  expect(recipes.entries.find((e) => e.starterId === starterId)!.standardCheck.state).toBe("ok");
  const approved = await d.ok(teacher, "teacher.recipeDecision", { params, body: { starterId, revision: 0, decision: "approve" } });
  const entry = approved.entries.find((e) => e.starterId === starterId)!;
  const peer = d.tokenFor(PL.maribel);
  let plan = await d.ok(student, "student.planGoal", { params, body: { goal: "PRIVATE improve basketball practice", skills: [] } });
  expect(plan.opportunities[0]!.recipe).toMatchObject({ version: 1, approvedBy: "Ada Okoye" });
  expect(await d.ok(teacher, "teacher.planner", { params })).toEqual([]);
  const target = { ...params, planId: plan.id, opportunityId: plan.opportunities[0]!.id };
  plan = await d.ok(student, "student.plannerDecision", { params: target, body: { revision: plan.revision, decision: "skipped" } });
  expect(plan.opportunities[0]!.decision).toBe("skipped");
  const peerPlan = await d.ok(peer, "student.planGoal", { params, body: { goal: "basketball practice", skills: [] } });
  const child = { studentId: PL.jules as never };
  await d.ok(admin, "admin.studentLearningDisposition", { params: child, body: { revision: 0, legalHold: false, deletionAuthorized: true, archiveSatisfied: true } });
  await d.ok(admin, "admin.purgeStudentLearning", { params: child, body: { revision: 1, confirmStudentId: child.studentId } });
  expect(await d.ok(teacher, "teacher.recipes", { params })).toEqual(approved);
  expect(await d.ok(peer, "student.planner", { params })).toEqual([peerPlan]);
  await d.ok(teacher, "teacher.recipeDecision", { params, body: { starterId, revision: entry.revision, decision: "withdraw" } });
  expect((await d.ok(peer, "student.planner", { params }))[0]!.opportunities[0]).toMatchObject({ unavailableReason: expect.stringContaining("withdrawn") });
  const peerTarget = { ...params, planId: peerPlan.id, opportunityId: peerPlan.opportunities[0]!.id };
  expect(outcomeOf(await d.call(peer, "student.plannerDecision", { params: peerTarget, body: { revision: peerPlan.revision, decision: "accepted" } }))).toBe("409 conflict");
  expect((await d.stores.planner.list(params.offeringId))[0]!.opportunities).toHaveLength(1);
});

it.each(["withdrawn", "stale-digest", "standards-withdrawn"])("refuses future steps on %s recipes and preserves reviewed evidence without private goals", async (retirement) => {
  const d = await bootPilotDistrict();
  const params = { offeringId: PL.grade6 as never }, starterId = "g6-unit-rate-basketball-practice";
  const student = d.tokenFor(PL.jules), teacher = d.tokenFor(PL.okoye);
  const approved = await d.ok(teacher, "teacher.recipeDecision", { params, body: { starterId, revision: 0, decision: "approve" } });
  const entry = approved.entries.find((e) => e.starterId === starterId)!;
  const goal = "PRIVATE basketball practice";
  let plan = await d.ok(student, "student.planGoal", { params, body: { goal, skills: [] } });
  const target = { ...params, planId: plan.id, opportunityId: plan.opportunities[0]!.id };
  plan = await d.ok(student, "student.plannerDecision", { params: target, body: { revision: plan.revision, decision: "accepted" } });
  plan = await d.ok(student, "student.plannerShare", { params: target, body: { revision: plan.revision, text: "Shared synthetic project", assistance: "independent" } });
  await d.ok(teacher, "teacher.plannerReview", { params: target, body: { revision: plan.revision, level: "practiced", assistance: "independent", independentlyAssessed: false, decision: "hold", rationale: "Practice only; unseen assessment still required." } });
  let active = await d.ok(student, "student.planGoal", { params, body: { goal, skills: [] } });
  const activeTarget = { ...params, planId: active.id, opportunityId: active.opportunities[0]!.id };
  active = await d.ok(student, "student.plannerDecision", { params: activeTarget, body: { revision: active.revision, decision: "accepted" } });
  const history = await d.stores.planner.list(params.offeringId);
  const teacherBefore = await d.ok(teacher, "teacher.planner", { params });
  if (retirement === "withdrawn") await d.ok(teacher, "teacher.recipeDecision", { params, body: { starterId, revision: entry.revision, decision: "withdraw" } });
  else if (retirement === "standards-withdrawn") await d.ok(d.tokenFor(PL.admin), "admin.withdrawStandards", { params: { frameworkKey: "ccss-math" } });
  else {
    const record = (await d.stores.guidance.records.list(params.offeringId)).find((r) => r.type === "recipe")!;
    if (record.type !== "recipe") throw new Error("missing recipe");
    await d.stores.guidance.records.save({ ...record, revision: record.revision + 1, pin: { ...record.pin!, releaseDigest: "sha256:stale-release" } }, record.revision);
  }
  const archived = (await d.ok(student, "student.planner", { params }))[0]!;
  expect(archived.opportunities[0]).toMatchObject({ unavailableReason: expect.any(String), response: { text: "Shared synthetic project" }, reviews: [{ level: "practiced", decision: "hold" }] });
  const body = { revision: active.revision };
  expect(outcomeOf(await d.call(student, "student.plannerDecision", { params: activeTarget, body: { ...body, decision: "accepted" } }))).toBe("409 conflict");
  expect(outcomeOf(await d.call(student, "student.plannerCoach", { params: activeTarget, body: { ...body, action: "show", allowAi: true } }))).toBe("409 conflict");
  expect(outcomeOf(await d.call(student, "student.plannerShare", { params: activeTarget, body: { ...body, text: "New synthetic evidence", assistance: "independent" } }))).toBe("409 conflict");
  expect(await d.stores.planner.list(params.offeringId)).toEqual(history);
  expect(JSON.stringify(history)).not.toContain("unavailableReason");
  expect(await d.ok(teacher, "teacher.planner", { params })).toEqual(teacherBefore);
  expect(JSON.stringify(teacherBefore)).not.toContain(goal);
  expect(teacherBefore[0]!.opportunities[0]!.recipe!.matched).toEqual([]);
  expect((await d.ok(student, "student.plannerKnowledge", { params })).competencies[0]!.status).toBe("practiced");
});
