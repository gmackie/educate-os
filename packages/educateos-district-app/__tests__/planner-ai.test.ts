import { describe, expect, it, vi } from "vitest";
import { OfferingId } from "@educateos/contracts";
import { usdNano, usdNanoFromCents } from "@educateos/ai-governance";
import { plannerExplanation, type PlannerAiOptions, type PlannerAiProvider } from "../src/planner-ai.ts";
import { bootDistrict, NF, NORTHFIELD } from "./support.ts";

const params = { offeringId: OfferingId.parse(NF.eng9) };
const scope = { level: "offering" as const, districtId: NORTHFIELD.district.id, schoolId: NORTHFIELD.schools[0]!.id, offeringId: OfferingId.parse(NF.eng9) };
const directory = { ...NORTHFIELD, courses: NORTHFIELD.courses.map((c) => ({ ...c, gradeBand: "6" })) };
const usage = { inputTokens: 60, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 };
const full = { layersFor: async () => ({ district: "full" as const }) };
async function fixture() {
  const d = await bootDistrict(directory);
  const plan = await d.ok(d.tokenFor(NF.amara), "student.planGoal", { params, body: { goal: "PRIVATE pizza game", skills: [] } });
  const opportunity = plan.opportunities[0]!;
  const completeGuarded = vi.fn<PlannerAiProvider["completeGuarded"]>(async (input) => ({ released: true, output: { competencyUri: input.competencyUri, releaseDigest: input.releaseDigest, step: input.step, explanation: "For your game, divide the number made by minutes to find the amount per minute. Keep those units on your table." }, usage, actualUsdNano: usdNano(1000n) }));
  const options: PlannerAiOptions = { provider: { completeGuarded }, model: { provider: "cloudflare", modelId: "synthetic-model" }, estimatedMaxUsdNano: usdNanoFromCents(1), enabledFor: async () => true };
  return { d, completeGuarded, options, input: { options, policy: full, governor: d.app.aiGovernor, scope, levels: new Set(["06"]), plan, opportunity, allowAi: true } };
}

