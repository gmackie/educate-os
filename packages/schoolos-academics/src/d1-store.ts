import { SchoolOsError, type DistrictDirectorySnapshot } from "@schoolos/contracts";
import type { AcademicStore, StoredDirectory } from "./store.ts";
import { validateDirectory } from "./validation.ts";
import { canonicalJson, parseStoredDirectory, RECORD_LISTS, RECORD_TABLES, rowChanges, rowsOf, type RecordList, type Row } from "./directory-rows.ts";

/**
 * The part of a D1 prepared statement the store uses. A Workers `D1PreparedStatement` satisfies
 * it as it is; it is named structurally so this package's sources compile without the Workers
 * runtime's typings (ADR-0009).
 */
export interface D1StatementLike {
  /** Binds the statement's `?` parameters. */
  bind(...values: (string | number | null)[]): D1StatementLike;
}

/** The part of a Workers `D1Database` binding the store uses. */
export interface D1DatabaseLike {
  /** Prepares one statement. */
  prepare(query: string): D1StatementLike;
  /** Runs statements in one transaction: all of them commit, or none does. */
  batch(statements: D1StatementLike[]): Promise<{ results?: unknown[] }[]>;
}

const VERSION_CONFLICT = "schoolos: academic directory version conflict";

function isVersionConflict(error: unknown): boolean {
  return error instanceof Error && error.message.includes(VERSION_CONFLICT);
}

/**
 * An {@link AcademicStore} on Cloudflare D1, over the tables `migrations/0001_academic_directory.sql`
 * creates. One database holds one district's directory.
 *
 * A commit writes only the rows that differ from the version it was planned against: inserted,
 * changed (content or position) and removed records, in one `batch`, which D1 runs as a single
 * transaction. The batch's first statement is the version check, a trigger that aborts the batch
 * unless the stored version is still the expected one, so a concurrent commit can never be
 * overwritten, even by a second store instance or Worker isolate.
 *
 * Loading reads every table in one batch, so it sees a single committed version, and parses the
 * result with the contract schema: a row edited outside the store fails the load rather than
 * reaching a decision.
 */
export class D1AcademicStore implements AcademicStore {
  readonly #db: D1DatabaseLike;
  /** The last version this instance read or wrote, which a commit at that version diffs against. */
  #known: { version: number; snapshot: DistrictDirectorySnapshot } | undefined;

  constructor(db: D1DatabaseLike) {
    this.#db = db;
  }

  /**
   * Stores `snapshot` as version 0 of an empty database, after parsing and integrity-checking it
   * (refused with `validation-failed` listing every issue). Refused with `conflict` if the database
   * already holds a directory, in which case nothing is written.
   */
  static async seed(db: D1DatabaseLike, snapshot: DistrictDirectorySnapshot): Promise<D1AcademicStore> {
    const valid = validateDirectory(snapshot);
    const inserts = [
      db.prepare("INSERT INTO academic_directory (singleton, district_id, version, district_json) VALUES (1, ?, 0, ?)")
        .bind(valid.district.id, canonicalJson(valid.district)),
    ];
    const rows = rowsOf(valid);
    for (const list of RECORD_LISTS) {
      for (const [key, row] of rows[list]) inserts.push(insertRow(db, list, key, row));
    }
    try {
      await db.batch(inserts);
    } catch (error) {
      if (error instanceof Error && /UNIQUE|PRIMARY KEY/i.test(error.message)) {
        throw new SchoolOsError("conflict", "This database already holds an academic directory.");
      }
      throw error;
    }
    return new D1AcademicStore(db);
  }

  async load(): Promise<StoredDirectory> {
    const [meta, ...lists] = await this.#db.batch([
      this.#db.prepare("SELECT version, district_json FROM academic_directory WHERE singleton = 1"),
      ...RECORD_LISTS.map((list) => this.#db.prepare(`SELECT record_json FROM ${RECORD_TABLES[list]} ORDER BY position`)),
    ]);
    const head = meta?.results?.[0] as { version: number; district_json: string } | undefined;
    if (head === undefined) throw new Error("the academic directory database has not been seeded");

    const rows = Object.fromEntries(RECORD_LISTS.map((list, i) =>
      [list, (lists[i]?.results ?? []).map((row) => (row as { record_json: string }).record_json)])) as Record<RecordList, string[]>;
    const snapshot = parseStoredDirectory(head.district_json, rows);
    this.#known = { version: head.version, snapshot };
    return { version: head.version, snapshot: structuredClone(snapshot) };
  }

  async commit(next: DistrictDirectorySnapshot, expectedVersion: number): Promise<void> {
    const base = this.#known?.version === expectedVersion ? this.#known : await this.load();
    if (base.version !== expectedVersion) {
      throw new SchoolOsError("conflict", "The directory changed while this request was in progress; retry it.");
    }
    const current = base.snapshot;
    if (next.district.id !== current.district.id) {
      throw new SchoolOsError("conflict", "A directory store holds one district, which a commit cannot change.");
    }

    const db = this.#db;
    const statements = [db.prepare("INSERT INTO academic_directory_commit (expected_version) VALUES (?)").bind(expectedVersion)];
    const districtJson = canonicalJson(next.district);
    if (districtJson !== canonicalJson(current.district)) {
      statements.push(db.prepare("UPDATE academic_directory SET district_json = ? WHERE singleton = 1").bind(districtJson));
    }
    for (const change of rowChanges(current, next)) {
      const table = RECORD_TABLES[change.list];
      if (change.kind === "delete") statements.push(db.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(change.key));
      else if (change.kind === "insert") statements.push(insertRow(db, change.list, change.key, change.row));
      else statements.push(db.prepare(`UPDATE ${table} SET position = ?, record_json = ? WHERE id = ?`).bind(change.row.position, change.row.json, change.key));
    }

    try {
      await db.batch(statements);
    } catch (error) {
      if (!isVersionConflict(error)) throw error;
      this.#known = undefined;
      throw new SchoolOsError("conflict", "The directory changed while this request was in progress; retry it.");
    }
    this.#known = { version: expectedVersion + 1, snapshot: structuredClone(next) };
  }
}

function insertRow(db: D1DatabaseLike, list: RecordList, key: string, row: Row): D1StatementLike {
  return db.prepare(`INSERT INTO ${RECORD_TABLES[list]} (id, position, record_json) VALUES (?, ?, ?)`).bind(key, row.position, row.json);
}
