// The Durable Object implementation of `CommerceStore` (SCHO-99), published as its own entry point
// (`@educateos/commerce/durable-object-store`). Like the fleet's and releases' stores it names the
// storage it needs structurally and imports nothing from `cloudflare:workers`; the root's Worker
// hosts it, with the `CommerceService` it serves, in a Durable Object of its own.
import type { CommercialAccountId, InstanceId } from "@educateos/contracts";
import { SerialQueue } from "@educateos/fleet";
import { type DurableObjectSqlStorage, DurableObjectTables, parseStoredJson } from "@educateos/fleet/durable-object-store";
import { z } from "zod";
import { FinanceAuditEvent } from "./audit.ts";
import type { ProcessorRef } from "./ids.ts";
import { CommercialAccount, CreditEntry, Grant, Invoice, Payment, ProcessorOperation, PurchaseOrder, Subscription } from "./model.ts";
import type { CommerceLogs, CommerceRecords, CommerceStore } from "./store.ts";

/** The commerce tables. Exported so tests and migrations can name them. */
export const COMMERCE_TABLES = {
  records: "educateos_commerce_records",
  logs: "educateos_commerce_logs",
  processedEvents: "educateos_commerce_processed_events",
  entitlementRevisions: "educateos_commerce_entitlement_revisions",
} as const;

const { records, logs, processedEvents, entitlementRevisions } = COMMERCE_TABLES;

