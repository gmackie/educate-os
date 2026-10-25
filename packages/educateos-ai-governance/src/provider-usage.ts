import { EducateOsError } from "@educateos/contracts";
import { AiAttempt, TokenUsage, normalizeTokenUsage, type ModelRef, type PriceBookId } from "./model.ts";
import { usdNano, usdNanoFromDecimalUsd, usdNanoValue, type UsdNano } from "./money.ts";
import { priceUsage, type PriceBook } from "./price-book.ts";

/**
 * Converts an AI Gateway log's `cost` (US dollars) to nanodollars, rounding up to a whole
 * nanodollar so a fraction of one is charged, never dropped.
 *
 * A decimal string is read exactly, with {@link usdNanoFromDecimalUsd} once any digits past the
 * ninth are rounded up. A JavaScript number (what `JSON.parse` makes of the log API's `cost`) is
 * read as its exact decimal string: the shortest decimal that converts back to the same float
 * (`String(cost)`, with any exponent expanded), which is the text the log sent whenever that had
 * at most 17 significant digits. Its digits past the ninth are rounded up too, so `0.000038` is
 * 38,000 nanodollars and `1.0000000001` is 1,000,000,001. Prefer the string form where the log
 * API offers one. Throws `validation-failed` for a negative, non-finite or non-decimal cost.
 */
export function usdNanoFromGatewayCost(cost: string | number): UsdNano {
  let decimal: string;
  if (typeof cost === "number") {
    if (!Number.isFinite(cost) || cost < 0) throw new EducateOsError("validation-failed", "expected a non-negative gateway cost");
    decimal = expandExponent(String(cost));
  } else {
    decimal = cost.trim();
  }
  const match = /^(\d{1,20})(?:\.(\d+))?$/.exec(decimal);
  if (match === null) throw new EducateOsError("validation-failed", "expected a decimal gateway cost in US dollars");
  const fraction = match[2] ?? "";
  const truncated = usdNanoFromDecimalUsd(fraction.length > 9 ? `${match[1]}.${fraction.slice(0, 9)}` : decimal);
  const roundsUp = /[1-9]/.test(fraction.slice(9));
  return roundsUp ? usdNano(usdNanoValue(truncated) + 1n) : truncated;
}

