// `DurableObjectLedgerStore` in workerd, against real Durable Object SQLite storage: a restarted
// object replays to the same balances, concurrent reservations never overspend a pool, version 1
// rows are upgraded on read, and history cannot be rewritten.

import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ENTRY_SCHEMA_VERSION, LedgerIndex, usdNanoFromCents, type VoidEntry } from "../../src/index.ts";
import { DurableObjectLedgerStore, LEDGER_ENTRIES_TABLE, LedgerCorruptionError } from "../../src/durable-object-store.ts";

let ledgers = 0;
const fresh = () => env.LEDGER.getByName(`ledger-${ledgers++}`);

describe("DurableObjectLedgerStore", () => {
  it("replays a restarted object to identical balances and entries", async () => {
    const ledger = fresh();
    expect(await ledger.reserve("req-1", 30)).toMatchObject({ outcome: "reserved", replayed: false });
    expect(await ledger.reserve("req-2", 20)).toMatchObject({ outcome: "reserved" });
    expect(await ledger.reserve("req-3", 10)).toMatchObject({ outcome: "reserved" });
    await ledger.settle("req-1", 25);
    await ledger.void("req-3");
    const balances = await ledger.balances();
    const entries = await ledger.entries();
    expect(balances["fpl_nf-bio-fall"]).toEqual({ allocationUsdNano: usdNanoFromCents(100), chargedUsdNano: usdNanoFromCents(45), remainingUsdNano: usdNanoFromCents(55) });

    // A new instance over the same storage rebuilds the index from the table alone.
    await evictDurableObject(ledger);
    expect(await ledger.balances()).toEqual(balances);
    expect(await ledger.entries()).toEqual(entries);
    // ...and still knows what was held, so a retried reservation replays instead of holding again.
    expect(await ledger.reserve("req-2", 20)).toMatchObject({ outcome: "reserved", replayed: true, status: "held" });
    expect((await ledger.entries()).length).toBe(entries.length);
  });

  it("admits exactly five of 100 concurrent $0.20 reservations against a $1 pool", async () => {
    const ledger = fresh();
    const results = await Promise.all(Array.from({ length: 100 }, (_, i) => ledger.reserve(`req-${i}`, 20)));
    expect(results.filter((result) => result.outcome === "reserved")).toHaveLength(5);
    expect(results.filter((result) => result.outcome === "denied" && result.reason === "pool-exhausted")).toHaveLength(95);
    expect((await ledger.balances())["fpl_nf-bio-fall"]?.remainingUsdNano).toBe("0");

    // The same holds after a restart: what was committed is exactly what was admitted.
    await evictDurableObject(ledger);
    expect((await ledger.entries()).filter((entry) => entry.type === "reservation")).toHaveLength(5);
  });

  it("reads and upgrades stored version 1 entries, and keeps writing version 2 after them", async () => {
    const ledger = fresh();
    const v1Reservation = {
      type: "reservation",
      requestId: "req-v1",
      districtId: "dst_northfield",
      principalId: "prn_nf-student-amara",
      workspace: { kind: "course", offeringId: "off_nf-bio-fall-p2" },
      poolId: "fpl_nf-bio-fall",
      model: { provider: "anthropic", modelId: "claude-sonnet-example" },
      heldCents: 12,
      period: "2026-10",
      reservedAt: "2026-10-01T10:00:00.000Z",
    };
    const v1Settlement = {
      type: "settlement",
      requestId: "req-v1",
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
      actualCents: 7,
      settledAt: "2026-10-01T10:00:05.000Z",
    };
    await runInDurableObject(ledger, async (_instance, state) => {
      // Creates the table, then writes rows as a version 1 store did.
      await new DurableObjectLedgerStore(state.storage).read();
      for (const entry of [v1Reservation, v1Settlement]) {
        state.storage.sql.exec(
          `INSERT INTO ${LEDGER_ENTRIES_TABLE} (entry_schema_version, entry_type, request_id, entry_json) VALUES (1, ?, ?, ?)`,
          entry.type, entry.requestId, JSON.stringify(entry),
        );
      }
    });
    await evictDurableObject(ledger);

    const [reservation, settlement] = await ledger.entries();
    expect(reservation).toMatchObject({ entrySchemaVersion: ENTRY_SCHEMA_VERSION, fundingPurpose: "generative", heldUsdNano: usdNanoFromCents(12) });
    expect(settlement).toMatchObject({
      entrySchemaVersion: ENTRY_SCHEMA_VERSION,
      chargedUsdNano: usdNanoFromCents(7),
      hasUnknownCost: false,
      attempts: [{ attemptIndex: 0, state: "estimated", actualUsdNano: usdNanoFromCents(7) }],
    });
    expect((await ledger.balances())["fpl_nf-bio-fall"]?.chargedUsdNano).toBe(usdNanoFromCents(7));

    // New writes land at the current version beside the upgraded rows, which stay as stored.
    await ledger.reserve("req-v2", 5);
    await runInDurableObject(ledger, (_instance, state) => {
      const versions = state.storage.sql.exec(`SELECT entry_schema_version AS v FROM ${LEDGER_ENTRIES_TABLE} ORDER BY seq`).toArray();
      expect(versions.map((row) => row.v)).toEqual([1, 1, ENTRY_SCHEMA_VERSION]);
    });
  });

  it("refuses to rewrite or delete history", async () => {
    const ledger = fresh();
    await ledger.reserve("req-1", 10);
    await runInDurableObject(ledger, (_instance, state) => {
      expect(() => state.storage.sql.exec(`UPDATE ${LEDGER_ENTRIES_TABLE} SET entry_json = '{}'`)).toThrow(/append-only/);
      expect(() => state.storage.sql.exec(`DELETE FROM ${LEDGER_ENTRIES_TABLE}`)).toThrow(/append-only/);
    });
  });

  it("refuses a row whose body does not match its version", async () => {
    await runInDurableObject(fresh(), async (_instance, state) => {
      await new DurableObjectLedgerStore(state.storage).read();
      state.storage.sql.exec(
        `INSERT INTO ${LEDGER_ENTRIES_TABLE} (entry_schema_version, entry_type, request_id, entry_json) VALUES (?, 'void', 'req-x', ?)`,
        ENTRY_SCHEMA_VERSION, JSON.stringify({ type: "void", requestId: "req-x", voidedAt: "2026-10-01T10:00:00.000Z" }),
      );
      await expect(new DurableObjectLedgerStore(state.storage).read()).rejects.toThrow(LedgerCorruptionError);
    });
  });

  it("appends nothing when a step throws or appends an entry its schema refuses", async () => {
    await runInDurableObject(fresh(), async (_instance, state) => {
      const store = new DurableObjectLedgerStore(state.storage);
      const voided: VoidEntry = { type: "void", entrySchemaVersion: 2, requestId: "req-1", voidedAt: "2026-10-01T10:00:00.000Z" };
      await expect(store.transact(() => {
        throw new Error("decided against it");
      })).rejects.toThrow("decided against it");
      // The first entry is valid, the second carries a field no entry has; neither may land.
      await expect(store.transact(() => ({ append: [voided, { ...voided, prompt: "hello" } as VoidEntry], result: null }))).rejects.toThrow();
      expect((await store.read()).entries).toEqual([]);
      expect((await new DurableObjectLedgerStore(state.storage).read()).entries).toEqual([]);
      expect(state.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${LEDGER_ENTRIES_TABLE}`).one().n).toBe(0);
      expect(await store.read()).toBeInstanceOf(LedgerIndex);
    });
  });
});
