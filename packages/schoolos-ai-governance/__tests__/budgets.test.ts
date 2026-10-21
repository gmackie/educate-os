import { describe, expect, it } from "vitest";
import {
  NO_ACCOUNT_FACTS_REASON,
  aiPopulation,
  budgetThreshold,
  cloudflareAccountFacts,
  recommendedSafetyReserveUsdNano,
  type AiLedger,
} from "../src/index.ts";
import { AMARA, BIO_FALL, c, ENG9, harness, MINI, MODERATOR, northfieldPools, paid, PERSONAL, SONNET, tokens } from "./setup.ts";

/** A Hall Monitor check that cost $0.000038: far below a cent. */
const CHECK_COST = "38000";

/**
 * A month-to-date ledger at 2026-10-05T15:00Z: a settled 30¢ Biology request, a 20¢ Biology request
 * still in flight, a voided one, an English request whose cost never came back (charged at its 10¢
 * hold), a 60¢ personal request and three sub-cent moderation checks.
 */
async function monthToDate(ledger: AiLedger): Promise<void> {
  await ledger.reserve("req-bio", AMARA, BIO_FALL, SONNET, c(50));
  await ledger.settle("req-bio", paid(tokens(100, 50), c(30)));
  await ledger.reserve("req-bio-held", AMARA, BIO_FALL, SONNET, c(20));
  await ledger.reserve("req-bio-voided", AMARA, BIO_FALL, SONNET, c(40));
  await ledger.void("req-bio-voided");
  await ledger.reserve("req-eng-lost", AMARA, ENG9, SONNET, c(10));
  await ledger.settle("req-eng-lost", { attempts: [{ attemptIndex: 0, state: "unknown" }] });
  await ledger.reserve("req-personal", AMARA, PERSONAL, MINI, c(80));
  await ledger.settle("req-personal", paid(tokens(100, 50), c(60)));
  for (const id of ["chk-1", "chk-2", "chk-3"]) {
    await ledger.reserve(id, AMARA, BIO_FALL, MODERATOR, "100000", { fundingPurpose: "safety" });
    await ledger.settle(id, paid(tokens(40, 1), CHECK_COST));
  }
}

describe("budget thresholds", () => {
  it("is info from 70%, warning from 85%, critical from 95% and exhausted from 100%", () => {
    const at = (cents: number) => budgetThreshold(c(cents), c(100));
    expect([at(69), at(70), at(84), at(85), at(94), at(95), at(99), at(100), at(130)])
      .toStrictEqual(["none", "info", "info", "warning", "warning", "critical", "critical", "exhausted", "exhausted"]);
    expect(budgetThreshold("0", "0")).toBe("none");
    expect(budgetThreshold("1", "0")).toBe("exhausted");
  });
});

describe("the safety reserve recommendation", () => {
  it("is max($5, $0.10 per active teacher and AI-enabled student)", () => {
    expect(recommendedSafetyReserveUsdNano({ activeTeachers: 4, aiEnabledStudents: 5 })).toBe("5000000000");
    // The source plan's 120-enrollment co-op: 12 teachers and 60 AI-enabled students.
    expect(recommendedSafetyReserveUsdNano({ activeTeachers: 12, aiEnabledStudents: 60 })).toBe("7200000000");
  });

  it("counts the students a funded generative pool can serve, by the ledger's own rules", () => {
    const { source } = harness();
    // With the personal pool, every student is AI-enabled.
    expect(aiPopulation(source.snapshot, northfieldPools(), [])).toStrictEqual({ activeTeachers: 4, aiEnabledStudents: 5 });
    // Without it, only students in a class a course pool covers: Biology and the high school.
    const coursesOnly = northfieldPools({ "fpl_nf-personal": { monthlyAllocationUsdNano: "0" } });
    expect(aiPopulation(source.snapshot, coursesOnly, [])).toStrictEqual({ activeTeachers: 4, aiEnabledStudents: 3 });
  });
});

describe("the funding report", () => {
  it("keeps charged and held apart, excludes voided holds, and reports the safety pool separately to the nanodollar", async () => {
    const { ledger } = harness();
    await monthToDate(ledger);
    const report = await ledger.fundingReport({ districtCapUsdNano: c(5000) });
    expect(report.period).toBe("2026-10");
    expect(report.pools.map((pool) => pool.poolId)).toStrictEqual(["fpl_nf-bio-fall", "fpl_nf-bio-spring", "fpl_nf-high", "fpl_nf-personal"]);
    expect(report.pools[0]).toMatchObject({
      chargedUsdNano: "300000000",
      heldUsdNano: "200000000",
      remainingUsdNano: "9500000000",
      utilizationPercent: 5,
      threshold: "none",
    });
    // The lost request is charged at its hold until reconciliation.
    expect(report.pools[2]).toMatchObject({ chargedUsdNano: "100000000", heldUsdNano: "0", utilizationPercent: 2 });
    expect(report.pools[3]).toMatchObject({ chargedUsdNano: "600000000", utilizationPercent: 20 });
    expect(report.safety.pool).toMatchObject({
      poolId: "fpl_nf-safety",
      monthlyAllocationUsdNano: "1000000000",
      chargedUsdNano: "114000",
      heldUsdNano: "0",
      remainingUsdNano: "999886000",
      utilizationPercent: 0.01,
      threshold: "none",
    });
    expect(report.safety).toMatchObject({
      population: { activeTeachers: 4, aiEnabledStudents: 5 },
      recommendedMinimumUsdNano: "5000000000",
      belowRecommended: true,
    });
    expect(report.generativeAllocationUsdNano).toBe("28000000000");
    expect(report.districtCapUsdNano).toBe("50000000000");
  });

  it("starts each month afresh", async () => {
    const { ledger, clock } = harness();
    await monthToDate(ledger);
    clock.set("2026-11-01T00:00:00.000Z");
    const report = await ledger.fundingReport();
    expect(report.pools.every((pool) => pool.chargedUsdNano === "0" && pool.heldUsdNano === "0")).toBe(true);
    expect(report.safety.pool?.chargedUsdNano).toBe("0");
  });
});

