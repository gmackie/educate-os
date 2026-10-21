import type { CommercialAccountId, InstanceId } from "@schoolos/contracts";
import { SerialQueue } from "@schoolos/fleet";
import type { FinanceAuditEvent } from "./audit.ts";
import type { ProcessorRef } from "./ids.ts";
import type { CommercialAccount, CreditEntry, Grant, Invoice, Payment, ProcessorOperation, PurchaseOrder, Subscription } from "./model.ts";

/** The mutable commerce records, by kind. Each is replaced whole when its state changes. */
export interface CommerceRecords {
  account: CommercialAccount;
  subscription: Subscription;
  purchaseOrder: PurchaseOrder;
  invoice: Invoice;
  grant: Grant;
  /** A charge or refund requested from the processor, keyed by its processor reference. */
  processorOperation: ProcessorOperation;
}

/** The append-only commerce logs, by kind. Entries are never changed or removed. */
export interface CommerceLogs {
  audit: FinanceAuditEvent;
  credit: CreditEntry;
  payment: Payment;
}

/**
 * Where commerce keeps its records: `DurableObjectCommerceStore`
 * (`@schoolos/commerce/durable-object-store`) in production. Logs have no update or delete, which
 * is what makes the finance audit append-only.
 *
 * Every service operation runs inside {@link CommerceStore.atomically}, so its writes (a webhook's
 * payment, invoice, subscription change, audit events and its processed mark) commit together or
 * not at all, and no other operation interleaves with it.
 */
export interface CommerceStore {
  /**
   * Runs `work` as one atomic step: every write it makes commits together, or none does if it
   * throws, and no other `atomically` step runs until it has settled. Reads inside `work` see its
   * own writes. Not reentrant: `work` must not call `atomically` again.
   */
  atomically<T>(work: () => Promise<T>): Promise<T>;
  /** A record by kind and ID. */
  get<K extends keyof CommerceRecords>(kind: K, id: string): Promise<CommerceRecords[K] | undefined>;
  /** Inserts or replaces a record. */
  put<K extends keyof CommerceRecords>(kind: K, id: string, record: CommerceRecords[K]): Promise<void>;
  /** Every record of a kind belonging to an account, or every record of the kind if no account is given. */
  list<K extends keyof CommerceRecords>(kind: K, accountId?: CommercialAccountId): Promise<CommerceRecords[K][]>;
  /** Appends an entry to a log. */
  append<K extends keyof CommerceLogs>(log: K, entry: CommerceLogs[K]): Promise<void>;
  /** An account's entries in a log, oldest first. */
  entries<K extends keyof CommerceLogs>(log: K, accountId: CommercialAccountId): Promise<CommerceLogs[K][]>;
  /** An account's newest entry in a log, if any: the tip the next audit event chains onto. */
  lastEntry<K extends keyof CommerceLogs>(log: K, accountId: CommercialAccountId): Promise<CommerceLogs[K] | undefined>;
  /** Whether a processor webhook event has already been applied. */
  hasProcessedEvent(eventId: ProcessorRef): Promise<boolean>;
  /** Records that a processor webhook event has been applied. Throws if it already was, which rolls back its step. */
  markEventProcessed(eventId: ProcessorRef): Promise<void>;
  /** The next entitlement revision for an instance: 1, then 2, and so on. */
  nextEntitlementRevision(instanceId: InstanceId): Promise<number>;
}

/**
 * A {@link CommerceStore} in memory. For tests and as the reference for real implementations. An
 * `atomically` step that throws restores the state from before it began.
 */
export class InMemoryCommerceStore implements CommerceStore {
  #records = new Map<string, Map<string, unknown>>();
  #logs = new Map<string, unknown[]>();
  #processedEvents = new Set<string>();
  #revisions = new Map<string, number>();
  readonly #queue = new SerialQueue();

  async atomically<T>(work: () => Promise<T>): Promise<T> {
    return this.#queue.run(async () => {
      const snapshot = structuredClone({ records: this.#records, logs: this.#logs, processed: this.#processedEvents, revisions: this.#revisions });
      try {
        return await work();
      } catch (error) {
        this.#records = snapshot.records;
        this.#logs = snapshot.logs;
        this.#processedEvents = snapshot.processed;
        this.#revisions = snapshot.revisions;
        throw error;
      }
    });
  }

  #table(kind: string): Map<string, unknown> {
    let table = this.#records.get(kind);
    if (table === undefined) this.#records.set(kind, (table = new Map()));
    return table;
  }

  async get<K extends keyof CommerceRecords>(kind: K, id: string): Promise<CommerceRecords[K] | undefined> {
    const record = this.#table(kind).get(id) as CommerceRecords[K] | undefined;
    return record && structuredClone(record);
  }

  async put<K extends keyof CommerceRecords>(kind: K, id: string, record: CommerceRecords[K]): Promise<void> {
    this.#table(kind).set(id, structuredClone(record));
  }

  async list<K extends keyof CommerceRecords>(kind: K, accountId?: CommercialAccountId): Promise<CommerceRecords[K][]> {
    const all = [...this.#table(kind).values()] as CommerceRecords[K][];
    return structuredClone(accountId === undefined ? all : all.filter((record) => record.accountId === accountId));
  }

  async append<K extends keyof CommerceLogs>(log: K, entry: CommerceLogs[K]): Promise<void> {
    let entries = this.#logs.get(log);
    if (entries === undefined) this.#logs.set(log, (entries = []));
    entries.push(structuredClone(entry));
  }

  async entries<K extends keyof CommerceLogs>(log: K, accountId: CommercialAccountId): Promise<CommerceLogs[K][]> {
    const entries = (this.#logs.get(log) ?? []) as CommerceLogs[K][];
    return structuredClone(entries.filter((entry) => entry.accountId === accountId));
  }

  async lastEntry<K extends keyof CommerceLogs>(log: K, accountId: CommercialAccountId): Promise<CommerceLogs[K] | undefined> {
    return (await this.entries(log, accountId)).at(-1);
  }

  async hasProcessedEvent(eventId: ProcessorRef): Promise<boolean> {
    return this.#processedEvents.has(eventId);
  }

  async markEventProcessed(eventId: ProcessorRef): Promise<void> {
    if (this.#processedEvents.has(eventId)) throw new Error("processor event already marked processed");
    this.#processedEvents.add(eventId);
  }

  async nextEntitlementRevision(instanceId: InstanceId): Promise<number> {
    const next = (this.#revisions.get(instanceId) ?? 0) + 1;
    this.#revisions.set(instanceId, next);
    return next;
  }

  /** Every stored record and log entry, for tests that inspect what commerce keeps. */
  dump(): unknown[] {
    return structuredClone([...[...this.#records.values()].flatMap((table) => [...table.values()]), ...[...this.#logs.values()].flat()]);
  }
}
