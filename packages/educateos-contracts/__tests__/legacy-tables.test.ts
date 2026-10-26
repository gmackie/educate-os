/// <reference types="node" />
// The recovery of tables the rename orphaned (SCHO-232), over Node's SQLite. The workerd suite in
// `@educateos/district-worker` runs the same migration against Durable Object storage and the
// district's own stores.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { hasLegacyTables, legacyTableName, mergeLegacyDocument, migrateLegacyTables, type LegacySql, type LegacyTablePlan } from "../src/legacy-tables.ts";

/** A Durable Object's SQL API, played by Node's SQLite, with its transactions. */
function database(): { sql: LegacySql; transaction<T>(closure: () => T): T } {
  const db = new DatabaseSync(":memory:");
  const sql: LegacySql = {
    exec: (query, ...bindings) => {
      const rows = db.prepare(query).all(...bindings) as Record<string, unknown>[];
      return { toArray: () => rows };
    },
  };
  return {
    sql,
    transaction: (closure) => {
      db.exec("BEGIN");
      try {
        const result = closure();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

// Spread: Node returns rows without a prototype, which strict equality would tell apart.
const rows = (sql: LegacySql, query: string) => sql.exec(query).toArray().map((row) => ({ ...row }));
const tables = (sql: LegacySql) => rows(sql, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name);

/** Creates a table under its legacy name and its current name, with the same DDL, as the rename left them. */
function both(sql: LegacySql, ddl: (table: string) => string[], table: string): void {
  for (const name of [legacyTableName(table), table]) for (const statement of ddl(name)) sql.exec(statement);
}

const LOG = (t: string) => [
  `CREATE TABLE ${t} (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, body TEXT NOT NULL)`,
  `CREATE TRIGGER ${t}_no_update BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT, 'append-only'); END`,
];

describe("migrateLegacyTables", () => {
  it("names the legacy and backup tables from the current name, and refuses any other name", () => {
    expect(legacyTableName("educateos_quizzes")).toBe("schoolos_quizzes"); // rename-educateos: keep
    expect(() => legacyTableName("academic_terms")).toThrow(/does not start with/);
    expect(() => legacyTableName("educateos_x; DROP TABLE y")).toThrow(/not a table or column name/);
  });

  it("does nothing, and creates nothing, when there is no legacy table", () => {
    const { sql } = database();
    sql.exec("CREATE TABLE educateos_items (id TEXT PRIMARY KEY)");
    expect(migrateLegacyTables(sql, ["educateos_items"])).toStrictEqual([]);
    expect(tables(sql)).toStrictEqual(["educateos_items"]);
  });

  it("puts an append-only log's legacy rows first, keeps the rows written since after them, and keeps the log append-only", () => {
    const { sql } = database();
    both(sql, LOG, "educateos_log");
    for (const id of ["a", "b", "c"]) sql.exec("INSERT INTO schoolos_log (id, body) VALUES (?, 'old')", id); // rename-educateos: keep
    for (const id of ["x", "y"]) sql.exec("INSERT INTO educateos_log (id, body) VALUES (?, 'new')", id);
    // The same ID on both sides: the current row is the later write and is kept.
    sql.exec("INSERT INTO schoolos_log (id, body) VALUES ('y', 'old y')"); // rename-educateos: keep

    expect(migrateLegacyTables(sql, ["educateos_log"])).toStrictEqual(["schoolos_log"]); // rename-educateos: keep
    expect(rows(sql, "SELECT seq, id, body FROM educateos_log ORDER BY seq")).toStrictEqual([
      { seq: 1, id: "a", body: "old" },
      { seq: 2, id: "b", body: "old" },
      { seq: 3, id: "c", body: "old" },
      { seq: 5, id: "x", body: "new" },
      { seq: 6, id: "y", body: "new" },
    ]);
    // The next append follows every row, and the trigger still guards the table and the backup.
    sql.exec("INSERT INTO educateos_log (id, body) VALUES ('z', 'next')");
    expect(rows(sql, "SELECT seq FROM educateos_log WHERE id = 'z'")).toStrictEqual([{ seq: 7 }]);
    expect(() => sql.exec("UPDATE educateos_log SET body = 'edited'")).toThrow(/append-only/);
    expect(() => sql.exec("UPDATE schoolos_log_premigration SET body = 'edited'")).toThrow(/append-only/); // rename-educateos: keep
    expect(rows(sql, "SELECT COUNT(*) AS n FROM schoolos_log_premigration")).toStrictEqual([{ n: 4 }]); // rename-educateos: keep
    expect(tables(sql)).toStrictEqual(["educateos_log", "schoolos_log_premigration"]); // rename-educateos: keep

    // A second start finds nothing to do.
    expect(migrateLegacyTables(sql, ["educateos_log"])).toStrictEqual([]);
    expect(rows(sql, "SELECT COUNT(*) AS n FROM educateos_log")).toStrictEqual([{ n: 6 }]);
  });

  it("copies everything as it is when nothing was written since", () => {
    const { sql } = database();
    both(sql, (t) => [`CREATE TABLE ${t} (offering_id TEXT NOT NULL, topic_id TEXT NOT NULL, body BLOB, PRIMARY KEY (offering_id, topic_id))`], "educateos_topics");
    sql.exec("INSERT INTO schoolos_topics VALUES ('o', 't2', x'01'), ('o', 't1', x'02')"); // rename-educateos: keep
    migrateLegacyTables(sql, ["educateos_topics"]);
    expect(rows(sql, "SELECT topic_id FROM educateos_topics ORDER BY rowid").map((r) => r.topic_id)).toStrictEqual(["t2", "t1"]);
  });

  it("appends the positions written since after a parent's legacy positions", () => {
    const { sql } = database();
    both(sql, (t) => [`CREATE TABLE ${t} (offering_id TEXT NOT NULL, position INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (offering_id, position))`], "educateos_releases");
    sql.exec("INSERT INTO schoolos_releases VALUES ('o1', 0, 'old 0'), ('o1', 1, 'old 1'), ('o2', 0, 'other')"); // rename-educateos: keep
    sql.exec("INSERT INTO educateos_releases VALUES ('o1', 0, 'new 0'), ('o1', 1, 'new 1'), ('o3', 0, 'only new')");
    migrateLegacyTables(sql, [{ table: "educateos_releases", merge: { kind: "positions", parent: ["offering_id"], position: "position" } }]);
    expect(rows(sql, "SELECT offering_id, position, body FROM educateos_releases ORDER BY offering_id, position")).toStrictEqual([
      { offering_id: "o1", position: 0, body: "old 0" },
      { offering_id: "o1", position: 1, body: "old 1" },
      { offering_id: "o1", position: 2, body: "new 0" },
      { offering_id: "o1", position: 3, body: "new 1" },
      { offering_id: "o2", position: 0, body: "other" },
      { offering_id: "o3", position: 0, body: "only new" },
    ]);
  });

  it("keeps the current row of a key both sides hold, with its revision past both", () => {
    const { sql } = database();
    both(sql, (t) => [`CREATE TABLE ${t} (offering_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, settings TEXT NOT NULL)`], "educateos_books");
    sql.exec("INSERT INTO schoolos_books VALUES ('o1', 7, 'old'), ('o2', 3, 'old only')"); // rename-educateos: keep
    sql.exec("INSERT INTO educateos_books VALUES ('o1', 2, 'new'), ('o3', 1, 'new only')");
    migrateLegacyTables(sql, [{ table: "educateos_books", merge: { kind: "revision", key: ["offering_id"], revision: "revision" } }]);
    expect(rows(sql, "SELECT * FROM educateos_books ORDER BY offering_id")).toStrictEqual([
      { offering_id: "o1", revision: 8, settings: "new" },
      { offering_id: "o2", revision: 3, settings: "old only" },
      { offering_id: "o3", revision: 1, settings: "new only" },
    ]);
  });

  it("keeps a one-row table's current row, and copies the legacy row when there is none", () => {
    const one = (t: string) => [`CREATE TABLE ${t} (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL)`];
    const kept = database().sql;
    both(kept, one, "educateos_state");
    kept.exec("INSERT INTO schoolos_state VALUES (1, 'old')"); // rename-educateos: keep
    kept.exec("INSERT INTO educateos_state VALUES (1, 'new')");
    migrateLegacyTables(kept, [{ table: "educateos_state", merge: { kind: "keyed" } }]);
    expect(rows(kept, "SELECT state FROM educateos_state")).toStrictEqual([{ state: "new" }]);

    const copied = database().sql;
    both(copied, one, "educateos_state");
    copied.exec("INSERT INTO schoolos_state VALUES (1, 'old')"); // rename-educateos: keep
    migrateLegacyTables(copied, [{ table: "educateos_state", merge: { kind: "keyed" } }]);
    expect(rows(copied, "SELECT state FROM educateos_state")).toStrictEqual([{ state: "old" }]);
  });

  it("leaves the legacy rows a store's condition names in the backup", () => {
    const { sql } = database();
    both(sql, (t) => [`CREATE TABLE ${t} (id TEXT PRIMARY KEY, pair TEXT NOT NULL, open INTEGER NOT NULL)`], "educateos_links");
    sql.exec("INSERT INTO schoolos_links VALUES ('l1', 'p', 1), ('l2', 'p', 0), ('l3', 'q', 1)"); // rename-educateos: keep
    sql.exec("INSERT INTO educateos_links VALUES ('n1', 'p', 1)");
    migrateLegacyTables(sql, [{
      table: "educateos_links",
      skipLegacyWhere: "legacy.open = 1 AND EXISTS (SELECT 1 FROM educateos_links AS current WHERE current.pair = legacy.pair AND current.open = 1)",
    }]);
    expect(rows(sql, "SELECT id FROM educateos_links ORDER BY id").map((r) => r.id)).toStrictEqual(["l2", "l3", "n1"]);
  });

  it("refuses, and rolls back, a merge that would leave a legacy row out when the store cannot choose", () => {
    const { sql, transaction } = database();
    both(sql, (t) => [`CREATE TABLE ${t} (id TEXT PRIMARY KEY, owner TEXT NOT NULL UNIQUE)`], "educateos_spaces");
    sql.exec("INSERT INTO schoolos_spaces VALUES ('w1', 'amara')"); // rename-educateos: keep
    sql.exec("INSERT INTO educateos_spaces VALUES ('w2', 'amara')");
    expect(() => transaction(() => migrateLegacyTables(sql, [{ table: "educateos_spaces", refuseConflicts: "two workspaces" }]))).toThrow("two workspaces");
    expect(tables(sql)).toStrictEqual(["educateos_spaces", "schoolos_spaces"]); // rename-educateos: keep
    expect(rows(sql, "SELECT id FROM educateos_spaces")).toStrictEqual([{ id: "w2" }]);
    expect(hasLegacyTables(sql, ["educateos_spaces"])).toBe(true);
  });

  it("hands a document to its store, and renames every table of it", () => {
    const { sql } = database();
    const doc = (t: string) => [`CREATE TABLE ${t} (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)`, `CREATE TABLE ${t}_parts (part INTEGER PRIMARY KEY, data TEXT NOT NULL)`];
    both(sql, doc, "educateos_doc");
    sql.exec("INSERT INTO schoolos_doc VALUES (1, '[1]')"); // rename-educateos: keep
    sql.exec("INSERT INTO educateos_doc VALUES (1, '[2]')");
    const plan: LegacyTablePlan = {
      tables: ["educateos_doc", "educateos_doc_parts"],
      migrate(s, legacy) {
        const [old] = s.exec(`SELECT json FROM ${legacy("educateos_doc")}`).toArray();
        const [now] = s.exec("SELECT json FROM educateos_doc").toArray();
        s.exec("UPDATE educateos_doc SET json = ?", JSON.stringify([...JSON.parse(String(old!.json)), ...JSON.parse(String(now!.json))]));
      },
    };
    expect(migrateLegacyTables(sql, [plan])).toStrictEqual(["schoolos_doc", "schoolos_doc_parts"]); // rename-educateos: keep
    expect(rows(sql, "SELECT json FROM educateos_doc")).toStrictEqual([{ json: "[1,2]" }]);
    expect(tables(sql)).toContain("schoolos_doc_parts_premigration"); // rename-educateos: keep
    expect(migrateLegacyTables(sql, [plan])).toStrictEqual([]);
  });

  it("gives a second backup its own name if pre-rename code ever ran again", () => {
    const { sql } = database();
    const ddl = (t: string) => [`CREATE TABLE ${t} (id TEXT PRIMARY KEY)`];
    both(sql, ddl, "educateos_items");
    sql.exec("INSERT INTO schoolos_items VALUES ('a')"); // rename-educateos: keep
    migrateLegacyTables(sql, ["educateos_items"]);
    for (const statement of ddl("schoolos_items")) sql.exec(statement); // rename-educateos: keep
    sql.exec("INSERT INTO schoolos_items VALUES ('b')"); // rename-educateos: keep
    migrateLegacyTables(sql, ["educateos_items"]);
    expect(tables(sql)).toStrictEqual(["educateos_items", "schoolos_items_premigration", "schoolos_items_premigration_2"]); // rename-educateos: keep
    expect(rows(sql, "SELECT id FROM educateos_items ORDER BY id").map((r) => r.id)).toStrictEqual(["a", "b"]);
  });

  it("refuses a legacy table that lacks a column the current one requires", () => {
    const { sql } = database();
    sql.exec("CREATE TABLE schoolos_items (id TEXT PRIMARY KEY)"); // rename-educateos: keep
    sql.exec("CREATE TABLE educateos_items (id TEXT PRIMARY KEY, body TEXT NOT NULL)");
    sql.exec("INSERT INTO schoolos_items VALUES ('a')"); // rename-educateos: keep
    expect(() => migrateLegacyTables(sql, ["educateos_items"])).toThrow(/has no body/);
  });
});

describe("mergeLegacyDocument", () => {
  it("keeps every item of both lists, legacy first, an item of both sides taking its current version", () => {
    const legacy = { artifacts: [{ id: "a", v: 1 }, { id: "b", v: 1 }], pins: [{ artifactId: "a" }], map: { s1: "x", s2: "y" }, flag: "old" };
    const current = { artifacts: [{ id: "c", v: 1 }, { id: "b", v: 2 }], pins: [{ artifactId: "a" }, { artifactId: "c" }], map: { s2: "z" }, flag: "new" };
    expect(mergeLegacyDocument(legacy, current)).toStrictEqual({
      artifacts: [{ id: "a", v: 1 }, { id: "b", v: 2 }, { id: "c", v: 1 }],
      pins: [{ artifactId: "a" }, { artifactId: "c" }],
      map: { s1: "x", s2: "z" },
      flag: "new",
    });
  });
});
