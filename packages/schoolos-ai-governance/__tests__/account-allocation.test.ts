import { describe, expect, it } from "vitest";
import {
  allocateCloudflareAccounts,
  cloudflareAccountFacts,
  WORKERS_AI_NEURONS_SKU,
  WORKERS_PAID_BASE_FEE_SKU,
  type AccountAllocation,
  type AccountCostRow,
  type AccountUsageEvent,
  type CloudflareAllocationInput,
} from "../src/index.ts";

const MONTH = "2026-11";
const DAY = "2026-11-03";
/** Gross Workers AI usage at list price: $0.011 per 1,000 neurons is 11,000 nanodollars a neuron. */
const NEURON_NANO = 11_000n;

function neuronEvent(product: string, neurons: number, extra: Partial<AccountUsageEvent> = {}): AccountUsageEvent {
  return {
    accountId: "acct-a",
    product,
    costCenter: "default",
    day: DAY,
    sku: WORKERS_AI_NEURONS_SKU,
    grossUsdNano: (BigInt(neurons) * NEURON_NANO).toString(),
    neurons,
    ...extra,
  };
}

function allocate(input: Partial<CloudflareAllocationInput> & Pick<CloudflareAllocationInput, "events">) {
  return allocateCloudflareAccounts({ month: MONTH, accounts: [cloudflareAccountFacts("acct-a"), cloudflareAccountFacts("acct-b")], ...input });
}

function account(report: { accounts: AccountAllocation[] }, accountId: string): AccountAllocation {
  return report.accounts.find((entry) => entry.accountId === accountId)!;
}

function row(rows: readonly AccountCostRow[], sku: string, period?: string): AccountCostRow {
  return rows.find((entry) => entry.sku === sku && (period === undefined || entry.period === period))!;
}

function allocatedTotal(target: AccountCostRow): bigint {
  return target.allocations.reduce((sum, allocation) => sum + BigInt(allocation.netAllocatedUsdNano), 0n) + BigInt(target.unallocatedUsdNano);
}