describe("guarded planner provider seam (production unwired)", () => {
  it("reserves through the existing ledger, verifies structured alignment and settles actual usage", async () => {
    const { d, input, completeGuarded } = await fixture();
    // The seam is called after the state machine creates its help event.
    input.opportunity.coaching!.events.push({ action: "show", source: "curriculum", at: new Date().toISOString() });
    expect(await plannerExplanation(input)).toBe("used");
    expect(input.opportunity.coaching).toMatchObject({ source: "governed-ai", guidance: expect.stringContaining("For your game") });
    const sent = completeGuarded.mock.calls[0]![0];
    expect(sent.maxOutputTokens).toBe(600);
    expect(Object.keys(sent).toSorted()).toEqual(["code", "competencyUri", "goal", "instruction", "maxOutputTokens", "releaseDigest", "request", "step"].toSorted());
    expect(sent.goal).toBe("PRIVATE pizza game");
    const report = await d.app.ledger.report();
    expect(report.district).toMatchObject({ requests: 1, usageUsdNano: "1000" });
    expect(JSON.stringify(report)).not.toContain("PRIVATE");
  });

  it.each([new Set(["KG"]), new Set(["05"]), new Set(["05", "06"]), new Set(["13"]), new Set<string>()])("never calls the provider for K–5, mixed or unknown ages (%s)", async (levels) => {
    const { input, completeGuarded } = await fixture();
    expect(await plannerExplanation({ ...input, levels })).toBe("policy-denied");
    expect(completeGuarded).not.toHaveBeenCalled();
  });

  it("requires opt-in, a wired provider, explicit district permission and curriculum policy", async () => {
    const { input, completeGuarded } = await fixture();
    expect(await plannerExplanation({ ...input, allowAi: false })).toBe("not-requested");
    expect(await plannerExplanation({ ...input, options: undefined })).toBe("not-wired");
    expect(await plannerExplanation({ ...input, policy: undefined })).toBe("policy-denied");
    expect(await plannerExplanation({ ...input, options: { ...input.options, enabledFor: async () => false } })).toBe("policy-denied");
    expect(await plannerExplanation({ ...input, policy: { layersFor: async () => ({ district: "none", offering: "full" }) } })).toBe("policy-denied");
    expect(await plannerExplanation({ ...input, policy: { layersFor: async () => ({ district: "full", school: "hints-only" }) } })).toBe("policy-denied");
    expect(completeGuarded).not.toHaveBeenCalled();
  });

  it("never sends a denied model or an unfunded request and keeps the deterministic fallback", async () => {
    const { input, completeGuarded } = await fixture();
    const before = structuredClone(input.opportunity.coaching);
    expect(await plannerExplanation({ ...input, options: { ...input.options, model: { provider: "cloudflare", modelId: "unapproved" } } })).toBe("budget-denied");
    expect(await plannerExplanation({ ...input, options: { ...input.options, estimatedMaxUsdNano: usdNanoFromCents(10000000) } })).toBe("budget-denied");
    expect(completeGuarded).not.toHaveBeenCalled();
    expect(input.opportunity.coaching).toEqual(before);
  });

  it.each(["wrong-uri", "wrong-digest", "wrong-step", "extra-mastery", "screen-withheld"])("rejects invalid/screened output (%s) while settling billed usage", async (kind) => {
    const { d, input, completeGuarded } = await fixture();
    const before = structuredClone(input.opportunity.coaching);
    completeGuarded.mockImplementationOnce(async (request) => ({ released: kind !== "screen-withheld", output: { competencyUri: kind === "wrong-uri" ? "urn:bogus" : request.competencyUri, releaseDigest: kind === "wrong-digest" ? "bogus" : request.releaseDigest, step: kind === "wrong-step" ? 99 : request.step, explanation: "Do something", ...(kind === "extra-mastery" ? { mastery: "demonstrated" } : {}) }, usage, actualUsdNano: usdNano(1000n) }));
    expect(await plannerExplanation(input)).toBe("invalid-output");
    expect(input.opportunity.coaching).toEqual(before);
    expect((await d.app.ledger.report()).district.usageUsdNano).toBe("1000");
  });

  it("keeps an unknown-cost liability on provider failure, with no text released", async () => {
    const { d, input, completeGuarded } = await fixture();
    completeGuarded.mockRejectedValueOnce(new Error("provider unavailable"));
    expect(await plannerExplanation(input)).toBe("provider-unavailable");
    expect(input.opportunity.coaching!.source).toBe("curriculum");
    expect((await d.app.ledger.report()).district.usageUsdNano).toBe(usdNanoFromCents(1));
  });

  it("wires a fake guarded provider through the authenticated coach route only with opt-in", async () => {
    const { options, completeGuarded } = await fixture();
    const d = await bootDistrict(directory, { plannerAi: options, aiHelp: full });
    const student = d.tokenFor(NF.amara);
    let p = await d.ok(student, "student.planGoal", { params, body: { goal: "pizza", skills: [] } });
    const target = { ...params, planId: p.id, opportunityId: p.opportunities[0]!.id };
    p = await d.ok(student, "student.plannerDecision", { params: target, body: { revision: p.revision, decision: "accepted" } });
    p = await d.ok(student, "student.plannerCoach", { params: target, body: { revision: p.revision, action: "show", allowAi: false } });
    expect(completeGuarded).not.toHaveBeenCalled();
    p = await d.ok(student, "student.plannerCoach", { params: target, body: { revision: p.revision, action: "show", allowAi: true } });
    expect(p.opportunities[0]!.coaching).toMatchObject({ aiStatus: "used", source: "governed-ai" });
    expect((await d.ok(student, "student.plannerKnowledge", { params })).competencies[0]!.status).toBe("unverified");
    expect(await d.ok(d.tokenFor(NF.rivera), "teacher.planner", { params })).toEqual([]);
  });
});
