import { describe, expect, it } from "vitest";
import type { PrincipalId } from "@educateos/contracts";
import { cloudflareAccountFacts, NO_ACCOUNT_FACTS_REASON, usdNanoFromCents, usdNanoValue, type FundingPool, type ModelRef } from "@educateos/ai-governance";
import { bootDistrict, expectError, NF, NORTHFIELD, recordAiRequest, type TestDistrict } from "./support.ts";

const SYNTHETIC: ModelRef = { provider: "cloudflare", modelId: "synthetic-model" };
const MODERATOR: ModelRef = { provider: "cloudflare", modelId: "clef-flash-example" };
const DISTRICT = { level: "district", districtId: NORTHFIELD.district.id } as const;

/** A course pool of $100, a personal pool of $2 and a safety reserve of $3. */
const POOLS: FundingPool[] = [
  { id: "fpl_courses" as never, name: "Course AI", purpose: "course", scope: DISTRICT, monthlyAllocationUsdNano: usdNanoFromCents(10_000), allowedModels: [SYNTHETIC] },
  { id: "fpl_personal" as never, name: "Personal AI", purpose: "personal", scope: DISTRICT, monthlyAllocationUsdNano: usdNanoFromCents(200), allowedModels: [SYNTHETIC] },
  { id: "fpl_safety" as never, name: "Safety reserve", purpose: "safety", scope: DISTRICT, monthlyAllocationUsdNano: usdNanoFromCents(300), allowedModels: [MODERATOR] },
];

/** A moderation check that cost $0.000038. */
const CHECK_COST = "38000";

const ROUTES = ["admin.aiFunding", "admin.aiCostSummary", "admin.aiProjection"] as const;

async function boot(options: Parameters<typeof bootDistrict>[1] = {}): Promise<TestDistrict> {
  return bootDistrict(NORTHFIELD, {
    fundingPools: POOLS,
    modelCatalog: [{ ...SYNTHETIC, mode: "enabled" }, { ...MODERATOR, mode: "hidden" }],
    aiMonthlyDistrictCapUsdNano: usdNanoFromCents(15_000),
    // 4 days and 15 hours into October.
    now: () => new Date("2026-10-05T15:00:00.000Z"),
    ...options,
  });
}

/** Two 2¢ English requests, a $1.70 personal request, and three sub-cent moderation checks. */
async function spend(district: TestDistrict): Promise<void> {
  await recordAiRequest(district, NF.amara, NF.eng9);
  await recordAiRequest(district, NF.amara, NF.eng9);
  const governor = district.app.aiGovernor;
  const principal = (id: string) => ({ principalId: id as PrincipalId, districtId: district.app.districtId });
  const usage = { inputTokens: 40, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 };
  expect((await governor.beforeRequest({
    requestId: "req-personal",
    principal: principal(NF.elena),
    workspace: { kind: "personal" },
    model: SYNTHETIC,
    estimatedMaxUsdNano: usdNanoFromCents(180),
  })).effect).toBe("allow");
  await governor.afterResponse({ status: "completed", requestId: "req-personal", usage, actualUsdNano: usdNanoFromCents(170) });
  for (const id of ["chk-1", "chk-2", "chk-3"]) {
    expect((await governor.beforeRequest({
      requestId: id,
      principal: principal(NF.amara),
      workspace: { kind: "course", offeringId: NF.eng9 },
      model: MODERATOR,
      estimatedMaxUsdNano: "100000",
      fundingPurpose: "safety",
    })).effect).toBe("allow");
    await governor.afterResponse({ status: "completed", requestId: id, usage, actualUsdNano: CHECK_COST });
  }
}