describe("Cloudflare account allocation", () => {
  it("applies the daily neuron allowance once per account, across every product", () => {
    const events = [neuronEvent("hall-monitor", 6_000), neuronEvent("schoolos", 6_000), neuronEvent("playtrek", 6_000)];
    const shared = account(allocate({ events }), "acct-a");
    expect(shared.allowances).toEqual([{ accountId: "acct-a", day: DAY, neurons: 18_000, freeNeuronsApplied: 10_000, freeAllowanceAppliedUsdNano: "110000000" }]);
    expect(row(shared.days, WORKERS_AI_NEURONS_SKU)).toMatchObject({
      grossUsageUsdNano: "198000000",
      freeAllowanceAppliedUsdNano: "110000000",
      contractAdjustmentUsdNano: "0",
      netEstimatedUsdNano: "88000000",
    });
    // Each product's gross stays visible; the net is shared by gross.
    expect(row(shared.days, WORKERS_AI_NEURONS_SKU).allocations.map((entry) => [entry.product, entry.grossUsageUsdNano, entry.netAllocatedUsdNano])).toEqual([
      ["hall-monitor", "66000000", "29333334"],
      ["playtrek", "66000000", "29333333"],
      ["schoolos", "66000000", "29333333"],
    ]);

    // The same usage in two accounts gets two allowances.
    const split = allocate({ events: [events[0]!, events[1]!, { ...events[2]!, accountId: "acct-b" }] });
    expect(account(split, "acct-a").allowances[0]).toMatchObject({ neurons: 12_000, freeNeuronsApplied: 10_000, freeAllowanceAppliedUsdNano: "110000000" });
    expect(account(split, "acct-b").allowances[0]).toMatchObject({ neurons: 6_000, freeNeuronsApplied: 6_000, freeAllowanceAppliedUsdNano: "66000000" });
    expect(row(account(split, "acct-b").days, WORKERS_AI_NEURONS_SKU).netEstimatedUsdNano).toBe("0");
  });

  it("caps the allowance at the gross it offsets and spreads it over the neuron SKUs", () => {
    const clef = { sku: "@cf/cloudflare/clef-flash", grossUsdNano: "38000" };
    const report = account(allocate({ events: [neuronEvent("hall-monitor", 3_000, clef), neuronEvent("schoolos", 1_000)] }), "acct-a");
    // 4,000 free neurons are worth 44,000,000, more than the 11,038,000 of gross that consumed
    // neurons (Clef is priced by tokens), so the allowance covers that gross and no more.
    expect(report.allowances[0]).toMatchObject({ freeNeuronsApplied: 4_000, freeAllowanceAppliedUsdNano: "11038000" });
    expect(row(report.days, clef.sku)).toMatchObject({ freeAllowanceAppliedUsdNano: "38000", netEstimatedUsdNano: "0" });
    expect(row(report.days, WORKERS_AI_NEURONS_SKU)).toMatchObject({ freeAllowanceAppliedUsdNano: "11000000", netEstimatedUsdNano: "0" });
    // Above the allowance, its value is spread over the neuron SKUs by their gross.
    const busy = account(allocate({ events: [neuronEvent("hall-monitor", 9_000, { ...clef, grossUsdNano: "30000000" }), neuronEvent("schoolos", 9_000)] }), "acct-a");
    expect(busy.allowances[0]).toMatchObject({ freeNeuronsApplied: 10_000, freeAllowanceAppliedUsdNano: "110000000" });
    // 110,000,000 split 30,000,000 : 99,000,000, with the remainder nanodollar to the larger fraction.
    expect(row(busy.days, clef.sku).freeAllowanceAppliedUsdNano).toBe("25581395");
    expect(row(busy.days, WORKERS_AI_NEURONS_SKU).freeAllowanceAppliedUsdNano).toBe("84418605");
    // A day whose neuron usage is priced below the neuron rate cannot be offset below zero.
    const cheap = account(allocate({ events: [neuronEvent("hall-monitor", 9_000, { grossUsdNano: "500" })] }), "acct-a");
    expect(row(cheap.days, WORKERS_AI_NEURONS_SKU)).toMatchObject({ grossUsageUsdNano: "500", freeAllowanceAppliedUsdNano: "500", netEstimatedUsdNano: "0" });
  });

  it("charges the Workers Paid base fee once per account per month, shared flat", () => {
    const events = [neuronEvent("hall-monitor", 10), neuronEvent("schoolos", 10), neuronEvent("playtrek", 10), neuronEvent("schoolos", 10, { day: "2026-11-04" })];
    const report = account(allocate({ events }), "acct-a");
    const fee = row(report.months, WORKERS_PAID_BASE_FEE_SKU);
    expect(report.months.filter((entry) => entry.sku === WORKERS_PAID_BASE_FEE_SKU)).toHaveLength(1);
    expect(fee).toMatchObject({ period: MONTH, grossUsageUsdNano: "5000000000", netEstimatedUsdNano: "5000000000", unallocatedUsdNano: "0" });
    expect(fee.allocations.map((entry) => [entry.product, entry.method, entry.netAllocatedUsdNano])).toEqual([
      ["hall-monitor", "flat_shared", "1666666667"],
      ["playtrek", "flat_shared", "1666666667"],
      ["schoolos", "flat_shared", "1666666666"],
    ]);
    // An account nobody used still pays its fee, as an unallocated residual.
    const idle = account(allocate({ events }), "acct-b");
    expect(idle.totals).toMatchObject({ grossUsageUsdNano: "5000000000", netEstimatedUsdNano: "5000000000", unallocatedUsdNano: "5000000000" });
  });

  it("keeps contract adjustments in their own column and allocates every row exactly", () => {
    const events = [
      neuronEvent("hall-monitor", 20_000, { costCenter: "district-a" }),
      neuronEvent("hall-monitor", 7_001, { costCenter: "district-b" }),
      neuronEvent("schoolos", 3_333),
    ];
    const report = account(allocate({
      events,
      contractAdjustments: [
        { accountId: "acct-a", sku: WORKERS_AI_NEURONS_SKU, period: MONTH, amountUsdNano: "-1001", reference: "credit-memo-7" },
        { accountId: "acct-a", sku: "r2-storage", period: DAY, amountUsdNano: "250", reference: "contract-3.2" },
      ],
    }), "acct-a");
    const month = row(report.months, WORKERS_AI_NEURONS_SKU);
    expect(month).toMatchObject({ grossUsageUsdNano: "333674000", freeAllowanceAppliedUsdNano: "110000000", contractAdjustmentUsdNano: "-1001", netEstimatedUsdNano: "223672999" });
    // An adjustment on a SKU nobody used that day is shared by the day's users.
    expect(row(report.days, "r2-storage")).toMatchObject({ grossUsageUsdNano: "0", netEstimatedUsdNano: "250", unallocatedUsdNano: "0" });
    for (const target of [...report.days, ...report.months]) expect(allocatedTotal(target)).toBe(BigInt(target.netEstimatedUsdNano));
    expect(report.totals).toMatchObject({ contractAdjustmentUsdNano: "-751" });
  });

  it("compares the invoice, flagging only large deltas on large samples", () => {
    const events = [
      neuronEvent("hall-monitor", 1_010_000, { requests: 500 }),
      neuronEvent("schoolos", 1_000_000, { day: "2026-11-04", requests: 20 }),
      { accountId: "acct-a", product: "schoolos", costCenter: "default", day: DAY, sku: "workers-requests", grossUsdNano: "300", requests: 10 },
      { accountId: "acct-a", product: "schoolos", costCenter: "default", day: "2026-11-04", sku: "workers-requests", requests: 4 },
    ] satisfies AccountUsageEvent[];
    const report = allocate({
      events,
      invoiceLines: [
        // Estimate 11,000,000,000 (1,000,000 billable neurons): $6 over is past max($5, 5% of $17).
        { accountId: "acct-a", sku: WORKERS_AI_NEURONS_SKU, period: DAY, amountUsdNano: "17000000000" },
        // The same delta on a 20-request day is not enough to judge.
        { accountId: "acct-a", sku: WORKERS_AI_NEURONS_SKU, period: "2026-11-04", amountUsdNano: "16890000000" },
        { accountId: "acct-a", sku: WORKERS_PAID_BASE_FEE_SKU, period: MONTH, amountUsdNano: "5000000000" },
        { accountId: "acct-b", sku: WORKERS_PAID_BASE_FEE_SKU, period: MONTH, amountUsdNano: "2500000000" },
        { accountId: "acct-b", sku: WORKERS_PAID_BASE_FEE_SKU, period: MONTH, amountUsdNano: "2500000000" },
        { accountId: "acct-a", sku: "d1-rows-read", period: MONTH, amountUsdNano: "120000000" },
      ],
      discrepancyThresholds: { minAbsoluteUsdNano: "5000000000", relativeBasisPoints: 500, minSampleRequests: 100 },
    });
    expect(report.discrepancies.map((entry) => [entry.accountId, entry.sku, entry.period, entry.deltaUsdNano, entry.status])).toEqual([
      ["acct-a", WORKERS_AI_NEURONS_SKU, DAY, "6000000000", "warning"],
      ["acct-a", WORKERS_AI_NEURONS_SKU, "2026-11-04", "6000000000", "insufficient_sample"],
      // A fixed fee has no sample to judge; it is compared on the threshold alone.
      ["acct-a", WORKERS_PAID_BASE_FEE_SKU, MONTH, "0", "within_threshold"],
      ["acct-b", WORKERS_PAID_BASE_FEE_SKU, MONTH, "0", "within_threshold"],
    ]);
    expect(report.discrepancies[0]!.thresholdUsdNano).toBe("5000000000");
    // An invoice line with no estimate, and usage no line covers, are listed rather than dropped.
    expect(report.unmatchedInvoiceLines).toEqual([{ accountId: "acct-a", sku: "d1-rows-read", period: MONTH, amountUsdNano: "120000000" }]);
    expect(report.unmatchedUsage).toEqual([{ accountId: "acct-a", sku: "workers-requests", period: MONTH, netEstimatedUsdNano: "300" }]);
    expect(row(account(report, "acct-a").months, "workers-requests")).toMatchObject({ requests: 14, unknownCostRequests: 4 });
  });

  it("uses the relative threshold for large invoices", () => {
    const report = allocate({
      events: [neuronEvent("hall-monitor", 10_010_000, { requests: 1_000 })],
      invoiceLines: [{ accountId: "acct-a", sku: WORKERS_AI_NEURONS_SKU, period: DAY, amountUsdNano: "115000000000" }],
    });
    // Estimate $110; 5% of $115 is $5.75, so a $5 delta is within it.
    expect(report.discrepancies[0]).toMatchObject({ deltaUsdNano: "5000000000", thresholdUsdNano: "5750000000", status: "within_threshold" });
  });

  it("refuses accounts without facts and days outside the month", () => {
    expect(() => allocate({ events: [neuronEvent("schoolos", 1, { accountId: "acct-z" })] })).toThrow(/no facts/);
    expect(() => allocate({ events: [neuronEvent("schoolos", 1, { day: "2026-12-01" })] })).toThrow(/outside/);
    expect(() => allocate({ events: [neuronEvent("schoolos", 1, { grossUsdNano: "-1" })] })).toThrow();
    expect(() => allocateCloudflareAccounts({ month: MONTH, accounts: [cloudflareAccountFacts("acct-a"), cloudflareAccountFacts("acct-a")], events: [] })).toThrow(/twice/);
  });
});

