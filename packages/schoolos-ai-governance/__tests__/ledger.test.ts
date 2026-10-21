import { describe, expect, it } from "vitest";
import { SchoolOsError, TermId } from "@schoolos/contracts";
import {
  AMARA,
  BIO_FALL,
  BIO_SPRING,
  CHIDI,
  DMITRI,
  ELENA,
  ENG9,
  GEMINI,
  harness,
  MATH7,
  MINI,
  NF,
  northfieldPools,
  OPUS,
  PERSONAL,
  SONNET,
  tokens,
} from "./setup.ts";

describe("reserve, settle and void", () => {
  it("holds the estimate, then charges the actual cost and releases the rest", async () => {
    const { ledger } = harness();
    const reserved = await ledger.reserve("req-1", AMARA, BIO_FALL, SONNET, 120);
    expect(reserved).toMatchObject({ outcome: "reserved", replayed: false, status: "held" });
    expect((await ledger.poolBalances("2026-10"))["fpl_nf-bio-fall"]).toMatchObject({ chargedCents: 120, remainingCents: 880 });

    await ledger.settle("req-1", tokens(900, 300, 100), 45);
    expect((await ledger.poolBalances("2026-10"))["fpl_nf-bio-fall"]).toMatchObject({ chargedCents: 45, remainingCents: 955 });
  });

  it("releases a failed request's hold entirely", async () => {
    const { ledger } = harness();
    await ledger.reserve("req-1", AMARA, BIO_FALL, SONNET, 120);
    expect(await ledger.void("req-1")).toEqual({ outcome: "voided", replayed: false });
    expect((await ledger.poolBalances("2026-10"))["fpl_nf-bio-fall"]!.chargedCents).toBe(0);
    expect(await ledger.void("req-1")).toEqual({ outcome: "voided", replayed: true });
    expect(await ledger.settle("req-1", tokens(1, 1), 5)).toEqual({ outcome: "already-voided" });
    expect(await ledger.void("req-unknown")).toEqual({ outcome: "not-found" });
  });

  it("refuses to settle a request that was never reserved", async () => {
    const { ledger } = harness();
    await expect(ledger.settle("req-ghost", tokens(1, 1), 5)).rejects.toMatchObject({ code: "not-found" });
  });
});

describe("idempotent retry", () => {
  it("bills a duplicate retry once", async () => {
    const { ledger } = harness();
    const first = await ledger.reserve("req-retry", AMARA, BIO_FALL, SONNET, 100);
    const retry = await ledger.reserve("req-retry", AMARA, BIO_FALL, SONNET, 100);
    expect(retry).toMatchObject({ outcome: "reserved", replayed: true, status: "held" });
    expect(retry.outcome === "reserved" && first.outcome === "reserved" && retry.reservation).toEqual(
      first.outcome === "reserved" && first.reservation);

    const settled = await ledger.settle("req-retry", tokens(500, 200), 60);
    const again = await ledger.settle("req-retry", tokens(500, 200), 60);
    expect(again).toEqual({ outcome: "settled", settlement: settled.outcome === "settled" && settled.settlement, replayed: true });
    // A late retry with different numbers cannot change what was billed.
    await ledger.settle("req-retry", tokens(9_000, 9_000), 999);
    expect(await ledger.void("req-retry")).toEqual({ outcome: "already-settled" });
    expect(await ledger.reserve("req-retry", AMARA, BIO_FALL, SONNET, 100)).toMatchObject({ replayed: true, status: "settled" });

    const report = await ledger.report();
    expect(report.district).toMatchObject({ requests: 1, usageCents: 60, inputTokens: 500 });
    expect((await ledger.entries()).map((entry) => entry.type)).toEqual(["reservation", "settlement"]);
  });

  it("refuses to reuse a request ID for a different principal, model or estimate", async () => {
    const { ledger } = harness();
    await ledger.reserve("req-1", AMARA, BIO_FALL, SONNET, 100);
    for (const attempt of [
      () => ledger.reserve("req-1", ELENA, BIO_FALL, SONNET, 100),
      () => ledger.reserve("req-1", AMARA, BIO_FALL, MINI, 100),
      () => ledger.reserve("req-1", AMARA, BIO_FALL, SONNET, 101),
      () => ledger.reserve("req-1", AMARA, ENG9, SONNET, 100),
    ]) {
      const error = await attempt().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SchoolOsError);
      expect((error as SchoolOsError).code).toBe("conflict");
    }
  });

  it("holds once when the same request races itself", async () => {
    const { ledger } = harness();
    const results = await Promise.all(Array.from({ length: 5 }, () => ledger.reserve("req-race", AMARA, BIO_FALL, SONNET, 100)));
    expect(results.filter((result) => result.outcome === "reserved" && !result.replayed)).toHaveLength(1);
    expect((await ledger.poolBalances("2026-10"))["fpl_nf-bio-fall"]!.chargedCents).toBe(100);
  });
});

