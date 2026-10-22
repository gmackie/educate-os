// Prices generative model calls in exact nanodollars (SCHO-134): the AI Gateway log's cost when the
// gateway reports one, else the deployment's rate table merged with the shared Cloudflare price
// book (SCHO-115), else unknown.

import type { AiCallUsage } from "@gadgets/workshop-shared/ai-call-guard";
import {
  normalizeAttempt,
  PRICE_BOOK_CLOUDFLARE_2026_10_20,
  priceUsage as priceFromBook,
  ratesInEffect,
  sameModel,
  usdNanoFromRational,
  usdNanoValue,
  type AiAttempt,
  type ModelRef,
  type PriceBookId,
  type TokenUsage,
  type UsdNano,
} from "@schoolos/ai-governance";
import type { GuardConfig, ModelRate } from "./config.ts";
import type { GatewayLogSource } from "./gateway-logs.ts";

const PER_MILLION = 1_000_000n;

/** The shared price book a model the deployment lists without rates is priced from. */
export const SHARED_PRICE_BOOK = PRICE_BOOK_CLOUDFLARE_2026_10_20;

/** A rate the deployment priced itself. */
type ListedRate = ModelRate & Required<Pick<ModelRate, "priceBookId" | "inputUsdNanoPerMTok" | "outputUsdNanoPerMTok" | "cacheReadUsdNanoPerMTok" | "cacheWriteUsdNanoPerMTok">>;

function isListed(rate: ModelRate): rate is ListedRate {
  return rate.priceBookId !== undefined;
}

/**
 * The configured rate for a model, if it has one the guard can reserve with: either the
 * deployment's own prices, or a model the shared price book prices at `at`.
 */
export function rateFor(config: GuardConfig, model: ModelRef, at: Date = new Date()): ModelRate | undefined {
  const rate = config.modelRates.find((candidate) => sameModel(candidate, model));
  if (rate === undefined || isListed(rate)) return rate;
  return ratesInEffect(SHARED_PRICE_BOOK, model.provider, model.modelId, at).length > 0 ? rate : undefined;
}

/**
 * The most a call can cost before it runs: the rate's assumed prompt at the dearer of the input and
 * cache-write rates, plus the call's response cap (or the rate's default) at the output rate.
 * Rounded up, and never below one nanodollar, since a reservation holds a positive amount. A model
 * priced by the shared book is held at that book's price for the same token counts.
 */
export function estimateMaxUsdNano(rate: ModelRate, maxOutputTokens: number | undefined, at: Date = new Date()): UsdNano {
  const outputTokens = maxOutputTokens ?? rate.defaultMaxOutputTokens;
  let estimate: UsdNano;
  if (isListed(rate)) {
    const promptRate = [rate.inputUsdNanoPerMTok, rate.cacheWriteUsdNanoPerMTok].map(usdNanoValue).reduce((a, b) => (a > b ? a : b));
    const numerator = BigInt(rate.reserveInputTokens) * promptRate + BigInt(outputTokens) * usdNanoValue(rate.outputUsdNanoPerMTok);
    estimate = usdNanoFromRational(numerator, PER_MILLION);
  } else {
    const usage = { inputTokens: rate.reserveInputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const priced = priceFromBook(SHARED_PRICE_BOOK, rate, { usage }, at);
    // rateFor admitted the model because the book prices it; a book that charges a counter tokens
    // cannot supply (neurons) is no basis for a hold.
    if (!priced.ok) throw new Error(`the shared price book cannot price a hold for ${rate.provider}/${rate.modelId}`);
    estimate = priced.usdNano;
  }
  return estimate === "0" ? "1" : estimate;
}

/** What `usage` costs at the deployment's own `rate`, rounded up to a whole nanodollar. */
function priceListed(rate: ListedRate, usage: TokenUsage): UsdNano {
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

/** The one attempt a generative call is settled with, and the price book an estimate came from. */
export interface PricedAttempt {
  /** The attempt. */
  attempt: AiAttempt;
  /** The book an `estimated` cost came from. */
  priceBookId?: PriceBookId;
}

/** What {@link priceSettlement} prices. */
export interface SettlementInput {
  /** The model the call ran. */
  model: ModelRef;
  /** The Workshop's usage, when it reported usable counts. */
  usage: TokenUsage | undefined;
  /** When the call ran, as an ISO instant; it selects the price book rates in effect. */
  at: string;
  /** The call's AI Gateway log, when the Workshop reported one. */
  gatewayLogId?: string;
}

/** Why a gateway log's cost could not be used, for the caller's log. Never the log's content. */
export type GatewayLookup = "found" | "no_cost" | "not_found" | "failed" | "not_configured" | "no_log_id";

/**
 * Prices a call's single attempt, by priority (SCHO-115's `normalizeAttempt`):
 *
 * 1. `provider_reported`: the cost its AI Gateway log reports, when logs are configured and the
 *    log already carries one.
 * 2. `estimated`: the deployment's own rates for the model, else the shared price book's.
 * 3. `unknown`: no usage, or nothing prices it. The ledger charges it at the hold, never $0, and
 *    the nightly reconciliation settles it from the gateway log once one is available.
 *
 * The Workshop's token counts are used throughout, since they split out the prompt cache and the
 * gateway log does not. A gateway that cannot be reached falls back to the estimate.
 */
export async function priceSettlement(
  config: GuardConfig,
  gatewayLogs: GatewayLogSource | null,
  input: SettlementInput,
): Promise<PricedAttempt & { gateway: GatewayLookup }> {
  const ids = { attemptIndex: 0, ...(input.gatewayLogId === undefined ? {} : { gatewayLogId: input.gatewayLogId }) };
  const context = { ...ids, model: input.model, at: input.at };
  const reported = input.usage === undefined ? {} : { usage: input.usage };

  let gateway: GatewayLookup = input.gatewayLogId === undefined ? "no_log_id" : gatewayLogs === null ? "not_configured" : "not_found";
  if (input.gatewayLogId !== undefined && gatewayLogs !== null) {
    try {
      const log = await gatewayLogs.log(input.gatewayLogId);
      if (log !== null) gateway = log.cost === undefined || log.cost === null ? "no_cost" : "found";
      if (log !== null && gateway === "found" && input.usage !== undefined) {
        return { attempt: normalizeAttempt(reported, { ...context, gatewayCostUsd: log.cost }).attempt, gateway };
      }
    } catch {
      gateway = "failed";
    }
  }

  const rate = config.modelRates.find((candidate) => sameModel(candidate, input.model));
  if (input.usage !== undefined && rate !== undefined && isListed(rate)) {
    return { attempt: { ...ids, state: "estimated", usage: input.usage, actualUsdNano: priceListed(rate, input.usage) }, priceBookId: rate.priceBookId, gateway };
  }
  const normalized = normalizeAttempt(reported, { ...context, priceBook: SHARED_PRICE_BOOK });
  return { attempt: normalized.attempt, ...(normalized.priceBookId === undefined ? {} : { priceBookId: normalized.priceBookId }), gateway };
}
