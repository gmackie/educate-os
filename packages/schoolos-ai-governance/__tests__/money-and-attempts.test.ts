import { describe, expect, it } from "vitest";
import {
  AiLedger,
  addUsdNano,
  ceilUsdNanoToCents,
  compareUsdNano,
  formatUsdNanoAsDecimalUsd,
  InMemoryLedgerStore,
  LedgerEntry,
  ledgerGovernor,
  normalizeTokenUsage,
  parseCostExportCsv,
  subUsdNano,
  sumUsdNano,
  UsdNano,
  usdNanoFromCents,
  usdNanoFromDecimalUsd,
  usdNanoFromRational,
} from "../src/index.ts";
import { AMARA, BIO_FALL, c, Clock, FakeSource, harness, NF, paid, SONNET, tokens } from "./setup.ts";

/** The cost of one Hall Monitor moderation check: $0.000038. */
const MODERATION = "38000";

describe("UsdNano", () => {
  it("is a canonical decimal integer string", () => {
    for (const ok of ["0", "1", "38000", "123456789012345678901234567890"]) expect(UsdNano.safeParse(ok).success).toBe(true);
    for (const bad of ["", "-1", "01", "1.5", "1e9", " 1", 38000]) expect(UsdNano.safeParse(bad).success).toBe(false);
  });

  it("does exact integer arithmetic", () => {
    expect(addUsdNano("38000", "2")).toBe("38002");
    expect(subUsdNano("1", "38000")).toBe("-37999");
    expect(sumUsdNano(["9007199254740993", "9007199254740993"])).toBe("18014398509481986");
    expect([compareUsdNano("2", "10"), compareUsdNano("10", "10"), compareUsdNano("10", "-2")]).toEqual([-1, 0, 1]);
    expect(usdNanoFromCents(400)).toBe("4000000000");
    expect(() => usdNanoFromCents(1.5)).toThrow();
  });

  it("rounds up wherever it must round", () => {
    expect([ceilUsdNanoToCents("0"), ceilUsdNanoToCents("1"), ceilUsdNanoToCents("38000000"), ceilUsdNanoToCents("40000000")]).toEqual([0, 1, 4, 4]);
    expect(ceilUsdNanoToCents("-25000000")).toBe(-2);
    // 1,000 tokens at $0.038 per million tokens is 38,000 nanodollars; one more token rounds up.
    expect(usdNanoFromRational(1_000n * 38_000_000n, 1_000_000n)).toBe(MODERATION);
    expect(usdNanoFromRational(1_001n * 38_000_000n, 1_000_000n)).toBe("38038");
    expect(usdNanoFromRational(1n, 3n)).toBe("1");
    expect(usdNanoFromRational(0n, 3n)).toBe("0");
  });

  it("converts decimal dollars exactly, both ways", () => {
    expect(usdNanoFromDecimalUsd("0.000038")).toBe(MODERATION);
    expect(usdNanoFromDecimalUsd("12")).toBe("12000000000");
    expect(usdNanoFromDecimalUsd("0.000000001")).toBe("1");
    expect(() => usdNanoFromDecimalUsd("0.0000000001")).toThrow();
    expect(formatUsdNanoAsDecimalUsd(MODERATION)).toBe("0.000038000");
    expect(formatUsdNanoAsDecimalUsd("-25000000")).toBe("-0.025000000");
  });
});

describe("token usage normalization", () => {
  it("never counts cache reads twice", () => {
    // OpenAI-style: the prompt total already contains the cached tokens.
    expect(normalizeTokenUsage({ inputTokens: 1_000, outputTokens: 50, cacheReadTokens: 800, inputIncludesCache: true }))
      .toEqual({ inputTokens: 200, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 0 });
    // Anthropic-style: input excludes cache reads and writes, so it is kept as reported.
    expect(normalizeTokenUsage({ inputTokens: 200, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 100, inputIncludesCache: false }))
      .toEqual({ inputTokens: 200, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 100 });
  });

  it("refuses a total smaller than its cached part", () => {
    expect(() => normalizeTokenUsage({ inputTokens: 100, outputTokens: 1, cacheReadTokens: 800, inputIncludesCache: true }))
      .toThrow(/inconsistent/);
  });
});

