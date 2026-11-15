// Adversarial pilot scenarios (SCHO-432): each one tries to get something the product must refuse.
// These are rule checks over invented people. They say nothing about whether children learn.
import { describe, expect, it, vi } from "vitest";
import { RIVERBEND, PL } from "@educateos/fixtures";
import { auditOpportunity, bootPilotDistrict, onboardGuardian, outcomeOf, type PilotDistrict, type PilotPlan } from "../src/pilot/index.ts";

const grade6 = { offeringId: PL.grade6 as never };
const HOUR = 3_600_000;

type Drive = { project: "independent" | "adult" | "peer" | "ai" | "unknown"; challenge?: "independent" | "adult" | "peer" | "ai" | "unknown" };
/** Plays one student through accept, share and (optionally) the independent challenge. Returns the plan. */
async function drive(d: PilotDistrict, who: string, goal: string, how: Drive, index = 0): Promise<PilotPlan> {
  const token = d.tokenFor(who);
  let plan = await d.ok(token, "student.planGoal", { params: grade6, body: { goal, skills: [] } });
  const target = () => ({ ...grade6, planId: plan.id, opportunityId: plan.opportunities[index]!.id }) as never;
  plan = await d.ok(token, "student.plannerDecision", { params: target(), body: { revision: plan.revision, decision: "accepted" } });
  plan = await d.ok(token, "student.plannerShare", { params: target(), body: { revision: plan.revision, text: "My project explanation.", assistance: how.project } });
  if (how.challenge !== undefined) {
    plan = await d.ok(token, "student.plannerCoach", { params: target(), body: { revision: plan.revision, action: "try", allowAi: false } });
    plan = await d.ok(token, "student.plannerChallenge", { params: target(), body: { revision: plan.revision, text: "My practice answer.", reflection: "I could use this elsewhere.", assistance: how.challenge } });
  }
  return plan;
}
const teacher = (d: PilotDistrict) => d.tokenFor(PL.okoye);
const target = (plan: PilotPlan, index = 0) => ({ ...grade6, planId: plan.id, opportunityId: plan.opportunities[index]!.id }) as never;
const recommend = (plan: PilotPlan, d: PilotDistrict, over: Record<string, unknown> = {}) => ({
  revision: plan.revision, level: "demonstrated" as const, assistance: "independent" as const, independentlyAssessed: true, decision: "recommend" as const,
  rationale: "Observed independently on an unseen task.", assessment: { method: "independent-task" as const, observedAt: d.now().toISOString(), context: "Unseen teacher-selected task." }, ...over,
});
const status = async (d: PilotDistrict, who: string, code = "6.RP.A.3b") => (await d.ok(d.tokenFor(who), "student.plannerKnowledge", { params: grade6 })).competencies.find((c) => c.code === code)?.status ?? "unverified";

