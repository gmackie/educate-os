// Recovery of the tables the EducateOS rename orphaned (SCHO-232), published as its own entry point
// (`@educateos/contracts/legacy-tables`).
//
// The rename (SCHO-200) renamed every SQLite table a Durable Object store keeps from `schoolos_*`
// to `educateos_*`. The first deploy of it created the new tables empty beside the old ones, so a
// live district's data stayed in tables nothing read any more, while new rows went to the new ones.
// Each store therefore calls `migrateLegacyTables` in its schema setup, inside the transaction that
// creates its tables and before it reads them: for each of its tables whose legacy twin exists, the
// legacy rows are copied in, every conflict with a row written since is settled by a rule the store
// names, and the legacy table is renamed to `schoolos_<name>_premigration` and kept, never dropped.
// Once that table is gone the call costs one `sqlite_master` lookup.
//
// The helper names the storage it needs structurally, like the stores, so it runs over a Durable
// Object's `ctx.storage.sql` and over Node's SQLite in tests. Table and column names are this
// repository's constants, checked against a strict pattern before they are put in SQL.

/**
 * The part of a SQLite-backed Durable Object's `ctx.storage.sql` the migration uses. Every store's
 * own storage type satisfies it.
 */
export interface LegacySql {
  /** Runs one statement, returning a cursor over its rows. */
  exec(query: string, ...bindings: (string | number)[]): { toArray(): Record<string, unknown>[] };
}

/** The prefix the rename gave every store's tables. */
export const TABLE_PREFIX = "educateos_";

/** The prefix the same tables had before the rename. */
export const LEGACY_TABLE_PREFIX = "schoolos_";

/** Appended to a legacy table's name once its rows are copied: the table is kept as a backup. */
export const PREMIGRATION_SUFFIX = "_premigration";

/**
 * How rows the legacy table and the current one both hold are settled. In every rule a row the
 * legacy table alone holds is copied with its values unchanged.
 *
 * - `rows`: rows are independent records. A legacy row that collides with a current one on the
 *   primary key or a unique constraint is left in the backup: the current row is the later write.
 *   Legacy rows keep their rowids and the current rows are moved after them, so a table read in
 *   insertion order (an `AUTOINCREMENT` log, rows read `ORDER BY rowid`) reads the legacy rows
 *   first, as they were written first. A current row's sequence number therefore changes.
 * - `keyed`: as `rows`, for a table only ever read by key, so insertion order is not kept: the
 *   current rows are not moved and copied rows get new rowids. For one-row tables (pinned by
 *   `CHECK (id = 1)`), where the current row, if any, wins, and for large content.
 * - `positions`: rows form one list per `parent`, numbered from 0 by `position`. A parent's legacy
 *   rows keep their positions and its current rows follow them, renumbered in their order.
 * - `revision`: one row per primary key, carrying the revision optimistic concurrency checks. For a
 *   key both tables hold, the current row is kept and its revision set past both, so a change
 *   planned against either side fails with `conflict` and is planned again over the merged rows.
 */
export type LegacyRowMerge =
  | { readonly kind: "rows" }
  | { readonly kind: "keyed" }
  | { readonly kind: "positions"; readonly parent: readonly string[]; readonly position: string }
  | { readonly kind: "revision"; readonly key: readonly string[]; readonly revision: string };

/** One table to recover rows into. */
export interface LegacyTable {
  /** The table's current name, starting with {@link TABLE_PREFIX}. Its legacy name is derived. */
  readonly table: string;
  /** How conflicting rows are settled. Defaults to `{ kind: "rows" }`. */
  readonly merge?: LegacyRowMerge;
  /**
   * A further condition under which a legacy row is left in the backup rather than copied: SQL
   * over the alias `legacy` (the legacy row), which may name the current table.
   */
  readonly skipLegacyWhere?: string;
  /**
   * Set when no legacy row may be left out by a conflict, because the store cannot tell which side
   * to keep: the migration then throws an error with this message, which rolls it back.
   */
  readonly refuseConflicts?: string;
}

/**
 * A document a store keeps as a whole in one or more tables (a one-row state, a chunked document's
 * head and parts), which no row rule can merge. The store reads both sides and writes the result.
 */
export interface LegacyDocument {
  /** The document's tables, by current name. All are renamed once `migrate` has run. */
  readonly tables: readonly string[];
  /**
   * Copies the legacy document into the current tables, which the store's schema has created.
   * Runs only when the first table's legacy twin exists. `legacy` maps a current table name to its
   * legacy name. A merge the store cannot make safely must throw, which rolls the migration back.
   */
  migrate(sql: LegacySql, legacy: (table: string) => string): void;
}

