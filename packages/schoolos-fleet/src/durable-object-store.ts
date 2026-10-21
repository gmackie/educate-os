// Durable Object storage for the fleet, published as its own entry point
// (`@schoolos/fleet/durable-object-store`). It names the storage it needs structurally and imports
// nothing from `cloudflare:workers`, so the package's main entry stays runtime-agnostic and the
// Worker hosting the agent chooses its own Durable Object class around it. `@schoolos/releases`
// and `@schoolos/commerce` build their Durable Object stores on the helpers here.
import { z } from "zod";
import type { SequenceCounter } from "./agent.ts";
import { Sequence } from "./protocol.ts";

/** A value SQLite stores in one column. */
export type SqlValue = string | number | null;

/**
 * The part of a SQLite-backed Durable Object's `ctx.storage` the SchoolOS Durable Object stores
 * use: synchronous SQL and synchronous transactions. `DurableObjectStorage` satisfies it as it is.
 */
export interface DurableObjectSqlStorage {
  /** The SQL API. */
  readonly sql: {
    /** Runs one statement, returning a cursor over its rows. */
    exec(query: string, ...bindings: SqlValue[]): { toArray(): Record<string, unknown>[] };
  };
  /** Runs `closure` in one transaction, rolled back if it throws. */
  transactionSync<T>(closure: () => T): T;
}

/** Thrown when a stored row can't be read. A store refuses to act on state it can't read. */
export class StoredRowCorruptionError extends Error {
  override readonly name = "StoredRowCorruptionError";
}

/**
 * Parses a JSON column with `schema`. A row that is not JSON or doesn't match is refused with a
 * {@link StoredRowCorruptionError} naming only `what`, never the row's content.
 */
export function parseStoredJson<T extends z.ZodType>(schema: T, text: unknown, what: string): z.infer<T> {
  let json: unknown;
  try {
    json = JSON.parse(z.string().parse(text));
  } catch {
    throw new StoredRowCorruptionError(`${what} is not JSON`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new StoredRowCorruptionError(`${what} does not match its schema`);
  return parsed.data;
}

/**
 * A store's tables in a Durable Object: runs each step in one synchronous transaction, creating
 * the tables in the first. A Durable Object runs one synchronous block at a time, so a step
 * neither interleaves with another nor half-commits.
 */
export class DurableObjectTables {
  readonly #storage: DurableObjectSqlStorage;
  readonly #schema: readonly string[];
  #ready = false;

  /** `schema` is the store's `CREATE … IF NOT EXISTS` statements, run once per object instance. */
  constructor(storage: DurableObjectSqlStorage, schema: readonly string[]) {
    this.#storage = storage;
    this.#schema = schema;
  }

  /** Runs `step` in one transaction, rolled back if it throws. */
  transact<T>(step: (sql: DurableObjectSqlStorage["sql"]) => T): T {
    const result = this.#storage.transactionSync(() => {
      if (!this.#ready) for (const statement of this.#schema) this.#storage.sql.exec(statement);
      return step(this.#storage.sql);
    });
    // Only once the transaction that created the tables has committed.
    this.#ready = true;
    return result;
  }
}

/** The table the sequence counter lives in. Exported so tests and migrations can name it. */
export const SEQUENCE_TABLE = "schoolos_fleet_sequence";

// One row, pinned by the CHECK, holding the last number handed out. The trigger refuses any write
// that would move it backwards, so no code path can make the counter repeat a number.
const SEQUENCE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ${SEQUENCE_TABLE} (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last INTEGER NOT NULL CHECK (last >= 0)
  )`,
  `CREATE TRIGGER IF NOT EXISTS ${SEQUENCE_TABLE}_monotonic BEFORE UPDATE ON ${SEQUENCE_TABLE}
    WHEN NEW.last < OLD.last
    BEGIN SELECT RAISE(ABORT, 'the fleet sequence never goes backwards'); END`,
  `INSERT OR IGNORE INTO ${SEQUENCE_TABLE} (id, last) VALUES (1, 0)`,
];

/**
 * A {@link SequenceCounter} in a SQLite-backed Durable Object (SCHO-39). Every number is committed
 * before it is returned, so a restarted or evicted agent carries on from the last number it handed
 * out rather than falling behind the root's last accepted sequence and being refused as a replay.
 * Concurrent callers never get the same number.
 */
export class DurableObjectSequenceCounter implements SequenceCounter {
  readonly #tables: DurableObjectTables;

  constructor(storage: DurableObjectSqlStorage) {
    this.#tables = new DurableObjectTables(storage, SEQUENCE_SCHEMA);
  }

  async next(): Promise<number> {
    return this.#tables.transact((sql) => {
      const [row] = sql.exec(`UPDATE ${SEQUENCE_TABLE} SET last = last + 1 WHERE id = 1 RETURNING last`).toArray();
      return Sequence.parse(row?.last);
    });
  }

  async ensureAbove(floor: number): Promise<void> {
    const target = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(floor);
    this.#tables.transact((sql) => sql.exec(`UPDATE ${SEQUENCE_TABLE} SET last = MAX(last, ?) WHERE id = 1`, target));
  }
}