// Records are replaced whole; logs are append-only, enforced by triggers so no code path can
// rewrite the finance audit, the credit ledger or the payment history; a processed event's ID is
// a primary key, so a webhook can be marked applied only once.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ${records} (
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (kind, id)
  )`,
  `CREATE INDEX IF NOT EXISTS ${records}_by_account ON ${records} (kind, account_id)`,
  `CREATE TABLE IF NOT EXISTS ${logs} (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    log TEXT NOT NULL,
    account_id TEXT NOT NULL,
    entry_json TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ${logs}_by_account ON ${logs} (log, account_id, seq)`,
  `CREATE TRIGGER IF NOT EXISTS ${logs}_no_update BEFORE UPDATE ON ${logs}
    BEGIN SELECT RAISE(ABORT, 'commerce logs are append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS ${logs}_no_delete BEFORE DELETE ON ${logs}
    BEGIN SELECT RAISE(ABORT, 'commerce logs are append-only'); END`,
  `CREATE TABLE IF NOT EXISTS ${processedEvents} (event_id TEXT PRIMARY KEY)`,
  `CREATE TABLE IF NOT EXISTS ${entitlementRevisions} (
    instance_id TEXT PRIMARY KEY,
    last INTEGER NOT NULL CHECK (last >= 1)
  )`,
];

// Each kind is parsed with its own schema when written and again when read, so a row that no
// longer matches is refused rather than acted on.
const RECORD_SCHEMAS: { [K in keyof CommerceRecords]: z.ZodType<CommerceRecords[K]> } = {
  account: CommercialAccount,
  subscription: Subscription,
  purchaseOrder: PurchaseOrder,
  invoice: Invoice,
  grant: Grant,
  processorOperation: ProcessorOperation,
};
const LOG_SCHEMAS: { [K in keyof CommerceLogs]: z.ZodType<CommerceLogs[K]> } = {
  audit: FinanceAuditEvent,
  credit: CreditEntry,
  payment: Payment,
};

// What an `atomically` step has written so far. Nothing reaches SQL until the step returns.
interface Pending {
  records: Map<string, { kind: keyof CommerceRecords; id: string; accountId: string; record: unknown }>;
  appended: { log: keyof CommerceLogs; accountId: string; entry: unknown }[];
  processed: Set<string>;
  revisions: Map<string, number>;
}

const recordKey = (kind: string, id: string) => `${kind}\0${id}`;

/**
 * A {@link CommerceStore} in a SQLite-backed Durable Object.
 *
 * An `atomically` step stages its writes in memory, where its own reads see them, and commits
 * them all in one synchronous transaction when it returns; if it throws, or the object is evicted
 * before then, nothing is written. Steps are queued, so one runs at a time, and a webhook's
 * payment, invoice and subscription changes, audit events and processed mark land together or not
 * at all. Calls outside a step read what is committed and commit each write on its own.
 */
export class DurableObjectCommerceStore implements CommerceStore {
  readonly #tables: DurableObjectTables;
  readonly #queue = new SerialQueue();
  #pending: Pending | undefined;

  constructor(storage: DurableObjectSqlStorage) {
    this.#tables = new DurableObjectTables(storage, SCHEMA);
  }

  async atomically<T>(work: () => Promise<T>): Promise<T> {
    return this.#queue.run(async () => {
      const pending: Pending = { records: new Map(), appended: [], processed: new Set(), revisions: new Map() };
      this.#pending = pending;
      try {
        const result = await work();
        this.#commit(pending);
        return result;
      } finally {
        this.#pending = undefined;
      }
    });
  }

  async get<K extends keyof CommerceRecords>(kind: K, id: string): Promise<CommerceRecords[K] | undefined> {
    const staged = this.#pending?.records.get(recordKey(kind, id));
    if (staged !== undefined) return structuredClone(staged.record as CommerceRecords[K]);
    const [row] = this.#tables.transact((sql) => sql.exec(`SELECT record_json FROM ${records} WHERE kind = ? AND id = ?`, kind, id).toArray());
    return row === undefined ? undefined : parseStoredJson(RECORD_SCHEMAS[kind], row.record_json, `${kind} ${id}`);
  }

  async put<K extends keyof CommerceRecords>(kind: K, id: string, record: CommerceRecords[K]): Promise<void> {
    const parsed = RECORD_SCHEMAS[kind].parse(record);
    this.#write((pending) => pending.records.set(recordKey(kind, id), { kind, id, accountId: parsed.accountId, record: structuredClone(parsed) }));
  }

  async list<K extends keyof CommerceRecords>(kind: K, accountId?: CommercialAccountId): Promise<CommerceRecords[K][]> {
    const rows = this.#tables.transact((sql) =>
      accountId === undefined
        ? sql.exec(`SELECT id, record_json FROM ${records} WHERE kind = ? ORDER BY rowid`, kind).toArray()
        : sql.exec(`SELECT id, record_json FROM ${records} WHERE kind = ? AND account_id = ? ORDER BY rowid`, kind, accountId).toArray());
    const byId = new Map<string, CommerceRecords[K]>();
    for (const row of rows) byId.set(String(row.id), parseStoredJson(RECORD_SCHEMAS[kind], row.record_json, `${kind} ${String(row.id)}`));
    for (const staged of this.#pending?.records.values() ?? []) {
      if (staged.kind === kind && (accountId === undefined || staged.accountId === accountId)) byId.set(staged.id, staged.record as CommerceRecords[K]);
    }
    return structuredClone([...byId.values()]);
  }

  async append<K extends keyof CommerceLogs>(log: K, entry: CommerceLogs[K]): Promise<void> {
    const parsed = LOG_SCHEMAS[log].parse(entry);
    this.#write((pending) => pending.appended.push({ log, accountId: parsed.accountId, entry: structuredClone(parsed) }));
  }

  async entries<K extends keyof CommerceLogs>(log: K, accountId: CommercialAccountId): Promise<CommerceLogs[K][]> {
    const rows = this.#tables.transact((sql) =>
      sql.exec(`SELECT seq, entry_json FROM ${logs} WHERE log = ? AND account_id = ? ORDER BY seq`, log, accountId).toArray());
    const stored = rows.map((row) => parseStoredJson(LOG_SCHEMAS[log], row.entry_json, `${log} entry ${String(row.seq)}`));
    return structuredClone([...stored, ...this.#staged(log, accountId)]);
  }

  async lastEntry<K extends keyof CommerceLogs>(log: K, accountId: CommercialAccountId): Promise<CommerceLogs[K] | undefined> {
    const staged = this.#staged(log, accountId).at(-1);
    if (staged !== undefined) return structuredClone(staged);
    const [row] = this.#tables.transact((sql) =>
      sql.exec(`SELECT seq, entry_json FROM ${logs} WHERE log = ? AND account_id = ? ORDER BY seq DESC LIMIT 1`, log, accountId).toArray());
    return row === undefined ? undefined : parseStoredJson(LOG_SCHEMAS[log], row.entry_json, `${log} entry ${String(row.seq)}`);
  }

  async hasProcessedEvent(eventId: ProcessorRef): Promise<boolean> {
    if (this.#pending?.processed.has(eventId) === true) return true;
    return this.#tables.transact((sql) => sql.exec(`SELECT 1 FROM ${processedEvents} WHERE event_id = ?`, eventId).toArray()).length > 0;
  }

  async markEventProcessed(eventId: ProcessorRef): Promise<void> {
    if (await this.hasProcessedEvent(eventId)) throw new Error("processor event already marked processed");
    this.#write((pending) => pending.processed.add(eventId));
  }

  async nextEntitlementRevision(instanceId: InstanceId): Promise<number> {
    const staged = this.#pending?.revisions.get(instanceId);
    const [row] = staged === undefined
      ? this.#tables.transact((sql) => sql.exec(`SELECT last FROM ${entitlementRevisions} WHERE instance_id = ?`, instanceId).toArray())
      : [];
    const next = (staged ?? z.number().int().min(1).optional().parse(row?.last) ?? 0) + 1;
    this.#write((pending) => pending.revisions.set(instanceId, next));
    return next;
  }

  #staged<K extends keyof CommerceLogs>(log: K, accountId: CommercialAccountId): CommerceLogs[K][] {
    return (this.#pending?.appended ?? []).filter((a) => a.log === log && a.accountId === accountId).map((a) => a.entry as CommerceLogs[K]);
  }

  // Inside a step a write is staged; outside one it is committed on its own.
  #write(stage: (pending: Pending) => void): void {
    if (this.#pending !== undefined) {
      stage(this.#pending);
      return;
    }
    const alone: Pending = { records: new Map(), appended: [], processed: new Set(), revisions: new Map() };
    stage(alone);
    this.#commit(alone);
  }

  #commit(pending: Pending): void {
    this.#tables.transact((sql) => {
      for (const { kind, id, accountId, record } of pending.records.values()) {
        sql.exec(
          `INSERT INTO ${records} (kind, id, account_id, record_json) VALUES (?, ?, ?, ?)
           ON CONFLICT (kind, id) DO UPDATE SET account_id = excluded.account_id, record_json = excluded.record_json`,
          kind, id, accountId, JSON.stringify(record),
        );
      }
      for (const { log, accountId, entry } of pending.appended) {
        sql.exec(`INSERT INTO ${logs} (log, account_id, entry_json) VALUES (?, ?, ?)`, log, accountId, JSON.stringify(entry));
      }
      // A plain INSERT: an event marked twice fails the primary key and rolls the whole step back.
      for (const eventId of pending.processed) sql.exec(`INSERT INTO ${processedEvents} (event_id) VALUES (?)`, eventId);
      for (const [instanceId, last] of pending.revisions) {
        sql.exec(
          `INSERT INTO ${entitlementRevisions} (instance_id, last) VALUES (?, ?) ON CONFLICT (instance_id) DO UPDATE SET last = excluded.last`,
          instanceId, last,
        );
      }
    });
  }
}
