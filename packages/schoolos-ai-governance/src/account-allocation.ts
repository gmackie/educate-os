import { z } from "zod";
import { SchoolOsError } from "@schoolos/contracts";
import { apportion } from "./apportion.ts";
import { BillingPeriod } from "./entries.ts";
import { SignedUsdNano, UsdNano, signedUsdNano, usdNano, usdNanoValue } from "./money.ts";
import { PRICE_BOOK_CLOUDFLARE_2026_10_20, WORKERS_AI_NEURONS_SKU, findPriceRate } from "./price-book.ts";

// Cloudflare account allocation (Hall Monitor source plan 02 §5 and §8, 03 §6). Everything here is
// pure: it takes usage, account facts and (optionally) invoice lines, and returns tables. Importing
// Cloudflare's billing data needs account credentials, so a least-privilege importer that produces
// these inputs is follow-up work; this module defines the inputs it will produce.

/** A Cloudflare account ID. Every allowance and the Workers Paid fee apply once per account. */
export const CloudflareAccountId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, "expected a Cloudflare account ID");
/** A Cloudflare account ID. */
export type CloudflareAccountId = z.infer<typeof CloudflareAccountId>;

/** A product that runs in a Cloudflare account, such as `schoolos`, `hall-monitor` or `playtrek`. */
export const ProductId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "expected a product ID");
/** A product ID. */
export type ProductId = z.infer<typeof ProductId>;

/** A tenant or cost center within a product, which allocated cost is charged back to. */
export const CostCenterId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, "expected a cost center ID");
/** A cost center ID. */
export type CostCenterId = z.infer<typeof CostCenterId>;

/** A UTC calendar day, `YYYY-MM-DD`, or a UTC calendar month, `YYYY-MM`. */
export const AllocationPeriod = z.union([z.iso.date(), BillingPeriod]);
/** An allocation period. */
export type AllocationPeriod = z.infer<typeof AllocationPeriod>;

/** The SKU this module charges the Workers Paid base fee under. */
export const WORKERS_PAID_BASE_FEE_SKU = "workers-paid-base-fee";
/** The Workers Paid plan's base fee: $5 per account per month, not per Worker or product. */
export const WORKERS_PAID_BASE_FEE_USD_NANO: UsdNano = "5000000000";
/** Workers AI's included usage: 10,000 neurons per account per UTC day, shared by every product. */
export const WORKERS_AI_FREE_NEURONS_PER_DAY = 10_000;

/**
 * Gross usage by one product and cost center in one account, for one UTC day and SKU. An event may
 * be one request or a rollup of several (`requests`, default 1, is what discrepancy checks count as
 * sample size). `grossUsdNano` is usage at list or contracted rates before any allowance; absent,
 * the cost is unknown and the event is counted in the unknown bucket rather than as $0. `neurons`
 * are the Workers AI neurons the usage consumed, which draw on the account's daily allowance.
 */
export const AccountUsageEvent = z.strictObject({
  accountId: CloudflareAccountId,
  product: ProductId,
  costCenter: CostCenterId,
  day: z.iso.date(),
  sku: z.string().min(1).max(200),
  grossUsdNano: UsdNano.optional(),
  neurons: z.int().nonnegative().optional(),
  requests: z.int().positive().optional(),
});
/** An account usage event. */
export type AccountUsageEvent = z.infer<typeof AccountUsageEvent>;

/** A rate as a ratio: `numeratorUsdNano` nanodollars per `denominator` units. */
export const UsdNanoRate = z.strictObject({
  numeratorUsdNano: UsdNano,
  denominator: z.string().regex(/^[1-9]\d{0,29}$/, "expected a positive integer"),
});
/** A rate. */
export type UsdNanoRate = z.infer<typeof UsdNanoRate>;

