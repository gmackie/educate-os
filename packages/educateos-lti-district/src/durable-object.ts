// The Durable Object implementation of `RecordTable`, published as its own entry point
// (`@educateos/lti-district/durable-object`). It names the storage it needs structurally and imports
// nothing from `cloudflare:workers`, so the main entry stays runtime-agnostic and the district
// Worker chooses its own Durable Object class around it (one object per district).
import { migrateLegacyTables } from "@educateos/contracts/legacy-tables";
import type { RecordTable, TableRow } from "./table.ts";

/** A value SQLite stores in one column. */
export type LtiSqlValue = string | number | null;

/**
 * The part of a SQLite-backed Durable Object's `ctx.storage` the table uses: synchronous SQL and
 * synchronous transactions. `DurableObjectStorage` satisfies it as it is.
 */
export interface LtiSqlStorage {
  /** The SQL API. */
  readonly sql: {
    /** Runs one statement, returning a cursor over its rows. */
    exec(query: string, ...bindings: LtiSqlValue[]): { toArray(): Record<string, unknown>[] };
  };
  /** Runs `closure` in one transaction, rolled back if it throws. */
  transactionSync<T>(closure: () => T): T;
}

/** The table every LTI record lives in. Exported so tests and migrations can name it. */
export const LTI_RECORDS_TABLE = "educateos_lti_records";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ${LTI_RECORDS_TABLE} (
    collection TEXT NOT NULL,
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    expires_at INTEGER,
    PRIMARY KEY (collection, key)
  )`,
  `CREATE INDEX IF NOT EXISTS ${LTI_RECORDS_TABLE}_expiry ON ${LTI_RECORDS_TABLE} (collection, expires_at)
    WHERE expires_at IS NOT NULL`,
];

/** Thrown when a stored row cannot be read. A store refuses to decide on state it cannot read. */
export class LtiRecordCorruptionError extends Error {
  override readonly name = "LtiRecordCorruptionError";
}

function rowOf(raw: Record<string, unknown>): TableRow {
  const { value_json: json, expires_at: expiresAt } = raw;
  if (typeof json !== "string" || (expiresAt !== null && typeof expiresAt !== "number")) {
    throw new LtiRecordCorruptionError("an LTI record has an unexpected shape");
  }
  try {
    return { value: JSON.parse(json), expiresAt: expiresAt ?? undefined };
  } catch {
    throw new LtiRecordCorruptionError("an LTI record is not JSON");
  }
}

/**
 * A {@link RecordTable} in a SQLite-backed Durable Object's storage, created once per object
 * instance. `delete` is a single `DELETE … RETURNING`, so a single-use value is read and removed in
 * one statement, and {@link atomically} is `transactionSync`.
 */
export class DurableObjectRecordTable implements RecordTable {
  readonly #raw: LtiSqlStorage;
  #ready = false;

  constructor(storage: LtiSqlStorage) {
    this.#raw = storage;
  }

  /**
   * The storage, its table created on first use rather than when the table is made, so a failed
   * migration fails LTI's own calls and not the start of the object holding it.
   */
  get #storage(): LtiSqlStorage {
    if (!this.#ready) {
      this.#raw.transactionSync(() => {
        for (const statement of SCHEMA) this.#raw.sql.exec(statement);
        // Records from before the rename (SCHO-232); one written since under the same key wins.
        migrateLegacyTables(this.#raw.sql, [{ table: LTI_RECORDS_TABLE, merge: { kind: "keyed" } }]);
      });
      this.#ready = true;
    }
    return this.#raw;
  }

  get(collection: string, key: string): TableRow | undefined {
    const [row] = this.#storage.sql
      .exec(`SELECT value_json, expires_at FROM ${LTI_RECORDS_TABLE} WHERE collection = ? AND key = ?`, collection, key)
      .toArray();
    return row === undefined ? undefined : rowOf(row);
  }

  put(collection: string, key: string, value: unknown, expiresAt?: number): void {
    this.#storage.sql.exec(
      `INSERT INTO ${LTI_RECORDS_TABLE} (collection, key, value_json, expires_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (collection, key) DO UPDATE SET value_json = excluded.value_json, expires_at = excluded.expires_at`,
      collection,
      key,
      JSON.stringify(value),
      expiresAt ?? null,
    );
  }

  delete(collection: string, key: string): TableRow | undefined {
    const [row] = this.#storage.sql
      .exec(`DELETE FROM ${LTI_RECORDS_TABLE} WHERE collection = ? AND key = ? RETURNING value_json, expires_at`, collection, key)
      .toArray();
    return row === undefined ? undefined : rowOf(row);
  }

  list(collection: string): { key: string; row: TableRow }[] {
    return this.#storage.sql
      .exec(`SELECT key, value_json, expires_at FROM ${LTI_RECORDS_TABLE} WHERE collection = ? ORDER BY key`, collection)
      .toArray()
      .map((raw) => {
        if (typeof raw.key !== "string") throw new LtiRecordCorruptionError("an LTI record has an unexpected key");
        return { key: raw.key, row: rowOf(raw) };
      });
  }

  purgeExpired(collection: string, now: number): void {
    this.#storage.sql.exec(
      `DELETE FROM ${LTI_RECORDS_TABLE} WHERE collection = ? AND expires_at IS NOT NULL AND expires_at <= ?`,
      collection,
      now,
    );
  }

  atomically<T>(step: () => T): T {
    return this.#storage.transactionSync(step);
  }
}
