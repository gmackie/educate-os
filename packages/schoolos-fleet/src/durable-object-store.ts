// Durable Object storage for the fleet, published as its own entry point
// (`@schoolos/fleet/durable-object-store`). It names the storage it needs structurally and imports
// nothing from `cloudflare:workers`, so the package's main entry stays runtime-agnostic and the
// Worker hosting the agent chooses its own Durable Object class around it.
import { z } from "zod";
import type { SequenceCounter } from "./agent.ts";
import { Sequence } from "./protocol.ts";

/** A value SQLite stores in one column. */
export type SqlValue = string | number | null;

/**
 * The part of a SQLite-backed Durable Object's `ctx.storage` the SchoolOS Durable Object stores
 * use: synchronous SQL and synchronous transactions. `DurableObjectStorage` satisfies it as it is.
 * `@schoolos/releases` and `@schoolos/commerce` build their stores on it too.
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
 * before it is returned, each in its own synchronous transaction, so a restarted or evicted agent
 * carries on from the last number it handed out rather than falling behind the root's last
 * accepted sequence and being refused as a replay. Concurrent callers never get the same number.
 */
export class DurableObjectSequenceCounter implements SequenceCounter {
  readonly #storage: DurableObjectSqlStorage;
  #ready = false;

  constructor(storage: DurableObjectSqlStorage) {
    this.#storage = storage;
  }

  async next(): Promise<number> {
    return this.#transact(() => {
      const [row] = this.#storage.sql.exec(`UPDATE ${SEQUENCE_TABLE} SET last = last + 1 WHERE id = 1 RETURNING last`).toArray();
      return Sequence.parse(row?.last);
    });
  }

  async ensureAbove(floor: number): Promise<void> {
    const target = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(floor);
    this.#transact(() => this.#storage.sql.exec(`UPDATE ${SEQUENCE_TABLE} SET last = MAX(last, ?) WHERE id = 1`, target));
  }

  // The schema is created in the first transaction and remembered only once that one commits.
  #transact<T>(closure: () => T): T {
    const result = this.#storage.transactionSync(() => {
      if (!this.#ready) for (const statement of SEQUENCE_SCHEMA) this.#storage.sql.exec(statement);
      return closure();
    });
    this.#ready = true;
    return result;
  }
}