/** What one Cloudflare account's plan includes and charges once per account. */
export const CloudflareAccountFacts = z.strictObject({
  accountId: CloudflareAccountId,
  /** The Workers Paid base fee, charged once per account per month. */
  workersPaidBaseFeeUsdNano: UsdNano,
  /** Workers AI neurons included per account per UTC day. */
  workersAiFreeNeuronsPerDay: z.int().nonnegative(),
  /** The list price of a neuron, which values the included neurons. */
  workersAiNeuronRate: UsdNanoRate,
});
/** Cloudflare account facts. */
export type CloudflareAccountFacts = z.infer<typeof CloudflareAccountFacts>;

/**
 * An account's facts at Cloudflare's published 2026-10-20 terms ($5 base fee, 10,000 free neurons
 * a day, the `cloudflare-2026-10-20` neuron rate), with any of them overridden.
 */
export function cloudflareAccountFacts(accountId: CloudflareAccountId, overrides: Partial<Omit<CloudflareAccountFacts, "accountId">> = {}): CloudflareAccountFacts {
  const neuronRate = findPriceRate(PRICE_BOOK_CLOUDFLARE_2026_10_20, "cloudflare", WORKERS_AI_NEURONS_SKU, "neurons", PRICE_BOOK_CLOUDFLARE_2026_10_20.reviewedAt)!;
  return CloudflareAccountFacts.parse({
    accountId,
    workersPaidBaseFeeUsdNano: WORKERS_PAID_BASE_FEE_USD_NANO,
    workersAiFreeNeuronsPerDay: WORKERS_AI_FREE_NEURONS_PER_DAY,
    workersAiNeuronRate: { numeratorUsdNano: neuronRate.numeratorUsdNano, denominator: neuronRate.denominator },
    ...overrides,
  });
}

/**
 * A contracted change to an account's bill for one SKU and period: a negotiated credit (negative)
 * or surcharge (positive). Kept in its own column, never netted into gross usage.
 */
export const ContractAdjustment = z.strictObject({
  accountId: CloudflareAccountId,
  sku: z.string().min(1).max(200),
  period: AllocationPeriod,
  amountUsdNano: SignedUsdNano,
  /** Where the adjustment comes from: a contract clause or credit memo. */
  reference: z.string().min(1).max(200),
});
/** A contract adjustment. */
export type ContractAdjustment = z.infer<typeof ContractAdjustment>;

/** One line of a Cloudflare invoice or billing export, for one SKU and a day or month. */
export const InvoiceLine = z.strictObject({
  accountId: CloudflareAccountId,
  sku: z.string().min(1).max(200),
  period: AllocationPeriod,
  amountUsdNano: SignedUsdNano,
  invoiceId: z.string().min(1).max(200).optional(),
});
/** An invoice line. */
export type InvoiceLine = z.infer<typeof InvoiceLine>;

/**
 * How a net amount is shared among the products and cost centers that used it. `gross_pro_rata`
 * weighs each by its gross usage; `flat_shared` splits evenly among them (the default for the
 * Workers Paid base fee, which is overhead rather than usage).
 */
export const AllocationMethod = z.enum(["gross_pro_rata", "flat_shared"]);
/** An allocation method. */
export type AllocationMethod = z.infer<typeof AllocationMethod>;

/**
 * When an invoice-versus-estimate delta is a warning: its magnitude exceeds the larger of
 * `minAbsoluteUsdNano` and `relativeBasisPoints` of the invoiced amount, and the estimate covers at
 * least `minSampleRequests` requests. Below that sample, a delta is reported as
 * `insufficient_sample`; a row with no requests at all (a fixed fee) is judged on the threshold. The defaults are the source plan's proposal (max($5, 5%)); the sample size
 * is a pilot hypothesis, to be tuned by pilot size.
 */
export const DiscrepancyThresholds = z.strictObject({
  minAbsoluteUsdNano: UsdNano,
  relativeBasisPoints: z.int().nonnegative().max(10_000),
  minSampleRequests: z.int().nonnegative(),
});
/** Discrepancy thresholds. */
export type DiscrepancyThresholds = z.infer<typeof DiscrepancyThresholds>;

