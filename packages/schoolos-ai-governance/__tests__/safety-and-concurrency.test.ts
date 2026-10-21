import { describe, expect, it } from "vitest";
import { TermId } from "@schoolos/contracts";
import {
  AiLedger,
  denialErrorCode,
  FundingPoolSet,
  LedgerEntry,
  LedgerIndex,
  ledgerGovernor,
  resolveFunding,
  usdNanoValue,
  type LedgerDecision,
  type LedgerStore,
} from "../src/index.ts";
import {
  AMARA,
  BIO_FALL,
  c,
  Clock,
  ELENA,
  FakeSource,
  harness,
  MODERATOR,
  NF,
  northfieldPools,
  paid,
  PERSONAL,
  SONNET,
  tokens,
} from "./setup.ts";

/** A Hall Monitor moderation check's hold: $0.0001. */
const CHECK = "100000";

function safety(ledger: AiLedger, requestId: string, who = AMARA, where = BIO_FALL, estimate = CHECK) {
  return ledger.reserve(requestId, who, where, MODERATOR, estimate, { fundingPurpose: "safety" });
}

function ids(result: ReturnType<typeof resolveFunding>) {
  return result.ok ? result.pools.map((pool) => pool.id) : result.reason;
}

describe("safety funding pool", () => {
  it("is district scoped, and a district has at most one", () => {
    const pools = northfieldPools();
    const safetyPool = pools.find((pool) => pool.purpose === "safety")!;
    expect(FundingPoolSet.safeParse([{ ...safetyPool, scope: { level: "school", districtId: NF, schoolId: "sch_nf-high" } }]).success).toBe(false);
    expect(FundingPoolSet.safeParse([
      { ...safetyPool, scope: { level: "offering", districtId: NF, schoolId: "sch_nf-high", offeringId: "off_nf-bio-fall-p2" } },
    ]).success).toBe(false);
    expect(FundingPoolSet.safeParse([...pools, { ...safetyPool, id: "fpl_nf-safety-2" }]).success).toBe(false);
  });

  it("funds safety requests only from the safety pool, and generative requests never from it", async () => {
    const { ledger, source } = harness();
    const pools = northfieldPools();
    expect(ids(resolveFunding(source.snapshot, pools, [], AMARA, BIO_FALL, "safety"))).toEqual(["fpl_nf-safety"]);
    expect(ids(resolveFunding(source.snapshot, pools, [], AMARA, PERSONAL, "safety"))).toEqual(["fpl_nf-safety"]);
    expect(ids(resolveFunding(source.snapshot, pools, [], AMARA, BIO_FALL))).not.toContain("fpl_nf-safety");
    expect(ids(resolveFunding(source.snapshot, pools, [], AMARA, PERSONAL))).not.toContain("fpl_nf-safety");

    // A generative request is never sent to the safety pool, even with every course pool spent
    // and a safety pool that would pay for the model.
    source.pools = northfieldPools({
      "fpl_nf-bio-fall": { monthlyAllocationUsdNano: "0" },
      "fpl_nf-high": { monthlyAllocationUsdNano: "0" },
      "fpl_nf-safety": { allowedModels: [MODERATOR, SONNET] },
    });
    expect(await ledger.reserve("req-gen", AMARA, BIO_FALL, SONNET, CHECK)).toEqual({ outcome: "denied", reason: "pool-exhausted" });
    expect(await ledger.reserve("req-gen-2", AMARA, BIO_FALL, MODERATOR, CHECK)).toEqual({ outcome: "denied", reason: "model-not-allowed" });
    const reserved = await safety(ledger, "req-mod");
    expect(reserved).toMatchObject({ outcome: "reserved", reservation: { poolId: "fpl_nf-safety", fundingPurpose: "safety" } });
    // With no safety pool configured, a safety request has nothing to draw on.
    source.pools = northfieldPools().filter((pool) => pool.purpose !== "safety");
    expect(await safety(ledger, "req-mod-2")).toEqual({ outcome: "denied", reason: "no-funding-pool" });
  });

  it("still moderates once a student's generative pool is exhausted", async () => {
    const { ledger, source } = harness();
    source.pools = northfieldPools({ "fpl_nf-bio-fall": { monthlyAllocationUsdNano: c(100) }, "fpl_nf-high": { monthlyAllocationUsdNano: "0" } });
    expect(await ledger.reserve("req-1", AMARA, BIO_FALL, SONNET, c(100))).toMatchObject({ outcome: "reserved" });
    expect(await ledger.reserve("req-2", AMARA, BIO_FALL, SONNET, c(1))).toEqual({ outcome: "denied", reason: "pool-exhausted" });
    const moderation = await safety(ledger, "req-mod");
    expect(moderation).toMatchObject({ outcome: "reserved", status: "held", reservation: { poolId: "fpl_nf-safety" } });
    await ledger.settle("req-mod", paid(tokens(1_000, 1), "38000"));
    expect((await ledger.poolBalances("2026-10"))["fpl_nf-safety"]).toMatchObject({ chargedUsdNano: "38000" });
  });

  it("is outside every principal cap, in both directions", async () => {
    const { ledger, source } = harness();
    // Amara spends her whole 400-cent cap.
    await ledger.reserve("req-1", AMARA, BIO_FALL, SONNET, c(400));
    await ledger.settle("req-1", paid(tokens(1, 1), c(400)));
    expect(await ledger.reserve("req-2", AMARA, BIO_FALL, SONNET, "1")).toEqual({ outcome: "denied", reason: "principal-cap-reached" });
    expect(await safety(ledger, "req-mod-1")).toMatchObject({ outcome: "reserved" });

    // Elena's moderation costs more than her cap would allow, and leaves the cap untouched.
    source.pools = northfieldPools({ "fpl_nf-safety": { monthlyAllocationUsdNano: c(10_000) } });
    expect(await safety(ledger, "req-mod-2", ELENA, BIO_FALL, c(500))).toMatchObject({ outcome: "reserved" });
    expect(await ledger.reserve("req-3", ELENA, BIO_FALL, SONNET, c(400))).toMatchObject({ outcome: "reserved" });
  });

  it("refuses with safety-budget-exhausted when the safety pool is spent", async () => {
    const { ledger, source } = harness();
    source.pools = northfieldPools({ "fpl_nf-safety": { monthlyAllocationUsdNano: "250000" } });
    expect(await safety(ledger, "req-mod-1")).toMatchObject({ outcome: "reserved" });
    expect(await safety(ledger, "req-mod-2")).toMatchObject({ outcome: "reserved" });
    expect(await safety(ledger, "req-mod-3")).toEqual({ outcome: "denied", reason: "safety-budget-exhausted" });
    expect(denialErrorCode("safety-budget-exhausted")).toBe("budget-exceeded");
    // Generative pools are untouched by the exhausted safety pool.
    expect(await ledger.reserve("req-gen", AMARA, BIO_FALL, SONNET, c(1))).toMatchObject({ outcome: "reserved" });
  });

  it("keeps moderating after term close, and through the governor", async () => {
    const { ledger, source } = harness();
    source.closures = [{ type: "term.closed", districtId: NF, termId: TermId.parse("trm_nf-2026-fall"), closedAt: "2026-10-05T14:00:00.000Z" }];
    expect(await ledger.reserve("req-gen", AMARA, BIO_FALL, SONNET, c(1))).toEqual({ outcome: "denied", reason: "term-closed" });
    const governor = ledgerGovernor(ledger);
    const request = { requestId: "req-mod", principal: AMARA, workspace: BIO_FALL, model: MODERATOR, estimatedMaxUsdNano: CHECK, fundingPurpose: "safety" };
    expect(await governor.beforeRequest(request)).toMatchObject({ effect: "allow", reservation: { fundingPurpose: "safety" } });
    // Reusing the request ID as a generative request is a conflict, not a second hold.
    await expect(ledger.reserve("req-mod", AMARA, BIO_FALL, MODERATOR, CHECK)).rejects.toMatchObject({ code: "conflict" });
    expect(await governor.afterResponse({ status: "completed", requestId: "req-mod", usage: tokens(1_000, 1), actualUsdNano: "38000" }))
      .toMatchObject({ outcome: "settled" });
    expect((await ledger.usageEvents())[0]).toMatchObject({ fundingPurpose: "safety", poolId: "fpl_nf-safety" });
  });
});