describe("an AI-completed project is never mastery", () => {
  it("refuses a recommendation when the learner's own practice disclosed AI help, and keeps the status at practiced", async () => {
    const d = await bootPilotDistrict();
    const plan = await drive(d, PL.jules, "Build a Roblox Pizza Tycoon", { project: "ai", challenge: "ai" });
    expect(outcomeOf(await d.call(teacher(d), "teacher.plannerReview", { params: target(plan), body: recommend(plan, d) }))).toBe("409 conflict");
    expect(await status(d, PL.jules)).toBe("practiced");
  });

  it("refuses a recommendation on a finished project with no separate practice challenge", async () => {
    const d = await bootPilotDistrict();
    const plan = await drive(d, PL.jules, "Build a Roblox Pizza Tycoon", { project: "independent" });
    expect(outcomeOf(await d.call(teacher(d), "teacher.plannerReview", { params: target(plan), body: recommend(plan, d) }))).toBe("409 conflict");
    expect(await status(d, PL.jules)).toBe("practiced");
  });

  it("does not let a teacher relabel AI-assisted or unknown-assistance work as independent", async () => {
    const d = await bootPilotDistrict();
    const plan = await drive(d, PL.jules, "Build a Roblox Pizza Tycoon", { project: "independent", challenge: "unknown" });
    expect(outcomeOf(await d.call(teacher(d), "teacher.plannerReview", { params: target(plan), body: recommend(plan, d) }))).toBe("409 conflict");
    for (const assistance of ["ai", "unknown", "peer", "adult"] as const) {
      expect(outcomeOf(await d.call(teacher(d), "teacher.plannerReview", { params: target(plan), body: recommend(plan, d, { assistance }) })), assistance).toBe("409 conflict");
    }
    expect(await status(d, PL.jules)).toBe("practiced");
  });

  it("keeps help the learner disclosed visible to the teacher, and never makes it a grade", async () => {
    const d = await bootPilotDistrict();
    await drive(d, PL.jules, "Build a Roblox Pizza Tycoon", { project: "ai", challenge: "independent" });
    const detail = await d.ok(teacher(d), "teacher.guidanceEvidence", { params: { ...grade6, frameworkKey: "ccss-math", code: "6.RP.A.3" } });
    expect(JSON.stringify(detail)).toContain('"assistance":"ai"');
    expect(JSON.stringify(detail)).not.toMatch(/Build a Roblox Pizza Tycoon/);
    expect(await d.stores.assessment.load()).toEqual(await (await bootPilotDistrict()).stores.assessment.load());
  });

  it("requires a disclosure at all: sharing without one is refused", async () => {
    const d = await bootPilotDistrict();
    const token = d.tokenFor(PL.jules);
    let plan = await d.ok(token, "student.planGoal", { params: grade6, body: { goal: "Build a Roblox Pizza Tycoon", skills: [] } });
    plan = await d.ok(token, "student.plannerDecision", { params: target(plan), body: { revision: plan.revision, decision: "accepted" } });
    const result = await d.call(token, "student.plannerShare", { params: target(plan), body: { revision: plan.revision, text: "Done." } as never });
    expect(outcomeOf(result)).toBe("400 validation-failed");
  });
});

