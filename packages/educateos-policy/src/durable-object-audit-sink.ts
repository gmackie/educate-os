// The Durable Object implementation of `PolicyAuditSink` (SCHO-48), published as its own entry
// point (`@educateos/policy/durable-object-audit-sink`). It names the storage it needs structurally
// and imports nothing from `cloudflare:workers`, so the package's main entry stays
// runtime-agnostic and the Worker that hosts a district's audit trail chooses its own Durable
// Object class around it.
import { z } from "zod";
import { migrateLegacyTables } from "@educateos/contracts/legacy-tables";
import { PolicyAuditEvent, type PolicyAuditSink } from "./audit.ts";

/** A value SQLite stores in one column. */
export type AuditSqlValue = string | number | null;

/**
 * The part of a SQLite-backed Durable Object's `ctx.storage` the sink uses. `DurableObjectStorage`
 * satisfies it as it is.
 */
export interface AuditSqlStorage {
  /** The SQL API. */
  readonly sql: {
    /** Runs one statement, returning a cursor over its rows. */
    exec(query: string, ...bindings: AuditSqlValue[]): { toArray(): Record<string, unknown>[] };
  };
  /** Runs `closure` in one transaction, rolled back if it throws. */
  transactionSync<T>(closure: () => T): T;
}

/** The table events are appended to. Exported so tests and migrations can name it. */
export const POLICY_AUDIT_TABLE = "educateos_policy_audit_events";

// `seq` keeps append order. The correlation ID, time and effect are copies of what the JSON holds,
// so the trail can be searched without parsing it; the JSON is what is trusted. The triggers make
// the table append-only at the storage layer, so no code path, this one included, can rewrite or
// remove a decision once recorded.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ${POLICY_AUDIT_TABLE} (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    correlation_id TEXT NOT NULL,
    decided_at TEXT NOT NULL,
    effect TEXT NOT NULL,
    event_json TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ${POLICY_AUDIT_TABLE}_correlation ON ${POLICY_AUDIT_TABLE} (correlation_id)`,
  `CREATE TRIGGER IF NOT EXISTS ${POLICY_AUDIT_TABLE}_no_update BEFORE UPDATE ON ${POLICY_AUDIT_TABLE}
    BEGIN SELECT RAISE(ABORT, 'policy audit events are append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS ${POLICY_AUDIT_TABLE}_no_delete BEFORE DELETE ON ${POLICY_AUDIT_TABLE}
    BEGIN SELECT RAISE(ABORT, 'policy audit events are append-only'); END`,
];

const StoredRow = z.object({ seq: z.number(), event_json: z.string() });

/** One recorded event and its position in the trail. */
export interface StoredPolicyAuditEvent {
  /** The event's position: strictly increasing in append order. */
  seq: number;
  /** The event. */
  event: PolicyAuditEvent;
}

/** The most events one {@link DurableObjectPolicyAuditSink.read} returns. */
export const MAX_AUDIT_PAGE = 500;

/** Thrown when a stored row cannot be read back as an event. */
export class PolicyAuditCorruptionError extends Error {
  override readonly name = "PolicyAuditCorruptionError";
}

function parseRow(raw: Record<string, unknown>): StoredPolicyAuditEvent {
  const row = StoredRow.safeParse(raw);
  if (!row.success) throw new PolicyAuditCorruptionError("an audit row has an unexpected shape");
  let json: unknown;
  try {
    json = JSON.parse(row.data.event_json);
  } catch {
    throw new PolicyAuditCorruptionError(`audit row ${row.data.seq} is not JSON`);
  }
  const event = PolicyAuditEvent.safeParse(json);
  if (!event.success) throw new PolicyAuditCorruptionError(`audit row ${row.data.seq} is not a policy audit event`);
  return { seq: row.data.seq, event: event.data };
}

/**
 * A durable {@link PolicyAuditSink}: one district's decision trail in a SQLite-backed Durable
 * Object, append-only. Every event is parsed with {@link PolicyAuditEvent} before it is written, so
 * nothing but identifiers and closed vocabulary reaches the table, and a malformed event fails the
 * decision that produced it rather than being stored. The engine awaits `record`, so a decision
 * takes effect only once its event is durable.
 *
 * Reads page through the trail in order, or fetch every decision of one invocation by the
 * correlation ID its error body carries.
 */
export class DurableObjectPolicyAuditSink implements PolicyAuditSink {
  readonly #storage: AuditSqlStorage;
  #ready = false;

  constructor(storage: AuditSqlStorage) {
    this.#storage = storage;
  }

  async record(event: PolicyAuditEvent): Promise<void> {
    const parsed = PolicyAuditEvent.parse(event);
    this.#exec(
      `INSERT INTO ${POLICY_AUDIT_TABLE} (correlation_id, decided_at, effect, event_json) VALUES (?, ?, ?, ?)`,
      parsed.correlationId,
      parsed.decidedAt,
      parsed.effect,
      JSON.stringify(parsed),
    );
  }

  /** Up to `limit` events after position `afterSeq` (from the start when omitted), oldest first. */
  async read(options: { afterSeq?: number; limit: number }): Promise<StoredPolicyAuditEvent[]> {
    const limit = z.number().int().min(1).max(MAX_AUDIT_PAGE).parse(options.limit);
    const afterSeq = z.number().int().min(0).parse(options.afterSeq ?? 0);
    return this.#exec(
      `SELECT seq, event_json FROM ${POLICY_AUDIT_TABLE} WHERE seq > ? ORDER BY seq LIMIT ?`,
      afterSeq,
      limit,
    ).map(parseRow);
  }

  /** Every decision recorded under one correlation ID, in the order they were made. */
  async forCorrelation(correlationId: string): Promise<PolicyAuditEvent[]> {
    return this.#exec(
      `SELECT seq, event_json FROM ${POLICY_AUDIT_TABLE} WHERE correlation_id = ? ORDER BY seq`,
      correlationId,
    ).map((row) => parseRow(row).event);
  }

  #exec(query: string, ...bindings: AuditSqlValue[]): Record<string, unknown>[] {
    if (!this.#ready) {
      this.#storage.transactionSync(() => {
        for (const statement of SCHEMA) this.#storage.sql.exec(statement);
        // The decisions recorded before the rename (SCHO-232) come first, as they were made first.
        migrateLegacyTables(this.#storage.sql, [POLICY_AUDIT_TABLE]);
      });
      this.#ready = true;
    }
    return this.#storage.sql.exec(query, ...bindings).toArray();
  }
}