/** Neurons per product and day of the synthetic month: some days fit in the allowance, some exceed it. */
function neuronsOn(product: number, day: number): number {
  return ((day * 7 + product * 13) % 11) * 900 + product * 50;
}

describe("a synthetic month in one shared account", () => {
  const days = Array.from({ length: 30 }, (_, index) => `2026-11-${String(index + 1).padStart(2, "0")}`);
  const products = ["hall-monitor", "playtrek", "schoolos"] as const;
  const events: AccountUsageEvent[] = [];
  for (const [d, day] of days.entries()) {
    for (const [p, product] of products.entries()) {
      events.push(neuronEvent(product, neuronsOn(p, d), { day, costCenter: `tenant-${(d + p) % 2}`, requests: 40 }));
      events.push({ accountId: "acct-a", product, costCenter: "platform", day, sku: "workers-requests", grossUsdNano: String(1_000 + d * 10 + p), requests: 200 });
    }
    // One day's rollup lost its cost: it is counted as unknown, not as $0.
    if (d === 17) events.push({ accountId: "acct-a", product: "playtrek", costCenter: "platform", day, sku: "workers-requests", requests: 50 });
  }
  // The invoice, worked out independently: billable neurons above 10,000 a day, at 11 nanodollars.
  let billableNeurons = 0n;
  for (const d of days.keys()) {
    const total = products.reduce((sum, _, p) => sum + neuronsOn(p, d), 0);
    billableNeurons += BigInt(Math.max(0, total - 10_000));
  }
  const report = allocateCloudflareAccounts({
    month: MONTH,
    accounts: [cloudflareAccountFacts("acct-a")],
    events,
    invoiceLines: [
      { accountId: "acct-a", sku: WORKERS_AI_NEURONS_SKU, period: MONTH, amountUsdNano: (billableNeurons * NEURON_NANO).toString(), invoiceId: "inv-2026-11" },
      { accountId: "acct-a", sku: WORKERS_PAID_BASE_FEE_SKU, period: MONTH, amountUsdNano: "5000000000", invoiceId: "inv-2026-11" },
      { accountId: "acct-a", sku: "artifacts-operations", period: MONTH, amountUsdNano: "150000000", invoiceId: "inv-2026-11" },
    ],
  });
  const acct = account(report, "acct-a");

  it("keeps gross equal to the usage and applies one allowance a day", () => {
    const eventGross = events.reduce((sum, event) => sum + BigInt(event.grossUsdNano ?? "0"), 0n);
    expect(BigInt(acct.totals.grossUsageUsdNano)).toBe(eventGross + 5_000_000_000n);
    expect(acct.allowances).toHaveLength(30);
    for (const allowance of acct.allowances) {
      expect(allowance.freeNeuronsApplied).toBe(Math.min(allowance.neurons, 10_000));
      expect(BigInt(allowance.freeAllowanceAppliedUsdNano)).toBe(BigInt(allowance.freeNeuronsApplied) * NEURON_NANO);
    }
    const free = acct.allowances.reduce((sum, allowance) => sum + BigInt(allowance.freeAllowanceAppliedUsdNano), 0n);
    expect(BigInt(acct.totals.freeAllowanceAppliedUsdNano)).toBe(free);
    expect(free).toBeLessThanOrEqual(30n * 10_000n * NEURON_NANO);
  });

  it("reconciles with the invoice without double counting", () => {
    const neurons = row(acct.months, WORKERS_AI_NEURONS_SKU);
    expect(BigInt(neurons.netEstimatedUsdNano)).toBe(billableNeurons * NEURON_NANO);
    expect(BigInt(neurons.grossUsageUsdNano) - BigInt(neurons.freeAllowanceAppliedUsdNano)).toBe(BigInt(neurons.netEstimatedUsdNano));
    expect(report.discrepancies.map((entry) => [entry.sku, entry.deltaUsdNano, entry.status])).toEqual([
      [WORKERS_AI_NEURONS_SKU, "0", "within_threshold"],
      [WORKERS_PAID_BASE_FEE_SKU, "0", "within_threshold"],
    ]);
  });

  it("allocates every nanodollar of every row, and reports residuals and unknowns", () => {
    for (const target of [...acct.days, ...acct.months]) expect(allocatedTotal(target)).toBe(BigInt(target.netEstimatedUsdNano));
    // Month allocations are the day allocations summed, plus the month-only fee.
    for (const monthRow of acct.months.filter((entry) => entry.sku !== WORKERS_PAID_BASE_FEE_SKU)) {
      const fromDays = acct.days.filter((entry) => entry.sku === monthRow.sku).reduce((sum, entry) => sum + allocatedTotal(entry), 0n);
      expect(allocatedTotal(monthRow)).toBe(fromDays);
    }
    const byProduct = new Map<string, bigint>();
    for (const monthRow of acct.months) {
      for (const allocation of monthRow.allocations) byProduct.set(allocation.product, (byProduct.get(allocation.product) ?? 0n) + BigInt(allocation.netAllocatedUsdNano));
    }
    expect([...byProduct.values()].reduce((sum, part) => sum + part, 0n)).toBe(BigInt(acct.totals.netEstimatedUsdNano));
    expect(acct.totals).toMatchObject({ unallocatedUsdNano: "0", unknownCostRequests: 50 });
    expect(report.unmatchedInvoiceLines).toEqual([{ accountId: "acct-a", sku: "artifacts-operations", period: MONTH, amountUsdNano: "150000000", invoiceId: "inv-2026-11" }]);
    expect(report.unmatchedUsage.map((entry) => entry.sku)).toEqual(["workers-requests"]);
  });

  it("is deterministic", () => {
    const again = allocateCloudflareAccounts({
      month: MONTH,
      accounts: [cloudflareAccountFacts("acct-a")],
      events: events.toReversed(),
      invoiceLines: [],
    });
    expect(account(again, "acct-a").months).toEqual(acct.months);
    expect(account(again, "acct-a").days).toEqual(acct.days);
  });
});