describe("weak or invented alignment is rejected", () => {
  it("audits every offered opportunity against the approved release, and catches each way to cheat", async () => {
    const d = await bootPilotDistrict();
    const plan = await d.ok(d.tokenFor(PL.jules), "student.planGoal", { params: grade6, body: { goal: "Build a Roblox Pizza Tycoon", skills: [] } });
    const [rate, writing] = plan.opportunities as [PilotPlan["opportunities"][number], PilotPlan["opportunities"][number]];
    const levels = new Set(["06"]);
    const audit = (o: PilotPlan["opportunities"][number], l = levels) => auditOpportunity(d.app.catalog, o, l);
    expect(await audit(rate)).toEqual([]);
    expect(await audit(writing)).toEqual([]);
    // A made-up code, a code on the wrong subject's framework, a fabricated node, an altered node and a stale digest.
    expect((await audit({ ...rate, code: "6.RP.A.9" as never })).map((p) => p.rule)).toEqual(["unknown-code"]);
    expect((await audit({ ...rate, frameworkKey: "ccss-ela" })).map((p) => p.rule)).toContain("wrong-subject");
    expect((await audit({ ...rate, node: { ...rate.node, uri: "https://case.example/CFItems/00000000-0000-4000-8000-000000000000" } })).map((p) => p.rule)).toContain("not-in-registry");
    expect((await audit({ ...rate, node: { ...rate.node, fullStatement: `${rate.node.fullStatement} Also all of ratio.` } })).map((p) => p.rule)).toContain("altered-node");
    expect((await audit({ ...rate, releaseDigest: "sha256:forged" })).map((p) => p.rule)).toContain("wrong-release");
    // An ELA node pinned in the math release is not in that release; an ELA node under a math code is a misattributed subject.
    expect((await audit({ ...rate, node: writing.node })).map((p) => p.rule)).toContain("not-in-registry");
    expect((await audit({ ...writing, code: "6.RP.A.3b" })).map((p) => p.rule)).toEqual(expect.arrayContaining(["wrong-code", "wrong-subject"]));
    // A grade 6 standard must not be offered to a grade 7 class, and the contract must assess only the one competency.
    expect((await audit(rate, new Set(["07"]))).map((p) => p.rule)).toContain("wrong-grade");
    expect((await audit({ ...rate, contract: { ...rate.contract, competencies: [...rate.contract.competencies, ...writing.contract.competencies] } })).map((p) => p.rule)).toContain("contract-mismatch");
  });

  it("has no lettered component node: 6.RP.A.3b pins the real 6.RP.A.3 record and no invented GUID", async () => {
    const d = await bootPilotDistrict();
    const plan = await d.ok(d.tokenFor(PL.jules), "student.planGoal", { params: grade6, body: { goal: "Build a Roblox Pizza Tycoon", skills: [] } });
    const rate = plan.opportunities.find((o) => o.code === "6.RP.A.3b")!;
    const release = (await d.app.catalog.approvedRelease("ccss-math"))!;
    expect(release.content.nodes!.some((n) => n.humanCodingScheme === "6.RP.A.3b")).toBe(false);
    expect(rate.node).toEqual(release.content.nodes!.find((n) => n.humanCodingScheme === "6.RP.A.3"));
    expect(rate.node.provenance.source).toBe("derived");
    expect(JSON.stringify(rate)).not.toMatch(/caseGuid|CFItems|casenetwork/i);
  });

  it.each([
    "Design a Minecraft castle with towers",
    "I like animals",
    "Write a poem about the ocean",
    "Build a garden",
  ])("offers no lesson for an interest with no natural fit: %s", async (goal) => {
    const d = await bootPilotDistrict();
    const plan = await d.ok(d.tokenFor(PL.noor), "student.planGoal", { params: grade6, body: { goal, skills: [] } });
    expect(plan.opportunities).toEqual([]);
    expect(await d.ok(d.tokenFor(PL.noor), "student.plannerKnowledge", { params: grade6 })).toMatchObject({ competencies: [] });
    expect((await d.ok(d.tokenFor(PL.okoye), "teacher.planner", { params: grade6 }))).toEqual([]);
    expect((await d.ok(teacher(d), "teacher.guidance", { params: grade6 })).coverage).toEqual([]);
  });

  it("only maps a goal to a standard the student chose, never one outside the class's grade", async () => {
    const d = await bootPilotDistrict();
    const noor = d.tokenFor(PL.noor);
    const chosen = await d.ok(noor, "student.planGoal", { params: grade6, body: { goal: "Build a garden", skills: [], focus: "6.RP.A.3b" } });
    expect(chosen.opportunities.map((o) => o.code)).toEqual(["6.RP.A.3b"]);
    expect(chosen.opportunities[0]!.reason).toContain("You chose");
    expect(outcomeOf(await d.call(noor, "student.planGoal", { params: grade6, body: { goal: "Build a garden", skills: [], focus: "7.RP.A.1" } }))).toBe("409 conflict");
  });

  // Known limitation, recorded so a pilot does not oversell the matcher: matching is keyword-based,
  // so a game-themed goal with no rate content still reaches a rate task. The guard is downstream.
  it("known limitation: a topic keyword alone can offer a task, but it stays optional and proves nothing", async () => {
    const d = await bootPilotDistrict();
    const token = d.tokenFor(PL.noor);
    let plan = await d.ok(token, "student.planGoal", { params: grade6, body: { goal: "Make my Roblox avatar look cool", skills: [] } });
    expect(plan.opportunities.length).toBeGreaterThan(0);
    plan = await d.ok(token, "student.plannerDecision", { params: target(plan), body: { revision: plan.revision, decision: "skipped" } });
    expect(plan.opportunities[0]!.decision).toBe("skipped");
    expect(await status(d, PL.noor)).toBe("unverified");
  });
});

describe("withdrawn standards stop new work but keep history", () => {
  it("refuses coaching, sharing and recommending against a withdrawn release, and offers nothing new from it", async () => {
    const d = await bootPilotDistrict();
    const token = d.tokenFor(PL.jules);
    const shared = await drive(d, PL.jules, "Build a Roblox Pizza Tycoon", { project: "independent", challenge: "independent" });
    let open = await d.ok(token, "student.planGoal", { params: grade6, body: { goal: "Build a Roblox Pizza Tycoon", skills: [] } });
    open = await d.ok(token, "student.plannerDecision", { params: target(open), body: { revision: open.revision, decision: "accepted" } });
    await d.ok(d.tokenFor(PL.admin), "admin.withdrawStandards", { params: { frameworkKey: "ccss-math" } });
    expect(outcomeOf(await d.call(token, "student.plannerCoach", { params: target(open), body: { revision: open.revision, action: "show", allowAi: false } }))).toBe("409 conflict");
    expect(outcomeOf(await d.call(token, "student.plannerShare", { params: target(open), body: { revision: open.revision, text: "x", assistance: "independent" } }))).toBe("409 conflict");
    expect(outcomeOf(await d.call(teacher(d), "teacher.plannerReview", { params: target(shared), body: recommend(shared, d) }))).toBe("409 conflict");
    // The history is still readable, and a new plan cannot offer the withdrawn framework.
    expect((await d.ok(token, "student.planner", { params: grade6 })).some((p) => p.id === shared.id)).toBe(true);
    const fresh = await d.ok(token, "student.planGoal", { params: grade6, body: { goal: "Build a Roblox Pizza Tycoon", skills: [] } });
    expect(fresh.opportunities.map((o) => o.code)).toEqual(["W.6.1"]);
  });

  it("offers nothing at all in a district that has approved no standards", async () => {
    const d = await bootPilotDistrict({ standards: [] });
    const plan = await d.ok(d.tokenFor(PL.jules), "student.planGoal", { params: grade6, body: { goal: "Build a Roblox Pizza Tycoon", skills: [] } });
    expect(plan.opportunities).toEqual([]);
  });
});

