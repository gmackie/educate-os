import { z } from "zod";
import { EducateOsError } from "@educateos/contracts";
import { AiProvider, PriceBookId, type ModelRef, type TokenUsage } from "./model.ts";
import { UsdNano, usdNanoFromRational } from "./money.ts";

/**
 * The usage counter a rate charges for. The token units follow {@link TokenUsage}, in which no
 * token is counted twice: `input_tokens` charges uncached input, `cached_input_tokens` charges
 * cache reads and `cache_write_tokens` charges cache writes. `requests` charges each attempt once.
 */
export const PriceRateUnit = z.enum([
  "input_tokens",
  "cached_input_tokens",
  "cache_write_tokens",
  "output_tokens",
  "neurons",
  "requests",
]);
/** A price rate unit. */
export type PriceRateUnit = z.infer<typeof PriceRateUnit>;

/**
 * One list or contracted price: `numeratorUsdNano` nanodollars per `denominator` units of `unit`,
 * for one provider SKU, in effect from `effectiveFrom` until (not including) `effectiveTo`. The
 * rate is a ratio so that prices such as $0.038 per million tokens are exact; the cost of an
 * attempt is rounded up to a whole nanodollar once, after every rate is applied.
 *
 * These are the same rate semantics as Hall Monitor's costing price book, restated here because
 * this package depends on no Hall Monitor package.
 */
export const PriceRate = z.strictObject({
  providerId: AiProvider,
  /** The billable SKU. For a model it is the model's ID on the provider's API. */
  sku: z.string().min(1).max(200),
  unit: PriceRateUnit,
  numeratorUsdNano: UsdNano,
  /** A positive decimal integer string. */
  denominator: z.string().regex(/^[1-9]\d{0,29}$/, "expected a positive integer"),
  effectiveFrom: z.iso.datetime(),
  effectiveTo: z.iso.datetime().optional(),
  /** Where the price was published, or the contract it comes from. */
  sourceUrl: z.url({ protocol: /^https$/ }),
}).refine((rate) => rate.effectiveTo === undefined || Date.parse(rate.effectiveTo) > Date.parse(rate.effectiveFrom), {
  message: "effectiveTo must be after effectiveFrom",
  path: ["effectiveTo"],
});
/** A price rate. */
export type PriceRate = z.infer<typeof PriceRate>;

/**
 * A reviewed, immutable snapshot of prices. Historical rates never change once used: a new price
 * is a new rate (with its own effective dates) in a new book, so every charge can be recomputed
 * from the book ID it records.
 */
export const PriceBook = z.strictObject({
  id: PriceBookId,
  /** When the prices were last checked against their sources. */
  reviewedAt: z.iso.datetime(),
  rates: z.array(PriceRate).min(1),
});
/** A price book. */
export type PriceBook = z.infer<typeof PriceBook>;

/**
 * Validates a price book and freezes it deeply. Throws `validation-failed` when it is malformed or
 * when two rates for the same provider, SKU and unit are in effect at the same time, so a lookup
 * never has to choose between rates.
 */
