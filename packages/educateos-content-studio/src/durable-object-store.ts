// The Durable Object implementation of `ContentStudioStorage` (SCHO-80), published as its own entry
// point (`@educateos/content-studio/durable-object-store`). It names the storage it needs
// structurally and imports nothing from `cloudflare:workers`, so the package's main entry stays
// runtime-agnostic and the Worker hosting a district's studio object chooses its own class around it.
import { type ContentItemId, type ResourceId, EducateOsError } from "@educateos/contracts";
import { migrateLegacyTables } from "@educateos/contracts/legacy-tables";
import { ResourceDescriptor } from "@educateos/registry";
import type { ClassBinding, ContentItem, StudioRelease } from "./item.ts";
import { StudioAuditEvent } from "./pipeline.ts";
import type { ContentStudioStorage } from "./storage.ts";

/** A value SQLite stores in one column. Blobs arrive as `ArrayBuffer`. */
export type StudioSqlValue = string | number | null | ArrayBuffer;

/**
 * The part of a SQLite-backed Durable Object's `ctx.storage` the store uses: synchronous SQL and
 * synchronous transactions. `DurableObjectStorage` satisfies it as it is.
 */
export interface StudioSqlStorage {
  /** The SQL API. */
  readonly sql: {
    /** Runs one statement, returning a cursor over its rows. */
    exec(query: string, ...bindings: StudioSqlValue[]): { toArray(): Record<string, unknown>[] };
  };
  /** Runs `closure` in one transaction, rolled back if it throws. */
  transactionSync<T>(closure: () => T): T;
}

/** The tables the store writes. Exported so tests and migrations can name them. */
export const STUDIO_TABLES = {
  items: "educateos_studio_items",
  snapshotChunks: "educateos_studio_snapshot_chunks",
  releases: "educateos_studio_releases",
  bindings: "educateos_studio_bindings",
  audit: "educateos_studio_audit",
} as const;

/** The version rows are written at. Each stored row records its own. */
export const STUDIO_ROW_SCHEMA_VERSION = 1;

/**
 * Snapshots are split into chunks this size: a Durable Object's SQLite holds at most 2 MB in one
 * value, and an upload may be 20 MB.
 */
export const SNAPSHOT_CHUNK_BYTES = 1024 * 1024;

const T = STUDIO_TABLES;
const appendOnly = (table: string, what: string) => [
  `CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, '${what} are append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, '${what} are append-only'); END`,
];