/** One entry of a store's migration: a table name (merged by `rows`), a table, or a document. */
export type LegacyTablePlan = string | LegacyTable | LegacyDocument;

const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

function identifier(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`not a table or column name: ${name}`);
  return name;
}

/** The name `table` had before the rename. */
export function legacyTableName(table: string): string {
  if (!identifier(table).startsWith(TABLE_PREFIX)) throw new Error(`${table} does not start with ${TABLE_PREFIX}`);
  return LEGACY_TABLE_PREFIX + table.slice(TABLE_PREFIX.length);
}

function tableExists(sql: LegacySql, name: string): boolean {
  return sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length > 0;
}

interface Column {
  name: string;
  required: boolean;
  /** Whether the column is the table's `INTEGER PRIMARY KEY`, an alias of its rowid. */
  rowid: boolean;
}

function columns(sql: LegacySql, table: string): Column[] {
  const info = sql.exec(`PRAGMA table_info(${identifier(table)})`).toArray();
  const keys = info.filter((c) => Number(c.pk) > 0);
  return info.map((c) => ({
    name: identifier(String(c.name)),
    required: Number(c.notnull) === 1 && c.dflt_value === null && Number(c.pk) === 0,
    rowid: keys.length === 1 && Number(c.pk) === 1 && String(c.type).toUpperCase() === "INTEGER",
  }));
}

function maxRowid(sql: LegacySql, table: string): number {
  const [row] = sql.exec(`SELECT COALESCE(MAX(rowid), 0) AS n FROM ${table}`).toArray();
  return Number(row?.n ?? 0);
}

/** Runs `closure` with the table's triggers (append-only, monotonic) lifted, then restores them. */
function withoutTriggers(sql: LegacySql, table: string, closure: () => void): void {
  const triggers = sql.exec("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?", table).toArray();
  for (const trigger of triggers) sql.exec(`DROP TRIGGER ${identifier(String(trigger.name))}`);
  closure();
  for (const trigger of triggers) sql.exec(String(trigger.sql));
}

const POSITION_OFFSET = 1_000_000_000;

function copyRows(sql: LegacySql, plan: LegacyTable, legacy: string): void {
  const current = identifier(plan.table);
  const merge = plan.merge ?? { kind: "rows" };
  const target = columns(sql, current);
  const source = new Set(columns(sql, legacy).map((c) => c.name));
  const missing = target.filter((c) => c.required && !source.has(c.name)).map((c) => c.name);
  if (missing.length > 0) throw new Error(`${legacy} has no ${missing.join(", ")} for ${current}`);
  const shared = target.filter((c) => source.has(c.name));
  // Only the `rows` rule keeps rowids: it has made room for them. The others let SQLite assign them.
  const keepRowid = merge.kind === "rows" && !shared.some((c) => c.rowid);
  const list = [...(keepRowid ? ["rowid"] : []), ...shared.map((c) => c.name)].join(", ");
  const sameKey = (keys: readonly string[]) => keys.map((k) => `legacy.${identifier(k)} = ${current}.${k}`).join(" AND ");
  const currentHasRows = sql.exec(`SELECT 1 FROM ${current} LIMIT 1`).toArray().length > 0;

  if (currentHasRows && merge.kind !== "keyed") {
    withoutTriggers(sql, current, () => {
      if (merge.kind === "revision") {
        const rev = identifier(merge.revision);
        sql.exec(
          `UPDATE ${current} SET ${rev} = MAX(${rev}, (SELECT legacy.${rev} FROM ${legacy} AS legacy WHERE ${sameKey(merge.key)})) + 1
           WHERE EXISTS (SELECT 1 FROM ${legacy} AS legacy WHERE ${sameKey(merge.key)})`,
        );
      } else if (merge.kind === "positions") {
        // Through a high range first, so no step of the renumbering collides with a row not yet moved.
        const pos = identifier(merge.position);
        sql.exec(`UPDATE ${current} SET ${pos} = ${pos} + ${POSITION_OFFSET} WHERE EXISTS (SELECT 1 FROM ${legacy} AS legacy WHERE ${sameKey(merge.parent)})`);
        sql.exec(
          `UPDATE ${current} SET ${pos} = ${pos} - ${POSITION_OFFSET} + (SELECT MAX(legacy.${pos}) + 1 FROM ${legacy} AS legacy WHERE ${sameKey(merge.parent)})
           WHERE ${pos} >= ${POSITION_OFFSET}`,
        );
      } else if (merge.kind === "rows") {
        // Past every rowid either table holds, so the move cannot collide and the legacy rows fit below.
        const offset = Math.max(maxRowid(sql, legacy), maxRowid(sql, current));
        if (offset > 0) sql.exec(`UPDATE ${current} SET rowid = rowid + ${offset}`);
      }
    });
  }

  const skip = plan.skipLegacyWhere === undefined ? "" : ` WHERE NOT (${plan.skipLegacyWhere})`;
  const before = count(sql, current);
  sql.exec(`INSERT OR IGNORE INTO ${current} (${list}) SELECT ${list} FROM ${legacy} AS legacy${skip} ORDER BY rowid`);
  if (plan.refuseConflicts !== undefined && count(sql, current) - before < count(sql, `${legacy} AS legacy${skip}`)) {
    throw new Error(plan.refuseConflicts);
  }
}

