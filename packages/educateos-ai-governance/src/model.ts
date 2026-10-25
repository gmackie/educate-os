import { z } from "zod";
import { OfferingId, EducateOsError } from "@educateos/contracts";
import { UsdNano } from "./money.ts";

/**
 * The AI providers a district can route through AI Gateway. This mirrors the Workshop's
 * `AiModelProvider`; it is restated here because EducateOS packages import nothing from the kernel
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

/**
 * What a request's spend is for. `generative` requests (an assistant, feedback) are the default and
 * are funded by course and personal pools, within each principal's cap. `safety` requests (content
 * moderation, say) are organizational: they draw only on the district's safety pool, never on a
 * principal's cap, so a student who has spent their AI budget is still protected. A generative
 * request never draws on a safety pool, so ordinary use cannot starve moderation.
 */
export const FundingPurpose = z.enum(["generative", "safety"]);
/** A funding purpose. */
export type FundingPurpose = z.infer<typeof FundingPurpose>;

/**
 * Token counts for one model response, with no token counted twice: `inputTokens` is uncached
 * input only, and the tokens read from or written to the provider's prompt cache are counted
 * separately in `cacheReadTokens` and `cacheWriteTokens`. Providers that report an input total
 * which already includes cached tokens must go through {@link normalizeTokenUsage} first.
 */
export const TokenUsage = z.strictObject({
  /** Input tokens neither read from nor written to the prompt cache. */
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  /** Input tokens served from the prompt cache. Not included in `inputTokens`. */
  cacheReadTokens: z.int().nonnegative(),
  /** Input tokens written to the prompt cache. Not included in `inputTokens`. */
  cacheWriteTokens: z.int().nonnegative(),
});
/** Token usage. */
export type TokenUsage = z.infer<typeof TokenUsage>;

/**
 * Token counts as a provider reports them. `inputIncludesCache` says whether `inputTokens` is a
 * total that already contains the cached tokens (OpenAI's `prompt_tokens`, Google's
 * `promptTokenCount`) or excludes them (Anthropic's `input_tokens`).
 */
export interface ReportedTokenUsage {
  /** The provider's input count. */
  inputTokens: number;
  /** Output tokens. */
  outputTokens: number;
  /** Cache-read tokens, when reported. */
  cacheReadTokens?: number;
  /** Cache-write tokens, when reported. */
  cacheWriteTokens?: number;
  /** Whether `inputTokens` already includes the cache reads and writes. */
  inputIncludesCache: boolean;
}

/**
 * Converts reported token counts to a {@link TokenUsage} whose `inputTokens` excludes cached
 * tokens, so cache reads are never counted (or priced) twice. Throws `validation-failed` when an
 * inclusive total is smaller than its own cached part, or when any count is not a whole number.
 */
export function normalizeTokenUsage(reported: ReportedTokenUsage): TokenUsage {
  const cacheReadTokens = reported.cacheReadTokens ?? 0;
  const cacheWriteTokens = reported.cacheWriteTokens ?? 0;
  const inputTokens = reported.inputIncludesCache
    ? reported.inputTokens - cacheReadTokens - cacheWriteTokens
    : reported.inputTokens;
  const usage = TokenUsage.safeParse({ inputTokens, outputTokens: reported.outputTokens, cacheReadTokens, cacheWriteTokens });
  if (!usage.success) throw new EducateOsError("validation-failed", "inconsistent token usage");
  return usage.data;
}

/** The sum of some token usages. */
export function addTokenUsage(usages: Iterable<TokenUsage>): TokenUsage {
  const total: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const usage of usages) {
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.cacheReadTokens += usage.cacheReadTokens;
    total.cacheWriteTokens += usage.cacheWriteTokens;
  }
  return total;
}

/**
 * Names the price book a cost was computed from (a provider's published rates, or a district's
 * negotiated ones, at some version), so a charge can be audited against the rates that made it.
 */
export const PriceBookId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/, "expected a price book ID");
/** A price book identifier. */
export type PriceBookId = z.infer<typeof PriceBookId>;

/**
 * How an attempt's cost is known: reported by the provider, estimated by the gateway from token
 * counts and a price book, or not known at all (the attempt ran but no usage or cost came back).
 */
export const AttemptCostState = z.enum(["provider_reported", "estimated", "unknown"]);
/** An attempt cost state. */
export type AttemptCostState = z.infer<typeof AttemptCostState>;

const attemptIdentifiers = {
  /** The attempt's position within its request, from 0. Unique per request. */
  attemptIndex: z.int().nonnegative().max(1000),
  /** The provider's ID for the attempt, when it returned one. */
  providerRequestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/).optional(),
  /** The AI Gateway log ID for the attempt, when there is one. */
  gatewayLogId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/).optional(),
};

/**
 * One provider call made for a request. A request holds one reservation, but a retry after a
 * timeout or a provider error is a second call the provider may bill, so each is recorded.
 *
 * An attempt whose cost is `unknown` carries no amount; the ledger charges it at the request's
 * reserved maximum (a liability, never $0) until reconciliation settles what was billed.
 */
export const AiAttempt = z.discriminatedUnion("state", [
  z.strictObject({
    ...attemptIdentifiers,
    state: z.enum(["provider_reported", "estimated"]),
    usage: TokenUsage,
    /** What the attempt cost. */
    actualUsdNano: UsdNano,
  }),
  z.strictObject({
    ...attemptIdentifiers,
    state: z.literal("unknown"),
    /** Token counts, when they came back without a cost. */
    usage: TokenUsage.optional(),
  }),
]);
/** One attempt of a request. */
export type AiAttempt = z.infer<typeof AiAttempt>;

/** A request's attempts, in index order, with no index repeated. */
export const AiAttempts = z.array(AiAttempt).min(1).max(100).superRefine((attempts, ctx) => {
  for (const [index, attempt] of attempts.entries()) {
    if (index > 0 && attempt.attemptIndex <= attempts[index - 1]!.attemptIndex) {
      ctx.addIssue({ code: "custom", message: "attempts must be in increasing attemptIndex order", path: [index, "attemptIndex"] });
    }
  }
});

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
  /**
   * The safety pool cannot fund a safety request. The caller should not fall back to unmoderated
   * generative AI: it should block generative AI for the request and offer a path without AI.
   */
  "safety-budget-exhausted",
  "request-already-completed",
]);
/** A denial reason. */
export type AiDenialReason = z.infer<typeof AiDenialReason>;

/** The EducateOS error code a denial is reported to the caller with. */
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
    case "safety-budget-exhausted":
      return "budget-exceeded";
    case "request-already-completed":
      return "conflict";
  }
}
