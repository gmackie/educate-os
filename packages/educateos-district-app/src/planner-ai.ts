import { z } from "zod";
import type { AiHelpPolicySource } from "@educateos/curriculum";
import { AiRequestId, ModelRef, AiSettlement, type AiRequestGovernor, type GovernedAiRequest } from "@educateos/ai-governance";
import type { PlannerPlan } from "./planner.ts";

/** The only model output accepted: it cannot change alignment, tasks, evidence or mastery. */
export const PlannerExplanation = z.strictObject({
  competencyUri: z.string(), releaseDigest: z.string(), step: z.number().int().nonnegative(),
  explanation: z.string().trim().min(1).max(2400),
});
/** Server-injected gateway adapter. Only the district Worker supplies live transport. */
export interface PlannerAiProvider {
  /** Must run existing input/output screening; released=false withholds all text. Never log payloads. */
  completeGuarded(input: {
    /** Recheck the district kill switch and consent immediately before sending and release. */
    authorize(): Promise<boolean>; request: GovernedAiRequest; goal: string; code: string; competencyUri: string;
    releaseDigest: string; step: number; instruction: string; maxOutputTokens: number;
  }, signal: AbortSignal): Promise<{ released: boolean; output: unknown; /** Absent only when no generative call was sent. */ settlement?: AiSettlement }>;
}
/** Deployment configuration, never request-selected providers, models, costs or permission. */
export interface PlannerAiOptions {
  provider: PlannerAiProvider;
  model: z.infer<typeof ModelRef>;
  estimatedMaxUsdNano: GovernedAiRequest["estimatedMaxUsdNano"];
  /** Explicit district authorization in addition to curriculum help policy and ledger policy. */
  /** Durable subject revocation or an explicitly revoked deployment grant. */
  consentRevoked?(studentId: PlannerPlan["studentId"]): Promise<boolean>;
  enabledFor(offeringId: PlannerPlan["offeringId"], studentId: PlannerPlan["studentId"]): Promise<boolean>;
}
/** Why the working curriculum fallback was used. No provider errors or policy secrets are returned. */
export const PlannerAiStatus = z.enum(["not-requested", "not-wired", "consent-revoked", "policy-denied", "budget-denied", "invalid-output", "provider-unavailable", "used"]);

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
  try { if (await options.consentRevoked?.(plan.studentId)) return "consent-revoked"; } catch { return "policy-denied"; }
  if (!input.levels?.size || [...input.levels].some((l) => !/^(0[6-9]|1[0-2])$/.test(l)) || !input.policy) return "policy-denied";
  // Bounds apply before a reservation or any external screening/model call.
  if (plan.goal.length > 2000 || o.code.length > 100 || o.node.uri.length > 2048 || o.releaseDigest.length > 256
    || !coach.lesson.steps[coach.step] || coach.lesson.steps[coach.step]!.instruction.length > 4000) return "policy-denied";
  const allowed = async () => {
    if (!await options.enabledFor(plan.offeringId, plan.studentId)) return false;
    const layers = await input.policy!.layersFor(input.scope);
    return ![layers.district, layers.school, layers.offering].some((l) => l !== undefined && l !== "full");
  };
  let request: GovernedAiRequest;
  try {
    if (!await allowed()) return await options.consentRevoked?.(plan.studentId) ? "consent-revoked" : "policy-denied";
    request = { requestId: AiRequestId.parse(`plp:${crypto.randomUUID()}`), principal: { districtId: input.scope.districtId, principalId: plan.studentId }, workspace: { kind: "course", offeringId: plan.offeringId }, model: options.model, estimatedMaxUsdNano: options.estimatedMaxUsdNano };
    if ((await input.governor.beforeRequest(request)).effect !== "allow") return "budget-denied";
  } catch { return "policy-denied"; }
  let completion: Awaited<ReturnType<PlannerAiProvider["completeGuarded"]>>;
  try {
    const signal = AbortSignal.timeout(20000);
    completion = await Promise.race([options.provider.completeGuarded({ authorize: allowed, request, goal: plan.goal, code: o.code, competencyUri: o.node.uri, releaseDigest: o.releaseDigest, step: coach.step, instruction: coach.lesson.steps[coach.step]!.instruction, maxOutputTokens: 600 }, signal), new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
  } catch {
    // A timeout may still have spent money. Preserve its liability instead of voiding the hold.
    try { await input.governor.afterResponse({ status: "completed", requestId: request.requestId, attempts: [{ attemptIndex: 0, state: "unknown" }] }); } catch { /* Reservation stays held; no text is released. */ }
    return "provider-unavailable";
  }
  try {
    await input.governor.afterResponse(completion.settlement === undefined
      ? { status: "failed", requestId: request.requestId }
      : { status: "completed", requestId: request.requestId, ...AiSettlement.parse(completion.settlement) });
    // Revocation or a policy tightening while screening/model I/O ran withholds the response.
    if (!await allowed()) return await options.consentRevoked?.(plan.studentId) ? "consent-revoked" : "policy-denied";
  } catch { return "provider-unavailable"; }
  const parsed = PlannerExplanation.safeParse(completion.output);
  if (!completion.released || !parsed.success || parsed.data.competencyUri !== o.node.uri || parsed.data.releaseDigest !== o.releaseDigest || parsed.data.step !== coach.step) return "invalid-output";
  coach.guidance = `${parsed.data.explanation}\nYour turn: ${coach.lesson.steps[coach.step]!.action}`;
  coach.source = "governed-ai";
  const event = coach.events.at(-1);
  if (event) event.source = "governed-ai";
  return "used";
}