describe("AI budget routes", () => {
  it("answer only district administrators", async () => {
    const district = await boot();
    const staff = { teacher: district.tokenFor(NF.rivera), schoolAdmin: district.tokenFor("prn_nf-principal-high") };
    for (const token of Object.values(staff)) {
      for (const name of ROUTES) expectError(await district.call(token, name), 403, "forbidden");
      expectError(await district.call(token, "admin.updateFundingPools", { body: { allocations: [{ poolId: "fpl_courses", monthlyAllocationCents: 1 }] } }), 403, "forbidden");
    }
    expectError(await district.call(district.tokenFor(NF.amara), "admin.aiFunding"), 403, "forbidden");
    // Refused before anything was recorded.
    expect((await district.app.stores.fundingAllocations.list())).toStrictEqual([]);
  });

  it("report each pool's charged, held and remaining amounts and the safety reserve, to the nanodollar", async () => {
    const district = await boot();
    await spend(district);
    const { report, revision } = await district.ok(district.tokenFor(NF.admin), "admin.aiFunding");
    expect(revision).toBeUndefined();
    expect(report.period).toBe("2026-10");
    expect(report.pools).toMatchObject([
      { poolId: "fpl_courses", chargedUsdNano: "40000000", heldUsdNano: "0", remainingUsdNano: "99960000000", utilizationPercent: 0.04, threshold: "none" },
      { poolId: "fpl_personal", chargedUsdNano: "1700000000", remainingUsdNano: "300000000", utilizationPercent: 85, threshold: "warning" },
    ]);
    expect(report.safety).toMatchObject({
      pool: { poolId: "fpl_safety", monthlyAllocationUsdNano: "3000000000", chargedUsdNano: "114000", remainingUsdNano: "2999886000", threshold: "none" },
      population: { activeTeachers: 4, aiEnabledStudents: 5 },
      recommendedMinimumUsdNano: "5000000000",
      belowRecommended: true,
    });
    expect(report).toMatchObject({ generativeAllocationUsdNano: "102000000000", districtCapUsdNano: "150000000000" });
  });

  it("summarize gross model cost and safety spend, and say why there is no net estimate without account facts", async () => {
    const district = await boot();
    await spend(district);
    expect(await district.ok(district.tokenFor(NF.admin), "admin.aiCostSummary")).toStrictEqual({
      period: "2026-10",
      requests: 6,
      grossModelCostUsdNano: "1740114000",
      reconciliationAdjustmentUsdNano: "0",
      heldUsdNano: "0",
      unknownCostRequests: 0,
      safetySpendUsdNano: "114000",
      net: { status: "unavailable", reason: NO_ACCOUNT_FACTS_REASON },
    });
  });

  it("estimate the net bill once account facts are configured, with the free allowance kept apart from gross", async () => {
    const district = await boot({ cloudflareAccount: cloudflareAccountFacts("acct-northfield") });
    await spend(district);
    const { net, grossModelCostUsdNano } = await district.ok(district.tokenFor(NF.admin), "admin.aiCostSummary");
    if (net.status !== "estimated") throw new Error("expected a net estimate");
    // 158,190 neurons that day; the 10,000 included are worth $0.11. The $5 plan fee is in gross and net.
    expect(net).toMatchObject({
      grossUsageUsdNano: "6740114000",
      freeAllowanceAppliedUsdNano: "110000000",
      planFeeUsdNano: "5000000000",
      netEstimatedUsdNano: "6630114000",
    });
    expect(grossModelCostUsdNano).toBe("1740114000");
    const allocated = net.allocations.reduce((sum, a) => sum + usdNanoValue(a.netAllocatedUsdNano), 0n);
    expect(allocated.toString()).toBe(net.netEstimatedUsdNano);
  });

  it("project month-end spend by run rate and flag pools projected above 80%", async () => {
    const district = await boot();
    await spend(district);
    const projection = await district.ok(district.tokenFor(NF.admin), "admin.aiProjection");
    expect(projection).toMatchObject({ elapsedDays: 4.625, monthDays: 31, warningPercent: 80 });
    expect(projection.pools).toMatchObject([
      { poolId: "fpl_courses", projectedUsdNano: "268108109", flagged: false },
      // $1.70 × 31 / 4.625 = $11.39, over five times the $2 pool.
      { poolId: "fpl_personal", projectedUsdNano: "11394594595", projectedUtilizationPercent: 569.72, flagged: true },
      { poolId: "fpl_safety", projectedUsdNano: "764109", flagged: false },
    ]);
  });
});