/** The default {@link DiscrepancyThresholds}: max($5, 5% of the invoice), at 100 or more requests. */
export const DEFAULT_DISCREPANCY_THRESHOLDS: DiscrepancyThresholds = {
  minAbsoluteUsdNano: "5000000000",
  relativeBasisPoints: 500,
  minSampleRequests: 100,
};

/** Everything {@link allocateCloudflareAccounts} allocates for one month. */
export const CloudflareAllocationInput = z.strictObject({
  month: BillingPeriod,
  /** Every account the events, adjustments and invoice lines name, each once. */
  accounts: z.array(CloudflareAccountFacts),
  events: z.array(AccountUsageEvent),
  contractAdjustments: z.array(ContractAdjustment).optional(),
  invoiceLines: z.array(InvoiceLine).optional(),
  /** Allocation method by SKU. Unlisted SKUs use `gross_pro_rata`, the base fee `flat_shared`. */
  methods: z.record(z.string(), AllocationMethod).optional(),
  discrepancyThresholds: DiscrepancyThresholds.optional(),
});
/** Allocation input. */
export type CloudflareAllocationInput = z.input<typeof CloudflareAllocationInput>;

/**
 * The cost columns of a row, kept apart and never summed into one another: gross usage at list
 * rates, the account allowance applied to it, contracted adjustments, and the resulting
 * `net = gross - allowance + adjustment` estimate of what the invoice will say. (These are the
 * `gross_usage_usd_nano`, `free_allowance_applied_usd_nano`, `contract_adjustment_usd_nano` and
 * `net_estimated_usd_nano` columns of the cost ledger design.)
 */
export interface CostColumns {
  /** Usage at list or contracted rates, before allowances and adjustments. */
  grossUsageUsdNano: UsdNano;
  /** The account's included usage applied to it. */
  freeAllowanceAppliedUsdNano: UsdNano;
  /** Contracted credits (negative) and surcharges (positive). */
  contractAdjustmentUsdNano: SignedUsdNano;
  /** What the account is estimated to be invoiced. */
  netEstimatedUsdNano: SignedUsdNano;
}

/** One product and cost center's share of a row. */
export interface CostAllocation {
  /** The product. */
  product: ProductId;
  /** The cost center. */
  costCenter: CostCenterId;
  /** How its share was worked out. */
  method: AllocationMethod;
  /** Its own gross usage in the row, which stays visible whatever the allowance did. */
  grossUsageUsdNano: UsdNano;
  /** Its share of the row's net estimate. The shares sum exactly to the allocated net. */
  netAllocatedUsdNano: SignedUsdNano;
}

/** One account, SKU and day or month. */
export interface AccountCostRow extends CostColumns {
  /** The account. */
  accountId: CloudflareAccountId;
  /** The UTC day (`YYYY-MM-DD`) or month (`YYYY-MM`). */
  period: AllocationPeriod;
  /** The SKU. */
  sku: string;
  /** Requests behind the row. */
  requests: number;
  /** Requests whose cost is unknown: not in `grossUsageUsdNano`, and not $0 either. */
  unknownCostRequests: number;
  /** Workers AI neurons consumed. */
  neurons: number;
  /** The net estimate, shared out. Sorted by product, then cost center. */
  allocations: CostAllocation[];
  /** Net that nobody used and so could not be shared out: a residual for an administrator. */
  unallocatedUsdNano: SignedUsdNano;
}

/** How one account's daily Workers AI allowance was used on one UTC day. */
export interface AccountDayAllowance {
  /** The account. */
  accountId: CloudflareAccountId;
  /** The UTC day. */
  day: string;
  /** Neurons consumed that day by every product in the account. */
  neurons: number;
  /** Included neurons applied: at most the account's daily allowance, once. */
  freeNeuronsApplied: number;
  /** Their value, at most the gross usage that consumed neurons. */
  freeAllowanceAppliedUsdNano: UsdNano;
}