describe("settlement idempotency and attempts", () => {
  it("charges once for ten duplicate settlements", async () => {
    const { ledger } = harness();
    await ledger.reserve("req-dup", AMARA, BIO_FALL, SONNET, c(10));
    const results = await Promise.all(Array.from({ length: 10 }, () => ledger.settle("req-dup", paid(tokens(100, 20), "70000"))));
    expect(results.filter((result) => result.outcome === "settled" && !result.replayed)).toHaveLength(1);
    expect((await ledger.entries()).filter((entry) => entry.type === "settlement")).toHaveLength(1);
    expect((await ledger.poolBalances("2026-10"))["fpl_nf-bio-fall"]!.chargedUsdNano).toBe("70000");
    expect((await ledger.report()).district).toMatchObject({ requests: 1, attempts: 1, usageUsdNano: "70000", inputTokens: 100 });
  });

  it("charges each attempt of a genuine retry under one request", async () => {
    const { ledger } = harness();
    await ledger.reserve("req-retried", AMARA, BIO_FALL, SONNET, c(10));
    const settlement = {
      priceBookId: "anthropic-2026-10",
      attempts: [
        { attemptIndex: 0, state: "provider_reported" as const, usage: tokens(1_000, 0), actualUsdNano: "3000000", providerRequestId: "msg_01" },
        { attemptIndex: 1, state: "provider_reported" as const, usage: tokens(1_000, 400, 200), actualUsdNano: "9000000", gatewayLogId: "log-2" },
      ],
    };
    const settled = await ledger.settle("req-retried", settlement);
    expect(settled).toMatchObject({ outcome: "settled", replayed: false, settlement: { chargedUsdNano: "12000000", hasUnknownCost: false } });
    expect(await ledger.settle("req-retried", settlement)).toMatchObject({ outcome: "settled", replayed: true });
    // A different payload for the same request is a conflict, even if only the price book differs.
    await expect(ledger.settle("req-retried", { ...settlement, priceBookId: "anthropic-2026-11" })).rejects.toMatchObject({ code: "conflict" });
    await expect(ledger.settle("req-retried", { ...settlement, attempts: settlement.attempts.slice(0, 1) })).rejects.toMatchObject({ code: "conflict" });

    const [event] = await ledger.usageEvents();
    expect(event).toMatchObject({ attempts: 2, inputTokens: 2_000, outputTokens: 400, cacheReadTokens: 200, chargedUsdNano: "12000000", priceBookId: "anthropic-2026-10" });
    expect((await ledger.report()).district).toMatchObject({ requests: 1, attempts: 2 });
  });

  it("refuses attempts out of order or repeated", async () => {
    const { ledger } = harness();
    await ledger.reserve("req-1", AMARA, BIO_FALL, SONNET, c(10));
    const attempt = { attemptIndex: 0, state: "estimated" as const, usage: tokens(1, 1), actualUsdNano: "1" };
    await expect(ledger.settle("req-1", { attempts: [attempt, attempt] })).rejects.toMatchObject({ code: "validation-failed" });
    await expect(ledger.settle("req-1", { attempts: [] })).rejects.toMatchObject({ code: "validation-failed" });
    await expect(ledger.settle("req-1", { attempts: [{ attemptIndex: 0, state: "unknown", actualUsdNano: "1" } as never] }))
      .rejects.toMatchObject({ code: "validation-failed" });
  });

  it("accumulates sub-cent charges exactly", async () => {
    const { ledger } = harness();
    for (let i = 0; i < 1_000; i++) {
      await ledger.reserve(`req-mod-${i}`, AMARA, BIO_FALL, SONNET, "100000");
      await ledger.settle(`req-mod-${i}`, paid(tokens(1_000, 1), MODERATION));
    }
    const balance = (await ledger.poolBalances("2026-10"))["fpl_nf-bio-fall"]!;
    expect(balance.chargedUsdNano).toBe("38000000");
    expect(ceilUsdNanoToCents(balance.chargedUsdNano)).toBe(4);
    expect((await ledger.report()).byPrincipal[AMARA.principalId]).toMatchObject({ requests: 1_000, usageUsdNano: "38000000" });
  });
});

