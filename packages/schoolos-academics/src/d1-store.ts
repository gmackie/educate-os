import { DistrictDirectorySnapshot, SchoolOsError } from "@schoolos/contracts";
import type { AcademicStore, StoredDirectory } from "./store.ts";
import { validateDirectory } from "./validation.ts";

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

/** The record lists of a directory and the table each is stored in. */
const RECORD_TABLES = {
  schools: "academic_schools",
  terms: "academic_terms",
  courses: "academic_courses",
  offerings: "academic_offerings",
  principals: "academic_principals",
  enrollments: "academic_enrollments",
  roleAssignments: "academic_role_assignments",
} as const satisfies Record<Exclude<keyof DistrictDirectorySnapshot, "district">, string>;

type RecordList = keyof typeof RECORD_TABLES;
const RECORD_LISTS = Object.keys(RECORD_TABLES) as RecordList[];

const VERSION_CONFLICT = "schoolos: academic directory version conflict";

/**
 * JSON with object keys sorted, so a record serializes the same however it was built and the
 * store can tell a changed row from an unchanged one by comparing strings.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner,
  );
}

/** A record's key in its table: its ID, or for a role assignment (which has none) its JSON. */
function keyOf(record: object, json: string): string {
  return "id" in record && typeof record.id === "string" ? record.id : json;
}

interface Row {
  position: number;
  json: string;
}

/** Each list's rows by key, as the store holds them. */
type Rows = Record<RecordList, Map<string, Row>>;

function rowsOf(snapshot: DistrictDirectorySnapshot): Rows {
  const rows = {} as Rows;
  for (const list of RECORD_LISTS) {
    rows[list] = new Map(
      (snapshot[list] as object[]).map((record, position) => {
        const json = canonicalJson(record);
        return [keyOf(record, json), { position, json }];
      }),
    );
  }
  return rows;
}

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

    const raw: Record<string, unknown> = { district: JSON.parse(head.district_json) };
    RECORD_LISTS.forEach((list, i) => {
      raw[list] = (lists[i]?.results ?? []).map((row) => JSON.parse((row as { record_json: string }).record_json));
    });
    const parsed = DistrictDirectorySnapshot.safeParse(raw);
    // Paths only: the rows hold personal data, and an unreadable row is not trusted to be safe to log.
    if (!parsed.success) {
      throw new Error(`the stored academic directory is unreadable at ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
    }
    this.#known = { version: head.version, snapshot: parsed.data };
    return { version: head.version, snapshot: structuredClone(parsed.data) };
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
    const before = rowsOf(current);
    const after = rowsOf(next);
    for (const list of RECORD_LISTS) {
      for (const key of before[list].keys()) {
        if (!after[list].has(key)) statements.push(db.prepare(`DELETE FROM ${RECORD_TABLES[list]} WHERE id = ?`).bind(key));
      }
      for (const [key, row] of after[list]) {
        const was = before[list].get(key);
        if (was === undefined) statements.push(insertRow(db, list, key, row));
        else if (was.json !== row.json || was.position !== row.position) {
          statements.push(
            db.prepare(`UPDATE ${RECORD_TABLES[list]} SET position = ?, record_json = ? WHERE id = ?`).bind(row.position, row.json, key),
          );
        }
      }
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