/** Gives other pending work a chance to run. */
function yieldToOthers(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 3)));
}

/**
 * A store that does not serialize: each step reads a snapshot, yields so other steps interleave,
 * decides on the (possibly stale) snapshot, yields again, and commits. With `checkConflicts` it is
 * an optimistic store, a correct implementation that refuses to commit over a step that committed
 * in between and retries on fresh state. Without it, it is broken, which the tests use to show
 * they would catch a store that lets decisions race.
 */
class InterleavingLedgerStore implements LedgerStore {
  readonly #entries: LedgerEntry[] = [];
  readonly #checkConflicts: boolean;
  retries = 0;

  constructor(checkConflicts: boolean) {
    this.#checkConflicts = checkConflicts;
  }

  async read(): Promise<LedgerIndex> {
    return new LedgerIndex(this.#entries);
  }

  async transact<T>(decide: (ledger: LedgerIndex) => LedgerDecision<T>): Promise<T> {
    for (;;) {
      const version = this.#entries.length;
      const snapshot = new LedgerIndex(this.#entries);
      await yieldToOthers();
      const { append, result } = decide(snapshot);
      await yieldToOthers();
      if (this.#checkConflicts && this.#entries.length !== version) {
        this.retries += 1;
        continue;
      }
      this.#entries.push(...append.map((entry) => LedgerEntry.parse(entry)));
      return result;
    }
  }
}

/** A $1.00 course pool, nothing behind it, and 100 concurrent $0.20 reservations against it. */
async function hundredConcurrentReservations(store: LedgerStore) {
  const source = new FakeSource();
  source.pools = northfieldPools({ "fpl_nf-bio-fall": { monthlyAllocationUsdNano: c(100) }, "fpl_nf-high": { monthlyAllocationUsdNano: "0" } });
  const ledger = new AiLedger({ districtId: NF, store, source, now: new Clock().now });
  const results = await Promise.all(Array.from({ length: 100 }, (_, i) => ledger.reserve(`req-${i}`, AMARA, BIO_FALL, SONNET, c(20))));
  const balance = (await ledger.poolBalances("2026-10"))["fpl_nf-bio-fall"]!;
  return { ledger, results, admitted: results.filter((result) => result.outcome === "reserved").length, balance };
}

describe("concurrency", () => {
  it("never holds more than the allocation under 100 concurrent reservations", async () => {
    // InMemoryLedgerStore runs each decide-and-append synchronously on one index, so steps cannot
    // interleave even under Promise.all: transact is the serialization point.
    const { ledger, results, admitted, balance } = await hundredConcurrentReservations(harness().store);
    expect(admitted).toBe(5);
    expect(results.filter((result) => result.outcome === "denied" && result.reason === "pool-exhausted")).toHaveLength(95);
    expect(usdNanoValue(balance.chargedUsdNano)).toBeLessThanOrEqual(usdNanoValue(balance.allocationUsdNano));

    // Settling below the hold frees room, but charged plus held stays within the allocation.
    for (const [i, result] of results.entries()) {
      if (result.outcome === "reserved") await ledger.settle(`req-${i}`, paid(tokens(10, 10), c(10)));
    }
    const more = await Promise.all(Array.from({ length: 10 }, (_, i) => ledger.reserve(`req-more-${i}`, AMARA, BIO_FALL, SONNET, c(20))));
    expect(more.filter((result) => result.outcome === "reserved")).toHaveLength(2);
    expect((await ledger.poolBalances("2026-10"))["fpl_nf-bio-fall"]!.remainingUsdNano).toBe(c(10));
  });

  it("holds the invariant with a store whose steps interleave, when it rejects stale commits", async () => {
    const store = new InterleavingLedgerStore(true);
    const { admitted, balance } = await hundredConcurrentReservations(store);
    expect(admitted).toBe(5);
    expect(usdNanoValue(balance.chargedUsdNano)).toBeLessThanOrEqual(usdNanoValue(balance.allocationUsdNano));
    expect(store.retries).toBeGreaterThan(0);
  });

  it("would catch a store that lets steps race", async () => {
    const { admitted, balance } = await hundredConcurrentReservations(new InterleavingLedgerStore(false));
    expect(admitted).toBeGreaterThan(5);
    expect(usdNanoValue(balance.chargedUsdNano)).toBeGreaterThan(usdNanoValue(balance.allocationUsdNano));
  });

  it("serializes safety and generative reservations against their own pools", async () => {
    const { ledger, source } = harness();
    source.pools = northfieldPools({ "fpl_nf-safety": { monthlyAllocationUsdNano: "500000" } });
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0 ? safety(ledger, `req-mod-${i}`) : ledger.reserve(`req-gen-${i}`, AMARA, BIO_FALL, SONNET, c(1))));
    const reasons = results.map((result) => (result.outcome === "denied" ? result.reason : result.reservation.poolId));
    expect(reasons.filter((reason) => reason === "fpl_nf-safety")).toHaveLength(5);
    expect(reasons.filter((reason) => reason === "safety-budget-exhausted")).toHaveLength(5);
    expect(reasons.filter((reason) => reason === "fpl_nf-bio-fall")).toHaveLength(10);
  });
});
