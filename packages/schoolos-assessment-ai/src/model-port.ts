// The model port: how an AI evaluator reaches a model, always through governance. Its
// `beforeRequest` / `afterResponse` pair is a narrowing of `AiRequestGovernor` in
// `@schoolos/ai-governance` (G01), in the governor's own types, amounts in nanodollars included,
// so `ledgerGovernor` supplies those two methods as they are.
import { z } from "zod";
import {
  AiDenialReason,
  AiProvider,
  AiRequestId,
  ModelRef,
  TokenUsage,
  UsdNano,
  type AiWorkspaceContext,
  type GovernedAiRequest,
} from "@schoolos/ai-governance";

export { AiProvider, ModelRef, TokenUsage };

/** The label a model's suggestions carry in the assessment service: `<provider>/<modelId>`. */
export function modelLabel(model: ModelRef): string {
  return `${model.provider}/${model.modelId}`;
}

/**
 * Identifies one model request: governance's `AiRequestId`. An AI assessment run uses its run ID,
 * which is derived from its whole run key, so every attempt of one run is the same request.
 */
export const ModelRequestId = AiRequestId;
/** A model request identifier. */
export type ModelRequestId = AiRequestId;

/** Why governance refused a request: governance's `AiDenialReason`. */
export const ModelDenialReason = AiDenialReason;
/** A model denial reason. */
export type ModelDenialReason = AiDenialReason;

/**
 * What governance is told before a request: a `GovernedAiRequest` whose workspace is a course,
 * because AI assessment of course work is always billed to its offering, and whose purpose is the
 * default, generative. `estimatedMaxUsdNano` is the execution profile's cost limit. There is no
 * field for the prompt, so the student's work never reaches the ledger.
 */
export type GovernedModelRequest = Omit<GovernedAiRequest, "workspace" | "fundingPurpose"> & {
  workspace: Extract<AiWorkspaceContext, { kind: "course" }>;
};

/** Whether governance lets a request go ahead; the parts of `GovernorDecision` an evaluator reads. */
export type ModelGovernorDecision = { effect: "allow" } | { effect: "deny"; reason: ModelDenialReason };

/**
 * How a request ended, as reported to governance: the single-attempt and failed forms of
 * `AiResponseOutcome`, with the cost in nanodollars.
 */
export type ModelResponseOutcome =
  | { status: "completed"; requestId: ModelRequestId; usage: TokenUsage; actualUsdNano: UsdNano }
  | { status: "failed"; requestId: ModelRequestId };

/**
 * One prompt. `instructions` are SchoolOS's own text, the rubric and the teacher's instructions;
 * they never contain student work. `payload` holds the student's work as JSON inside a boundary
 * whose token is random per request, so the work cannot close the boundary and speak outside it.
 */
export interface ModelPrompt {
  requestId: ModelRequestId;
  model: ModelRef;
  instructions: string;
  /** The boundary token; `payload` opens with `<untrusted-content boundary="…">` and closes with the same. */
  boundary: string;
  payload: string;
  maxOutputTokens: number;
}

/** What the model returned. `output` is untrusted until parsed. */
export const ModelCompletion = z.strictObject({
  output: z.unknown(),
  usage: TokenUsage,
  /** What the request cost, in nanodollars, as the gateway reported or estimated it. */
  actualUsdNano: UsdNano,
});
/** A model completion. */
export type ModelCompletion = z.infer<typeof ModelCompletion>;

/**
 * The only way an AI evaluator reaches a model. `beforeRequest` must allow before `complete` is
 * called; `afterResponse` is called once the request has finally succeeded or failed. A request ID
 * still held may be asked again, and is billed once.
 */
export interface ModelPort {
  /** Holds funds for the request, or refuses it before any spend. */
  beforeRequest(request: GovernedModelRequest): Promise<ModelGovernorDecision>;
  /** Sends the prompt. Throwing is a transient failure: the run retries it under the same request ID. */
  complete(prompt: ModelPrompt): Promise<ModelCompletion>;
  /** Settles a completed request or releases a failed one. What it resolves to is not read. */
  afterResponse(outcome: ModelResponseOutcome): Promise<unknown>;
}
