// The Durable Object implementation of `AcademicStore` (SCHO-171), published as its own entry point
// (`@educateos/academics/durable-object-store`). It names the storage it needs structurally and
// imports nothing from `cloudflare:workers`, so the package's main entry stays runtime-agnostic and
// the Worker hosting a district chooses its own Durable Object class around it.
//
// It keeps the rows `D1AcademicStore` keeps, in tables of the same names and shape, so a district
// can move its directory to D1 by copying rows once D1 is deployable (SCHO-138).
import { EducateOsError, type DistrictDirectorySnapshot } from "@educateos/contracts";
import { canonicalJson, parseStoredDirectory, RECORD_LISTS, RECORD_TABLES, rowChanges, rowsOf, type RecordList } from "./directory-rows.ts";
import type { AcademicStore, StoredDirectory } from "./store.ts";
import { validateDirectory } from "./validation.ts";

/** A value SQLite stores in one column. */
export type DirectorySqlValue = string | number | null;

/**
 * The part of a SQLite-backed Durable Object's `ctx.storage` the store uses: synchronous SQL and
 * synchronous transactions. `DurableObjectStorage` satisfies it as it is.
 */
export interface DirectorySqlStorage {
  /** The SQL API. */
  readonly sql: {
    /** Runs one statement, returning a cursor over its rows. */
    exec(query: string, ...bindings: DirectorySqlValue[]): { toArray(): Record<string, unknown>[] };
  };
  /** Runs `closure` in one transaction, rolled back if it throws. */
  transactionSync<T>(closure: () => T): T;
}

/** The one-row table holding the district and the directory's version. */
export const ACADEMIC_DIRECTORY_TABLE = "academic_directory";

// `migrations/0001_academic_directory.sql` without its commit view and trigger: a Durable Object
// checks the version and writes in one synchronous transaction, so nothing can commit in between.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ${ACADEMIC_DIRECTORY_TABLE} (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    district_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 0),
    district_json TEXT NOT NULL
  )`,
  ...RECORD_LISTS.map((list) =>
    `CREATE TABLE IF NOT EXISTS ${RECORD_TABLES[list]} (id TEXT PRIMARY KEY, position INTEGER NOT NULL, record_json TEXT NOT NULL)`
  ),
];

/**
 * An {@link AcademicStore} in a SQLite-backed Durable Object's storage: one object per district.
 *
 * A commit reads the stored version and directory, checks the version, and writes only the rows
 * that differ (removed, inserted and changed records), all inside one `transactionSync` with no
 * `await` in between, so two commits from the same version cannot both succeed. A load parses the
 * rows with the contract schema, so a row edited outside the store fails the load rather than
 * reaching a decision.
 */
export class DurableObjectAcademicStore implements AcademicStore {
  readonly #storage: DirectorySqlStorage;

  private constructor(storage: DirectorySqlStorage) {
    this.#storage = storage;
  }

  /**
   * The store in `storage`, seeded with `seed` as version 0 if it holds no directory yet. The seed
   * is parsed and integrity-checked first (refused with `validation-failed` listing every issue).
   * A store that already holds a directory keeps it and ignores the seed, unless it is another
   * district's, which is refused with `conflict`: one object holds one district.
   */
  static open(storage: DirectorySqlStorage, seed: DistrictDirectorySnapshot): DurableObjectAcademicStore {
    const store = new DurableObjectAcademicStore(storage);
    storage.transactionSync(() => {
      for (const statement of SCHEMA) storage.sql.exec(statement);
      const [head] = storage.sql.exec(`SELECT district_id FROM ${ACADEMIC_DIRECTORY_TABLE} WHERE singleton = 1`).toArray();
      if (head !== undefined) {
        if (head.district_id !== seed.district.id) {
          throw new EducateOsError("conflict", "This storage holds another district's directory.");
        }
        return;
      }
      const valid = validateDirectory(seed);
      storage.sql.exec(
        `INSERT INTO ${ACADEMIC_DIRECTORY_TABLE} (singleton, district_id, version, district_json) VALUES (1, ?, 0, ?)`,
        valid.district.id,
        canonicalJson(valid.district),
      );
      const rows = rowsOf(valid);
      for (const list of RECORD_LISTS) {
        for (const [key, row] of rows[list]) store.#insert(list, key, row.position, row.json);
      }
    });
    return store;
  }

  async load(): Promise<StoredDirectory> {
    return this.#storage.transactionSync(() => this.#read());
  }

  async commit(next: DistrictDirectorySnapshot, expectedVersion: number): Promise<void> {
    this.#storage.transactionSync(() => {
      const { version, snapshot: current } = this.#read();
      if (version !== expectedVersion) {
        throw new EducateOsError("conflict", "The directory changed while this request was in progress; retry it.");
      }
      if (next.district.id !== current.district.id) {
        throw new EducateOsError("conflict", "A directory store holds one district, which a commit cannot change.");
      }
      const { sql } = this.#storage;
      sql.exec(
        `UPDATE ${ACADEMIC_DIRECTORY_TABLE} SET version = ?, district_json = ? WHERE singleton = 1`,
        version + 1,
        canonicalJson(next.district),
      );
      for (const change of rowChanges(current, next)) {
        const table = RECORD_TABLES[change.list];
        if (change.kind === "delete") sql.exec(`DELETE FROM ${table} WHERE id = ?`, change.key);
        else if (change.kind === "insert") this.#insert(change.list, change.key, change.row.position, change.row.json);
        else sql.exec(`UPDATE ${table} SET position = ?, record_json = ? WHERE id = ?`, change.row.position, change.row.json, change.key);
      }
    });
  }

  #insert(list: RecordList, key: string, position: number, json: string): void {
    this.#storage.sql.exec(`INSERT INTO ${RECORD_TABLES[list]} (id, position, record_json) VALUES (?, ?, ?)`, key, position, json);
  }

  #read(): StoredDirectory {
    const { sql } = this.#storage;
    const [head] = sql.exec(`SELECT version, district_json FROM ${ACADEMIC_DIRECTORY_TABLE} WHERE singleton = 1`).toArray();
    if (head === undefined || typeof head.version !== "number" || typeof head.district_json !== "string") {
      throw new Error("the academic directory has not been seeded, or its head row is unreadable");
    }
    const lists = {} as Record<RecordList, string[]>;
    for (const list of RECORD_LISTS) {
      lists[list] = sql.exec(`SELECT record_json FROM ${RECORD_TABLES[list]} ORDER BY position`).toArray().map((row) => {
        if (typeof row.record_json !== "string") throw new Error(`the stored academic directory is unreadable at ${list}`);
        return row.record_json;
      });
    }
    return { version: head.version, snapshot: parseStoredDirectory(head.district_json, lists) };
  }
}
