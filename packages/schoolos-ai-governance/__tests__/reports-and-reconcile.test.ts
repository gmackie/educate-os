import { describe, expect, it } from "vitest";
import { parseCostExportCsv, parseCostExportJson, sumUsdNano, type UsageReport, type UsageTotals } from "../src/index.ts";
import { AMARA, BIO_FALL, c, DMITRI, ELENA, ENG9, harness, MINI, MORGAN, paid, PERSONAL, SONNET, tokens, USHIST } from "./setup.ts";

function sum(rows: Iterable<UsageTotals>, field: keyof UsageTotals): number | string {
  const values = [...rows].map((row) => row[field]);
  return typeof values[0] === "string" || field.endsWith("UsdNano")
    ? sumUsdNano(values as string[])
    : (values as number[]).reduce((total, value) => total + value, 0);
}

/** Each breakdown must account for every nanodollar and token of the district total exactly once. */
function expectBreakdownsReconcile(report: UsageReport) {
  for (const field of ["requests", "attempts", "inputTokens", "outputTokens", "usageUsdNano", "adjustmentUsdNano", "totalUsdNano"] as const) {
    const district = report.district[field];
    expect(sum([...Object.values(report.byPrincipal), report.unattributed], field)).toBe(district);
    expect(sum([...Object.values(report.byOffering), report.personal, report.unattributed], field)).toBe(district);
    expect(sum(Object.values(report.byPool), field)).toBe(district);
    expect(sum(Object.values(report.byModel), field)).toBe(district);
  }
}

/** A month of Northfield use: three students and a teacher across three classes and personal work. */
async function aMonthOfUse() {
  const h = harness();
  const { ledger, clock } = h;
  const use = async (id: string, who: typeof AMARA, where: typeof BIO_FALL, model: typeof SONNET, cents: number, input: number, output: number) => {
    await ledger.reserve(id, who, where, model, c(cents + 20));
    await ledger.settle(id, paid(tokens(input, output), c(cents)));
  };
  clock.set("2026-10-05T15:00:00.000Z");
  await use("req-a1", AMARA, BIO_FALL, SONNET, 40, 4_000, 1_000);
  await use("req-a2", AMARA, ENG9, SONNET, 25, 2_500, 600);
  await use("req-a3", AMARA, PERSONAL, MINI, 5, 800, 200);
  await use("req-e1", ELENA, BIO_FALL, SONNET, 30, 3_000, 700);
  await use("req-e2", ELENA, USHIST, SONNET, 18, 1_800, 500);
  clock.set("2026-10-06T10:00:00.000Z");
  await use("req-d1", DMITRI, BIO_FALL, MINI, 12, 1_200, 300);
  await use("req-m1", MORGAN, BIO_FALL, SONNET, 50, 5_000, 1_500);
  // A failed request costs nothing and produces no usage event.
  await ledger.reserve("req-failed", DMITRI, USHIST, SONNET, c(30));
  await ledger.void("req-failed");
  return h;
}

describe("usage reports", () => {
  it("reconciles per-student and per-class cost and usage", async () => {
    const { ledger } = await aMonthOfUse();
    const report = await ledger.report();
    expectBreakdownsReconcile(report);

    expect(report.district).toMatchObject({ requests: 7, usageUsdNano: c(180), totalUsdNano: c(180) });
    expect(report.byPrincipal["prn_nf-student-amara"]).toMatchObject({ requests: 3, usageUsdNano: c(70), inputTokens: 7_300 });
    expect(report.byPrincipal["prn_nf-student-dmitri"]).toMatchObject({ requests: 1, usageUsdNano: c(12) });
    // Biology's class total is exactly its students' and teacher's use in Biology.
    const biology = (await ledger.usageEvents()).filter((event) => event.workspace.kind === "course" && event.workspace.offeringId === "off_nf-bio-fall-p2");
    expect(report.byOffering["off_nf-bio-fall-p2"]).toMatchObject({
      requests: biology.length,
      usageUsdNano: sumUsdNano(biology.map((event) => event.chargedUsdNano)),
      outputTokens: biology.reduce((total, event) => total + event.outputTokens, 0),
    });
    expect(report.byOffering["off_nf-bio-fall-p2"]).toMatchObject({ requests: 4, usageUsdNano: c(132) });
    expect(report.personal).toMatchObject({ requests: 1, usageUsdNano: c(5) });
    expect(report.byModel["openai/gpt-mini-example"]).toMatchObject({ requests: 2, usageUsdNano: c(17) });

    // Pool balances agree with the report's per-pool totals.
    const balances = await ledger.poolBalances("2026-10");
    for (const [poolId, totals] of Object.entries(report.byPool)) expect(balances[poolId]!.chargedUsdNano).toBe(totals.totalUsdNano);
  });
});