/** One account's tables for the month. */
export interface AccountAllocation {
  /** The account. */
  accountId: CloudflareAccountId;
  /** Per SKU and UTC day, in day then SKU order. */
  days: AccountCostRow[];
  /** Per SKU for the month, including the base fee and month-level adjustments, in SKU order. */
  months: AccountCostRow[];
  /** The daily allowance, one per day with neuron usage. */
  allowances: AccountDayAllowance[];
  /** The month's totals. */
  totals: CostColumns & { unallocatedUsdNano: SignedUsdNano; unknownCostRequests: number };
}

/** How an invoice line compares with the estimate for its SKU and period. */
export interface InvoiceDiscrepancy {
  /** The account. */
  accountId: CloudflareAccountId;
  /** The SKU. */
  sku: string;
  /** The UTC day or month the invoice lines cover. */
  period: AllocationPeriod;
  /** The invoiced amount (lines for the same SKU and period are summed). */
  invoicedUsdNano: SignedUsdNano;
  /** The net estimate. */
  estimatedUsdNano: SignedUsdNano;
  /** `invoiced - estimated`. */
  deltaUsdNano: SignedUsdNano;
  /** The largest delta that is not a warning. */
  thresholdUsdNano: UsdNano;
  /** Requests behind the estimate. */
  sampleRequests: number;
  /** `warning` above the threshold; `insufficient_sample` when too few requests to judge. */
  status: "within_threshold" | "warning" | "insufficient_sample";
}

/** Estimated usage that no invoice line covers. */
export interface UnmatchedUsage {
  /** The account. */
  accountId: CloudflareAccountId;
  /** The SKU. */
  sku: string;
  /** The day or month with no invoice line. */
  period: AllocationPeriod;
  /** The net estimate no line accounts for. */
  netEstimatedUsdNano: SignedUsdNano;
}

/** The month's allocation, and its comparison with the invoice. */
export interface CloudflareAllocationReport {
  /** The UTC month. */
  month: BillingPeriod;
  /** One per account, in account order. */
  accounts: AccountAllocation[];
  /** One per invoiced SKU and period that has an estimate. */
  discrepancies: InvoiceDiscrepancy[];
  /** Invoice lines (summed per SKU and period) with no estimate at all. */
  unmatchedInvoiceLines: InvoiceLine[];
  /**
   * Estimates no invoice line covers. A SKU invoiced by the month is matched as a whole; one
   * invoiced by the day lists each day without a line; one not invoiced lists its month.
   */
  unmatchedUsage: UnmatchedUsage[];
}

/**
 * Estimates and allocates one month of Cloudflare usage across the accounts it ran in.
 *
 * Allowances and fees belong to an account, not to a product: the 10,000 included Workers AI
 * neurons are applied once per account per UTC day across every product's usage (so Hall Monitor,
 * SchoolOS and PlayTrek in one account share one allowance, and the same usage split across two
 * accounts gets two), and the Workers Paid base fee is charged once per account per month. The
 * allowance is valued at the neuron rate, capped at the gross usage that consumed neurons, and
 * spread over that usage's SKUs by gross.
 *
 * Each row's net is then shared among the products and cost centers that used it by the SKU's
 * {@link AllocationMethod}, in whole nanodollars by largest remainder (ties to the earlier
 * product and cost center), so shares sum exactly to the net. A charge with no usage of its own
 * (the base fee, an adjustment on an unused SKU) is shared among everyone who used the account in
 * the period; with no one to share it, it is reported as unallocated. Allocations are internal
 * chargeback, never a claim that Cloudflare billed a tenant that amount.
 *
 * With invoice lines, each SKU-day or SKU-month is compared with its estimate (see
 * {@link DiscrepancyThresholds}), and invoice lines and usage that do not match are listed rather
 * than dropped. Throws `validation-failed` on malformed input, an account without facts, or a day
 * outside the month.
 */
