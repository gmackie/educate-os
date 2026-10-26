// The Durable Object implementation of `IdentityLinkStore`, published as its own entry point
// (`@educateos/identity-links/durable-object-store`). It names the storage it needs structurally and
// imports nothing from `cloudflare:workers`, so the package's main entry stays runtime-agnostic and
// the Worker that hosts a district's control Durable Object chooses its own class around it.
import { z } from "zod";
import type { DistrictId } from "@educateos/contracts";
import { migrateLegacyTables } from "@educateos/contracts/legacy-tables";
import { IdentityLinkIndex } from "./log-index.ts";
import { IdentityLinkEntry } from "./records.ts";
import { stageStep, type IdentityLinkStep, type IdentityLinkStore } from "./store.ts";

/** A value SQLite stores in one column. */
export type IdentityLinkSqlValue = string | number | null;

/**
 * The part of a SQLite-backed Durable Object's `ctx.storage` the store uses: synchronous SQL and
 * synchronous transactions. `DurableObjectStorage` satisfies it as it is.
 */
export interface IdentityLinkSqlStorage {
  /** The SQL API. */
  readonly sql: {
    /** Runs one statement, returning a cursor over its rows. */
    exec(query: string, ...bindings: IdentityLinkSqlValue[]): { toArray(): Record<string, unknown>[] };
  };
  /** Runs `closure` in one transaction, rolled back if it throws. */
  transactionSync<T>(closure: () => T): T;
}

/** The table entries are appended to. Exported so tests and migrations can name it. */
export const IDENTITY_LINK_ENTRIES_TABLE = "educateos_identity_link_entries";

/** The version entries are written at. Each stored row records its own. */
export const IDENTITY_LINK_ENTRY_SCHEMA_VERSION = 1;

// `seq` keeps append order. The version, type and request ID are copies of what the JSON holds, so
// the table can be read and indexed without parsing; the JSON is what is trusted. The triggers make
// the table append-only at the storage layer, so no code path can rewrite a decision or its audit.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ${IDENTITY_LINK_ENTRIES_TABLE} (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_schema_version INTEGER NOT NULL,
    entry_type TEXT NOT NULL,
    request_id TEXT NOT NULL,
    entry_json TEXT NOT NULL
  )`,
  `CREATE TRIGGER IF NOT EXISTS ${IDENTITY_LINK_ENTRIES_TABLE}_no_update BEFORE UPDATE ON ${IDENTITY_LINK_ENTRIES_TABLE}
    BEGIN SELECT RAISE(ABORT, 'identity-link entries are append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS ${IDENTITY_LINK_ENTRIES_TABLE}_no_delete BEFORE DELETE ON ${IDENTITY_LINK_ENTRIES_TABLE}
    BEGIN SELECT RAISE(ABORT, 'identity-link entries are append-only'); END`,
];

const StoredRow = z.object({
  seq: z.number(),
  entry_schema_version: z.number(),
  entry_json: z.string(),
});

/**
 * Thrown when the stored log cannot be read: a row of an unknown version, one that does not parse,
 * or one that breaks a transition. The control refuses to decide on a history it cannot trust.
 */
export class IdentityLinkLogCorruptionError extends Error {
  override readonly name = "IdentityLinkLogCorruptionError";
}

function parseRow(raw: Record<string, unknown>): IdentityLinkEntry {
  const row = StoredRow.safeParse(raw);
  if (!row.success) throw new IdentityLinkLogCorruptionError("an identity-link row has an unexpected shape");
  if (row.data.entry_schema_version !== IDENTITY_LINK_ENTRY_SCHEMA_VERSION) {
    throw new IdentityLinkLogCorruptionError(`identity-link row ${row.data.seq} has unknown entry schema version ${row.data.entry_schema_version}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(row.data.entry_json);
  } catch {
    throw new IdentityLinkLogCorruptionError(`identity-link row ${row.data.seq} is not JSON`);
  }
  const entry = IdentityLinkEntry.safeParse(json);
  // The row number only: a row that fails its schema is not trusted to be free of profile data.
  if (!entry.success) throw new IdentityLinkLogCorruptionError(`identity-link row ${row.data.seq} does not match its schema`);
  return entry.data;
}

/**
 * An {@link IdentityLinkStore} in a SQLite-backed Durable Object's storage: one district's control
 * object holds that district's log, and the store is created once per object instance.
 *
 * Entries are appended to one table as JSON with the schema version they were written at. On first
 * use every row is parsed and folded into an in-memory {@link IdentityLinkIndex}, re-running every
 * transition check, which is what replays a restarted object to the same state. That cache cannot
 * go stale: only this object writes the table, and if a write fails to persist the runtime discards
 * the object, cache and all.
 *
 * `transact` stages the step on a copy of the index and inserts its entries inside one
 * `transactionSync`, with no `await` between reading the index and committing, so two decisions
 * arriving together cannot interleave: the second decides only after the first has committed.
 */
export class DurableObjectIdentityLinkStore implements IdentityLinkStore {
  readonly districtId: DistrictId;
  readonly #storage: IdentityLinkSqlStorage;
  #index: IdentityLinkIndex | undefined;

  constructor(storage: IdentityLinkSqlStorage, districtId: DistrictId) {
    this.#storage = storage;
    this.districtId = districtId;
  }

  async read(): Promise<IdentityLinkIndex> {
    return this.#load().clone();
  }

  async transact<T>(decide: (index: IdentityLinkIndex) => IdentityLinkStep<T>): Promise<T> {
    const index = this.#load();
    const { staged, result } = this.#storage.transactionSync(() => {
      const step = stageStep(index, decide);
      for (const entry of step.appended) {
        this.#storage.sql.exec(
          `INSERT INTO ${IDENTITY_LINK_ENTRIES_TABLE} (entry_schema_version, entry_type, request_id, entry_json) VALUES (?, ?, ?, ?)`,
          IDENTITY_LINK_ENTRY_SCHEMA_VERSION,
          entry.type,
          entry.requestId,
          JSON.stringify(entry),
        );
      }
      return step;
    });
    // Only once the transaction has committed, so a rolled-back step leaves the index untouched.
    this.#index = staged;
    return result;
  }

  #load(): IdentityLinkIndex {
    if (this.#index !== undefined) return this.#index;
    // The entries written before the rename (SCHO-232) come first, as they were appended first. The
    // log is folded inside the migration's transaction, so a merged log that breaks its own rules
    // rolls the migration back and leaves the legacy table where it was.
    this.#index = this.#storage.transactionSync(() => {
      for (const statement of SCHEMA) this.#storage.sql.exec(statement);
      migrateLegacyTables(this.#storage.sql, [IDENTITY_LINK_ENTRIES_TABLE]);
      const rows = this.#storage.sql.exec(`SELECT seq, entry_schema_version, entry_json FROM ${IDENTITY_LINK_ENTRIES_TABLE} ORDER BY seq`).toArray();
      const entries = rows.map(parseRow);
      try {
        return new IdentityLinkIndex(this.districtId, entries);
      } catch (error) {
        throw new IdentityLinkLogCorruptionError(`the stored identity-link log breaks its own rules: ${(error as Error).message}`);
      }
    });
    return this.#index;
  }
}
