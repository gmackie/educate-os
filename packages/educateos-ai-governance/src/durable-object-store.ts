// The Durable Object implementation of `LedgerStore`, published as its own entry point
// (`@educateos/ai-governance/durable-object-store`). It names the storage it needs structurally and
// imports nothing from `cloudflare:workers`, so the package's main entry stays runtime-agnostic and
// a Worker that hosts a ledger chooses its own Durable Object class around it.
import { z } from "zod";
import { migrateLegacyTables } from "@educateos/contracts/legacy-tables";
import {
  CurrentLedgerEntry,
  ENTRY_SCHEMA_VERSION,
  LedgerEntry,
  LedgerIndex,
  LegacyLedgerEntryV1,
  upgradeLedgerEntryV1,
} from "./entries.ts";
import type { LedgerDecision, LedgerStore } from "./store.ts";

/** A value SQLite stores in one column. */
export type LedgerSqlValue = string | number | null;

/**
 * The part of a SQLite-backed Durable Object's `ctx.storage` the store uses: synchronous SQL and
 * synchronous transactions. `DurableObjectStorage` satisfies it as it is.
 */
export interface LedgerSqlStorage {
  /** The SQL API. */
  readonly sql: {
    /** Runs one statement, returning a cursor over its rows. */
    exec(query: string, ...bindings: LedgerSqlValue[]): { toArray(): Record<string, unknown>[] };
  };
  /** Runs `closure` in one transaction, rolled back if it throws. */
  transactionSync<T>(closure: () => T): T;
}

/** The table entries are appended to. Exported so tests and migrations can name it. */
export const LEDGER_ENTRIES_TABLE = "educateos_ai_ledger_entries";

// `seq` keeps append order. The version, type and request ID are copies of what the JSON holds, so
// the table can be read and indexed without parsing; the JSON is what is trusted. The triggers make
// the table append-only at the storage layer, so no code path can rewrite history.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ${LEDGER_ENTRIES_TABLE} (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_schema_version INTEGER NOT NULL,
    entry_type TEXT NOT NULL,
    request_id TEXT,
    entry_json TEXT NOT NULL
  )`,
  `CREATE TRIGGER IF NOT EXISTS ${LEDGER_ENTRIES_TABLE}_no_update BEFORE UPDATE ON ${LEDGER_ENTRIES_TABLE}
    BEGIN SELECT RAISE(ABORT, 'ledger entries are append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS ${LEDGER_ENTRIES_TABLE}_no_delete BEFORE DELETE ON ${LEDGER_ENTRIES_TABLE}
    BEGIN SELECT RAISE(ABORT, 'ledger entries are append-only'); END`,
];

const StoredRow = z.object({
  seq: z.number(),
  entry_schema_version: z.number(),
  entry_json: z.string(),
});

// Each stored version is parsed with that version's schema only, so a row whose version column and
// body disagree is refused rather than read as whichever format happens to fit.
const ENTRY_BY_VERSION: Record<number, z.ZodType<LedgerEntry>> = {
  1: LegacyLedgerEntryV1.transform(upgradeLedgerEntryV1),
  [ENTRY_SCHEMA_VERSION]: CurrentLedgerEntry,
};

/** Thrown when a stored row cannot be read. The ledger refuses to decide on history it cannot read. */
export class LedgerCorruptionError extends Error {
  override readonly name = "LedgerCorruptionError";
}

function parseRow(raw: Record<string, unknown>): LedgerEntry {
  const row = StoredRow.safeParse(raw);
  if (!row.success) throw new LedgerCorruptionError("a ledger row has an unexpected shape");
  const schema = ENTRY_BY_VERSION[row.data.entry_schema_version];
  if (schema === undefined) {
    throw new LedgerCorruptionError(`ledger row ${row.data.seq} has unknown entry schema version ${row.data.entry_schema_version}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(row.data.entry_json);
  } catch {
    throw new LedgerCorruptionError(`ledger row ${row.data.seq} is not JSON`);
  }
  const entry = schema.safeParse(json);
  // Field paths only: a row is content-free by schema, but an unreadable one is not trusted to be.
  if (!entry.success) throw new LedgerCorruptionError(`ledger row ${row.data.seq} does not match its schema version`);
  return entry.data;
}

/**
 * A {@link LedgerStore} in a SQLite-backed Durable Object's storage. One Durable Object holds one
 * district's (or billing owner's) ledger, and the store is created once per object instance.
 *
 * Entries are appended to one table as JSON, each with the schema version it was written at, and
 * every row is parsed with that version's schema when the store loads, so version 1 entries are
 * read and upgraded exactly as {@link LedgerEntry} does. The table is append-only: triggers refuse
 * any update or delete.
 *
 * The rows are folded into an in-memory {@link LedgerIndex} on first use, which is what replays a
 * restarted object to the same balances. That cache cannot go stale: only this object writes the
 * table, and if a write fails to persist the runtime discards the object, cache and all.
 *
 * `transact` runs `decide` and appends its entries inside one `transactionSync`, with no `await`
 * between reading the index and committing. Two reservations arriving together therefore cannot
 * interleave: the object runs one synchronous block at a time, so the second decides only after
 * the first has committed (input gates also hold other events while a storage operation is in
 * flight, but the guarantee does not rest on them). A `decide` that throws, or an entry that fails
 * validation, rolls the whole step back.
 */
export class DurableObjectLedgerStore implements LedgerStore {
  readonly #storage: LedgerSqlStorage;
  #index: LedgerIndex | undefined;

  constructor(storage: LedgerSqlStorage) {
    this.#storage = storage;
  }

  async read(): Promise<LedgerIndex> {
    return new LedgerIndex(this.#load().entries);
  }

  async transact<T>(decide: (ledger: LedgerIndex) => LedgerDecision<T>): Promise<T> {
    const index = this.#load();
    const { appended, result } = this.#storage.transactionSync(() => {
      const decision = decide(index);
      const parsed = decision.append.map((entry) => LedgerEntry.parse(entry));
      for (const entry of parsed) {
        this.#storage.sql.exec(
          `INSERT INTO ${LEDGER_ENTRIES_TABLE} (entry_schema_version, entry_type, request_id, entry_json) VALUES (?, ?, ?, ?)`,
          entry.entrySchemaVersion,
          entry.type,
          "requestId" in entry ? entry.requestId : null,
          JSON.stringify(entry),
        );
      }
      return { appended: parsed, result: decision.result };
    });
    // Only once the transaction has committed, so a rolled-back step leaves the index untouched.
    for (const entry of appended) index.apply(entry);
    return result;
  }

  #load(): LedgerIndex {
    if (this.#index !== undefined) return this.#index;
    // The entries written before the rename (SCHO-232) come first, as they were appended first. The
    // ledger is folded inside the migration's transaction, so a merged history the ledger refuses
    // rolls the migration back and leaves the legacy table where it was.
    this.#index = this.#storage.transactionSync(() => {
      for (const statement of SCHEMA) this.#storage.sql.exec(statement);
      migrateLegacyTables(this.#storage.sql, [LEDGER_ENTRIES_TABLE]);
      const rows = this.#storage.sql.exec(
        `SELECT seq, entry_schema_version, entry_json FROM ${LEDGER_ENTRIES_TABLE} ORDER BY seq`,
      ).toArray();
      return new LedgerIndex(rows.map(parseRow));
    });
    return this.#index;
  }
}
