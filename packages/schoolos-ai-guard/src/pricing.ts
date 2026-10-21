// Prices generative model calls from the deployment's rate table, in exact nanodollars.

import type { AiCallUsage } from "@gadgets/workshop-shared/ai-call-guard";
import { sameModel, usdNanoFromRational, usdNanoValue, type ModelRef, type TokenUsage, type UsdNano } from "@schoolos/ai-governance";
import type { GuardConfig, ModelRate } from "./config.ts";

const PER_MILLION = 1_000_000n;

/** The configured rate for a model, if it has one. */
export function rateFor(config: GuardConfig, model: ModelRef): ModelRate | undefined {
  return config.modelRates.find((rate) => sameModel(rate, model));
}

/**
 * The most a call can cost before it runs: the rate's assumed prompt at the dearer of the input and
 * cache-write rates, plus the call's response cap (or the rate's default) at the output rate.
 * Rounded up, and never below one nanodollar, since a reservation holds a positive amount.
 */
export function estimateMaxUsdNano(rate: ModelRate, maxOutputTokens: number | undefined): UsdNano {
  const promptRate = [rate.inputUsdNanoPerMTok, rate.cacheWriteUsdNanoPerMTok].map(usdNanoValue).reduce((a, b) => (a > b ? a : b));
  const outputTokens = BigInt(maxOutputTokens ?? rate.defaultMaxOutputTokens);
  const numerator = BigInt(rate.reserveInputTokens) * promptRate + outputTokens * usdNanoValue(rate.outputUsdNanoPerMTok);
  const estimate = usdNanoFromRational(numerator, PER_MILLION);
  return estimate === "0" ? "1" : estimate;
}

/** What `usage` costs at `rate`, rounded up to a whole nanodollar. */
export function priceUsage(rate: ModelRate, usage: TokenUsage): UsdNano {
  const numerator =
    BigInt(usage.inputTokens) * usdNanoValue(rate.inputUsdNanoPerMTok) +
    BigInt(usage.outputTokens) * usdNanoValue(rate.outputUsdNanoPerMTok) +
    BigInt(usage.cacheReadTokens) * usdNanoValue(rate.cacheReadUsdNanoPerMTok) +
    BigInt(usage.cacheWriteTokens) * usdNanoValue(rate.cacheWriteUsdNanoPerMTok);
  return usdNanoFromRational(numerator, PER_MILLION);
}

/**
 * The Workshop's usage as the ledger's {@link TokenUsage}. Both count the prompt disjointly (input
 * excludes cache reads and writes), so this is a rename; a count that is not a non-negative whole
 * number makes the usage untrustworthy, and it is dropped.
 */
export function tokenUsageOf(usage: AiCallUsage): TokenUsage | undefined {
  const counts = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
  if (!counts.every((count) => Number.isSafeInteger(count) && count >= 0)) return undefined;
  return { inputTokens: usage.input, outputTokens: usage.output, cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite };
}