function count(sql: LegacySql, from: string): number {
  const [row] = sql.exec(`SELECT COUNT(*) AS n FROM ${from}`).toArray();
  return Number(row?.n ?? 0);
}

function backupName(sql: LegacySql, legacy: string): string {
  // A second legacy table can appear only if pre-rename code ran again; its backup gets its own name.
  for (let n = 1; ; n++) {
    const name = `${legacy}${PREMIGRATION_SUFFIX}${n === 1 ? "" : `_${n}`}`;
    if (!tableExists(sql, name)) return name;
  }
}

/**
 * Recovers a store's rows from the tables the rename orphaned, for each entry of `plan` whose
 * legacy table exists: copies the legacy rows into the current table by its rule, then renames the
 * legacy table to `<legacy name>_premigration`. Run it inside the store's schema transaction, after
 * the `CREATE TABLE IF NOT EXISTS` statements and before any read, so a failure rolls back the
 * whole migration and leaves the legacy tables as they were. Idempotent: once the legacy tables are
 * renamed it does nothing.
 *
 * @returns the legacy tables migrated by this call, by their legacy names.
 */
export function migrateLegacyTables(sql: LegacySql, plan: readonly LegacyTablePlan[]): string[] {
  const migrated: string[] = [];
  const rename = (legacy: string) => {
    sql.exec(`ALTER TABLE ${legacy} RENAME TO ${backupName(sql, legacy)}`);
    migrated.push(legacy);
  };
  for (const entry of plan) {
    if (typeof entry !== "string" && "migrate" in entry) {
      const legacy = entry.tables.map(legacyTableName);
      if (!tableExists(sql, legacy[0]!)) continue;
      entry.migrate(sql, legacyTableName);
      for (const name of legacy) if (tableExists(sql, name)) rename(name);
      continue;
    }
    const table: LegacyTable = typeof entry === "string" ? { table: entry } : entry;
    const legacy = legacyTableName(table.table);
    if (!tableExists(sql, legacy)) continue;
    copyRows(sql, table, legacy);
    rename(legacy);
  }
  return migrated;
}

/** Whether a store still has tables the rename orphaned. For checks that the migration ran. */
export function hasLegacyTables(sql: LegacySql, tables: readonly string[]): boolean {
  return tables.some((table) => tableExists(sql, legacyTableName(table)));
}

function identity(item: unknown): string {
  if (typeof item === "object" && item !== null && !Array.isArray(item) && typeof (item as { id?: unknown }).id === "string") {
    return `id:${(item as { id: string }).id}`;
  }
  return `json:${canonical(item)}`;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value).toSorted().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merges a legacy document into the current one, for a {@link LegacyDocument} whose document is an
 * object of lists and maps. Field by field: a list becomes the legacy items followed by the current
 * items it lacks, an item matched by its string `id` (or, without one, by its whole value) taking
 * the current version in the legacy item's place; a map takes the entries of both, the current
 * entry winning whole; any other value is the current one. The result is not validated: the store
 * parses it and checks its own invariants, and throws if they fail.
 */
export function mergeLegacyDocument(legacy: unknown, current: unknown): unknown {
  if (!isRecord(legacy) || !isRecord(current)) return current;
  const merged: Record<string, unknown> = { ...legacy };
  for (const [key, value] of Object.entries(current)) merged[key] = key in legacy ? mergeField(legacy[key], value) : value;
  return merged;
}

function mergeField(legacy: unknown, current: unknown): unknown {
  if (Array.isArray(legacy) && Array.isArray(current)) {
    const merged = [...legacy];
    const index = new Map(merged.map((item, i) => [identity(item), i]));
    for (const item of current) {
      const at = index.get(identity(item));
      if (at === undefined) {
        index.set(identity(item), merged.length);
        merged.push(item);
      } else {
        merged[at] = item;
      }
    }
    return merged;
  }
  if (isRecord(legacy) && isRecord(current)) return { ...legacy, ...current };
  return current;
}
