// The Durable Object implementation of `WorkspaceStore`, published as its own entry point
// (`@educateos/workspaces/durable-object-store`). It names the storage it needs structurally and
// imports nothing from `cloudflare:workers`, so the package's main entry stays runtime-agnostic and
// the Worker hosting a district's directory chooses its own Durable Object class around it.
import { z } from "zod";
import { EducateOsError } from "@educateos/contracts";
import {
  legacyTableName,
  mergeLegacyDocument,
  migrateLegacyTables,
  PREMIGRATION_SUFFIX,
  renameIdentifiers,
  type LegacySql,
  type LegacyTablePlan,
} from "@educateos/contracts/legacy-tables";
import { Workspace, WorkspaceState } from "./model.ts";
import { assertWorkspaceInvariants, emptyWorkspaceState, type StoredWorkspaces, type WorkspaceStore } from "./store.ts";

/** A value SQLite stores in one column. */
export type WorkspaceSqlValue = string | number | null;

/**
 * The part of a SQLite-backed Durable Object's `ctx.storage` the store uses: synchronous SQL and
 * synchronous transactions. `DurableObjectStorage` satisfies it as it is.
 */
export interface WorkspaceSqlStorage {
  /** The SQL API. */
  readonly sql: {
    /** Runs one statement, returning a cursor over its rows. */
    exec(query: string, ...bindings: WorkspaceSqlValue[]): { toArray(): Record<string, unknown>[] };
  };
  /** Runs `closure` in one transaction, rolled back if it throws. */
  transactionSync<T>(closure: () => T): T;
}

/** The table holding one row per workspace. Exported so tests and migrations can name it. */
export const WORKSPACES_TABLE = "educateos_workspaces";
/** The one-row table holding the version and the rest of the state. */
export const WORKSPACE_STATE_TABLE = "educateos_workspace_state";