// Items are the one mutable record, and only through `putItem`'s revision check. Everything else is
// append-only at the storage layer, so no code path can rewrite a release, a binding, a snapshot or
// the audit trail. `seq` keeps append order; the JSON is what is trusted, the other columns index it.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ${T.items} (
    id TEXT PRIMARY KEY,
    row_schema_version INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    item_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ${T.snapshotChunks} (
    digest TEXT NOT NULL,
    chunk INTEGER NOT NULL,
    chunks INTEGER NOT NULL,
    bytes BLOB NOT NULL,
    PRIMARY KEY (digest, chunk)
  )`,
  `CREATE TABLE IF NOT EXISTS ${T.releases} (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    row_schema_version INTEGER NOT NULL,
    resource_id TEXT NOT NULL,
    version TEXT NOT NULL,
    release_json TEXT NOT NULL,
    UNIQUE (resource_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS ${T.bindings} (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    row_schema_version INTEGER NOT NULL,
    binding_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ${T.audit} (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    row_schema_version INTEGER NOT NULL,
    item_id TEXT NOT NULL,
    event_json TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ${T.audit}_by_item ON ${T.audit} (item_id, seq)`,
  ...appendOnly(T.snapshotChunks, "snapshots"),
  ...appendOnly(T.releases, "releases"),
  ...appendOnly(T.bindings, "class bindings"),
  ...appendOnly(T.audit, "audit events"),
];

/**
 * Thrown when a stored row cannot be trusted: an unknown schema version, JSON that does not parse,
 * or a record that fails its schema. Its message names the table and row, never the content.
 */
export class StudioStorageCorruptionError extends Error {
  override readonly name = "StudioStorageCorruptionError";
}

function parseJson(table: string, key: unknown, version: unknown, json: unknown): unknown {
  if (version !== STUDIO_ROW_SCHEMA_VERSION) throw new StudioStorageCorruptionError(`${table} row ${String(key)} has unknown schema version ${String(version)}`);
  if (typeof json !== "string") throw new StudioStorageCorruptionError(`${table} row ${String(key)} has no JSON`);
  try {
    return JSON.parse(json);
  } catch {
    throw new StudioStorageCorruptionError(`${table} row ${String(key)} is not JSON`);
  }
}

/** A release read back: its descriptor must still be a valid registry record. */
function parseRelease(row: Record<string, unknown>): StudioRelease {
  const release = parseJson(T.releases, row.seq, row.row_schema_version, row.release_json) as StudioRelease;
  if (!ResourceDescriptor.safeParse(release?.descriptor).success) throw new StudioStorageCorruptionError(`${T.releases} row ${String(row.seq)} does not match its schema`);
  return release;
}

function parseAudit(row: Record<string, unknown>): StudioAuditEvent {
  const event = StudioAuditEvent.safeParse(parseJson(T.audit, row.seq, row.row_schema_version, row.event_json));
  if (!event.success) throw new StudioStorageCorruptionError(`${T.audit} row ${String(row.seq)} does not match its schema`);
  return event.data;
}

function parseItem(row: Record<string, unknown>): ContentItem {
  const item = parseJson(T.items, row.id, row.row_schema_version, row.item_json) as ContentItem;
  // The revision column is what the compare-and-set reads; the JSON must agree with it.
  if (item?.id !== row.id || item.revision !== row.revision) throw new StudioStorageCorruptionError(`${T.items} row ${String(row.id)} does not match its columns`);
  return item;
}

/**
 * A {@link ContentStudioStorage} in a SQLite-backed Durable Object's storage: one district's studio
 * object holds that district's items, quarantined snapshots, releases, class bindings and audit.
 *
 * `putItem` is a compare-and-set on the item's revision inside one `transactionSync`, so of two
 * writes based on the same read, exactly one lands and the other is a `conflict`. Releases are
 * unique by resource and version, so a second release of the same version is a `conflict` too.
 * Releases, bindings, snapshots and audit events are append-only, enforced by triggers. Every row
 * read back is checked against its schema, and a row that fails is never returned.
 */
export class DurableObjectContentStudioStorage implements ContentStudioStorage {
  readonly #storage: StudioSqlStorage;
  #ready = false;

  constructor(storage: StudioSqlStorage) {
    this.#storage = storage;
  }

  async getItem(id: ContentItemId): Promise<ContentItem | undefined> {
    const row = this.#exec(`SELECT id, row_schema_version, revision, item_json FROM ${T.items} WHERE id = ?`, id)[0];
    return row === undefined ? undefined : parseItem(row);
  }

  async listItems(): Promise<ContentItem[]> {
    return this.#exec(`SELECT id, row_schema_version, revision, item_json FROM ${T.items} ORDER BY rowid`).map(parseItem);
  }

  async putItem(item: ContentItem): Promise<void> {
    this.#ensureSchema();
    this.#storage.transactionSync(() => {
      const stored = this.#storage.sql.exec(`SELECT revision FROM ${T.items} WHERE id = ?`, item.id).toArray()[0]?.revision ?? 0;
      if (stored !== item.revision - 1) throw new EducateOsError("conflict", `${item.id} changed since it was read`);
      this.#storage.sql.exec(
        `INSERT INTO ${T.items} (id, row_schema_version, revision, item_json) VALUES (?, ?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET row_schema_version = excluded.row_schema_version, revision = excluded.revision, item_json = excluded.item_json`,
        item.id,
        STUDIO_ROW_SCHEMA_VERSION,
        item.revision,
        JSON.stringify(item),
      );
    });
  }

  async putSnapshot(digest: string, bytes: Uint8Array): Promise<void> {
    this.#ensureSchema();
    const chunks = Math.max(1, Math.ceil(bytes.byteLength / SNAPSHOT_CHUNK_BYTES));
    this.#storage.transactionSync(() => {
      // Content-addressed: the same digest again is the same bytes, so it is a no-op.
      if (this.#storage.sql.exec(`SELECT 1 FROM ${T.snapshotChunks} WHERE digest = ? LIMIT 1`, digest).toArray().length > 0) return;
      for (let chunk = 0; chunk < chunks; chunk++) {
        const part = bytes.slice(chunk * SNAPSHOT_CHUNK_BYTES, (chunk + 1) * SNAPSHOT_CHUNK_BYTES);
        this.#storage.sql.exec(`INSERT INTO ${T.snapshotChunks} (digest, chunk, chunks, bytes) VALUES (?, ?, ?, ?)`, digest, chunk, chunks, part.buffer);
      }
    });
  }

  async getSnapshot(digest: string): Promise<Uint8Array | undefined> {
    const rows = this.#exec(`SELECT chunk, chunks, bytes FROM ${T.snapshotChunks} WHERE digest = ? ORDER BY chunk`, digest);
    if (rows.length === 0) return undefined;
    if (rows.some((row, index) => row.chunk !== index || row.chunks !== rows.length || !(row.bytes instanceof ArrayBuffer))) {
      throw new StudioStorageCorruptionError(`${T.snapshotChunks} for ${digest} are incomplete`);
    }
    const parts = rows.map((row) => new Uint8Array(row.bytes as ArrayBuffer));
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    return out;
  }

  async addRelease(release: StudioRelease): Promise<void> {
    this.#ensureSchema();
    const { id, release: { version } } = release.descriptor;
    this.#storage.transactionSync(() => {
      if (this.#storage.sql.exec(`SELECT 1 FROM ${T.releases} WHERE resource_id = ? AND version = ?`, id, version).toArray().length > 0) {
        throw new EducateOsError("conflict", `${id} already has release ${version}`);
      }
      this.#storage.sql.exec(
        `INSERT INTO ${T.releases} (row_schema_version, resource_id, version, release_json) VALUES (?, ?, ?, ?)`,
        STUDIO_ROW_SCHEMA_VERSION,
        id,
        version,
        JSON.stringify(release),
      );
    });
  }

  async listReleases(resourceId?: ResourceId): Promise<StudioRelease[]> {
    const rows = resourceId === undefined
      ? this.#exec(`SELECT seq, row_schema_version, release_json FROM ${T.releases} ORDER BY seq`)
      : this.#exec(`SELECT seq, row_schema_version, release_json FROM ${T.releases} WHERE resource_id = ? ORDER BY seq`, resourceId);
    return rows.map(parseRelease);
  }

  async addBinding(binding: ClassBinding): Promise<void> {
    this.#exec(`INSERT INTO ${T.bindings} (row_schema_version, binding_json) VALUES (?, ?)`, STUDIO_ROW_SCHEMA_VERSION, JSON.stringify(binding));
  }

  async listBindings(): Promise<ClassBinding[]> {
    return this.#exec(`SELECT seq, row_schema_version, binding_json FROM ${T.bindings} ORDER BY seq`)
      .map((row) => parseJson(T.bindings, row.seq, row.row_schema_version, row.binding_json) as ClassBinding);
  }

  async appendAudit(event: StudioAuditEvent): Promise<void> {
    const parsed = StudioAuditEvent.parse(event);
    this.#exec(`INSERT INTO ${T.audit} (row_schema_version, item_id, event_json) VALUES (?, ?, ?)`, STUDIO_ROW_SCHEMA_VERSION, parsed.itemId, JSON.stringify(parsed));
  }

  async listAudit(itemId: ContentItemId): Promise<StudioAuditEvent[]> {
    return this.#exec(`SELECT seq, row_schema_version, event_json FROM ${T.audit} WHERE item_id = ? ORDER BY seq`, itemId).map(parseAudit);
  }

  #exec(query: string, ...bindings: StudioSqlValue[]): Record<string, unknown>[] {
    this.#ensureSchema();
    return this.#storage.sql.exec(query, ...bindings).toArray();
  }

  #ensureSchema(): void {
    if (this.#ready) return;
    this.#storage.transactionSync(() => {
      for (const statement of SCHEMA) this.#storage.sql.exec(statement);
      // The studio's rows from before the rename (SCHO-232). An item, release (by resource and
      // version) or snapshot chunk written since under the same key is the later write and is kept.
      migrateLegacyTables(this.#storage.sql, [T.items, { table: T.snapshotChunks, merge: { kind: "keyed" } }, T.releases, T.bindings, T.audit]);
    });
    this.#ready = true;
  }
}