export function allocateCloudflareAccounts(input: CloudflareAllocationInput): CloudflareAllocationReport {
  const parsed = CloudflareAllocationInput.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new SchoolOsError("validation-failed", `cloudflare allocation: ${issue?.path.join(".") ?? ""}: ${issue?.message ?? "invalid"}`.slice(0, 1000));
  }
  const { month, accounts, events, contractAdjustments = [], invoiceLines = [], methods = {}, discrepancyThresholds = DEFAULT_DISCREPANCY_THRESHOLDS } = parsed.data;
  const facts = new Map<CloudflareAccountId, CloudflareAccountFacts>();
  for (const account of accounts) {
    if (facts.has(account.accountId)) throw new SchoolOsError("validation-failed", `cloudflare allocation: account ${account.accountId} is listed twice`);
    facts.set(account.accountId, account);
  }
  for (const item of [...events.map((event) => ({ accountId: event.accountId, period: event.day })), ...contractAdjustments, ...invoiceLines]) {
    if (!facts.has(item.accountId)) throw new SchoolOsError("validation-failed", `cloudflare allocation: no facts for account ${item.accountId}`);
    if (!item.period.startsWith(month)) throw new SchoolOsError("validation-failed", `cloudflare allocation: ${item.period} is outside ${month}`);
  }
  const methodFor = (sku: string): AllocationMethod => methods[sku] ?? (sku === WORKERS_PAID_BASE_FEE_SKU ? "flat_shared" : "gross_pro_rata");

  const allocations = [...facts.values()]
    .toSorted((a, b) => compareText(a.accountId, b.accountId))
    .map((account) => allocateAccount(
      account,
      month,
      events.filter((event) => event.accountId === account.accountId),
      contractAdjustments.filter((adjustment) => adjustment.accountId === account.accountId),
      methodFor,
    ));
  return { month, accounts: allocations, ...compareWithInvoice(allocations, invoiceLines, discrepancyThresholds) };
}

/** A row being built: bigint totals, and gross and requests per allocation key. */
interface RowBuilder {
  period: string;
  sku: string;
  gross: bigint;
  free: bigint;
  adjustment: bigint;
  requests: number;
  unknownCostRequests: number;
  neurons: number;
  /** Gross of the events that consumed neurons, which the allowance can offset. */
  neuronGross: bigint;
  /** Per allocation key: gross usage. Every key that used the row is present. */
  users: Map<string, bigint>;
}

function newRow(period: string, sku: string): RowBuilder {
  return { period, sku, gross: 0n, free: 0n, adjustment: 0n, requests: 0, unknownCostRequests: 0, neurons: 0, neuronGross: 0n, users: new Map() };
}