describe("updating allocations", () => {
  it("records a revision the ledger enforces at once, and warns when the safety reserve is below its recommendation", async () => {
    const district = await boot();
    const admin = district.tokenFor(NF.admin);
    const result = await district.ok(admin, "admin.updateFundingPools", {
      body: { allocations: [{ poolId: "fpl_personal", monthlyAllocationCents: 150 }, { poolId: "fpl_safety", monthlyAllocationCents: 450 }] },
    });
    expect(result.changed).toBe(true);
    expect(result.warnings).toStrictEqual(["The safety reserve is $4.50 a month, below the recommended $5.00."]);
    expect(result.revision).toMatchObject({
      number: 1,
      actorPrincipalId: NF.admin,
      allocations: { fpl_courses: "100000000000", fpl_personal: "1500000000", fpl_safety: "4500000000" },
    });
    expect(result.report.pools[1]!.monthlyAllocationUsdNano).toBe("1500000000");
    expect(result.report.safety.pool!.monthlyAllocationUsdNano).toBe("4500000000");

    // The ledger reads the new allocation: a $1.60 personal request no longer fits.
    const denied = await district.app.aiGovernor.beforeRequest({
      requestId: "req-too-much",
      principal: { principalId: NF.elena as PrincipalId, districtId: district.app.districtId },
      workspace: { kind: "personal" },
      model: SYNTHETIC,
      estimatedMaxUsdNano: usdNanoFromCents(160),
    });
    expect(denied.effect).toBe("deny");

    // A second change names the revision it was made over; history is kept.
    const second = await district.ok(admin, "admin.updateFundingPools", {
      body: { allocations: [{ poolId: "fpl_safety", monthlyAllocationCents: 500 }], expectedRevisionId: result.revision!.id },
    });
    expect(second).toMatchObject({ changed: true, warnings: [], revision: { number: 2, previousRevisionId: result.revision!.id } });
    expect((await district.app.stores.fundingAllocations.list()).map((r) => r.allocations["fpl_safety" as never])).toStrictEqual(["4500000000", "5000000000"]);
  });

  it("records nothing when nothing changes", async () => {
    const district = await boot();
    const result = await district.ok(district.tokenFor(NF.admin), "admin.updateFundingPools", {
      body: { allocations: [{ poolId: "fpl_courses", monthlyAllocationCents: 10_000 }] },
    });
    expect(result).toMatchObject({ changed: false });
    expect(result.revision).toBeUndefined();
  });

  it("refuses unknown pools, negative amounts, amounts over the district cap and stale revisions", async () => {
    const district = await boot();
    const admin = district.tokenFor(NF.admin);
    const update = (body: unknown) => district.call(admin, "admin.updateFundingPools", { body: body as never });
    expectError(await update({ allocations: [{ poolId: "fpl_nope", monthlyAllocationCents: 100 }] }), 400, "validation-failed");
    expectError(await update({ allocations: [{ poolId: "fpl_safety", monthlyAllocationCents: -1 }] }), 400, "validation-failed");
    expectError(await update({ allocations: [{ poolId: "fpl_safety", monthlyAllocationCents: 1.5 }] }), 400, "validation-failed");
    expectError(await update({ allocations: [{ poolId: "fpl_safety", monthlyAllocationCents: 100 }, { poolId: "fpl_safety", monthlyAllocationCents: 200 }] }), 400, "validation-failed");

    // $149 + $2 is over the $150 cap; the safety reserve does not count against it.
    const over = await update({ allocations: [{ poolId: "fpl_courses", monthlyAllocationCents: 14_900 }] });
    expectError(over, 400, "validation-failed");
    expect((over.body as { message: string }).message).toBe("The course and personal pools would total $151.00 a month, more than the district's cap of $150.00.");
    expect((await update({ allocations: [{ poolId: "fpl_courses", monthlyAllocationCents: 14_800 }, { poolId: "fpl_safety", monthlyAllocationCents: 90_000 }] })).status).toBe(200);

    expectError(await update({ allocations: [{ poolId: "fpl_safety", monthlyAllocationCents: 600 }], expectedRevisionId: "far_stale" }), 409, "conflict");
    expect(await district.app.stores.fundingAllocations.list()).toHaveLength(1);
  });
});