describe("unknown cost", () => {
  it("charges an attempt with no usage at the hold, never $0, until reconciliation", async () => {
    const { ledger } = harness();
    await ledger.reserve("req-lost", AMARA, BIO_FALL, SONNET, c(10));
    const settled = await ledger.settle("req-lost", { attempts: [{ attemptIndex: 0, state: "unknown" }] });
    expect(settled).toMatchObject({ outcome: "settled", settlement: { chargedUsdNano: c(10), hasUnknownCost: true } });
    expect((await ledger.poolBalances("2026-10"))["fpl_nf-bio-fall"]!.chargedUsdNano).toBe(c(10));
    expect((await ledger.usageEvents())[0]).toMatchObject({ hasUnknownCost: true, chargedUsdNano: c(10), inputTokens: 0 });
    expect((await ledger.report()).district).toMatchObject({ unknownCostRequests: 1, usageUsdNano: c(10) });

    // The bill says what it really cost, which replaces the liability and clears the flag.
    const bill = "request_id,date,provider,model,cost_usd\nreq-lost,2026-10-05,anthropic,claude-sonnet-example,0.000038";
    const result = await ledger.reconcile("bill-1", parseCostExportCsv(bill));
    expect(result.adjustments.map((adjustment) => adjustment.deltaUsdNano)).toEqual([subUsdNano(MODERATION, c(10))]);
    expect((await ledger.poolBalances("2026-10"))["fpl_nf-bio-fall"]!.chargedUsdNano).toBe(MODERATION);
    expect((await ledger.report()).district).toMatchObject({ unknownCostRequests: 0, totalUsdNano: MODERATION });
    expect((await ledger.usageEvents())[0]!.hasUnknownCost).toBe(false);
  });

  it("clears the flag with a zero adjustment when the bill matches the liability", async () => {
    const { ledger } = harness();
    await ledger.reserve("req-lost", AMARA, BIO_FALL, SONNET, c(10));
    await ledger.settle("req-lost", { attempts: [{ attemptIndex: 0, state: "unknown", usage: tokens(10, 0) }] });
    const bill = "request_id,date,provider,model,cost_usd\nreq-lost,2026-10-05,anthropic,claude-sonnet-example,0.10";
    const result = await ledger.reconcile("bill-1", parseCostExportCsv(bill));
    expect(result.adjustments.map((adjustment) => adjustment.deltaUsdNano)).toEqual(["0"]);
    expect((await ledger.report()).district.unknownCostRequests).toBe(0);
    // Re-running the same bill appends nothing more.
    expect((await ledger.reconcile("bill-1", parseCostExportCsv(bill))).adjustments).toEqual([]);
  });

  it("adds the hold for each unknown attempt to the known attempts' costs", async () => {
    const { ledger } = harness();
    await ledger.reserve("req-mixed", AMARA, BIO_FALL, SONNET, c(5));
    const settled = await ledger.settle("req-mixed", {
      attempts: [
        { attemptIndex: 0, state: "unknown" },
        { attemptIndex: 1, state: "estimated", usage: tokens(100, 10), actualUsdNano: MODERATION },
      ],
    });
    expect(settled).toMatchObject({ settlement: { chargedUsdNano: addUsdNano(c(5), MODERATION), hasUnknownCost: true } });
  });

  it("reaches the ledger through the governor", async () => {
    const { ledger } = harness();
    const governor = ledgerGovernor(ledger);
    const request = { requestId: "req-g", principal: AMARA, workspace: BIO_FALL, model: SONNET, estimatedMaxUsdNano: c(3) };
    expect(await governor.beforeRequest(request)).toMatchObject({ effect: "allow" });
    expect(await governor.afterResponse({ status: "completed", requestId: "req-g", attempts: [{ attemptIndex: 0, state: "unknown" }] }))
      .toMatchObject({ outcome: "settled", settlement: { chargedUsdNano: c(3), hasUnknownCost: true } });
  });
});

