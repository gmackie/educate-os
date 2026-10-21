import { describe, expect, it } from "vitest";
import { parseCostExportCsv, parseCostExportJson, type UsageReport, type UsageTotals } from "../src/index.ts";
import { AMARA, BIO_FALL, DMITRI, ELENA, ENG9, harness, MINI, MORGAN, PERSONAL, SONNET, tokens, USHIST } from "./setup.ts";

function sum(rows: Iterable<UsageTotals>, field: keyof UsageTotals) {
  let total = 0;
  for (const row of rows) total += row[field];
  return total;
}

/** Each breakdown must account for every cent and token of the district total exactly once. */
function expectBreakdownsReconcile(report: UsageReport) {
  for (const field of ["requests", "inputTokens", "outputTokens", "usageCents", "adjustmentCents", "totalCents"] as const) {
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
    await ledger.reserve(id, who, where, model, cents + 20);
    await ledger.settle(id, tokens(input, output), cents);
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
  await ledger.reserve("req-failed", DMITRI, USHIST, SONNET, 30);
  await ledger.void("req-failed");
  return h;
}

describe("usage reports", () => {
  it("reconciles per-student and per-class cost and usage", async () => {
    const { ledger } = await aMonthOfUse();
    const report = await ledger.report();
    expectBreakdownsReconcile(report);

    expect(report.district).toMatchObject({ requests: 7, usageCents: 180, totalCents: 180 });
    expect(report.byPrincipal["prn_nf-student-amara"]).toMatchObject({ requests: 3, usageCents: 70, inputTokens: 7_300 });
    expect(report.byPrincipal["prn_nf-student-dmitri"]).toMatchObject({ requests: 1, usageCents: 12 });
    // Biology's class total is exactly its students' and teacher's use in Biology.
    const biology = (await ledger.usageEvents()).filter((event) => event.workspace.kind === "course" && event.workspace.offeringId === "off_nf-bio-fall-p2");
    expect(report.byOffering["off_nf-bio-fall-p2"]).toMatchObject({
      requests: biology.length,
      usageCents: biology.reduce((total, event) => total + event.cents, 0),
      outputTokens: biology.reduce((total, event) => total + event.outputTokens, 0),
    });
    expect(report.byOffering["off_nf-bio-fall-p2"]).toMatchObject({ requests: 4, usageCents: 132 });
    expect(report.personal).toMatchObject({ requests: 1, usageCents: 5 });
    expect(report.byModel["openai/gpt-mini-example"]).toMatchObject({ requests: 2, usageCents: 17 });

    // Pool balances agree with the report's per-pool totals.
    const balances = await ledger.poolBalances("2026-10");
    for (const [poolId, totals] of Object.entries(report.byPool)) expect(balances[poolId]!.chargedCents).toBe(totals.totalCents);
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
      "req-d1,2026-10-06,openai,gpt-mini-example,0.095", // 9.5 cents rounds up to 10: estimated 12
      "req-failed,2026-10-06,anthropic,claude-sonnet-example,0.03", // voided, yet billed
    ].join("\n"));
    const result = await ledger.reconcile("bill-2026-10", bill);

    expect(result.lines.map((line) => [line.basis.kind === "request" && line.basis.requestId, line.estimatedCents, line.actualCents, line.varianceCents]))
      .toEqual([["req-a1", 40, 47, 7], ["req-e1", 30, 30, 0], ["req-d1", 12, 10, -2], ["req-failed", 0, 3, 3]]);
    expect(result.totals).toEqual({ estimatedCents: 82, actualCents: 90, varianceCents: 8, adjustmentCents: 8 });
    expect(result.adjustments.map((adjustment) => [adjustment.basis.kind === "request" && adjustment.basis.requestId, adjustment.poolId, adjustment.deltaCents, adjustment.attribution?.principalId]))
      .toEqual([
        ["req-a1", "fpl_nf-bio-fall", 7, "prn_nf-student-amara"],
        ["req-d1", "fpl_nf-bio-fall", -2, "prn_nf-student-dmitri"],
        ["req-failed", "fpl_nf-high", 3, "prn_nf-student-dmitri"],
      ]);

    // History is appended to, never edited.
    const after = await ledger.entries();
    expect(after.slice(0, historyBefore.length)).toEqual(historyBefore);
    expect(after.slice(historyBefore.length).every((entry) => entry.type === "adjustment")).toBe(true);

    const report = await ledger.report();
    expectBreakdownsReconcile(report);
    expect(report.byPrincipal["prn_nf-student-amara"]).toMatchObject({ usageCents: 70, adjustmentCents: 7, totalCents: 77 });
    expect(report.byPrincipal["prn_nf-student-dmitri"]).toMatchObject({ usageCents: 12, adjustmentCents: 1, totalCents: 13 });
    const balances = await ledger.poolBalances("2026-10");
    expect(balances["fpl_nf-bio-fall"]!.chargedCents).toBe(report.byPool["fpl_nf-bio-fall"]!.totalCents);
  });

  it("is idempotent: re-importing the same bill adds nothing, and a changed bill needs a new run ID", async () => {
    const { ledger } = await aMonthOfUse();
    const csv = "request_id,date,provider,model,cost_usd\nreq-a1,2026-10-05,anthropic,claude-sonnet-example,0.47";
    await ledger.reconcile("bill-1", parseCostExportCsv(csv));
    const count = (await ledger.entries()).length;

    const again = await ledger.reconcile("bill-1", parseCostExportCsv(csv));
    expect(again.adjustments).toEqual([]);
    expect(again.lines[0]).toMatchObject({ varianceCents: 7, priorAdjustmentCents: 7, adjustmentCents: 0 });
    expect(await ledger.reconcile("bill-1-reimport", parseCostExportCsv(csv))).toMatchObject({ adjustments: [] });
    expect((await ledger.entries()).length).toBe(count);

    const corrected = parseCostExportCsv(csv.replace("0.47", "0.50"));
    await expect(ledger.reconcile("bill-1", corrected)).rejects.toMatchObject({ code: "conflict" });
    const correction = await ledger.reconcile("bill-1-corrected", corrected);
    expect(correction.adjustments.map((adjustment) => adjustment.deltaCents)).toEqual([3]);
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
    expect(result.lines).toEqual([expect.objectContaining({ estimatedCents: 113, actualCents: 123, varianceCents: 10, adjustmentCents: 10 })]);
    expect(result.adjustments.map((adjustment) => [adjustment.poolId, adjustment.deltaCents, adjustment.attribution]))
      .toEqual([["fpl_nf-bio-fall", 6, undefined], ["fpl_nf-high", 4, undefined]]);
    // A billed day with no ledger usage cannot be attributed to a pool; it is reported, not adjusted.
    expect(result.unmatched).toEqual([{ model: SONNET, day: "2026-10-07", actualCents: 5 }]);

    const report = await ledger.report();
    expectBreakdownsReconcile(report);
    expect(report.unattributed.adjustmentCents).toBe(10);
    expect(report.district.totalCents).toBe(190);
  });

  it("leaves still-held requests for a later run", async () => {
    const { ledger } = harness();
    await ledger.reserve("req-open", AMARA, BIO_FALL, SONNET, 50);
    const result = await ledger.reconcile("bill-1", parseCostExportCsv("request_id,date,provider,model,cost_usd\nreq-open,2026-10-05,anthropic,claude-sonnet-example,0.20"));
    expect(result).toMatchObject({ unsettledRequestIds: ["req-open"], adjustments: [], lines: [] });
  });

  it("rejects a malformed export as a whole, naming the line", () => {
    const header = "request_id,date,provider,model,cost_usd";
    expect(() => parseCostExportCsv("id,date,cost\n")).toThrow(/header/);
    expect(() => parseCostExportCsv(`${header}\nreq-1,2026-10-05,anthropic,m,0.1\nreq-2,2026-10-05,mystery,m,0.1`)).toThrow(/line 3/);
    expect(() => parseCostExportCsv(`${header}\nreq-1,2026-10-05,anthropic,m,-0.10`)).toThrow(/line 2/);
    expect(() => parseCostExportCsv(`${header}\nreq-1,2026-10-05,anthropic,m,0.1234567`)).toThrow();
    expect(() => parseCostExportJson({ format: "schoolos.ai-cost-export.v1", rows: [{ date: "2026-10-05", provider: "openai", model: "m", cost_usd: 0.1 }] })).toThrow();
    expect(() => parseCostExportJson({ format: "schoolos.ai-cost-export.v1", rows: [], extra: true })).toThrow();
  });
});