function allocateAccount(
  account: CloudflareAccountFacts,
  month: BillingPeriod,
  events: readonly AccountUsageEvent[],
  adjustments: readonly ContractAdjustment[],
  methodFor: (sku: string) => AllocationMethod,
): AccountAllocation {
  const dayRows = new Map<string, RowBuilder>();
  const dayRow = (day: string, sku: string) => getOrCreate(dayRows, `${day} ${sku}`, () => newRow(day, sku));
  /** Every key that used the account, by day and for the whole month. */
  const usersByDay = new Map<string, Map<string, bigint>>();
  const monthUsers = new Map<string, bigint>();
  const monthUsersBySku = new Map<string, Map<string, bigint>>();
  for (const event of events) {
    const row = dayRow(event.day, event.sku);
    const key = allocationKey(event.product, event.costCenter);
    const gross = event.grossUsdNano === undefined ? 0n : usdNanoValue(event.grossUsdNano);
    const requests = event.requests ?? 1;
    row.gross += gross;
    row.requests += requests;
    if (event.grossUsdNano === undefined) row.unknownCostRequests += requests;
    if (event.neurons !== undefined) {
      row.neurons += event.neurons;
      row.neuronGross += gross;
    }
    for (const users of [row.users, getOrCreate(usersByDay, event.day, () => new Map()), monthUsers, getOrCreate(monthUsersBySku, event.sku, () => new Map())]) {
      users.set(key, (users.get(key) ?? 0n) + gross);
    }
  }
  for (const adjustment of adjustments) {
    if (adjustment.period.length === 10) dayRow(adjustment.period, adjustment.sku).adjustment += usdNanoValue(adjustment.amountUsdNano);
  }

  // The daily neuron allowance, once per account and UTC day, across every product and SKU.
  const allowances: AccountDayAllowance[] = [];
  const rate = account.workersAiNeuronRate;
  const daysUsed = [...new Set([...dayRows.values()].map((row) => row.period))].toSorted(compareText);
  for (const day of daysUsed) {
    const rows = [...dayRows.values()].filter((row) => row.period === day && row.neurons > 0).toSorted((a, b) => compareText(a.sku, b.sku));
    const neurons = rows.reduce((sum, row) => sum + row.neurons, 0);
    if (neurons === 0) continue;
    const freeNeuronsApplied = Math.min(neurons, account.workersAiFreeNeuronsPerDay);
    const neuronGross = rows.reduce((sum, row) => sum + row.neuronGross, 0n);
    // Valued rounding down, so the estimate (gross less allowance) is never understated.
    const value = (BigInt(freeNeuronsApplied) * usdNanoValue(rate.numeratorUsdNano)) / BigInt(rate.denominator);
    const free = value < neuronGross ? value : neuronGross;
    if (free > 0n) {
      for (const [target, part] of apportion(free, rows.map((row) => [row, row.neuronGross] as const))) target.free += part;
    }
    allowances.push({ accountId: account.accountId, day, neurons, freeNeuronsApplied, freeAllowanceAppliedUsdNano: usdNano(free) });
  }

  const sortedDayRows = [...dayRows.values()].toSorted((a, b) => compareText(a.period, b.period) || compareText(a.sku, b.sku));
  const dayTable = sortedDayRows.map((row) => finishRow(account.accountId, row, methodFor(row.sku), usersByDay.get(row.period) ?? new Map(), []));

  // Months: the days summed, plus what exists only by the month (the base fee and month-level
  // adjustments), which is shared among the SKU's users, or the account's for a SKU nobody used.
  const monthRows = new Map<string, { row: RowBuilder; dayShares: Map<string, bigint> }>();
  const monthRow = (sku: string) => getOrCreate(monthRows, sku, () => ({ row: newRow(month, sku), dayShares: new Map() }));
  for (const [index, row] of sortedDayRows.entries()) {
    const target = monthRow(row.sku);
    target.row.gross += row.gross;
    target.row.free += row.free;
    target.row.adjustment += row.adjustment;
    target.row.requests += row.requests;
    target.row.unknownCostRequests += row.unknownCostRequests;
    target.row.neurons += row.neurons;
    for (const [key, gross] of row.users) target.row.users.set(key, (target.row.users.get(key) ?? 0n) + gross);
    for (const allocation of dayTable[index]!.allocations) {
      const key = allocationKey(allocation.product, allocation.costCenter);
      target.dayShares.set(key, (target.dayShares.get(key) ?? 0n) + usdNanoValue(allocation.netAllocatedUsdNano));
    }
  }
  const baseFee = usdNanoValue(account.workersPaidBaseFeeUsdNano);
  if (baseFee > 0n) monthRow(WORKERS_PAID_BASE_FEE_SKU).row.gross += baseFee;
  const monthOnly = new Map<string, bigint>();
  if (baseFee > 0n) monthOnly.set(WORKERS_PAID_BASE_FEE_SKU, baseFee);
  for (const adjustment of adjustments) {
    if (adjustment.period.length !== 7) continue;
    monthRow(adjustment.sku).row.adjustment += usdNanoValue(adjustment.amountUsdNano);
    monthOnly.set(adjustment.sku, (monthOnly.get(adjustment.sku) ?? 0n) + usdNanoValue(adjustment.amountUsdNano));
  }
  const months = [...monthRows.values()]
    .toSorted((a, b) => compareText(a.row.sku, b.row.sku))
    .map(({ row, dayShares }) => {
      const users = monthUsersBySku.get(row.sku) ?? monthUsers;
      const carried: [string, bigint][] = [...dayShares];
      const dayUnallocated = dayTable
        .filter((day) => day.sku === row.sku)
        .reduce((sum, day) => sum + usdNanoValue(day.unallocatedUsdNano), 0n);
      return finishRow(account.accountId, row, methodFor(row.sku), users, carried, monthOnly.get(row.sku) ?? 0n, dayUnallocated);
    });

  const sum = (pick: (row: AccountCostRow) => string) => months.reduce((total, row) => total + usdNanoValue(pick(row)), 0n);
  return {
    accountId: account.accountId,
    days: dayTable,
    months,
    allowances,
    totals: {
      grossUsageUsdNano: usdNano(sum((row) => row.grossUsageUsdNano)),
      freeAllowanceAppliedUsdNano: usdNano(sum((row) => row.freeAllowanceAppliedUsdNano)),
      contractAdjustmentUsdNano: signedUsdNano(sum((row) => row.contractAdjustmentUsdNano)),
      netEstimatedUsdNano: signedUsdNano(sum((row) => row.netEstimatedUsdNano)),
      unallocatedUsdNano: signedUsdNano(sum((row) => row.unallocatedUsdNano)),
      unknownCostRequests: months.reduce((total, row) => total + row.unknownCostRequests, 0),
    },
  };
}