describe("caps and balances", () => {
  it("blocks new spend once the principal's monthly cap would be exceeded", async () => {
    const { ledger, clock } = harness();
    // The floor caps each principal at 400 cents a month, across every pool.
    await ledger.reserve("req-1", AMARA, BIO_FALL, SONNET, 300);
    await ledger.settle("req-1", tokens(1, 1), 300);
    expect(await ledger.reserve("req-2", AMARA, ENG9, SONNET, 150)).toEqual({ outcome: "denied", reason: "principal-cap-reached" });
    expect(await ledger.reserve("req-3", AMARA, ENG9, SONNET, 100)).toMatchObject({ outcome: "reserved" });
    // Another student is unaffected.
    expect(await ledger.reserve("req-4", ELENA, BIO_FALL, SONNET, 150)).toMatchObject({ outcome: "reserved" });
    // The cap renews with the month.
    clock.set("2026-11-02T09:00:00.000Z");
    expect(await ledger.reserve("req-5", AMARA, ENG9, SONNET, 150)).toMatchObject({ outcome: "reserved" });
  });

  it("applies a narrower scope's lower cap", async () => {
    const { ledger, source } = harness();
    source.offeringPolicy["off_nf-bio-fall-p2"] = { aiMonthlyCapCentsPerPrincipal: 50 };
    expect(await ledger.reserve("req-1", AMARA, BIO_FALL, SONNET, 60)).toEqual({ outcome: "denied", reason: "principal-cap-reached" });
    expect(await ledger.reserve("req-2", AMARA, ENG9, SONNET, 60)).toMatchObject({ outcome: "reserved" });
  });

  it("never interrupts settlement, even past the cap and the pool allocation", async () => {
    const { ledger } = harness();
    await ledger.reserve("req-1", AMARA, BIO_FALL, SONNET, 390);
    const settled = await ledger.settle("req-1", tokens(80_000, 20_000), 1_200);
    expect(settled).toMatchObject({ outcome: "settled", replayed: false });
    expect((await ledger.poolBalances("2026-10"))["fpl_nf-bio-fall"]!.remainingCents).toBe(-200);
    expect(await ledger.reserve("req-2", AMARA, BIO_FALL, SONNET, 1)).toEqual({ outcome: "denied", reason: "principal-cap-reached" });
  });

  it("draws on the next pool when the class pool runs dry, and denies an underfunded student", async () => {
    const { ledger, source } = harness();
    source.pools = northfieldPools({ "fpl_nf-bio-fall": { monthlyAllocationCents: 150 }, "fpl_nf-high": { monthlyAllocationCents: 100 } });
    const first = await ledger.reserve("req-1", AMARA, BIO_FALL, SONNET, 120);
    expect(first.outcome === "reserved" && first.reservation.poolId).toBe("fpl_nf-bio-fall");
    const second = await ledger.reserve("req-2", ELENA, BIO_FALL, SONNET, 90);
    expect(second.outcome === "reserved" && second.reservation.poolId).toBe("fpl_nf-high");
    // Neither pool has 80 cents left, though Dmitri is well under his own cap.
    expect(await ledger.reserve("req-3", DMITRI, BIO_FALL, SONNET, 80)).toEqual({ outcome: "denied", reason: "pool-exhausted" });
    // A model only the drained class pool allows has nowhere else to go.
    expect(await ledger.reserve("req-4", DMITRI, BIO_FALL, MINI, 40)).toEqual({ outcome: "denied", reason: "pool-exhausted" });
    // Chidi's class has no pool at all.
    expect(await ledger.reserve("req-5", CHIDI, MATH7, SONNET, 10))
      .toEqual({ outcome: "denied", reason: "no-funding-pool" });
  });

  it("lets concurrent reservations spend a balance only once", async () => {
    const { ledger, source } = harness();
    source.pools = northfieldPools({ "fpl_nf-bio-fall": { monthlyAllocationCents: 100 }, "fpl_nf-high": { monthlyAllocationCents: 0 } });
    const results = await Promise.all([AMARA, ELENA, DMITRI].map((who, i) => ledger.reserve(`req-${i}`, who, BIO_FALL, SONNET, 100)));
    expect(results.filter((result) => result.outcome === "reserved")).toHaveLength(1);
    expect(results.filter((result) => result.outcome === "denied")).toHaveLength(2);
  });

  it("refuses a disabled or unlisted model before holding anything", async () => {
    const { ledger, source } = harness();
    expect(await ledger.reserve("req-1", AMARA, BIO_FALL, GEMINI, 10)).toEqual({ outcome: "denied", reason: "model-disabled" });
    expect(await ledger.reserve("req-2", AMARA, BIO_FALL, OPUS, 10)).toEqual({ outcome: "denied", reason: "model-not-allowed" });
    source.floor = { ...source.floor, aiSpending: "disabled" };
    expect(await ledger.reserve("req-3", AMARA, PERSONAL, MINI, 10)).toEqual({ outcome: "denied", reason: "ai-spending-disabled" });
    expect(await ledger.entries()).toEqual([]);
  });

  it("refuses principals from another district", async () => {
    const { ledger } = harness();
    const outsider = { principalId: AMARA.principalId, districtId: "dst_riverbend" as typeof NF };
    expect(await ledger.reserve("req-1", outsider, PERSONAL, MINI, 10)).toEqual({ outcome: "denied", reason: "cross-district" });
  });
});

describe("term close", () => {
  it("denies a stale course budget after term close but still settles requests already in flight", async () => {
    const { ledger, source } = harness();
    expect(await ledger.reserve("req-spring", AMARA, BIO_SPRING, SONNET, 10)).toEqual({ outcome: "denied", reason: "term-closed" });

    await ledger.reserve("req-inflight", AMARA, BIO_FALL, SONNET, 50);
    source.closures = [{ type: "term.closed", districtId: NF, termId: TermId.parse("trm_nf-2026-fall"), closedAt: "2026-10-05T16:00:00.000Z" }];
    expect(await ledger.reserve("req-after", AMARA, BIO_FALL, SONNET, 50)).toEqual({ outcome: "denied", reason: "term-closed" });
    expect(await ledger.settle("req-inflight", tokens(10, 10), 20)).toMatchObject({ outcome: "settled" });
    // Personal work goes on.
    expect(await ledger.reserve("req-personal", AMARA, PERSONAL, MINI, 50)).toMatchObject({ outcome: "reserved" });
  });
});