/** `"3.8e-7"` as `"0.00000038"` and `"1e+21"` as `"1000000000000000000000"`; plain decimals as given. */
function expandExponent(text: string): string {
  const match = /^(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (match === null) return text;
  const digits = `${match[1]}${match[2] ?? ""}`;
  const point = match[1]!.length + Number(match[3]);
  if (point <= 0) return `0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return digits + "0".repeat(point - digits.length);
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

/** Where a normalized attempt's cost came from. */
export type AttemptCostSource = "gateway_log" | "price_book" | "none";

/**
 * Why a normalized attempt's cost is unknown: the provider reported no usage, reported usage that
 * contradicts itself (cached tokens exceeding the prompt total, say), or the price book has no
 * rate for the model, or charges a counter the provider did not report.
 */
export type AttemptUsageIssue = "usage_missing" | "inconsistent_usage" | "no_rate" | "missing_units";

/** What every normalizer needs to know about the attempt besides the provider's usage. */
export interface AttemptContext {
  /** The attempt's position within its request, from 0. */
  attemptIndex: number;
  /** The model the attempt ran. */
  model: ModelRef;
  /** When the attempt ran, as an ISO instant. It selects the price book rates in effect. */
  at: string;
  /** The book to estimate a cost from when no gateway cost is known. */
  priceBook?: PriceBook;
  /**
   * The cost the attempt's AI Gateway log reports, in US dollars, when there is one. It wins over
   * a price book estimate, since it is what the provider was billed through the gateway.
   */
  gatewayCostUsd?: string | number | null;
  /** The provider's ID for the attempt. */
  providerRequestId?: string;
  /** The AI Gateway log ID for the attempt. */
  gatewayLogId?: string;
}

/**
 * One provider attempt in the form the ledger settles ({@link AiAttempt}), with where its cost came
 * from. The neurons ride alongside rather than in the attempt, since the ledger charges money and
 * the Cloudflare account allocator is what applies the account's daily free neurons.
 */
export interface NormalizedAttempt {
  /** The attempt, ready for `AiLedger.settle`. */
  attempt: AiAttempt;
  /** `gateway_log` for a `provider_reported` attempt, `price_book` for `estimated`, else `none`. */
  costSource: AttemptCostSource;
  /** The book an `estimated` cost came from; settle with it as the settlement's `priceBookId`. */
  priceBookId?: PriceBookId;
  /** Workers AI neurons, when reported. */
  neurons?: number;
  /** Why the cost is unknown, for an `unknown` attempt. */
  issue?: AttemptUsageIssue;
}

/**
 * Builds the attempt for some already-normalized usage, choosing its cost by priority: the AI
 * Gateway log's cost, then the price book's rates applied to the usage, then unknown. An attempt
 * with no usage is `unknown` even when the gateway reported a cost, because the ledger records a
 * known cost only with the usage behind it; its gateway log ID lets reconciliation settle it.
 * An unknown attempt is charged at the request's hold, never at $0.
 */
export function normalizeAttempt(
  reported: { usage?: TokenUsage; neurons?: number; issue?: "usage_missing" | "inconsistent_usage" },
  context: AttemptContext,
): NormalizedAttempt {
  const ids = {
    attemptIndex: context.attemptIndex,
    ...(context.providerRequestId === undefined ? {} : { providerRequestId: context.providerRequestId }),
    ...(context.gatewayLogId === undefined ? {} : { gatewayLogId: context.gatewayLogId }),
  };
  const neurons = reported.neurons === undefined ? {} : { neurons: reported.neurons };
  const unknown = (issue: AttemptUsageIssue): NormalizedAttempt => ({
    attempt: AiAttempt.parse({ ...ids, state: "unknown", ...(reported.usage === undefined ? {} : { usage: reported.usage }) }),
    costSource: "none",
    ...neurons,
    issue,
  });
  const { usage } = reported;
  if (usage === undefined) return unknown(reported.issue ?? "usage_missing");
  if (context.gatewayCostUsd !== undefined && context.gatewayCostUsd !== null) {
    const actualUsdNano = usdNanoFromGatewayCost(context.gatewayCostUsd);
    return { attempt: AiAttempt.parse({ ...ids, state: "provider_reported", usage, actualUsdNano }), costSource: "gateway_log", ...neurons };
  }
  if (context.priceBook === undefined) return unknown("no_rate");
  const priced = priceUsage(context.priceBook, context.model, { usage, ...neurons }, context.at);
  if (!priced.ok) return unknown(priced.issue);
  return {
    attempt: AiAttempt.parse({ ...ids, state: "estimated", usage, actualUsdNano: priced.usdNano }),
    costSource: "price_book",
    priceBookId: priced.priceBookId,
    ...neurons,
  };
}

/**
 * Token usage as pi-ai's `AssistantMessage.usage` reports it, and as the kernel's AI call guard
 * passes it on (`AiCallOutcome.usage`): `input` excludes the cache, and `cacheRead` and
 * `cacheWrite` are counted separately. Restated structurally, since EducateOS imports nothing from
 * the kernel (ADR-0002).
 */
export interface PiAiUsage {
  /** Prompt tokens neither read from nor written to the cache. */
  input: number;
  /** Response tokens, reasoning included. */
  output: number;
  /** Prompt tokens read from the cache. */
  cacheRead: number;
  /** Prompt tokens written to the cache. */
  cacheWrite: number;
  /**
   * pi-ai's own cost estimate, in float dollars from its built-in model table. It is never charged:
   * it is not pinned to a reviewed price book and is not what the provider billed.
   */
  cost?: unknown;
}

/** Normalizes pi-ai usage, or its absence, into an attempt. */
export function normalizePiAiUsage(usage: PiAiUsage | undefined, context: AttemptContext): NormalizedAttempt {
  if (usage === undefined) return normalizeAttempt({}, context);
  return normalizeAttempt(tokenUsage({ inputTokens: usage.input, outputTokens: usage.output, cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite }), context);
}

/**
 * The cost and token fields of an AI Gateway log (the gateway logs API). `cost` is US dollars, as
 * a number or a decimal string. The log does not split cached tokens out of `tokens_in`, so a
 * price book estimate from it charges every input token at the uncached rate: never double
 * counted, at worst overstated, and only when the log reports no cost.
 */
export interface AiGatewayLogUsage {
  /** What the gateway says the request cost, in US dollars. */
  cost?: string | number | null;
  /** Input tokens. */
  tokens_in?: number | null;
  /** Output tokens. */
  tokens_out?: number | null;
}

/**
 * Normalizes an AI Gateway log into an attempt whose cost is the log's (`provider_reported`),
 * falling back to the context's price book when the log has none.
 */
export function normalizeGatewayLogUsage(log: AiGatewayLogUsage, context: AttemptContext): NormalizedAttempt {
  const withCost = { ...context, gatewayCostUsd: log.cost ?? context.gatewayCostUsd };
  if (log.tokens_in === undefined || log.tokens_in === null || log.tokens_out === undefined || log.tokens_out === null) {
    return normalizeAttempt({}, withCost);
  }
  return normalizeAttempt(tokenUsage({ inputTokens: log.tokens_in, outputTokens: log.tokens_out, cacheReadTokens: 0, cacheWriteTokens: 0 }), withCost);
}

/**
 * A Workers AI response's usage: `usage.input_tokens` and `usage.output_tokens`, with no prompt
 * cache, and the neurons the call consumed when the caller knows them.
 */
export interface WorkersAiUsage {
  /** Token counts, when the model reports them. */
  usage?: { input_tokens?: number | null; output_tokens?: number | null } | null;
  /** Neurons the call consumed. */
  neurons?: number | null;
}

/**
 * Normalizes a Workers AI response into an attempt. A model the price book prices by tokens (Clef)
 * is charged for tokens alone, with the neurons kept for the account allocator; any other Workers
 * AI model is charged for its neurons. A model that reports no output count is treated as having
 * no output, since Clef classifications report input only.
 */
export function normalizeWorkersAiUsage(response: WorkersAiUsage, context: AttemptContext): NormalizedAttempt {
  const neurons = response.neurons ?? undefined;
  if (neurons !== undefined && !(Number.isSafeInteger(neurons) && neurons >= 0)) return normalizeAttempt({ issue: "inconsistent_usage" }, context);
  const reported = neurons === undefined ? {} : { neurons };
  const input = response.usage?.input_tokens;
  if (input === undefined || input === null) return normalizeAttempt({ ...reported }, context);
  const usage = tokenUsage({ inputTokens: input, outputTokens: response.usage?.output_tokens ?? 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  return normalizeAttempt({ ...usage, ...reported }, context);
}

/**
 * OpenAI-style usage (OpenAI, and OpenAI-compatible APIs), in which `prompt_tokens` INCLUDES the
 * cached tokens reported in `prompt_tokens_details.cached_tokens`.
 */
export interface OpenAiStyleUsage {
  /** Every prompt token, cached ones included. */
  prompt_tokens: number;
  /** Response tokens, reasoning included. */
  completion_tokens: number;
  /** The cached part of `prompt_tokens`. */
  prompt_tokens_details?: { cached_tokens?: number | null } | null;
}

/**
 * Normalizes OpenAI-style usage into an attempt, subtracting the cached tokens from the prompt
 * total so they are counted (and priced) once, as cache reads. A cached count larger than the
 * prompt total is contradictory: the attempt is flagged `inconsistent_usage` and its cost is
 * unknown, so it is held as a liability rather than priced from numbers that cannot both be true.
 */
export function normalizeOpenAiStyleUsage(usage: OpenAiStyleUsage | undefined, context: AttemptContext): NormalizedAttempt {
  if (usage === undefined) return normalizeAttempt({}, context);
  try {
    const normalized = normalizeTokenUsage({
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      cacheReadTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
      inputIncludesCache: true,
    });
    return normalizeAttempt({ usage: normalized }, context);
  } catch (error) {
    if (error instanceof EducateOsError) return normalizeAttempt({ issue: "inconsistent_usage" }, context);
    throw error;
  }
}

/** Reported counts as a {@link TokenUsage}, or the inconsistent-usage flag if any is invalid. */
function tokenUsage(counts: TokenUsage): { usage: TokenUsage } | { issue: "inconsistent_usage" } {
  const parsed = TokenUsage.safeParse(counts);
  return parsed.success ? { usage: parsed.data } : { issue: "inconsistent_usage" };
}
