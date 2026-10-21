import { describe, expect, it } from "vitest";
import {
  CLEF_FLASH_MODEL,
  CLEF_MODEL,
  CLEF_OMNI_MODEL,
  definePriceBook,
  findPriceRate,
  normalizeAttempt,
  normalizeGatewayLogUsage,
  normalizeOpenAiStyleUsage,
  normalizePiAiUsage,
  normalizeWorkersAiUsage,
  PRICE_BOOK_CLOUDFLARE_2026_10_20,
  priceUsage,
  usdNanoFromGatewayCost,
  WORKERS_AI_NEURONS_SKU,
  type AttemptContext,
  type ModelRef,
  type PriceBook,
} from "../src/index.ts";
import { AMARA, BIO_FALL, c, harness, SONNET, tokens } from "./setup.ts";

const BOOK = PRICE_BOOK_CLOUDFLARE_2026_10_20;
const AT = "2026-10-20T12:00:00Z";
const CLEF_FLASH: ModelRef = { provider: "cloudflare", modelId: CLEF_FLASH_MODEL };
const LLAMA: ModelRef = { provider: "cloudflare", modelId: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" };
const GPT: ModelRef = { provider: "openai", modelId: "gpt-test" };

/** A deployment-supplied book for a test OpenAI model; these are test prices, not real ones. */
const DEPLOYMENT_BOOK: PriceBook = definePriceBook({
  id: "test-deployment-2026-10",
  reviewedAt: "2026-10-01T00:00:00Z",
  rates: [
    { providerId: "openai", sku: "gpt-test", unit: "input_tokens", numeratorUsdNano: "1000000000", denominator: "1000000", effectiveFrom: "2026-10-01T00:00:00Z", sourceUrl: "https://example.test/contract" },
    { providerId: "openai", sku: "gpt-test", unit: "cached_input_tokens", numeratorUsdNano: "100000000", denominator: "1000000", effectiveFrom: "2026-10-01T00:00:00Z", sourceUrl: "https://example.test/contract" },
    { providerId: "openai", sku: "gpt-test", unit: "output_tokens", numeratorUsdNano: "4000000000", denominator: "1000000", effectiveFrom: "2026-10-01T00:00:00Z", sourceUrl: "https://example.test/contract" },
  ],
});

function context(model: ModelRef, extra: Partial<AttemptContext> = {}): AttemptContext {
  return { attemptIndex: 0, model, at: AT, priceBook: BOOK, ...extra };
}

describe("price book", () => {
  it("ships Cloudflare's 2026-10-20 Workers AI rates with their sources", () => {
    expect(BOOK.id).toBe("cloudflare-2026-10-20");
    const rate = (sku: string, unit: "input_tokens" | "neurons") => findPriceRate(BOOK, "cloudflare", sku, unit, AT);
    expect(rate(CLEF_FLASH_MODEL, "input_tokens")).toMatchObject({ numeratorUsdNano: "38000000", denominator: "1000000" });
    expect(rate(CLEF_MODEL, "input_tokens")).toMatchObject({ numeratorUsdNano: "240000000", denominator: "1000000" });
    expect(rate(CLEF_OMNI_MODEL, "input_tokens")).toMatchObject({ numeratorUsdNano: "150000000", denominator: "1000000" });
    expect(rate(WORKERS_AI_NEURONS_SKU, "neurons")).toMatchObject({ numeratorUsdNano: "11000000", denominator: "1000" });
    expect(findPriceRate(BOOK, "cloudflare", CLEF_FLASH_MODEL, "output_tokens", AT)).toBeUndefined();
    for (const { sourceUrl } of BOOK.rates) expect(sourceUrl).toMatch(/^https:\/\/developers\.cloudflare\.com\//);
  });

  it("is frozen", () => {
    expect(Object.isFrozen(BOOK)).toBe(true);
    expect(Object.isFrozen(BOOK.rates[0])).toBe(true);
    expect(() => (BOOK.rates as unknown as unknown[]).push({})).toThrow();
  });

  it("selects rates by effective date", () => {
    // Clef-flash's cut price took effect on 2026-10-09; the book has no rate before it.
    expect(findPriceRate(BOOK, "cloudflare", CLEF_FLASH_MODEL, "input_tokens", "2026-10-08T23:59:59Z")).toBeUndefined();
    expect(findPriceRate(BOOK, "cloudflare", CLEF_FLASH_MODEL, "input_tokens", "2026-10-09T00:00:00Z")).toBeDefined();
    const revised = definePriceBook({
      id: "revised",
      reviewedAt: "2026-11-01T00:00:00Z",
      rates: [
        { providerId: "cloudflare", sku: "x", unit: "input_tokens", numeratorUsdNano: "1", denominator: "1", effectiveFrom: "2026-10-01T00:00:00Z", effectiveTo: "2026-11-01T00:00:00Z", sourceUrl: "https://example.test/a" },
        { providerId: "cloudflare", sku: "x", unit: "input_tokens", numeratorUsdNano: "2", denominator: "1", effectiveFrom: "2026-11-01T00:00:00Z", sourceUrl: "https://example.test/b" },
      ],
    });
    expect(findPriceRate(revised, "cloudflare", "x", "input_tokens", "2026-10-31T23:59:59Z")?.numeratorUsdNano).toBe("1");
    expect(findPriceRate(revised, "cloudflare", "x", "input_tokens", "2026-11-01T00:00:00Z")?.numeratorUsdNano).toBe("2");
  });

  it("refuses overlapping rates and malformed books", () => {
    const rate = { providerId: "cloudflare" as const, sku: "x", unit: "input_tokens" as const, numeratorUsdNano: "1", denominator: "1", effectiveFrom: "2026-10-01T00:00:00Z", sourceUrl: "https://example.test/a" };
    expect(() => definePriceBook({ id: "dup", reviewedAt: AT, rates: [rate, { ...rate, effectiveFrom: "2026-10-05T00:00:00Z" }] })).toThrow(/overlapping/);
    expect(() => definePriceBook({ id: "bad", reviewedAt: AT, rates: [{ ...rate, denominator: "0" }] })).toThrow();
    expect(() => definePriceBook({ id: "bad", reviewedAt: AT, rates: [{ ...rate, sourceUrl: "http://example.test" }] })).toThrow();
  });

  it("prices exactly and rounds up once per attempt", () => {
    // 1,000 Clef-flash input tokens is one moderation check: $0.000038. Output is free.
    expect(priceUsage(BOOK, CLEF_FLASH, { usage: tokens(1_000, 5) }, AT)).toEqual({ ok: true, usdNano: "38000", priceBookId: BOOK.id });
    expect(priceUsage(BOOK, CLEF_FLASH, { usage: tokens(1, 0) }, AT)).toMatchObject({ usdNano: "38" });
    // A third of a nanodollar per token (a test price) is charged as a whole nanodollar.
    const thirds = definePriceBook({
      id: "thirds",
      reviewedAt: AT,
      rates: (["input_tokens", "output_tokens"] as const).map((unit) => ({
        providerId: "openai" as const, sku: "x", unit, numeratorUsdNano: "1", denominator: "3", effectiveFrom: "2026-10-01T00:00:00Z", sourceUrl: "https://example.test/thirds",
      })),
    });
    const x: ModelRef = { provider: "openai", modelId: "x" };
    expect(priceUsage(thirds, x, { usage: tokens(1, 0) }, AT)).toMatchObject({ usdNano: "1" });
    expect(priceUsage(thirds, x, { usage: tokens(3, 0) }, AT)).toMatchObject({ usdNano: "1" });
    // Rounded once over the sum (2/3 → 1), not once per rate (1 + 1).
    expect(priceUsage(thirds, x, { usage: tokens(1, 1) }, AT)).toMatchObject({ usdNano: "1" });
    // Clef has no cached rate, so cache reads are charged as ordinary input (counted once).
    expect(priceUsage(BOOK, CLEF_FLASH, { usage: tokens(400, 0, 600) }, AT)).toMatchObject({ usdNano: "38000" });
  });

  it("prices other Workers AI models by neurons, and never charges tokens and neurons both", () => {
    expect(priceUsage(BOOK, LLAMA, { usage: tokens(500, 200), neurons: 1_000 }, AT)).toMatchObject({ ok: true, usdNano: "11000000" });
    expect(priceUsage(BOOK, CLEF_FLASH, { usage: tokens(1_000, 0), neurons: 1_000 }, AT)).toMatchObject({ usdNano: "38000" });
    expect(priceUsage(BOOK, LLAMA, { usage: tokens(500, 200) }, AT)).toEqual({ ok: false, issue: "no_rate" });
    expect(priceUsage(BOOK, GPT, { usage: tokens(1, 1) }, AT)).toEqual({ ok: false, issue: "no_rate" });
  });
});

describe("gateway log cost", () => {
  it("reads a decimal string exactly", () => {
    expect(usdNanoFromGatewayCost("0.000038")).toBe("38000");
    expect(usdNanoFromGatewayCost("12")).toBe("12000000000");
    expect(usdNanoFromGatewayCost("0")).toBe("0");
  });

  it("rounds digits past the ninth up", () => {
    expect(usdNanoFromGatewayCost("0.0000380001")).toBe("38001");
    expect(usdNanoFromGatewayCost("0.0000380000")).toBe("38000");
    expect(usdNanoFromGatewayCost("0.0000000000001")).toBe("1");
  });

  it("reads a float as its shortest round-trip decimal, rounding up", () => {
    // What JSON.parse makes of `"cost": 0.000038` converts back to exactly that text.
    expect(usdNanoFromGatewayCost(0.000038)).toBe("38000");
    expect(usdNanoFromGatewayCost(0.1)).toBe("100000000");
    expect(usdNanoFromGatewayCost(1.0000000001)).toBe("1000000001");
    // Exponent forms are expanded: 3.8e-7 dollars is 380 nanodollars, 1e-12 rounds up to one.
    expect(usdNanoFromGatewayCost(3.8e-7)).toBe("380");
    expect(usdNanoFromGatewayCost(1e-12)).toBe("1");
    expect(usdNanoFromGatewayCost(1e-300)).toBe("1");
    expect(usdNanoFromGatewayCost(1e19)).toBe("10000000000000000000000000000");
    expect(usdNanoFromGatewayCost(0)).toBe("0");
  });

  it("refuses negative, non-finite and exponent-form costs", () => {
    for (const bad of [-0.01, Number.NaN, Number.POSITIVE_INFINITY, "-0.01", "1e-5", "abc", ""]) {
      expect(() => usdNanoFromGatewayCost(bad)).toThrow();
    }
  });
});

describe("provider usage normalizers", () => {
  it("normalizes pi-ai usage, whose input already excludes the cache", () => {
    const result = normalizePiAiUsage({ input: 200, output: 50, cacheRead: 800, cacheWrite: 100, cost: { total: 99 } }, context(GPT, { priceBook: DEPLOYMENT_BOOK }));
    // 200 + 100 (write, at the input rate) at $1/M, 800 cached at $0.10/M, 50 out at $4/M.
    expect(result).toEqual({
      attempt: { attemptIndex: 0, state: "estimated", usage: tokens(200, 50, 800, 100), actualUsdNano: "580000" },
      costSource: "price_book",
      priceBookId: "test-deployment-2026-10",
    });
  });

  it("prefers the gateway's cost to the price book", () => {
    const result = normalizePiAiUsage({ input: 1_000, output: 0, cacheRead: 0, cacheWrite: 0 }, context(CLEF_FLASH, { gatewayCostUsd: "0.00004", gatewayLogId: "log-1" }));
    expect(result).toEqual({
      attempt: { attemptIndex: 0, gatewayLogId: "log-1", state: "provider_reported", usage: tokens(1_000, 0), actualUsdNano: "40000" },
      costSource: "gateway_log",
    });
  });

  it("normalizes an AI Gateway log", () => {
    expect(normalizeGatewayLogUsage({ cost: 0.000038, tokens_in: 1_000, tokens_out: 3 }, context(CLEF_FLASH, { gatewayLogId: "log-2" })))
      .toMatchObject({ attempt: { state: "provider_reported", actualUsdNano: "38000", gatewayLogId: "log-2" }, costSource: "gateway_log" });
    // No cost in the log: the book prices its tokens.
    expect(normalizeGatewayLogUsage({ cost: null, tokens_in: 1_000, tokens_out: 3 }, context(CLEF_FLASH)))
      .toMatchObject({ attempt: { state: "estimated", actualUsdNano: "38000" }, costSource: "price_book" });
    // A cost with no token counts cannot be settled as known; it stays a liability for reconciliation.
    expect(normalizeGatewayLogUsage({ cost: "0.01" }, context(CLEF_FLASH, { gatewayLogId: "log-3" })))
      .toEqual({ attempt: { attemptIndex: 0, gatewayLogId: "log-3", state: "unknown" }, costSource: "none", issue: "usage_missing" });
  });

  it("normalizes Workers AI usage and keeps its neurons", () => {
    expect(normalizeWorkersAiUsage({ usage: { input_tokens: 1_000, output_tokens: 2 }, neurons: 3 }, context(CLEF_FLASH)))
      .toEqual({ attempt: { attemptIndex: 0, state: "estimated", usage: tokens(1_000, 2), actualUsdNano: "38000" }, costSource: "price_book", priceBookId: BOOK.id, neurons: 3 });
    // A Clef classification may report input only.
    expect(normalizeWorkersAiUsage({ usage: { input_tokens: 1_000 } }, context(CLEF_FLASH))).toMatchObject({ attempt: { usage: tokens(1_000, 0) } });
    expect(normalizeWorkersAiUsage({ usage: { input_tokens: 500, output_tokens: 300 }, neurons: 2_000 }, context(LLAMA)))
      .toMatchObject({ attempt: { state: "estimated", actualUsdNano: "22000000" }, neurons: 2_000 });
    // Without neurons, a neuron-priced model has no known cost.
    expect(normalizeWorkersAiUsage({ usage: { input_tokens: 500, output_tokens: 300 } }, context(LLAMA)))
      .toMatchObject({ attempt: { state: "unknown", usage: tokens(500, 300) }, issue: "no_rate" });
    expect(normalizeWorkersAiUsage({ neurons: 7 }, context(CLEF_FLASH))).toEqual({ attempt: { attemptIndex: 0, state: "unknown" }, costSource: "none", neurons: 7, issue: "usage_missing" });
    expect(normalizeWorkersAiUsage({ usage: { input_tokens: 1.5 } }, context(CLEF_FLASH))).toMatchObject({ attempt: { state: "unknown" }, issue: "inconsistent_usage" });
  });

  it("subtracts OpenAI-style cached tokens from the prompt total, never double counting", () => {
    const result = normalizeOpenAiStyleUsage({ prompt_tokens: 1_000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } }, context(GPT, { priceBook: DEPLOYMENT_BOOK }));
    expect(result.attempt).toMatchObject({ state: "estimated", usage: tokens(200, 50, 800) });
    // 200 × $1/M + 800 × $0.10/M + 50 × $4/M = 200,000 + 80,000 + 200,000; not 1,000 × $1/M + 800 × $0.10/M.
    expect(result.attempt).toMatchObject({ actualUsdNano: "480000" });
    expect(normalizeOpenAiStyleUsage({ prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: null }, context(GPT, { priceBook: DEPLOYMENT_BOOK })).attempt)
      .toMatchObject({ usage: tokens(10, 1) });
  });

  it("flags cached tokens exceeding the prompt total", () => {
    expect(normalizeOpenAiStyleUsage({ prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 800 } }, context(GPT, { priceBook: DEPLOYMENT_BOOK })))
      .toEqual({ attempt: { attemptIndex: 0, state: "unknown" }, costSource: "none", issue: "inconsistent_usage" });
  });

  it("records missing usage as unknown, with no amount", () => {
    for (const result of [
      normalizePiAiUsage(undefined, context(CLEF_FLASH)),
      normalizeOpenAiStyleUsage(undefined, context(GPT)),
      normalizeWorkersAiUsage({}, context(CLEF_FLASH)),
      normalizeGatewayLogUsage({}, context(CLEF_FLASH)),
    ]) {
      expect(result).toEqual({ attempt: { attemptIndex: 0, state: "unknown" }, costSource: "none", issue: "usage_missing" });
    }
    // Usage but no book and no gateway cost: unknown, keeping the counts.
    expect(normalizeAttempt({ usage: tokens(1, 1) }, { attemptIndex: 2, model: GPT, at: AT }))
      .toEqual({ attempt: { attemptIndex: 2, state: "unknown", usage: tokens(1, 1) }, costSource: "none", issue: "no_rate" });
  });

  it("settles through the ledger, an unknown attempt as a liability", async () => {
    const { ledger } = harness();
    await ledger.reserve("req-norm", AMARA, BIO_FALL, SONNET, c(10));
    const estimated = normalizePiAiUsage({ input: 1_000, output: 0, cacheRead: 0, cacheWrite: 0 }, context(CLEF_FLASH));
    const missing = normalizePiAiUsage(undefined, context(CLEF_FLASH, { attemptIndex: 1 }));
    const result = await ledger.settle("req-norm", { attempts: [estimated.attempt, missing.attempt], priceBookId: estimated.priceBookId });
    // 38,000 for the priced attempt plus the 10¢ hold for the one whose cost never came back.
    expect(result).toMatchObject({ outcome: "settled", settlement: { chargedUsdNano: "100038000", hasUnknownCost: true, priceBookId: BOOK.id } });
  });
});
