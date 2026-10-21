// The model port: how an AI evaluator reaches a model, always through governance. Its
// `beforeRequest` / `afterResponse` pair mirrors `AiRequestGovernor` in `@schoolos/ai-governance`
// (G01), which is not in this package's lineage yet; once it is, `ledgerGovernor` supplies those
// two methods and the shapes below are replaced by imports.
import { z } from "zod";
import { DistrictId, OfferingId, PrincipalId } from "@schoolos/contracts";

/** The AI providers a district can route through AI Gateway; mirrors `AiProvider` in `@schoolos/ai-governance`. */
export const AiProvider = z.enum(["openai", "anthropic", "google", "cloudflare", "ollama"]);
/** An AI provider. */
export type AiProvider = z.infer<typeof AiProvider>;

/** Names one model: its provider and its ID on that provider's API. Mirrors `ModelRef` in `@schoolos/ai-governance`. */
export const ModelRef = z.strictObject({
  provider: AiProvider,
  modelId: z.string().regex(/^[A-Za-z0-9_.:@-][A-Za-z0-9_.:/@-]{0,150}$/, "expected a model ID"),
});
/** A model reference. */
export type ModelRef = z.infer<typeof ModelRef>;

/** The label a model's suggestions carry in the assessment service: `<provider>/<modelId>`. */
export function modelLabel(model: ModelRef): string {
  return `${model.provider}/${model.modelId}`;
}

/**
 * Identifies one model request; mirrors `AiRequestId`. An AI assessment run uses its run ID, which
 * is derived from its whole run key, so every attempt of one run is the same request.
 */
export const ModelRequestId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, "expected an opaque request ID");
/** A model request identifier. */
export type ModelRequestId = z.infer<typeof ModelRequestId>;

/** Why governance refused a request; mirrors `AiDenialReason`. */
export const ModelDenialReason = z.enum([
  "cross-district",
  "unknown-principal",
  "unknown-offering",
  "not-enrolled",
  "term-closed",
  "no-funding-pool",
  "ai-spending-disabled",
  "model-unknown",
  "model-disabled",
  "model-not-allowed",
  "principal-cap-reached",
  "pool-exhausted",
  "request-already-completed",
]);
/** A model denial reason. */
export type ModelDenialReason = z.infer<typeof ModelDenialReason>;

/**
 * What governance is told before a request; mirrors `GovernedAiRequest`, except that amounts here
 * are whole cents (an execution profile's cost limit) where governance holds integer nanodollars,
 * so the adapter onto the governor converts them with `usdNanoFromCents`. There is no field for
 * the prompt, so the student's work never reaches the ledger.
 */
export interface GovernedModelRequest {
  requestId: ModelRequestId;
  principal: { principalId: PrincipalId; districtId: DistrictId };
  /** AI assessment of course work is always billed to its offering. */
  workspace: { kind: "course"; offeringId: OfferingId };
  model: ModelRef;
  /** The most the request may cost: the execution profile's cost limit. */
  estimatedMaxCents: number;
}

/** Whether governance lets a request go ahead; the parts of `GovernorDecision` an evaluator reads. */
export type ModelGovernorDecision = { effect: "allow" } | { effect: "deny"; reason: ModelDenialReason };

/** Token counts for one response; mirrors `TokenUsage`. */
export const TokenUsage = z.strictObject({
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  cacheReadTokens: z.int().nonnegative(),
  cacheWriteTokens: z.int().nonnegative(),
});
/** Token usage. */
export type TokenUsage = z.infer<typeof TokenUsage>;

/**
 * How a request ended, as reported to governance; mirrors the single-attempt form of
 * `AiResponseOutcome`, in whole cents (see {@link GovernedModelRequest}).
 */
export type ModelResponseOutcome =
  | { status: "completed"; requestId: ModelRequestId; usage: TokenUsage; actualCents: number }
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
  /** The gateway's cost estimate, rounded up to whole cents. */
  actualCents: z.int().nonnegative(),
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
  /** Settles a completed request or releases a failed one. */
  afterResponse(outcome: ModelResponseOutcome): Promise<void>;
}