// A workspace's kind, owner and offering are copies of what its JSON holds, so the two keys can be
// enforced by SQLite itself: the partial unique indexes make a second personal workspace for a
// principal, or a second course workspace for a principal and offering, impossible to store
// whatever the code above does. The JSON is what is read back.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ${WORKSPACES_TABLE} (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('personal', 'course')),
    owner_principal_id TEXT NOT NULL,
    offering_id TEXT,
    workspace_json TEXT NOT NULL,
    CHECK ((kind = 'course') = (offering_id IS NOT NULL))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ${WORKSPACES_TABLE}_personal_key ON ${WORKSPACES_TABLE} (owner_principal_id) WHERE kind = 'personal'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ${WORKSPACES_TABLE}_course_key ON ${WORKSPACES_TABLE} (owner_principal_id, offering_id) WHERE kind = 'course'`,
  `CREATE TABLE IF NOT EXISTS ${WORKSPACE_STATE_TABLE} (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL,
    state_json TEXT NOT NULL
  )`,
];

/** The state apart from its workspaces, which have their own table. */
const StateRest = WorkspaceState.omit({ workspaces: true });

const WorkspaceRow = z.object({ id: z.string(), workspace_json: z.string() });
const StateRow = z.object({ version: z.number(), state_json: z.string() });

/** SQL: the current workspace `legacy` has the key of, other than itself. */
const SAME_KEY = `current.owner_principal_id = legacy.owner_principal_id AND current.kind = legacy.kind
  AND (current.kind = 'personal' OR current.offering_id = legacy.offering_id) AND current.id <> legacy.id`;

/**
 * The workspaces a district kept before the rename (SCHO-232) whose key a workspace created since
 * holds (a personal workspace opened again after the rename, say), each mapped to that workspace.
 * The workspace created since is the one kept, since the newest work names it; the legacy one stays
 * in the backup, and whatever named it (grants, promotions, artifacts) is reassigned to the one kept,
 * which has the same owner, kind and offering. Works before and after the directory is migrated.
 */
export function legacyWorkspaceReplacements(sql: LegacySql): Map<string, string> {
  const legacyTable = [legacyTableName(WORKSPACES_TABLE), legacyTableName(WORKSPACES_TABLE) + PREMIGRATION_SUFFIX]
    .find((name) => sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length > 0);
  const current = sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", WORKSPACES_TABLE).toArray().length > 0;
  if (legacyTable === undefined || !current) return new Map();
  const rows = sql.exec(`SELECT legacy.id AS legacy_id, current.id AS kept_id FROM ${legacyTable} AS legacy JOIN ${WORKSPACES_TABLE} AS current ON ${SAME_KEY}`).toArray();
  return new Map(rows.map((row) => [String(row.legacy_id), String(row.kept_id)]));
}

/**
 * Recovers the directory a district kept before the rename (SCHO-232): every workspace of both
 * sides, apart from a legacy one whose key a workspace created since holds (see
 * {@link legacyWorkspaceReplacements}), and the rest of the state merged with that legacy
 * workspace's grants, promotions and deletion records naming the workspace kept. A merged directory
 * that breaks its invariants is refused and rolls the migration back.
 */
const LEGACY_DIRECTORY: readonly LegacyTablePlan[] = [
  { table: WORKSPACES_TABLE, skipLegacyWhere: `EXISTS (SELECT 1 FROM ${WORKSPACES_TABLE} AS current WHERE ${SAME_KEY})` },
  {
    tables: [WORKSPACE_STATE_TABLE],
    migrate(sql: LegacySql, legacy: (table: string) => string) {
      const [before] = sql.exec(`SELECT version, state_json FROM ${legacy(WORKSPACE_STATE_TABLE)} WHERE id = 1`).toArray();
      if (before === undefined) return;
      const [after] = sql.exec(`SELECT version, state_json FROM ${WORKSPACE_STATE_TABLE} WHERE id = 1`).toArray();
      const replacements = legacyWorkspaceReplacements(sql);
      const old = StateRow.parse(before);
      let version = old.version;
      let rest = StateRest.parse(renameIdentifiers(parseJson(StateRest, old.state_json, "the workspace state"), replacements));
      if (after !== undefined) {
        const current = StateRow.parse(after);
        rest = StateRest.parse(mergeLegacyDocument(rest, parseJson(StateRest, current.state_json, "the workspace state")));
        version = Math.max(version, current.version) + 1;
      }
      const workspaces = sql.exec(`SELECT workspace_json FROM ${WORKSPACES_TABLE} ORDER BY rowid`).toArray()
        .map((row) => parseJson(Workspace, String(row.workspace_json), "a workspace"));
      assertWorkspaceInvariants({ workspaces, ...rest });
      sql.exec(
        `INSERT INTO ${WORKSPACE_STATE_TABLE} (id, version, state_json) VALUES (1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET version = excluded.version, state_json = excluded.state_json`,
        version,
        JSON.stringify(rest),
      );
      return replacements.size === 0 ? "merged" : `merged; ${replacements.size} legacy workspace(s) replaced by one created since`;
    },
  },
];

/** Thrown when a stored row cannot be read. The directory refuses to decide on state it cannot read. */
export class WorkspaceStoreCorruptionError extends Error {
  override readonly name = "WorkspaceStoreCorruptionError";
}

/**
 * A {@link WorkspaceStore} in a SQLite-backed Durable Object's storage. One Durable Object holds
 * one district's directory, and the store is created once per object instance.
 *
 * Each workspace is a row, unique by ID and by its key: the personal key (principal) and the course
 * key (principal and offering) are partial unique indexes. The grants, closures, promotions, outbox
 * and deletion records are one JSON document beside the version counter. A commit checks the
 * version, writes only the workspaces that changed and the document, and bumps the version, all in
 * one `transactionSync`; a duplicate key rolls the whole commit back. The state is cached after the
 * first load, which cannot go stale: only this object writes the tables, and if a write fails to
 * persist the runtime discards the object, cache and all.
 */
export class DurableObjectWorkspaceStore implements WorkspaceStore {
  readonly #storage: WorkspaceSqlStorage;
  #cached: { version: number; state: WorkspaceState; json: Map<string, string> } | undefined;

  constructor(storage: WorkspaceSqlStorage) {
    this.#storage = storage;
  }

  async load(): Promise<StoredWorkspaces> {
    const { version, state } = this.#load();
    return { version, state: structuredClone(state) };
  }

  async commit(rawNext: WorkspaceState, expectedVersion: number): Promise<void> {
    const next = WorkspaceState.parse(rawNext);
    assertWorkspaceInvariants(next);
    const current = this.#load();
    if (expectedVersion !== current.version) {
      throw new EducateOsError("conflict", "The workspace directory changed while this request was in progress; retry it.");
    }
    const json = new Map<string, string>(next.workspaces.map((w) => [w.id, JSON.stringify(w)]));
    const { workspaces: _rows, ...rest } = next;
    const version = current.version + 1;
    try {
      this.#storage.transactionSync(() => {
        for (const id of current.json.keys()) {
          if (!json.has(id)) this.#storage.sql.exec(`DELETE FROM ${WORKSPACES_TABLE} WHERE id = ?`, id);
        }
        for (const workspace of next.workspaces) {
          const body = json.get(workspace.id)!;
          if (current.json.get(workspace.id) === body) continue;
          this.#storage.sql.exec(
            `INSERT INTO ${WORKSPACES_TABLE} (id, kind, owner_principal_id, offering_id, workspace_json) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, owner_principal_id = excluded.owner_principal_id,
               offering_id = excluded.offering_id, workspace_json = excluded.workspace_json`,
            workspace.id,
            workspace.kind,
            workspace.ownerPrincipalId,
            workspace.kind === "course" ? workspace.offeringId : null,
            body,
          );
        }
        this.#storage.sql.exec(
          `INSERT INTO ${WORKSPACE_STATE_TABLE} (id, version, state_json) VALUES (1, ?, ?)
           ON CONFLICT (id) DO UPDATE SET version = excluded.version, state_json = excluded.state_json`,
          version,
          JSON.stringify(rest),
        );
      });
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
        throw new EducateOsError("policy-violation", "A workspace with this key already exists.");
      }
      throw error;
    }
    // Only once the transaction has committed, so a rolled-back commit leaves the cache untouched.
    this.#cached = { version, state: structuredClone(next), json };
  }

  #load(): { version: number; state: WorkspaceState; json: Map<string, string> } {
    if (this.#cached !== undefined) return this.#cached;
    // Read inside the migration's transaction, so a merged directory that cannot be read rolls it back.
    this.#cached = this.#storage.transactionSync(() => {
      for (const statement of SCHEMA) this.#storage.sql.exec(statement);
      migrateLegacyTables(this.#storage.sql, LEGACY_DIRECTORY);
      return this.#read();
    });
    return this.#cached;
  }

  #read(): { version: number; state: WorkspaceState; json: Map<string, string> } {
    const rows = this.#storage.sql.exec(`SELECT id, workspace_json FROM ${WORKSPACES_TABLE} ORDER BY rowid`).toArray();
    const meta = this.#storage.sql.exec(`SELECT version, state_json FROM ${WORKSPACE_STATE_TABLE} WHERE id = 1`).toArray();
    const json = new Map<string, string>();
    const workspaces = rows.map((raw) => {
      const row = WorkspaceRow.safeParse(raw);
      if (!row.success) throw new WorkspaceStoreCorruptionError("a workspace row has an unexpected shape");
      json.set(row.data.id, row.data.workspace_json);
      return parseJson(Workspace, row.data.workspace_json, `workspace ${row.data.id}`);
    });
    const { workspaces: _none, ...empty } = emptyWorkspaceState();
    let version = 0;
    let rest: Omit<WorkspaceState, "workspaces"> = empty;
    if (meta[0] !== undefined) {
      const row = StateRow.safeParse(meta[0]);
      if (!row.success) throw new WorkspaceStoreCorruptionError("the workspace state row has an unexpected shape");
      version = row.data.version;
      rest = parseJson(StateRest, row.data.state_json, "the workspace state");
    }
    return { version, state: { workspaces, ...rest }, json };
  }
}

function parseJson<S extends z.ZodType>(schema: S, text: string, what: string): z.output<S> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new WorkspaceStoreCorruptionError(`${what} is not JSON`);
  }
  const parsed = schema.safeParse(value);
  // Field paths only: a row may name a student, and an unreadable one is not trusted to be safe to log.
  if (!parsed.success) throw new WorkspaceStoreCorruptionError(`${what} does not match its schema`);
  return parsed.data;
}
