// `DurableObjectCommerceStore` in workerd, against real Durable Object SQLite storage: a webhook is
// stored with all its effects or none, survives a restart as applied, is applied once however
// often it arrives at once, and the finance logs can be neither rewritten nor read when corrupt.

import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { StoredRowCorruptionError } from "@schoolos/fleet/durable-object-store";
import { describe, expect, it } from "vitest";
import { COMMERCE_TABLES, DurableObjectCommerceStore } from "../../src/durable-object-store.ts";
import { idsFor } from "../support.ts";
import { NORTHFIELD } from "@schoolos/fixtures";

let objects = 0;
const fresh = () => env.COMMERCE.getByName(`commerce-${objects++}`);

interface Books {
  invoiceStatus: string;
  payments: unknown[];
  trail: { action: string; hash: string }[];
  chain: { intact: boolean };
}

async function charged() {
  const commerce = fresh();
  const { invoiceId, delivery } = JSON.parse(await commerce.chargedInvoice()) as { invoiceId: string; delivery: unknown };
  const books = async () => JSON.parse(await commerce.books(invoiceId)) as Books;
  return { commerce, delivery: JSON.stringify(delivery), books };
}

// The error an RPC call rejected with, settled without workerd also reporting it as unhandled.
async function rpcFailure(call: Promise<unknown>): Promise<unknown> {
  const [outcome] = await Promise.allSettled([call]);
  if (outcome?.status !== "rejected") throw new Error("expected the call to fail");
  return outcome.reason;
}

describe("DurableObjectCommerceStore", () => {
  it("keeps an applied webhook and its effects across a restart, and refuses it as a duplicate after", async () => {
    const { commerce, delivery, books } = await charged();
    expect(await commerce.deliver(delivery)).toBe("applied");
    const before = await books();
    expect(before).toMatchObject({ invoiceStatus: "paid", payments: [{ kind: "charge", amountCents: 40_000 }], chain: { intact: true } });

    await evictDurableObject(commerce);
    expect(await books()).toEqual(before);
    expect(await commerce.deliver(delivery)).toBe("duplicate");
    expect((await books()).payments).toHaveLength(1);
  });

  it("writes nothing when a webhook's step fails after its effects, and the redelivery applies once", async () => {
    const { commerce, delivery, books } = await charged();
    const before = await books();
    await commerce.crashNextMark();
    expect(await rpcFailure(commerce.deliver(delivery))).toMatchObject({ message: "the object was evicted before the step committed" });
    expect(await books()).toEqual(before);
    // What a restart would read: a fresh store over the same storage finds the invoice unpaid, no
    // payment and the event unprocessed. (The pool can't evict an object after a failed call, so the
    // restart is read this way rather than through evictDurableObject.)
    const { accountId } = idsFor(NORTHFIELD);
    await runInDurableObject(commerce, async (_instance, state) => {
      const store = new DurableObjectCommerceStore(state.storage);
      expect(await store.entries("payment", accountId)).toEqual([]);
      expect((await store.list("invoice", accountId)).map((invoice) => invoice.status)).toEqual(["open"]);
      expect(await store.entries("audit", accountId)).toEqual(before.trail);
      expect(state.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${COMMERCE_TABLES.processedEvents}`).one().n).toBe(0);
    });

    expect(await commerce.deliver(delivery)).toBe("applied");
    expect(await books()).toMatchObject({ invoiceStatus: "paid", payments: [{ amountCents: 40_000 }], chain: { intact: true } });
  });

  it("applies one of 20 concurrent deliveries of the same webhook", async () => {
    const { commerce, delivery, books } = await charged();
    const outcomes = await Promise.all(Array.from({ length: 20 }, () => commerce.deliver(delivery)));
    expect(outcomes.filter((outcome) => outcome === "applied")).toHaveLength(1);
    expect((await books()).payments).toHaveLength(1);
  });

  it("keeps one unbroken audit chain under concurrent operations and across a restart", async () => {
    const commerce = fresh();
    await commerce.chargedInvoice();
    await commerce.issueInvoices(15);
    expect(JSON.parse(await commerce.chain())).toMatchObject({ intact: true, length: 19 });
    await evictDurableObject(commerce);
    await commerce.issueInvoices(1);
    expect(JSON.parse(await commerce.chain())).toMatchObject({ intact: true, length: 20 });
  });

  it("refuses to rewrite or delete a log entry", async () => {
    const { commerce } = await charged();
    await runInDurableObject(commerce, (_instance, state) => {
      expect(() => state.storage.sql.exec(`UPDATE ${COMMERCE_TABLES.logs} SET entry_json = '{}'`)).toThrow(/append-only/);
      expect(() => state.storage.sql.exec(`DELETE FROM ${COMMERCE_TABLES.logs}`)).toThrow(/append-only/);
    });
  });

  it("refuses a stored record or log entry that no longer parses", async () => {
    const { commerce } = await charged();
    const { accountId } = idsFor(NORTHFIELD);
    await runInDurableObject(commerce, async (_instance, state) => {
      const store = new DurableObjectCommerceStore(state.storage);
      state.storage.sql.exec(`UPDATE ${COMMERCE_TABLES.records} SET record_json = '{"accountId":"acct_northfield"}' WHERE kind = 'account'`);
      await expect(store.get("account", accountId)).rejects.toThrow(StoredRowCorruptionError);
      state.storage.sql.exec(`INSERT INTO ${COMMERCE_TABLES.logs} (log, account_id, entry_json) VALUES ('audit', ?, 'not json')`, accountId);
      await expect(store.entries("audit", accountId)).rejects.toThrow(StoredRowCorruptionError);
    });
  });
});