describe("entry schema versions", () => {
  const v1 = [
    {
      type: "reservation", requestId: "req-old", districtId: NF, principalId: AMARA.principalId, workspace: BIO_FALL,
      poolId: "fpl_nf-bio-fall", model: SONNET, heldCents: 120, period: "2026-10", reservedAt: "2026-10-01T10:00:00.000Z",
    },
    { type: "settlement", requestId: "req-old", usage: tokens(900, 300, 100), actualCents: 45, settledAt: "2026-10-01T10:00:05.000Z" },
    { type: "reservation", requestId: "req-old-2", districtId: NF, principalId: AMARA.principalId, workspace: BIO_FALL,
      poolId: "fpl_nf-bio-fall", model: SONNET, heldCents: 30, period: "2026-10", reservedAt: "2026-10-01T11:00:00.000Z" },
    { type: "void", requestId: "req-old-2", voidedAt: "2026-10-01T11:00:01.000Z" },
    {
      type: "adjustment", adjustmentId: "bill-0:request:req-old:fpl_nf-bio-fall", reconciliationId: "bill-0",
      basis: { kind: "request", requestId: "req-old" }, poolId: "fpl_nf-bio-fall", model: SONNET, period: "2026-10",
      attribution: { principalId: AMARA.principalId, workspace: BIO_FALL }, deltaCents: -3, recordedAt: "2026-10-02T00:00:00.000Z",
    },
  ];

  it("reads a stored version 1 entry as version 2, cents times 10^7", () => {
    const [reservation, settlement, , voided, adjustment] = v1.map((entry) => LedgerEntry.parse(entry));
    expect(reservation).toMatchObject({ entrySchemaVersion: 2, heldUsdNano: "1200000000" });
    expect(reservation).not.toHaveProperty("heldCents");
    expect(settlement).toEqual({
      type: "settlement",
      entrySchemaVersion: 2,
      requestId: "req-old",
      attempts: [{ attemptIndex: 0, state: "estimated", usage: tokens(900, 300, 100), actualUsdNano: "450000000" }],
      chargedUsdNano: "450000000",
      hasUnknownCost: false,
      settledAt: "2026-10-01T10:00:05.000Z",
    });
    expect(voided).toMatchObject({ type: "void", entrySchemaVersion: 2 });
    expect(adjustment).toMatchObject({ entrySchemaVersion: 2, deltaUsdNano: "-30000000" });
    // A v1 entry with a v2 field, or a v2 entry with a cents field, is neither.
    expect(LedgerEntry.safeParse({ ...v1[1], chargedUsdNano: "1" }).success).toBe(false);
    expect(LedgerEntry.safeParse({ ...reservation, heldCents: 120 }).success).toBe(false);
  });

  it("keeps the same balances and reports over a store of version 1 entries", async () => {
    const store = new InMemoryLedgerStore();
    await store.transact(() => ({ append: v1 as never, result: null }));
    const clock = new Clock();
    const ledger = new AiLedger({ districtId: NF, store, source: new FakeSource(), now: clock.now });
    expect((await ledger.poolBalances("2026-10"))["fpl_nf-bio-fall"]!.chargedUsdNano).toBe(c(42));
    expect((await ledger.report()).district).toMatchObject({ requests: 1, usageUsdNano: c(45), adjustmentUsdNano: "-30000000" });
    // New spend lands beside the upgraded history.
    await ledger.reserve("req-new", AMARA, BIO_FALL, SONNET, MODERATION);
    await ledger.settle("req-new", paid(tokens(1, 1), MODERATION));
    expect((await ledger.poolBalances("2026-10"))["fpl_nf-bio-fall"]!.chargedUsdNano).toBe(addUsdNano(c(42), MODERATION));
  });
});
