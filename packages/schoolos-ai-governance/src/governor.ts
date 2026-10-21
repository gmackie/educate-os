import { z } from "zod";
import { SchoolOsError, type SchoolOsErrorBody } from "@schoolos/contracts";
import { AiRequestId, AiWorkspaceContext, Cents, ModelRef, TokenUsage, denialErrorCode, type AiDenialReason } from "./model.ts";
import { AiPrincipal, type AiLedger, type SettleResult, type VoidResult } from "./ledger.ts";
import type { ReservationEntry } from "./entries.ts";

/**
 * What the gateway seam knows before a model request: identifiers, the model and an upper bound on
 * its cost. There is deliberately no field for the prompt, and strict parsing rejects one, so the
 * seam cannot hand content to governance even by mistake.
 */
export const GovernedAiRequest = z.strictObject({
  /** Chosen by the seam and reused on every retry of the same request. */
  requestId: AiRequestId,
  principal: AiPrincipal,
  workspace: AiWorkspaceContext,
  model: ModelRef,
  /** The most the request can cost, from its input size and output token limit. */
  estimatedMaxCents: Cents.positive(),
});
/** A governed AI request. */
export type GovernedAiRequest = z.infer<typeof GovernedAiRequest>;

/** How a model request ended, as the gateway seam reports it. */
export const AiResponseOutcome = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("completed"),
    requestId: AiRequestId,
    usage: TokenUsage,
    /** The gateway's cost estimate for the response, rounded up to whole cents. */
    actualCents: Cents,
  }),
  /** The provider returned an error or the request was abandoned before any response. */
  z.strictObject({ status: z.literal("failed"), requestId: AiRequestId }),
]);
/** A response outcome. */
export type AiResponseOutcome = z.infer<typeof AiResponseOutcome>;

/** Whether a model request may go ahead. */
export type GovernorDecision =
  | { effect: "allow"; reservation: ReservationEntry }
  | {
    effect: "deny";
    /** For audit and administrators. */
    reason: AiDenialReason;
    /** What the requester is shown. It never names the reason. */
    error: SchoolOsErrorBody;
  };

/**
 * The hook a kernel AI Gateway seam calls around every model request. `beforeRequest` must be
 * called, and must allow, before the request is sent; `afterResponse` must be called once it ends,
 * whether it succeeded or failed. Both may be retried with the same request ID.
 */
export interface AiRequestGovernor {
  /** Holds funds for the request, or refuses it before any spend. Accepts unvalidated input. */
  beforeRequest(request: unknown): Promise<GovernorDecision>;
  /** Settles a completed request or releases a failed one. Accepts unvalidated input. */
  afterResponse(outcome: unknown): Promise<SettleResult | VoidResult>;
}

const DENIAL_MESSAGES: Record<ReturnType<typeof denialErrorCode>, string> = {
  "forbidden": "This AI request is not available here.",
  "policy-violation": "This AI model is not available under your district's policy.",
  "budget-exceeded": "The AI budget for this work has been used up.",
  "conflict": "This AI request has already completed.",
};

function deny(reason: AiDenialReason): GovernorDecision {
  const code = denialErrorCode(reason);
  return { effect: "deny", reason, error: new SchoolOsError(code, DENIAL_MESSAGES[code]).toBody() };
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new SchoolOsError("validation-failed", "malformed AI governance call");
  return result.data;
}

/**
 * The {@link AiRequestGovernor} backed by an {@link AiLedger}. A retry of a request that is still
 * held is allowed again with the same reservation, so it is billed once; a retry of a request
 * that already settled or was voided is refused, so it is not sent to the provider twice.
 */
export function ledgerGovernor(ledger: AiLedger): AiRequestGovernor {
  return {
    async beforeRequest(raw) {
      const request = parseOrThrow(GovernedAiRequest, raw);
      const result = await ledger.reserve(request.requestId, request.principal, request.workspace, request.model, request.estimatedMaxCents);
      if (result.outcome === "denied") return deny(result.reason);
      if (result.status !== "held") return deny("request-already-completed");
      return { effect: "allow", reservation: result.reservation };
    },
    async afterResponse(raw) {
      const outcome = parseOrThrow(AiResponseOutcome, raw);
      return outcome.status === "completed"
        ? ledger.settle(outcome.requestId, outcome.usage, outcome.actualCents)
        : ledger.void(outcome.requestId);
    },
  };
}