/**
 * Completes a row: its net, and the net shared among its users. For a day row the whole net is
 * shared; for a month row, `carried` holds the day rows' shares and only `toShare` (what exists by
 * the month alone) is shared here, with `carriedUnallocated` the days' residual.
 */
function finishRow(
  accountId: CloudflareAccountId,
  row: RowBuilder,
  method: AllocationMethod,
  fallbackUsers: ReadonlyMap<string, bigint>,
  carried: readonly [string, bigint][],
  toShare?: bigint,
  carriedUnallocated = 0n,
): AccountCostRow {
  const net = row.gross - row.free + row.adjustment;
  const amount = toShare ?? net;
  // Who shares the amount: the row's own users, or for a row nobody used, the period's.
  const users = [...(row.users.size > 0 ? row.users : fallbackUsers)].toSorted(([a], [b]) => compareText(a, b));
  const shares = new Map<string, bigint>(carried);
  let unallocated = carriedUnallocated;
  if (amount !== 0n) {
    const totalGross = users.reduce((sum, [, gross]) => sum + gross, 0n);
    const weights = users.map(([key, gross]): [string, bigint] => [key, method === "gross_pro_rata" && totalGross > 0n ? gross : 1n]);
    if (weights.length === 0) unallocated += amount;
    else for (const [key, part] of apportion(amount, weights)) shares.set(key, (shares.get(key) ?? 0n) + part);
  }
  const allocations = [...new Set([...row.users.keys(), ...shares.keys()])]
    .toSorted(compareText)
    .map((key): CostAllocation => {
      const [product, costCenter] = key.split("/") as [ProductId, CostCenterId];
      return {
        product,
        costCenter,
        method,
        grossUsageUsdNano: usdNano(row.users.get(key) ?? 0n),
        netAllocatedUsdNano: signedUsdNano(shares.get(key) ?? 0n),
      };
    });
  return {
    accountId,
    period: row.period,
    sku: row.sku,
    grossUsageUsdNano: usdNano(row.gross),
    freeAllowanceAppliedUsdNano: usdNano(row.free),
    contractAdjustmentUsdNano: signedUsdNano(row.adjustment),
    netEstimatedUsdNano: signedUsdNano(net),
    requests: row.requests,
    unknownCostRequests: row.unknownCostRequests,
    neurons: row.neurons,
    allocations,
    unallocatedUsdNano: signedUsdNano(unallocated),
  };
}