export function definePriceBook(input: z.input<typeof PriceBook>): Readonly<PriceBook> {
  const parsed = PriceBook.safeParse(input);
  if (!parsed.success) throw new EducateOsError("validation-failed", `price book: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  const book = parsed.data;
  for (const [index, rate] of book.rates.entries()) {
    const overlapping = book.rates.slice(index + 1).find((other) =>
      other.providerId === rate.providerId && other.sku === rate.sku && other.unit === rate.unit && overlaps(rate, other));
    if (overlapping !== undefined) {
      throw new EducateOsError("validation-failed", `price book ${book.id} has overlapping ${rate.unit} rates for ${rate.providerId}/${rate.sku}`);
    }
  }
  return deepFreeze(book);
}

/** The rates in `book` for one provider SKU that are in effect at the instant `at`. */
export function ratesInEffect(book: PriceBook, providerId: AiProvider, sku: string, at: string | Date): PriceRate[] {
  const time = instant(at);
  return book.rates.filter((rate) => rate.providerId === providerId && rate.sku === sku && inEffect(rate, time));
}

/** The one rate in `book` for a provider SKU and unit in effect at `at`, if there is one. */
export function findPriceRate(book: PriceBook, providerId: AiProvider, sku: string, unit: PriceRateUnit, at: string | Date): PriceRate | undefined {
  return ratesInEffect(book, providerId, sku, at).find((rate) => rate.unit === unit);
}

/** Provider usage to price: token counts with no token counted twice, and Workers AI neurons. */
export interface PriceableUsage {
  /** Token counts, when the provider reported them. */
  usage?: TokenUsage;
  /** Workers AI neurons, when the provider reported or estimated them. */
  neurons?: number;
}

/**
 * The outcome of pricing one attempt: its cost and the book it came from, or why it has none.
 * `no_rate` means the book has no rate for the model at that time; `missing_units` means the book
 * charges a counter the provider did not report. Either way the attempt's cost is unknown, never $0.
 */
export type PricedUsage =
  | { ok: true; usdNano: UsdNano; priceBookId: PriceBookId }
  | { ok: false; issue: "no_rate" | "missing_units" };

/**
 * Prices one attempt of `model` at the rates in effect at `at`, summing every rate exactly and then
 * rounding up once to a whole nanodollar.
 *
 * The model's own rates are used when the book has any. A SKU with no `cached_input_tokens` or
 * `cache_write_tokens` rate charges those tokens at its `input_tokens` rate, and a SKU with no
 * `output_tokens` rate (Clef) charges nothing for output. A Workers AI model with no rates of its
 * own is priced by its neurons at the {@link WORKERS_AI_NEURONS_SKU} rate. Token prices and neuron
 * prices are two displays of the same Workers AI usage, so an attempt is never charged both.
 */
export function priceUsage(book: PriceBook, model: ModelRef, usage: PriceableUsage, at: string | Date): PricedUsage {
  let rates = ratesInEffect(book, model.provider, model.modelId, at);
  if (rates.length === 0 && model.provider === "cloudflare" && usage.neurons !== undefined) {
    rates = ratesInEffect(book, "cloudflare", WORKERS_AI_NEURONS_SKU, at);
  }
  if (rates.length === 0) return { ok: false, issue: "no_rate" };
  const units = new Set(rates.map((rate) => rate.unit));
  const quantities = new Map<PriceRateUnit, bigint>();
  if (units.has("input_tokens") || units.has("cached_input_tokens") || units.has("cache_write_tokens") || units.has("output_tokens")) {
    const tokens = usage.usage;
    if (tokens === undefined) return { ok: false, issue: "missing_units" };
    const cacheRead = BigInt(tokens.cacheReadTokens);
    const cacheWrite = BigInt(tokens.cacheWriteTokens);
    quantities.set("input_tokens", BigInt(tokens.inputTokens)
      + (units.has("cached_input_tokens") ? 0n : cacheRead)
      + (units.has("cache_write_tokens") ? 0n : cacheWrite));
    quantities.set("cached_input_tokens", cacheRead);
    quantities.set("cache_write_tokens", cacheWrite);
    quantities.set("output_tokens", BigInt(tokens.outputTokens));
  }
  if (units.has("neurons")) {
    if (usage.neurons === undefined) return { ok: false, issue: "missing_units" };
    quantities.set("neurons", BigInt(usage.neurons));
  }
  quantities.set("requests", 1n);
  const denominator = rates.reduce((acc, rate) => lcm(acc, BigInt(rate.denominator)), 1n);
  let numerator = 0n;
  for (const rate of rates) {
    numerator += quantities.get(rate.unit)! * BigInt(rate.numeratorUsdNano) * (denominator / BigInt(rate.denominator));
  }
  return { ok: true, usdNano: usdNanoFromRational(numerator, denominator), priceBookId: book.id };
}

/** Clef-flash, Hall Monitor's default typed decision model on Workers AI. */
export const CLEF_FLASH_MODEL = "@cf/cloudflare/clef-flash";
/** Clef, Hall Monitor's escalation decision model on Workers AI. */
export const CLEF_MODEL = "@cf/cloudflare/clef";
/** Clef-omni, Hall Monitor's multimodal decision model on Workers AI. */
export const CLEF_OMNI_MODEL = "@cf/cloudflare/clef-omni";
/** The SKU of Workers AI usage billed in neurons rather than in per-model token prices. */
export const WORKERS_AI_NEURONS_SKU = "workers-ai-neurons";

const WORKERS_AI_PRICING = "https://developers.cloudflare.com/workers-ai/platform/pricing/";

/**
 * Cloudflare's published Workers AI prices, reviewed on 2026-10-20 (Hall Monitor source plan 03,
 * §1). The Clef models charge input tokens only: they have no output rate, so output is free by
 * omission rather than by a zero rate. Neurons are priced at gross list rate; the account-wide
 * daily free neuron allowance is applied per account and day by the account allocator, never here.
 *
 * Other providers' and models' prices are not in this book. They depend on the deployment's
 * contracts and model menu, so a deployment supplies its own book (with its own ID and sources)
 * for them; this package invents no prices.
 */
export const PRICE_BOOK_CLOUDFLARE_2026_10_20: Readonly<PriceBook> = definePriceBook({
  id: "cloudflare-2026-10-20",
  reviewedAt: "2026-10-20T00:00:00Z",
  rates: [
    {
      providerId: "cloudflare",
      sku: CLEF_FLASH_MODEL,
      unit: "input_tokens",
      // $0.038 per million input tokens, since the 2026-10-09 price cut.
      numeratorUsdNano: "38000000",
      denominator: "1000000",
      effectiveFrom: "2026-10-09T00:00:00Z",
      sourceUrl: "https://developers.cloudflare.com/workers-ai/models/clef-flash/",
    },
    {
      providerId: "cloudflare",
      sku: CLEF_MODEL,
      unit: "input_tokens",
      // $0.240 per million input tokens.
      numeratorUsdNano: "240000000",
      denominator: "1000000",
      effectiveFrom: "2026-10-20T00:00:00Z",
      sourceUrl: WORKERS_AI_PRICING,
    },
    {
      providerId: "cloudflare",
      sku: CLEF_OMNI_MODEL,
      unit: "input_tokens",
      // $0.150 per million input tokens, after modality tokenization.
      numeratorUsdNano: "150000000",
      denominator: "1000000",
      effectiveFrom: "2026-10-20T00:00:00Z",
      sourceUrl: "https://developers.cloudflare.com/workers-ai/models/clef-omni/",
    },
    {
      providerId: "cloudflare",
      sku: WORKERS_AI_NEURONS_SKU,
      unit: "neurons",
      // $0.011 per 1,000 neurons, before the account's daily free allowance.
      numeratorUsdNano: "11000000",
      denominator: "1000",
      effectiveFrom: "2026-10-20T00:00:00Z",
      sourceUrl: WORKERS_AI_PRICING,
    },
  ],
});

function instant(at: string | Date): number {
  const time = typeof at === "string" ? Date.parse(at) : at.getTime();
  if (Number.isNaN(time)) throw new EducateOsError("validation-failed", "expected a valid instant");
  return time;
}

function inEffect(rate: PriceRate, time: number): boolean {
  return Date.parse(rate.effectiveFrom) <= time && (rate.effectiveTo === undefined || time < Date.parse(rate.effectiveTo));
}

function overlaps(a: PriceRate, b: PriceRate): boolean {
  const end = (rate: PriceRate) => (rate.effectiveTo === undefined ? Infinity : Date.parse(rate.effectiveTo));
  return Date.parse(a.effectiveFrom) < end(b) && Date.parse(b.effectiveFrom) < end(a);
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function lcm(a: bigint, b: bigint): bigint {
  return (a / gcd(a, b)) * b;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