describe("students choose, and skipping is honored", () => {
  it("records a skip as no evidence, no mastery and no pressure to continue", async () => {
    const d = await bootPilotDistrict();
    const token = d.tokenFor(PL.jules);
    let plan = await d.ok(token, "student.planGoal", { params: grade6, body: { goal: "Build a Roblox Pizza Tycoon", skills: [] } });
    plan = await d.ok(token, "student.plannerDecision", { params: target(plan), body: { revision: plan.revision, decision: "skipped" } });
    expect(plan.opportunities[0]!.decision).toBe("skipped");
    expect(outcomeOf(await d.call(token, "student.plannerShare", { params: target(plan), body: { revision: plan.revision, text: "x", assistance: "independent" } }))).toBe("409 conflict");
    expect(await status(d, PL.jules)).toBe("unverified");
    // A skipped, unshared opportunity is invisible to the teacher and to coverage.
    expect(await d.ok(teacher(d), "teacher.planner", { params: grade6 })).toEqual([]);
    expect((await d.ok(teacher(d), "teacher.guidance", { params: grade6 })).coverage).toEqual([]);
  });

  it("lets a learner skip help and try alone, which closes help for that attempt", async () => {
    const d = await bootPilotDistrict();
    const token = d.tokenFor(PL.jules);
    let plan = await d.ok(token, "student.planGoal", { params: grade6, body: { goal: "Build a Roblox Pizza Tycoon", skills: [] } });
    plan = await d.ok(token, "student.plannerDecision", { params: target(plan), body: { revision: plan.revision, decision: "accepted" } });
    plan = await d.ok(token, "student.plannerCoach", { params: target(plan), body: { revision: plan.revision, action: "try", allowAi: false } });
    expect(plan.opportunities[0]!.coaching!.mode).toBe("independent");
    expect(plan.opportunities[0]!.coaching!.hints).toBe(0);
    expect(outcomeOf(await d.call(token, "student.plannerCoach", { params: target(plan), body: { revision: plan.revision, action: "show", allowAi: false } }))).toBe("409 conflict");
  });
});