describe("the month-end projection", () => {
  it("extends month-to-date spend linearly over the month, rounding up, and flags pools projected above 80%", async () => {
    const { ledger } = harness();
    await monthToDate(ledger);
    const projection = await ledger.projection();
    // 4 days 15 hours of a 31-day October.
    expect(projection).toMatchObject({ period: "2026-10", elapsedDays: 4.625, monthDays: 31, warningPercent: 80 });
    const pool = (id: string) => projection.pools.find((p) => p.poolId === id)!;
    // 50¢ (30¢ settled, 20¢ held) × 31 / 4.625 = $3.351351351…, a third of $10.
    expect(pool("fpl_nf-bio-fall")).toMatchObject({
      monthToDateUsdNano: "500000000",
      projectedUsdNano: "3351351352",
      projectedUtilizationPercent: 33.51,
      flagged: false,
    });
    // 60¢ × 31 / 4.625 = $4.02, over the $3 personal pool.
    expect(pool("fpl_nf-personal")).toMatchObject({ projectedUsdNano: "4021621622", projectedUtilizationPercent: 134.05, flagged: true });
    expect(pool("fpl_nf-safety")).toMatchObject({ monthToDateUsdNano: "114000", projectedUsdNano: "764109", flagged: false });
    expect(pool("fpl_nf-bio-spring")).toMatchObject({ projectedUsdNano: "0", flagged: false });
  });

  it("takes the run rate over at least one day", async () => {
    const { ledger, clock } = harness();
    clock.set("2026-10-01T01:00:00.000Z");
    await ledger.reserve("req-early", AMARA, PERSONAL, MINI, c(10));
    await ledger.settle("req-early", paid(tokens(10, 10), c(10)));
    const personal = (await ledger.projection()).pools.find((p) => p.poolId === "fpl_nf-personal")!;
    expect(personal).toMatchObject({ projectedUsdNano: "3100000000", flagged: true });
  });
});

describe("the cost summary", () => {
  it("reports gross model cost, safety spend and unknown-cost liabilities, and says why there is no net estimate", async () => {
    const { ledger } = harness();
    await monthToDate(ledger);
    expect(await ledger.costSummary()).toStrictEqual({
      period: "2026-10",
      requests: 6,
      grossModelCostUsdNano: "1000114000",
      reconciliationAdjustmentUsdNano: "0",
      heldUsdNano: "200000000",
      unknownCostRequests: 1,
      safetySpendUsdNano: "114000",
      net: { status: "unavailable", reason: NO_ACCOUNT_FACTS_REASON },
    });
  });

  it("applies the account's allowance and plan fee once, and shares the net out by pool", async () => {
    const { ledger } = harness();
    await monthToDate(ledger);
    const { net } = await ledger.costSummary(cloudflareAccountFacts("acct-district"));
    // Moderation is Workers AI: 3 neurons a check (38,000 at 11,000 a neuron, rounded down), all
    // within the free daily allowance, worth 99,000. Anthropic and OpenAI pass through at gross.
    // The $5 plan fee is shared evenly by the four pools that used the account.
    expect(net).toStrictEqual({
      status: "estimated",
      accountId: "acct-district",
      grossUsageUsdNano: "5900114000",
      freeAllowanceAppliedUsdNano: "99000",
      planFeeUsdNano: "5000000000",
      netEstimatedUsdNano: "5900015000",
      allocations: [
        { poolId: "fpl_nf-bio-fall", grossUsageUsdNano: "300000000", netAllocatedUsdNano: "1550000000" },
        { poolId: "fpl_nf-high", grossUsageUsdNano: "0", netAllocatedUsdNano: "1250000000" },
        { poolId: "fpl_nf-personal", grossUsageUsdNano: "600000000", netAllocatedUsdNano: "1850000000" },
        { poolId: "fpl_nf-safety", grossUsageUsdNano: "114000", netAllocatedUsdNano: "1250015000" },
      ],
      unknownCostRequests: 1,
    });
  });
});
