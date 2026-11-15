import { z } from "zod";
import type { AiHelpPolicySource } from "@educateos/curriculum";
import { AiRequestId, ModelRef, TokenUsage, UsdNano, type AiRequestGovernor, type GovernedAiRequest } from "@educateos/ai-governance";
import type { PlannerPlan } from "./planner.ts";

/** The only model output accepted: it cannot change alignment, tasks, evidence or mastery. */
export const PlannerExplanation = z.strictObject({
  competencyUri: z.string(), releaseDigest: z.string(), step: z.number().int().nonnegative(),
  explanation: z.string().trim().min(1).max(2400),
});
/** Server-injected gateway adapter. Production has none until the existing guard can supply this seam. */
export interface PlannerAiProvider {
  /** Must run existing input/output screening; released=false withholds all text. Never log payloads. */
  completeGuarded(input: {
    request: GovernedAiRequest; goal: string; code: string; competencyUri: string;
    releaseDigest: string; step: number; instruction: string; maxOutputTokens: number;
  }, signal: AbortSignal): Promise<{ released: boolean; output: unknown; usage: z.infer<typeof TokenUsage>; actualUsdNano: z.infer<typeof UsdNano> }>;
}
/** Deployment configuration, never request-selected providers, models, costs or permission. */
export interface PlannerAiOptions {
  provider: PlannerAiProvider;
  model: z.infer<typeof ModelRef>;
  estimatedMaxUsdNano: GovernedAiRequest["estimatedMaxUsdNano"];
  /** Explicit district authorization in addition to curriculum help policy and ledger policy. */
  enabledFor(offeringId: PlannerPlan["offeringId"]): Promise<boolean>;
}
/** Why the working curriculum fallback was used. No provider errors or policy secrets are returned. */
export const PlannerAiStatus = z.enum(["not-requested", "not-wired", "policy-denied", "budget-denied", "invalid-output", "provider-unavailable", "used"]);

/** Fail closed around age, consent, policy, reservation, screening and alignment verification. */
export async function plannerExplanation(input: {
  options?: PlannerAiOptions; policy?: AiHelpPolicySource; governor: AiRequestGovernor;
  scope: Parameters<AiHelpPolicySource["layersFor"]>[0]; levels: Set<string> | undefined;
  plan: PlannerPlan; opportunity: PlannerPlan["opportunities"][number]; allowAi: boolean;
}): Promise<z.infer<typeof PlannerAiStatus>> {
  const { options, plan, opportunity: o } = input;
  const coach = o.coaching!;
  if (!input.allowAi) return "not-requested";
  if (!options) return "not-wired";
  if (!input.levels?.size || [...input.levels].some((l) => !/^(0[6-9]|1[0-2])$/.test(l)) || !input.policy) return "policy-denied";
  let request: GovernedAiRequest;
  try {
    if (!await options.enabledFor(plan.offeringId)) return "policy-denied";
    const layers = await input.policy.layersFor(input.scope);
    // Full explanations are disallowed even under hints-only: curated hints still function.
    if ([layers.district, layers.school, layers.offering].some((l) => l !== undefined && l !== "full")) return "policy-denied";
    request = { requestId: AiRequestId.parse(`plp:${crypto.randomUUID()}`), principal: { districtId: input.scope.districtId, principalId: plan.studentId }, workspace: { kind: "course", offeringId: plan.offeringId }, model: options.model, estimatedMaxUsdNano: options.estimatedMaxUsdNano };
    if ((await input.governor.beforeRequest(request)).effect !== "allow") return "budget-denied";
  } catch { return "policy-denied"; }
  let completion: Awaited<ReturnType<PlannerAiProvider["completeGuarded"]>>;
  try {
    const signal = AbortSignal.timeout(4000);
    completion = await Promise.race([options.provider.completeGuarded({ request, goal: plan.goal, code: o.code, competencyUri: o.node.uri, releaseDigest: o.releaseDigest, step: coach.step, instruction: coach.lesson.steps[coach.step]!.instruction, maxOutputTokens: 600 }, signal), new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
  } catch {
    // A timeout may still have spent money. Preserve its liability instead of voiding the hold.
    try { await input.governor.afterResponse({ status: "completed", requestId: request.requestId, attempts: [{ attemptIndex: 0, state: "unknown" }] }); } catch { /* Reservation stays held; no text is released. */ }
    return "provider-unavailable";
  }
  try {
    await input.governor.afterResponse({ status: "completed", requestId: request.requestId, usage: TokenUsage.parse(completion.usage), actualUsdNano: UsdNano.parse(completion.actualUsdNano) });
  } catch { return "provider-unavailable"; }
  const parsed = PlannerExplanation.safeParse(completion.output);
  if (!completion.released || !parsed.success || parsed.data.competencyUri !== o.node.uri || parsed.data.releaseDigest !== o.releaseDigest || parsed.data.step !== coach.step) return "invalid-output";
  coach.guidance = `${parsed.data.explanation}\nYour turn: ${coach.lesson.steps[coach.step]!.action}`;
  coach.source = "governed-ai";
  const event = coach.events.at(-1);
  if (event) event.source = "governed-ai";
  return "used";
}