describe("retention and transfer need new evidence, not repetition", () => {
  async function demonstrated(d: PilotDistrict) {
    const plan = await drive(d, PL.jules, "Build a Roblox Pizza Tycoon", { project: "independent", challenge: "independent" });
    await d.ok(teacher(d), "teacher.plannerReview", { params: target(plan), body: recommend(plan, d) });
  }
  it("refuses a delayed check earlier than seven days, and one with no earlier demonstration", async () => {
    const d = await bootPilotDistrict();
    const solo = await drive(d, PL.maribel, "Compare cookie prices and persuade our club to choose a recipe", { project: "independent", challenge: "independent" });
    const delayed = (plan: PilotPlan) => recommend(plan, d, { level: "retained", assessment: { method: "delayed-check", observedAt: d.now().toISOString(), context: "Unseen task one week later." } });
    expect(outcomeOf(await d.call(teacher(d), "teacher.plannerReview", { params: target(solo), body: delayed(solo) }))).toBe("409 conflict");
    await demonstrated(d);
    d.setNow(new Date(d.now().getTime() + 6 * 24 * HOUR).toISOString());
    const early = await drive(d, PL.jules, "Build a Roblox Pizza Tycoon", { project: "independent", challenge: "independent" });
    expect(outcomeOf(await d.call(teacher(d), "teacher.plannerReview", { params: target(early), body: delayed(early) }))).toBe("409 conflict");
    // The refused check upgrades nothing: the earlier demonstration stands, and it is not "retained".
    expect(await status(d, PL.jules)).toBe("demonstrated");
  });

  it("requires a different context for transfer", async () => {
    const d = await bootPilotDistrict();
    await demonstrated(d);
    d.setNow(new Date(d.now().getTime() + 24 * HOUR).toISOString());
    const next = await drive(d, PL.jules, "Build a Roblox Pizza Tycoon", { project: "independent", challenge: "independent" });
    const transfer = (context: string) => recommend(next, d, { level: "transferred", assessment: { method: "new-context", observedAt: d.now().toISOString(), context } });
    expect(outcomeOf(await d.call(teacher(d), "teacher.plannerReview", { params: target(next), body: transfer("Unseen teacher-selected task.") }))).toBe("409 conflict");
    expect(outcomeOf(await d.call(teacher(d), "teacher.plannerReview", { params: target(next), body: transfer("Walking-time map problem, a setting the learner has not practiced.") }))).toBe("ok");
    expect(await status(d, PL.jules)).toBe("transferred");
  });
});

describe("the wrong family, class or district sees nothing", () => {
  it("keeps every guardian, other class, other teacher and other district out", async () => {
    const d = await bootPilotDistrict();
    const gina = await onboardGuardian(d, PL.jules, "pl-g-5001", "Gina (synthetic guardian)");
    // Nothing is open by default, and the policy audit names the denial.
    expect(outcomeOf(await d.call(gina.token, "guardian.guidanceSuggest", { params: { studentId: PL.jules as never, offeringId: PL.grade6 as never }, body: { kind: "curiosity", topic: "Chess" } }))).toBe("403 forbidden");
    // Another class's student and another class's teacher cannot read this class's planner or coverage.
    expect(outcomeOf(await d.call(d.tokenFor(PL.ines), "student.planner", { params: grade6 }))).toBe("404 not-found");
    expect(outcomeOf(await d.call(d.tokenFor(PL.quinn), "student.planner", { params: grade6 }))).toBe("404 not-found");
    for (const route of ["teacher.planner", "teacher.guidance"] as const) {
      expect(["403 forbidden", "404 not-found"], route).toContain(outcomeOf(await d.call(d.tokenFor(PL.vance), route, { params: grade6 })));
    }
    // A student cannot use a teacher route, and administrators get no student evidence through the planner.
    expect(outcomeOf(await d.call(d.tokenFor(PL.jules), "teacher.planner", { params: grade6 }))).toBe("403 forbidden");
    expect(["403 forbidden", "404 not-found"]).toContain(outcomeOf(await d.call(d.tokenFor(PL.admin), "teacher.planner", { params: grade6 })));
    // Another district's identity provider is not trusted here.
    const other = await bootPilotDistrict({ directory: RIVERBEND });
    const foreign = other.tokenFor(RIVERBEND.principals.find((p) => p.kind === "student")!.id);
    expect(outcomeOf(await d.call(foreign, "student.planner", { params: grade6 }))).toBe("401 unauthenticated");
    expect(outcomeOf(await d.call(undefined, "student.planner", { params: grade6 }))).toBe("401 unauthenticated");
  });
});

