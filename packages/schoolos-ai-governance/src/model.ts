import { z } from "zod";
import { OfferingId } from "@schoolos/contracts";

/**
 * The AI providers a district can route through AI Gateway. This mirrors the Workshop's
 * `AiModelProvider`; it is restated here because SchoolOS packages import nothing from the kernel
 * (ADR-0002), and the kernel seam that feeds this package maps one onto the other.
 */
export const AiProvider = z.enum(["openai", "anthropic", "google", "cloudflare", "ollama"]);
/** An AI provider. */
export type AiProvider = z.infer<typeof AiProvider>;

/** Names one model: its provider and its ID on that provider's API. */
export const ModelRef = z.strictObject({
  provider: AiProvider,
  modelId: z.string().min(1).max(200),
});
/** A model reference. */
export type ModelRef = z.infer<typeof ModelRef>;

/** Whether two references name the same model. */
export function sameModel(a: ModelRef, b: ModelRef): boolean {
  return a.provider === b.provider && a.modelId === b.modelId;
}

/** A stable string key for a model, used to group reports. */
export function modelKey(model: ModelRef): string {
  return `${model.provider}/${model.modelId}`;
}

/**
 * How the district's gateway offers a model, as in the Workshop's `GatewayModelMode`: `hidden`
 * models still run (they are only left out of pickers), and `disabled` models never run.
 */
export const GovernedModelMode = z.enum(["enabled", "hidden", "disabled"]);
/** A governed model mode. */
export type GovernedModelMode = z.infer<typeof GovernedModelMode>;

/** One model in the district's gateway catalog. */
export const GovernedModel = z.strictObject({
  ...ModelRef.shape,
  mode: GovernedModelMode,
});
/** A governed model. */
export type GovernedModel = z.infer<typeof GovernedModel>;

/**
 * Identifies one model request. The gateway seam chooses it and reuses it on every retry, which is
 * what makes reservation and settlement idempotent. The character set is narrow so that no prompt
 * text can be smuggled into the ledger through it.
 */
export const AiRequestId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, "expected an opaque request ID");
/** An AI request identifier. */
export type AiRequestId = z.infer<typeof AiRequestId>;

/**
 * The workspace a request was made from. A course workspace is billed to course funding for its
 * offering; a personal workspace draws only on the district personal pool. The record keeps the
 * offering, never the workspace's contents.
 */
export const AiWorkspaceContext = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("course"), offeringId: OfferingId }),
  z.strictObject({ kind: z.literal("personal") }),
]);
/** A request's workspace context. */
export type AiWorkspaceContext = z.infer<typeof AiWorkspaceContext>;

/** Token counts reported for one model response. */
export const TokenUsage = z.strictObject({
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  cacheReadTokens: z.int().nonnegative(),
  cacheWriteTokens: z.int().nonnegative(),
});
/** Token usage. */
export type TokenUsage = z.infer<typeof TokenUsage>;

/** A non-negative amount of US cents. The ledger holds and charges whole cents only. */
export const Cents = z.int().nonnegative();

/**
 * Why a request was refused before any spend. These go to the gateway seam and to audit; the
 * requester sees only the {@link denialErrorCode} and a generic message.
 */
export const AiDenialReason = z.enum([
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
/** A denial reason. */
export type AiDenialReason = z.infer<typeof AiDenialReason>;

/** The SchoolOS error code a denial is reported to the caller with. */
export function denialErrorCode(reason: AiDenialReason): "forbidden" | "policy-violation" | "budget-exceeded" | "conflict" {
  switch (reason) {
    case "cross-district":
    case "unknown-principal":
    case "unknown-offering":
    case "not-enrolled":
      return "forbidden";
    case "term-closed":
    case "ai-spending-disabled":
    case "model-unknown":
    case "model-disabled":
    case "model-not-allowed":
      return "policy-violation";
    case "no-funding-pool":
    case "principal-cap-reached":
    case "pool-exhausted":
      return "budget-exceeded";
    case "request-already-completed":
      return "conflict";
  }
}