function compareWithInvoice(
  accounts: readonly AccountAllocation[],
  lines: readonly InvoiceLine[],
  thresholds: DiscrepancyThresholds,
): Pick<CloudflareAllocationReport, "discrepancies" | "unmatchedInvoiceLines" | "unmatchedUsage"> {
  const invoiced = new Map<string, InvoiceLine>();
  for (const line of lines) {
    const key = `${line.accountId} ${line.sku} ${line.period}`;
    const existing = invoiced.get(key);
    invoiced.set(key, existing === undefined
      ? { accountId: line.accountId, sku: line.sku, period: line.period, amountUsdNano: line.amountUsdNano, ...(line.invoiceId === undefined ? {} : { invoiceId: line.invoiceId }) }
      : { accountId: line.accountId, sku: line.sku, period: line.period, amountUsdNano: signedUsdNano(usdNanoValue(existing.amountUsdNano) + usdNanoValue(line.amountUsdNano)) });
  }
  const estimates = new Map<string, AccountCostRow>();
  for (const account of accounts) {
    for (const row of [...account.days, ...account.months]) estimates.set(`${row.accountId} ${row.sku} ${row.period}`, row);
  }

  const discrepancies: InvoiceDiscrepancy[] = [];
  const unmatchedInvoiceLines: InvoiceLine[] = [];
  const sortedLines = [...invoiced].toSorted(([a], [b]) => compareText(a, b));
  for (const [key, line] of sortedLines) {
    const row = estimates.get(key);
    if (row === undefined) {
      unmatchedInvoiceLines.push(line);
      continue;
    }
    const actual = usdNanoValue(line.amountUsdNano);
    const estimated = usdNanoValue(row.netEstimatedUsdNano);
    const delta = actual - estimated;
    const magnitude = actual < 0n ? -actual : actual;
    const relative = (magnitude * BigInt(thresholds.relativeBasisPoints) + 9_999n) / 10_000n;
    const minimum = usdNanoValue(thresholds.minAbsoluteUsdNano);
    const threshold = relative > minimum ? relative : minimum;
    // A row with no requests is a fixed charge (the base fee, say): there is no sample to judge.
    const status = row.requests > 0 && row.requests < thresholds.minSampleRequests
      ? "insufficient_sample"
      : (delta < 0n ? -delta : delta) > threshold ? "warning" : "within_threshold";
    discrepancies.push({
      accountId: row.accountId,
      sku: row.sku,
      period: row.period,
      invoicedUsdNano: line.amountUsdNano,
      estimatedUsdNano: row.netEstimatedUsdNano,
      deltaUsdNano: signedUsdNano(delta),
      thresholdUsdNano: usdNano(threshold),
      sampleRequests: row.requests,
      status,
    });
  }

  const unmatchedUsage: UnmatchedUsage[] = [];
  const unmatched = (row: AccountCostRow): UnmatchedUsage => ({ accountId: row.accountId, sku: row.sku, period: row.period, netEstimatedUsdNano: row.netEstimatedUsdNano });
  for (const account of accounts) {
    for (const monthRow of account.months) {
      if (invoiced.has(`${monthRow.accountId} ${monthRow.sku} ${monthRow.period}`)) continue;
      const dayRows = account.days.filter((row) => row.sku === monthRow.sku);
      const invoicedByDay = [...invoiced.values()].some((line) => line.accountId === account.accountId && line.sku === monthRow.sku && line.period.length === 10);
      if (!invoicedByDay) unmatchedUsage.push(unmatched(monthRow));
      else for (const row of dayRows) if (!invoiced.has(`${row.accountId} ${row.sku} ${row.period}`)) unmatchedUsage.push(unmatched(row));
    }
  }
  return { discrepancies, unmatchedInvoiceLines, unmatchedUsage };
}

function allocationKey(product: ProductId, costCenter: CostCenterId): string {
  return `${product}/${costCenter}`;
}

/** Code-point order, so results do not depend on the runtime's locale. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function getOrCreate<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  let value = map.get(key);
  if (value === undefined) {
    value = create();
    map.set(key, value);
  }
  return value;
}
