import type { CommercialAccountId, InstanceId } from "@schoolos/fleet";
import type { FinanceAuditEvent } from "./audit.ts";
import type { ProcessorRef } from "./ids.ts";
import type { CommercialAccount, CreditEntry, Grant, Invoice, Payment, PurchaseOrder, Subscription } from "./model.ts";

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

/** A charge or refund commerce asked the processor for, and its outcome once a webhook reports it. */
export interface ProcessorOperation {
  processorRef: ProcessorRef;
  accountId: CommercialAccountId;
  kind: "charge" | "refund";
  invoiceId: Invoice["invoiceId"];
  amountCents: number;
  /** For a refund, the payment it reverses. */
  refundOf?: Payment["paymentId"];
  /** Absent until the processor reports the outcome. */
  outcome?: "succeeded" | "failed";
}


/**
 * Where commerce keeps its records. The private root service implements it over its own database
 * (a Durable Object, which serializes calls); every method is a single atomic step. Logs have no
 * update or delete, which is what makes the finance audit append-only.
 */
export interface CommerceStore {
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
  /** Whether a processor webhook event has already been applied. */
  hasProcessedEvent(eventId: ProcessorRef): Promise<boolean>;
  /** Records that a processor webhook event has been applied. */
  markEventProcessed(eventId: ProcessorRef): Promise<void>;
  /** The next entitlement revision for an instance: 1, then 2, and so on. */
  nextEntitlementRevision(instanceId: InstanceId): Promise<number>;
}

/** A {@link CommerceStore} in memory. For tests and as the reference for real implementations. */
export class InMemoryCommerceStore implements CommerceStore {
  readonly #records = new Map<string, Map<string, unknown>>();
  readonly #logs = new Map<string, unknown[]>();
  readonly #processedEvents = new Set<string>();
  readonly #revisions = new Map<string, number>();

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

  async hasProcessedEvent(eventId: ProcessorRef): Promise<boolean> {
    return this.#processedEvents.has(eventId);
  }

  async markEventProcessed(eventId: ProcessorRef): Promise<void> {
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