describe("no model is reached by default, and never for K-5", () => {
  const provider = () => ({ completeGuarded: vi.fn(async () => { throw new Error("a model must not be called"); }) });
  const wired = (completeGuarded: ReturnType<typeof provider>["completeGuarded"]) => ({
    provider: { completeGuarded }, model: { provider: "cloudflare", modelId: "synthetic-model" } as never, estimatedMaxUsdNano: "1000000" as never, enabledFor: async () => true,
  });

  it("answers a grade 5 student with an explicit scope message and creates no plan or model call", async () => {
    const { completeGuarded } = provider();
    const d = await bootPilotDistrict({ plannerAi: wired(completeGuarded) });
    const result = await d.call(d.tokenFor(PL.lena), "student.planGoal", { params: { offeringId: PL.grade5 as never }, body: { goal: "Build a Roblox Pizza Tycoon", skills: [] } });
    expect(outcomeOf(result)).toBe("409 conflict");
    expect(await d.ok(d.tokenFor(PL.lena), "student.planner", { params: { offeringId: PL.grade5 as never } })).toEqual([]);
    expect(completeGuarded).not.toHaveBeenCalled();
  });

  it("keeps even a grade 6 request on the curriculum lesson when the district has not enabled model help", async () => {
    const { completeGuarded } = provider();
    const d = await bootPilotDistrict({ plannerAi: wired(completeGuarded) });
    const token = d.tokenFor(PL.jules);
    let plan = await d.ok(token, "student.planGoal", { params: grade6, body: { goal: "Build a Roblox Pizza Tycoon", skills: [] } });
    plan = await d.ok(token, "student.plannerDecision", { params: target(plan), body: { revision: plan.revision, decision: "accepted" } });
    plan = await d.ok(token, "student.plannerCoach", { params: target(plan), body: { revision: plan.revision, action: "show", allowAi: true } });
    expect(plan.opportunities[0]!.coaching).toMatchObject({ source: "curriculum", aiStatus: "policy-denied" });
    expect(plan.opportunities[0]!.coaching!.guidance).toContain("Your turn");
    expect(completeGuarded).not.toHaveBeenCalled();
    const unwired = await bootPilotDistrict();
    const t2 = unwired.tokenFor(PL.jules);
    let p2 = await unwired.ok(t2, "student.planGoal", { params: grade6, body: { goal: "Build a Roblox Pizza Tycoon", skills: [] } });
    p2 = await unwired.ok(t2, "student.plannerDecision", { params: target(p2), body: { revision: p2.revision, decision: "accepted" } });
    p2 = await unwired.ok(t2, "student.plannerCoach", { params: target(p2), body: { revision: p2.revision, action: "show", allowAi: true } });
    expect(p2.opportunities[0]!.coaching!.aiStatus).toBe("not-wired");
  });
});

describe("family boundaries on the guardian opt-in", () => {
  it("is off by default, off again after revocation, and never reveals why a suggestion is refused", async () => {
    const d = await bootPilotDistrict();
    const gina = await onboardGuardian(d, PL.jules, "pl-g-6001", "Gina (synthetic guardian)");
    const admin = d.tokenFor(PL.admin);
    const view = await d.ok(gina.token, "guardian.guidance", { params: { studentId: PL.jules as never } });
    expect(view).toMatchObject({ capabilities: { suggest: false, progress: false }, offerings: [] });
    await d.ok(admin, "admin.setGuardianGuidance", { params: { relationshipId: gina.relationshipId as never }, body: { revision: 0, capabilities: ["suggest", "progress"] } });
    await d.ok(admin, "admin.setGuardianGuidance", { params: { relationshipId: gina.relationshipId as never }, body: { revision: 1, capabilities: [] } });
    const suggest = () => d.call(gina.token, "guardian.guidanceSuggest", { params: { studentId: PL.jules as never, offeringId: PL.grade6 as never }, body: { kind: "curiosity", topic: "Chess" } });
    expect(outcomeOf(await suggest())).toBe("403 forbidden");
    const history = (await d.ok(admin, "admin.guardianGuidance", { params: { studentId: PL.jules as never } })).relationships[0]!.history.map((h) => h.action);
    expect(history).toEqual(["enabled", "revoked"]);
  });

  it("shows a guardian only a coarse label for teacher-chosen standards, never work, goals or grades", async () => {
    const d = await bootPilotDistrict();
    const gina = await onboardGuardian(d, PL.jules, "pl-g-7001", "Gina (synthetic guardian)");
    await d.ok(d.tokenFor(PL.admin), "admin.setGuardianGuidance", { params: { relationshipId: gina.relationshipId as never }, body: { revision: 0, capabilities: ["progress"] } });
    await drive(d, PL.jules, "Build a Roblox Pizza Tycoon", { project: "ai", challenge: "independent" });
    const family = await d.ok(gina.token, "guardian.guidance", { params: { studentId: PL.jules as never } });
    expect(JSON.stringify(family)).not.toMatch(/Pizza Tycoon|My project explanation|My practice answer|"assistance"/);
    expect(family.offerings.flatMap((o) => o.progress ?? []).every((p) => /^[A-Z]/.test(p.label))).toBe(true);
  });
});