describe("bill reconciliation", () => {
  it("matches billed requests by ID and records the variance as adjustment entries", async () => {
    const { ledger } = await aMonthOfUse();
    const historyBefore = await ledger.entries();
    const bill = parseCostExportCsv([
      "request_id,date,provider,model,cost_usd",
      "req-a1,2026-10-05,anthropic,claude-sonnet-example,0.47", // estimated 40, billed 47
      "req-e1,2026-10-05,anthropic,claude-sonnet-example,0.30", // exact
      "req-d1,2026-10-06,openai,gpt-mini-example,0.095", // 9.5 cents, exactly: estimated 12
      "req-failed,2026-10-06,anthropic,claude-sonnet-example,0.03", // voided, yet billed
    ].join("\n"));
    const result = await ledger.reconcile("bill-2026-10", bill);

    expect(result.lines.map((line) => [line.basis.kind === "request" && line.basis.requestId, line.estimatedUsdNano, line.actualUsdNano, line.varianceUsdNano]))
      .toEqual([
        ["req-a1", c(40), c(47), c(7)],
        ["req-e1", c(30), c(30), "0"],
        // Billed amounts are kept exactly, to the nanodollar, rather than rounded to cents.
        ["req-d1", c(12), "95000000", "-25000000"],
        ["req-failed", "0", c(3), c(3)],
      ]);
    expect(result.totals).toEqual({ estimatedUsdNano: c(82), actualUsdNano: "895000000", varianceUsdNano: "75000000", adjustmentUsdNano: "75000000" });
    expect(result.adjustments.map((adjustment) => [adjustment.basis.kind === "request" && adjustment.basis.requestId, adjustment.poolId, adjustment.deltaUsdNano, adjustment.attribution?.principalId]))
      .toEqual([
        ["req-a1", "fpl_nf-bio-fall", c(7), "prn_nf-student-amara"],
        ["req-d1", "fpl_nf-bio-fall", "-25000000", "prn_nf-student-dmitri"],
        ["req-failed", "fpl_nf-high", c(3), "prn_nf-student-dmitri"],
      ]);

    // History is appended to, never edited.
    const after = await ledger.entries();
    expect(after.slice(0, historyBefore.length)).toEqual(historyBefore);
    expect(after.slice(historyBefore.length).every((entry) => entry.type === "adjustment")).toBe(true);

    const report = await ledger.report();
    expectBreakdownsReconcile(report);
    expect(report.byPrincipal["prn_nf-student-amara"]).toMatchObject({ usageUsdNano: c(70), adjustmentUsdNano: c(7), totalUsdNano: c(77) });
    expect(report.byPrincipal["prn_nf-student-dmitri"]).toMatchObject({ usageUsdNano: c(12), adjustmentUsdNano: "5000000", totalUsdNano: "125000000" });
    const balances = await ledger.poolBalances("2026-10");
    expect(balances["fpl_nf-bio-fall"]!.chargedUsdNano).toBe(report.byPool["fpl_nf-bio-fall"]!.totalUsdNano);
  });

  it("is idempotent: re-importing the same bill adds nothing, and a changed bill needs a new run ID", async () => {
    const { ledger } = await aMonthOfUse();
    const csv = "request_id,date,provider,model,cost_usd\nreq-a1,2026-10-05,anthropic,claude-sonnet-example,0.47";
    await ledger.reconcile("bill-1", parseCostExportCsv(csv));
    const count = (await ledger.entries()).length;

    const again = await ledger.reconcile("bill-1", parseCostExportCsv(csv));
    expect(again.adjustments).toEqual([]);
    expect(again.lines[0]).toMatchObject({ varianceUsdNano: c(7), priorAdjustmentUsdNano: c(7), adjustmentUsdNano: "0" });
    expect(await ledger.reconcile("bill-1-reimport", parseCostExportCsv(csv))).toMatchObject({ adjustments: [] });
    expect((await ledger.entries()).length).toBe(count);

    const corrected = parseCostExportCsv(csv.replace("0.47", "0.50"));
    await expect(ledger.reconcile("bill-1", corrected)).rejects.toMatchObject({ code: "conflict" });
    const correction = await ledger.reconcile("bill-1-corrected", corrected);
    expect(correction.adjustments.map((adjustment) => adjustment.deltaUsdNano)).toEqual([c(3)]);
  });

  it("reconciles an ID-less bill by model and day, apportioning the variance across pools", async () => {
    const { ledger } = await aMonthOfUse();
    // On 5 October Sonnet was settled at 40 + 30 from Biology's pool and 25 + 18 from the school pool.
    const result = await ledger.reconcile("invoice-oct", parseCostExportJson({
      format: "schoolos.ai-cost-export.v1",
      rows: [
        { date: "2026-10-05", provider: "anthropic", model: "claude-sonnet-example", cost_usd: "0.80" },
        { request_id: "", date: "2026-10-05", provider: "anthropic", model: "claude-sonnet-example", cost_usd: "0.43" },
        { date: "2026-10-07", provider: "anthropic", model: "claude-sonnet-example", cost_usd: "0.05" },
      ],
    }));
    expect(result.lines).toEqual([expect.objectContaining({ estimatedUsdNano: c(113), actualUsdNano: c(123), varianceUsdNano: c(10), adjustmentUsdNano: c(10) })]);
    expect(result.adjustments.map((adjustment) => [adjustment.poolId, adjustment.deltaUsdNano, adjustment.attribution]))
      .toEqual([["fpl_nf-bio-fall", "61946903", undefined], ["fpl_nf-high", "38053097", undefined]]);
    // A billed day with no ledger usage cannot be attributed to a pool; it is reported, not adjusted.
    expect(result.unmatched).toEqual([{ model: SONNET, day: "2026-10-07", actualUsdNano: c(5) }]);

    const report = await ledger.report();
    expectBreakdownsReconcile(report);
    expect(report.unattributed.adjustmentUsdNano).toBe(c(10));
    expect(report.district.totalUsdNano).toBe(c(190));
  });

  it("leaves still-held requests for a later run", async () => {
    const { ledger } = harness();
    await ledger.reserve("req-open", AMARA, BIO_FALL, SONNET, c(50));
    const result = await ledger.reconcile("bill-1", parseCostExportCsv("request_id,date,provider,model,cost_usd\nreq-open,2026-10-05,anthropic,claude-sonnet-example,0.20"));
    expect(result).toMatchObject({ unsettledRequestIds: ["req-open"], adjustments: [], lines: [] });
  });

  it("rejects a malformed export as a whole, naming the line", () => {
    const header = "request_id,date,provider,model,cost_usd";
    expect(() => parseCostExportCsv("id,date,cost\n")).toThrow(/header/);
    expect(() => parseCostExportCsv(`${header}\nreq-1,2026-10-05,anthropic,m,0.1\nreq-2,2026-10-05,mystery,m,0.1`)).toThrow(/line 3/);
    expect(() => parseCostExportCsv(`${header}\nreq-1,2026-10-05,anthropic,m,-0.10`)).toThrow(/line 2/);
    expect(() => parseCostExportCsv(`${header}\nreq-1,2026-10-05,anthropic,m,0.1234567891`)).toThrow();
    expect(() => parseCostExportJson({ format: "schoolos.ai-cost-export.v1", rows: [{ date: "2026-10-05", provider: "openai", model: "m", cost_usd: 0.1 }] })).toThrow();
    expect(() => parseCostExportJson({ format: "schoolos.ai-cost-export.v1", rows: [], extra: true })).toThrow();
  });
});
