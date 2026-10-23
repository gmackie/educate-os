// Durable stores for one district (SCHO-171), published as their own entry point
// (`@schoolos/district-app/durable-stores`). Every `DistrictAppStores` member lives in one
// SQLite-backed Durable Object's storage: the domain packages' own Durable Object stores where they
// have one, and the implementations below for the rest. Like those, this module names the storage
// it needs structurally and imports nothing from `cloudflare:workers`, so it compiles and tests
// under the web-standard surface (ADR-0009) and the Worker chooses its own Durable Object class.
//
// Each store keeps its own tables (all prefixed, so none collide) and makes each of its writes in
// one `transactionSync`. No transaction spans two stores: an operation that writes two of them
// (a submission writes artifact records and then assessment records) commits each in turn, as it
// does over the in-memory stores. See `DistrictObject` in `@schoolos/district-worker`.
//
// Nothing here uses D1 or R2: the hosted deploy service does not yet accept the placeholders a
// service Worker's D1 database or R2 bucket would need (SCHO-138), so revision content that would
// be an R2 object is kept in chunked SQLite rows (`DurableObjectBlobBucket`).
import { z } from "zod";
import {
  ConfigurationRevision,
  GuardianRelationship,
  SchoolOsError,
  type ActivityDefinitionId,
  type ActivityId,
  type ConfigRevisionId,
  type DistrictDirectorySnapshot,
  type GuardianRelationshipId,
  type OfferingId,
  type PrincipalId,
} from "@schoolos/contracts";
import { DurableObjectAcademicStore } from "@schoolos/academics/durable-object-store";
import { DurableObjectWorkspaceStore } from "@schoolos/workspaces/durable-object-store";
import {
  ArtifactState,
  assertRevisionInvariants,
  BackendArtifactStore,
  digestHex,
  sha256Digest,
  type ArtifactRecordStore,
  type InlineTextTable,
  type R2BucketLike,
  type R2ListPage,
  type StoredArtifacts,
  type StoredContent,
} from "@schoolos/learning-artifacts";
import type { RubricReleaseRef } from "@schoolos/assessment";
import { DurableObjectAssessmentRecordStore } from "@schoolos/assessment/durable-object-store";
import { RubricRelease, verifyRubricRelease, type RubricReleaseStore } from "@schoolos/assessment-ci";
import { DurableObjectAssessmentRunStore } from "@schoolos/assessment-ci/durable-object-store";
import { DurableObjectContentStudioStorage } from "@schoolos/content-studio/durable-object-store";
import {
  ActivityDefinition,
  ActivityInstallation,
  codexCollectionKey,
  CourseModule,
  CourseOutline,
  CoursePage,
  StudentCodex,
  type CodexPublication,
  type CodexPublisher,
  type CourseContentStorage,
  type CurriculumStorage,
} from "@schoolos/curriculum";
import { DurableObjectCatalogMirrorStorage } from "@schoolos/catalog/durable-object-storage";
import { DurableObjectLedgerStore } from "@schoolos/ai-governance/durable-object-store";
import {
  checkGuardianRelationshipCommit,
  GUARDIAN_RELATIONSHIP_CONFLICT,
  GuardianRelationshipAuditEvent,
  OPEN_APPROVAL_STATES,
  PendingToolAction,
  sameGuardianRelationship,
  type GuardianRelationshipStore,
  type ToolApprovalId,
  type ToolApprovalState,
  type ToolApprovalStore,
} from "@schoolos/policy";
import { DurableObjectPolicyAuditSink } from "@schoolos/policy/durable-object-audit-sink";
import { oneroster } from "@schoolos/integrations";
import { WorkshopUserLink } from "@schoolos/identity";
import {
  GuardianInvitation,
  GuardianInvitationRedemption,
  type GuardianInvitationId,
  type GuardianInvitationStore,
} from "@schoolos/identity-links";
import { DurableObjectIdentityLinkStore } from "@schoolos/identity-links/durable-object-store";
import { FundingAllocationRevision } from "./routes.ts";
import type { ConfigRevisionStore, DistrictAppStores, FundingAllocationStore, RosterSourceStore, WorkshopUserLinkStore } from "./stores.ts";

/** A value SQLite stores in one column. */
export type DistrictSqlValue = string | number | null | ArrayBuffer;

/**
 * The part of a SQLite-backed Durable Object's `ctx.storage` the district's stores use:
 * synchronous SQL and synchronous transactions. `DurableObjectStorage` satisfies it as it is, and
 * so does every domain store's own storage type.
 */
export interface DistrictSqlStorage {
  /** The SQL API. */
  readonly sql: {
    /** Runs one statement, returning a cursor over its rows. */
    exec(query: string, ...bindings: DistrictSqlValue[]): { toArray(): Record<string, unknown>[] };
  };
  /** Runs `closure` in one transaction, rolled back if it throws. */
  transactionSync<T>(closure: () => T): T;
}

/** The tables the stores in this module keep. Exported so tests and operators can name them. */
export const DISTRICT_TABLES = {
  configRevisions: "schoolos_district_config_revisions",
  fundingRevisions: "schoolos_district_funding_revisions",
  workshopUserLinks: "schoolos_district_workshop_user_links",
  rosterSources: "schoolos_district_roster_sources",
  artifactRecords: "schoolos_artifact_records",
  inlineText: "schoolos_artifact_inline_text",
  blobs: "schoolos_artifact_blobs",
  blobParts: "schoolos_artifact_blob_parts",
  rubricReleases: "schoolos_rubric_releases",
  definitions: "schoolos_curriculum_definitions",
  installations: "schoolos_curriculum_installations",
  codexCollections: "schoolos_codex_collections",
  courseOutlines: "schoolos_course_outlines",
  courseModules: "schoolos_course_modules",
  coursePages: "schoolos_course_pages",
  codexDocuments: "schoolos_codex_documents",
  toolApprovals: "schoolos_tool_approvals",
  // Guardians (ADR-0012, SCHO-188)
  guardianRelationships: "schoolos_guardian_relationships",
  guardianRelationshipEvents: "schoolos_guardian_relationship_events",
  guardianInvitations: "schoolos_guardian_invitations",
} as const;

/** Thrown when a stored row cannot be read. Nothing is decided on state that cannot be read. */
export class DistrictStoreCorruptionError extends Error {
  override readonly name = "DistrictStoreCorruptionError";
}

/** Parses a stored JSON column with `schema`. The message names what, never the row's content. */
function parseStored<S extends z.ZodType>(schema: S, text: unknown, what: string): z.output<S> {
  if (typeof text !== "string") throw new DistrictStoreCorruptionError(`${what} has an unexpected shape`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new DistrictStoreCorruptionError(`${what} is not JSON`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new DistrictStoreCorruptionError(`${what} does not match its schema`);
  return parsed.data;
}

/** Runs `statements` once per storage object, then `closure`, in one transaction. */
class Tables {
  readonly storage: DistrictSqlStorage;
  readonly #schema: readonly string[];
  #ready = false;

  constructor(storage: DistrictSqlStorage, schema: readonly string[]) {
    this.storage = storage;
    this.#schema = schema;
  }

  transaction<T>(closure: (sql: DistrictSqlStorage["sql"]) => T): T {
    return this.storage.transactionSync(() => {
      if (!this.#ready) for (const statement of this.#schema) this.storage.sql.exec(statement);
      this.#ready = true;
      return closure(this.storage.sql);
    });
  }
}

// Text a JSON document is split into, comfortably under SQLite's 2 MB value limit in UTF-8.
const DOCUMENT_CHUNK_LENGTH = 512 * 1024;

/**
 * One JSON document under a version, in chunks: the shape for state a store replaces as a whole,
 * which may outgrow one row. Its methods run inside the caller's transaction.
 */
class ChunkedDocument {
  readonly #table: string;

  constructor(table: string) {
    this.#table = table;
  }

  /** The statements that create its tables. */
  schema(): string[] {
    return [
      `CREATE TABLE IF NOT EXISTS ${this.#table} (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, parts INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS ${this.#table}_parts (part INTEGER PRIMARY KEY, data TEXT NOT NULL)`,
    ];
  }

  read(sql: DistrictSqlStorage["sql"]): { version: number; json: string } | undefined {
    const [head] = sql.exec(`SELECT version, parts FROM ${this.#table} WHERE id = 1`).toArray();
    if (head === undefined) return undefined;
    const parts = sql.exec(`SELECT part, data FROM ${this.#table}_parts ORDER BY part`).toArray();
    if (typeof head.version !== "number" || parts.length !== head.parts || parts.some((p, i) => p.part !== i || typeof p.data !== "string")) {
      throw new DistrictStoreCorruptionError(`${this.#table} is incomplete`);
    }
    return { version: head.version, json: parts.map((p) => p.data as string).join("") };
  }

  write(sql: DistrictSqlStorage["sql"], version: number, json: string): void {
    const count = Math.max(1, Math.ceil(json.length / DOCUMENT_CHUNK_LENGTH));
    sql.exec(`DELETE FROM ${this.#table}_parts`);
    for (let part = 0; part < count; part++) {
      sql.exec(`INSERT INTO ${this.#table}_parts (part, data) VALUES (?, ?)`, part, json.slice(part * DOCUMENT_CHUNK_LENGTH, (part + 1) * DOCUMENT_CHUNK_LENGTH));
    }
    sql.exec(
      `INSERT INTO ${this.#table} (id, version, parts) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET version = excluded.version, parts = excluded.parts`,
      version,
      count,
    );
  }
}

/**
 * An append-only list of revisions, each with an ID, oldest first. A revision is appended only
 * over the head the caller planned against; the check and the insert share one transaction.
 */
class RevisionLog<T extends { id: string }> {
  readonly #tables: Tables;
  readonly #table: string;
  readonly #schema: z.ZodType<T>;
  readonly #conflict: string;

  constructor(storage: DistrictSqlStorage, table: string, schema: z.ZodType<T>, conflict: string) {
    this.#table = table;
    this.#schema = schema;
    this.#conflict = conflict;
    this.#tables = new Tables(storage, [
      `CREATE TABLE IF NOT EXISTS ${table} (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, revision_json TEXT NOT NULL)`,
    ]);
  }

  list(): T[] {
    return this.#tables.transaction((sql) =>
      sql.exec(`SELECT revision_json FROM ${this.#table} ORDER BY seq`).toArray().map((row) => parseStored(this.#schema, row.revision_json, `a row of ${this.#table}`))
    );
  }

  append(revision: T, expectedHeadId: string | undefined): void {
    const parsed = this.#schema.parse(revision);
    this.#tables.transaction((sql) => {
      const [head] = sql.exec(`SELECT id FROM ${this.#table} ORDER BY seq DESC LIMIT 1`).toArray();
      if (head?.id !== expectedHeadId) throw new SchoolOsError("conflict", this.#conflict);
      sql.exec(`INSERT INTO ${this.#table} (id, revision_json) VALUES (?, ?)`, parsed.id, JSON.stringify(parsed));
    });
  }
}

/** A {@link ConfigRevisionStore} in a Durable Object's SQLite: one row per applied revision. */
export class DurableObjectConfigRevisionStore implements ConfigRevisionStore {
  readonly #log: RevisionLog<ConfigurationRevision>;

  constructor(storage: DistrictSqlStorage) {
    this.#log = new RevisionLog(storage, DISTRICT_TABLES.configRevisions, ConfigurationRevision, "The configuration changed since this plan was made; plan it again.");
  }

  async list(): Promise<ConfigurationRevision[]> {
    return this.#log.list();
  }

  async append(revision: ConfigurationRevision, expectedHeadId: ConfigRevisionId | undefined): Promise<void> {
    this.#log.append(revision, expectedHeadId);
  }
}

/** A {@link FundingAllocationStore} in a Durable Object's SQLite: one row per revision. */
export class DurableObjectFundingAllocationStore implements FundingAllocationStore {
  readonly #log: RevisionLog<FundingAllocationRevision>;

  constructor(storage: DistrictSqlStorage) {
    this.#log = new RevisionLog(storage, DISTRICT_TABLES.fundingRevisions, FundingAllocationRevision, "The funding allocations changed since you loaded them; review them again.");
  }

  async list(): Promise<FundingAllocationRevision[]> {
    return this.#log.list();
  }

  async append(revision: FundingAllocationRevision, expectedHeadId: string | undefined): Promise<void> {
    this.#log.append(revision, expectedHeadId);
  }
}

/** A {@link WorkshopUserLinkStore} in a Durable Object's SQLite: append-only, one row per link. */
export class DurableObjectWorkshopUserLinkStore implements WorkshopUserLinkStore {
  readonly #tables: Tables;

  constructor(storage: DistrictSqlStorage) {
    this.#tables = new Tables(storage, [
      `CREATE TABLE IF NOT EXISTS ${DISTRICT_TABLES.workshopUserLinks} (seq INTEGER PRIMARY KEY AUTOINCREMENT, link_json TEXT NOT NULL)`,
    ]);
  }

  async list(): Promise<WorkshopUserLink[]> {
    return this.#tables.transaction((sql) =>
      sql.exec(`SELECT link_json FROM ${DISTRICT_TABLES.workshopUserLinks} ORDER BY seq`).toArray()
        .map((row) => parseStored(WorkshopUserLink, row.link_json, "a Workshop user link"))
    );
  }

  async add(link: WorkshopUserLink): Promise<void> {
    const json = JSON.stringify(WorkshopUserLink.parse(link));
    this.#tables.transaction((sql) => sql.exec(`INSERT INTO ${DISTRICT_TABLES.workshopUserLinks} (link_json) VALUES (?)`, json));
  }
}

/** A {@link RosterSourceStore} in a Durable Object's SQLite: the source map as one chunked document. */
export class DurableObjectRosterSourceStore implements RosterSourceStore {
  readonly #document = new ChunkedDocument(DISTRICT_TABLES.rosterSources);
  readonly #tables: Tables;

  constructor(storage: DistrictSqlStorage) {
    this.#tables = new Tables(storage, this.#document.schema());
  }

  async load(): Promise<oneroster.OneRosterSourceMap> {
    const stored = this.#tables.transaction((sql) => this.#document.read(sql));
    return stored === undefined ? structuredClone(oneroster.EMPTY_SOURCE_MAP) : parseStored(oneroster.OneRosterSourceMap, stored.json, "the roster source map");
  }

  async save(sources: oneroster.OneRosterSourceMap): Promise<void> {
    const json = JSON.stringify(oneroster.OneRosterSourceMap.parse(sources));
    this.#tables.transaction((sql) => this.#document.write(sql, 0, json));
  }
}

const EMPTY_ARTIFACTS: ArtifactState = { artifacts: [], revisions: [], pins: [], shares: [] };

/**
 * An {@link ArtifactRecordStore} in a Durable Object's SQLite: the records as one chunked document
 * under a version. A commit reads the version and state, checks the version and the revision
 * invariants (`assertRevisionInvariants`), and writes, in one `transactionSync`.
 */
export class DurableObjectArtifactRecordStore implements ArtifactRecordStore {
  readonly #document = new ChunkedDocument(DISTRICT_TABLES.artifactRecords);
  readonly #tables: Tables;

  constructor(storage: DistrictSqlStorage) {
    this.#tables = new Tables(storage, this.#document.schema());
  }

  async load(): Promise<StoredArtifacts> {
    return this.#tables.transaction((sql) => this.#read(sql));
  }

  async commit(next: ArtifactState, expectedVersion: number): Promise<void> {
    const parsed = ArtifactState.parse(next);
    this.#tables.transaction((sql) => {
      const current = this.#read(sql);
      if (current.version !== expectedVersion) {
        throw new SchoolOsError("conflict", "The artifacts changed while this request was in progress; retry it.");
      }
      assertRevisionInvariants(current.state, parsed);
      this.#document.write(sql, current.version + 1, JSON.stringify(parsed));
    });
  }

  #read(sql: DistrictSqlStorage["sql"]): StoredArtifacts {
    const stored = this.#document.read(sql);
    if (stored === undefined) return { version: 0, state: structuredClone(EMPTY_ARTIFACTS) };
    return { version: stored.version, state: parseStored(ArtifactState, stored.json, "the artifact records") };
  }
}

/** An {@link InlineTextTable} in a Durable Object's SQLite: the table beside the artifact records. */
export class DurableObjectInlineTextTable implements InlineTextTable {
  readonly #tables: Tables;
  readonly #now: () => Date;

  constructor(storage: DistrictSqlStorage, options: { now?: () => Date } = {}) {
    this.#tables = new Tables(storage, [
      `CREATE TABLE IF NOT EXISTS ${DISTRICT_TABLES.inlineText} (key TEXT PRIMARY KEY, text TEXT NOT NULL, stored_at TEXT NOT NULL)`,
    ]);
    this.#now = options.now ?? (() => new Date());
  }

  async get(key: string): Promise<string | undefined> {
    const [row] = this.#tables.transaction((sql) => sql.exec(`SELECT text FROM ${DISTRICT_TABLES.inlineText} WHERE key = ?`, key).toArray());
    return typeof row?.text === "string" ? row.text : undefined;
  }

  async put(key: string, text: string): Promise<void> {
    const storedAt = this.#now().toISOString();
    this.#tables.transaction((sql) =>
      sql.exec(
        `INSERT INTO ${DISTRICT_TABLES.inlineText} (key, text, stored_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET text = excluded.text, stored_at = excluded.stored_at`,
        key,
        text,
        storedAt,
      )
    );
  }

  async delete(key: string): Promise<void> {
    this.#tables.transaction((sql) => sql.exec(`DELETE FROM ${DISTRICT_TABLES.inlineText} WHERE key = ?`, key));
  }

  async list(): Promise<StoredContent[]> {
    return this.#tables.transaction((sql) =>
      sql.exec(`SELECT key, stored_at FROM ${DISTRICT_TABLES.inlineText} ORDER BY key`).toArray()
        .map((row) => ({ key: String(row.key), storedAt: new Date(String(row.stored_at)) }))
    );
  }
}

// Bytes per stored part, under SQLite's 2 MB value limit.
const BLOB_PART_BYTES = 1024 * 1024;
// Objects one listing page returns, as R2's default page does.
const BLOB_LIST_PAGE = 1000;

/**
 * An {@link R2BucketLike} in a Durable Object's SQLite, standing in for the R2 bucket revision
 * content belongs in until a service Worker can declare one (SCHO-138). Each object is split into
 * 1 MiB parts; a put verifies its `sha256` before anything is written, and replaces the object in
 * one transaction. A Durable Object's storage is bounded (10 GB on the paid plan), so this suits a
 * pilot district's documents, not a district's video.
 */
export class DurableObjectBlobBucket implements R2BucketLike {
  readonly #tables: Tables;
  readonly #now: () => Date;

  constructor(storage: DistrictSqlStorage, options: { now?: () => Date } = {}) {
    this.#tables = new Tables(storage, [
      `CREATE TABLE IF NOT EXISTS ${DISTRICT_TABLES.blobs} (key TEXT PRIMARY KEY, size INTEGER NOT NULL, parts INTEGER NOT NULL, uploaded_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS ${DISTRICT_TABLES.blobParts} (key TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (key, part))`,
    ]);
    this.#now = options.now ?? (() => new Date());
  }

  async put(key: string, value: Uint8Array<ArrayBuffer>, options: { sha256?: string } = {}): Promise<unknown> {
    if (options.sha256 !== undefined && digestHex(await sha256Digest(value)) !== options.sha256) {
      throw new Error(`put ${key}: the bytes do not match the sha256 checksum`);
    }
    const parts = Math.max(1, Math.ceil(value.byteLength / BLOB_PART_BYTES));
    const uploadedAt = this.#now().toISOString();
    this.#tables.transaction((sql) => {
      sql.exec(`DELETE FROM ${DISTRICT_TABLES.blobParts} WHERE key = ?`, key);
      for (let part = 0; part < parts; part++) {
        const start = value.byteOffset + part * BLOB_PART_BYTES;
        const end = Math.min(value.byteOffset + value.byteLength, start + BLOB_PART_BYTES);
        sql.exec(`INSERT INTO ${DISTRICT_TABLES.blobParts} (key, part, data) VALUES (?, ?, ?)`, key, part, value.buffer.slice(start, end));
      }
      sql.exec(
        `INSERT INTO ${DISTRICT_TABLES.blobs} (key, size, parts, uploaded_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET size = excluded.size, parts = excluded.parts, uploaded_at = excluded.uploaded_at`,
        key,
        value.byteLength,
        parts,
        uploadedAt,
      );
    });
    return { key, size: value.byteLength };
  }

  async get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> {
    const bytes = this.#tables.transaction((sql) => {
      const [head] = sql.exec(`SELECT size, parts FROM ${DISTRICT_TABLES.blobs} WHERE key = ?`, key).toArray();
      if (head === undefined) return null;
      const rows = sql.exec(`SELECT part, data FROM ${DISTRICT_TABLES.blobParts} WHERE key = ? ORDER BY part`, key).toArray();
      if (rows.length !== head.parts || rows.some((row, i) => row.part !== i || !(row.data instanceof ArrayBuffer))) {
        throw new DistrictStoreCorruptionError(`stored object ${key} is incomplete`);
      }
      const out = new Uint8Array(Number(head.size));
      let offset = 0;
      for (const row of rows) {
        const part = new Uint8Array(row.data as ArrayBuffer);
        out.set(part, offset);
        offset += part.byteLength;
      }
      if (offset !== out.byteLength) throw new DistrictStoreCorruptionError(`stored object ${key} has the wrong size`);
      return out;
    });
    return bytes === null ? null : { arrayBuffer: async () => bytes.slice().buffer };
  }

  async head(key: string): Promise<{ size: number } | null> {
    const [row] = this.#tables.transaction((sql) => sql.exec(`SELECT size FROM ${DISTRICT_TABLES.blobs} WHERE key = ?`, key).toArray());
    return row === undefined ? null : { size: Number(row.size) };
  }

  async delete(key: string): Promise<void> {
    this.#tables.transaction((sql) => {
      sql.exec(`DELETE FROM ${DISTRICT_TABLES.blobParts} WHERE key = ?`, key);
      sql.exec(`DELETE FROM ${DISTRICT_TABLES.blobs} WHERE key = ?`, key);
    });
  }

  async list(options: { prefix?: string; cursor?: string } = {}): Promise<R2ListPage> {
    const prefix = options.prefix ?? "";
    // Keys are compared as text, and a page resumes after the last key it returned.
    const rows = this.#tables.transaction((sql) =>
      sql.exec(
        `SELECT key, uploaded_at FROM ${DISTRICT_TABLES.blobs} WHERE substr(key, 1, ?) = ? AND key > ? ORDER BY key LIMIT ?`,
        prefix.length,
        prefix,
        options.cursor ?? "",
        BLOB_LIST_PAGE + 1,
      ).toArray()
    );
    const objects = rows.slice(0, BLOB_LIST_PAGE).map((row) => ({ key: String(row.key), uploaded: new Date(String(row.uploaded_at)) }));
    return rows.length > BLOB_LIST_PAGE ? { objects, truncated: true, cursor: objects.at(-1)!.key } : { objects, truncated: false };
  }
}

/**
 * A {@link RubricReleaseStore} in a Durable Object's SQLite: one row per release. A release's
 * signature is verified before it is stored; the same content again keeps the first signature,
 * and different content under a stored ID and version is refused with `conflict`.
 */
export class DurableObjectRubricReleaseStore implements RubricReleaseStore {
  readonly #tables: Tables;

  constructor(storage: DistrictSqlStorage) {
    this.#tables = new Tables(storage, [
      `CREATE TABLE IF NOT EXISTS ${DISTRICT_TABLES.rubricReleases} (
        rubric_id TEXT NOT NULL, version INTEGER NOT NULL, release_json TEXT NOT NULL, PRIMARY KEY (rubric_id, version)
      )`,
    ]);
  }

  async get(ref: RubricReleaseRef): Promise<RubricRelease | undefined> {
    return this.#tables.transaction((sql) => this.#read(sql, ref));
  }

  async put(release: RubricRelease): Promise<void> {
    await verifyRubricRelease(release);
    const parsed = RubricRelease.parse(release);
    this.#tables.transaction((sql) => {
      const existing = this.#read(sql, parsed);
      if (existing !== undefined) {
        if (existing.signature.digest === parsed.signature.digest) return;
        throw new SchoolOsError("conflict", `Rubric ${parsed.rubricId} version ${parsed.version} is already released and cannot change.`);
      }
      sql.exec(`INSERT INTO ${DISTRICT_TABLES.rubricReleases} (rubric_id, version, release_json) VALUES (?, ?, ?)`, parsed.rubricId, parsed.version, JSON.stringify(parsed));
    });
  }

  #read(sql: DistrictSqlStorage["sql"], ref: RubricReleaseRef): RubricRelease | undefined {
    const [row] = sql.exec(`SELECT release_json FROM ${DISTRICT_TABLES.rubricReleases} WHERE rubric_id = ? AND version = ?`, ref.rubricId, ref.version).toArray();
    return row === undefined ? undefined : parseStored(RubricRelease, row.release_json, `rubric ${ref.rubricId} version ${ref.version}`);
  }
}

/**
 * {@link CurriculumStorage} in a Durable Object's SQLite: one row per definition version and per
 * installation. A published version and an installation are never rewritten.
 */
export class DurableObjectCurriculumStorage implements CurriculumStorage {
  readonly #tables: Tables;

  constructor(storage: DistrictSqlStorage) {
    this.#tables = new Tables(storage, [
      `CREATE TABLE IF NOT EXISTS ${DISTRICT_TABLES.definitions} (
        id TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL, definition_json TEXT NOT NULL, PRIMARY KEY (id, version)
      )`,
      `CREATE TABLE IF NOT EXISTS ${DISTRICT_TABLES.installations} (id TEXT PRIMARY KEY, installation_json TEXT NOT NULL)`,
    ]);
  }

  async listVersions(id: ActivityDefinitionId): Promise<ActivityDefinition[]> {
    return this.#tables.transaction((sql) =>
      sql.exec(`SELECT definition_json FROM ${DISTRICT_TABLES.definitions} WHERE id = ? ORDER BY version`, id).toArray()
        .map((row) => parseStored(ActivityDefinition, row.definition_json, `a version of ${id}`))
    );
  }

  async putVersion(definition: ActivityDefinition): Promise<void> {
    const parsed = ActivityDefinition.parse(definition);
    this.#tables.transaction((sql) => {
      const [existing] = sql.exec(`SELECT status FROM ${DISTRICT_TABLES.definitions} WHERE id = ? AND version = ?`, parsed.id, parsed.version).toArray();
      if (existing?.status === "published") throw new SchoolOsError("conflict", `${parsed.id} version ${parsed.version} is published`);
      if (existing === undefined) {
        const [count] = sql.exec(`SELECT COUNT(*) AS n FROM ${DISTRICT_TABLES.definitions} WHERE id = ?`, parsed.id).toArray();
        if (parsed.version !== Number(count?.n ?? 0) + 1) throw new SchoolOsError("conflict", `${parsed.id} has no version ${parsed.version - 1}`);
      }
      sql.exec(
        `INSERT INTO ${DISTRICT_TABLES.definitions} (id, version, status, definition_json) VALUES (?, ?, ?, ?)
         ON CONFLICT (id, version) DO UPDATE SET status = excluded.status, definition_json = excluded.definition_json`,
        parsed.id,
        parsed.version,
        parsed.status,
        JSON.stringify(parsed),
      );
    });
  }

  async addInstallation(installation: ActivityInstallation): Promise<void> {
    const parsed = ActivityInstallation.parse(installation);
    this.#tables.transaction((sql) => {
      if (sql.exec(`SELECT 1 FROM ${DISTRICT_TABLES.installations} WHERE id = ?`, parsed.id).toArray().length > 0) {
        throw new SchoolOsError("conflict", `${parsed.id} already exists`);
      }
      sql.exec(`INSERT INTO ${DISTRICT_TABLES.installations} (id, installation_json) VALUES (?, ?)`, parsed.id, JSON.stringify(parsed));
    });
  }

  async getInstallation(id: ActivityId): Promise<ActivityInstallation | undefined> {
    const [row] = this.#tables.transaction((sql) => sql.exec(`SELECT installation_json FROM ${DISTRICT_TABLES.installations} WHERE id = ?`, id).toArray());
    return row === undefined ? undefined : parseStored(ActivityInstallation, row.installation_json, `installation ${id}`);
  }
}

/**
 * A {@link CodexPublisher} that keeps each offering's published student Codexes in a Durable
 * Object's SQLite, one document per installed activity, under a revision per collection. The
 * mapping onto the Context gatekeeper (see `CodexPublisher`) is still to come; until then this is
 * where the district's class Codexes are published.
 */
export class DurableObjectCodexPublisher implements CodexPublisher {
  readonly #tables: Tables;

  constructor(storage: DistrictSqlStorage) {
    this.#tables = new Tables(storage, [
      `CREATE TABLE IF NOT EXISTS ${DISTRICT_TABLES.codexCollections} (collection_key TEXT PRIMARY KEY, revision INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS ${DISTRICT_TABLES.codexDocuments} (
        collection_key TEXT NOT NULL, activity_id TEXT NOT NULL, codex_json TEXT NOT NULL, PRIMARY KEY (collection_key, activity_id)
      )`,
    ]);
  }

  async publish(codex: StudentCodex): Promise<CodexPublication> {
    const parsed = StudentCodex.safeParse(codex);
    if (!parsed.success) throw new SchoolOsError("validation-failed", "only a student-visible Codex can be published");
    const collectionKey = codexCollectionKey(parsed.data.districtId, parsed.data.offeringId);
    const revision = this.#tables.transaction((sql) => {
      const [row] = sql.exec(
        `INSERT INTO ${DISTRICT_TABLES.codexCollections} (collection_key, revision) VALUES (?, 1)
         ON CONFLICT (collection_key) DO UPDATE SET revision = revision + 1 RETURNING revision`,
        collectionKey,
      ).toArray();
      sql.exec(
        `INSERT INTO ${DISTRICT_TABLES.codexDocuments} (collection_key, activity_id, codex_json) VALUES (?, ?, ?)
         ON CONFLICT (collection_key, activity_id) DO UPDATE SET codex_json = excluded.codex_json`,
        collectionKey,
        parsed.data.activityId,
        JSON.stringify(parsed.data),
      );
      return Number(row?.revision);
    });
    return { collectionKey, revision };
  }

  /** Every document in a collection, as published. */
  async documents(collectionKey: string): Promise<StudentCodex[]> {
    return this.#tables.transaction((sql) =>
      sql.exec(`SELECT codex_json FROM ${DISTRICT_TABLES.codexDocuments} WHERE collection_key = ? ORDER BY activity_id`, collectionKey).toArray()
        .map((row) => parseStored(StudentCodex, row.codex_json, "a published Codex"))
    );
  }
}

/**
 * {@link CourseContentStorage} in a Durable Object's SQLite (SCHO-186): per offering, a revision
 * row, one row per module in order and one row per page, so no single value approaches SQLite's
 * row limit. A commit checks the revision and replaces the offering's rows in one transaction.
 */
export class DurableObjectCourseContentStorage implements CourseContentStorage {
  readonly #tables: Tables;

  constructor(storage: DistrictSqlStorage) {
    this.#tables = new Tables(storage, [
      `CREATE TABLE IF NOT EXISTS ${DISTRICT_TABLES.courseOutlines} (offering_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, updated_json TEXT)`,
      `CREATE TABLE IF NOT EXISTS ${DISTRICT_TABLES.courseModules} (
        offering_id TEXT NOT NULL, position INTEGER NOT NULL, module_json TEXT NOT NULL, PRIMARY KEY (offering_id, position)
      )`,
      `CREATE TABLE IF NOT EXISTS ${DISTRICT_TABLES.coursePages} (
        offering_id TEXT NOT NULL, position INTEGER NOT NULL, page_json TEXT NOT NULL, PRIMARY KEY (offering_id, position)
      )`,
    ]);
  }

  async load(offeringId: OfferingId): Promise<CourseOutline | undefined> {
    return this.#tables.transaction((sql) => this.#read(sql, offeringId));
  }

  async commit(outline: CourseOutline, expectedRevision: number): Promise<void> {
    const parsed = CourseOutline.parse(outline);
    this.#tables.transaction((sql) => {
      if ((this.#read(sql, parsed.offeringId)?.revision ?? 0) !== expectedRevision) {
        throw new SchoolOsError("conflict", "The course content changed while this request was in progress; reload it and try again.");
      }
      sql.exec(`DELETE FROM ${DISTRICT_TABLES.courseModules} WHERE offering_id = ?`, parsed.offeringId);
      sql.exec(`DELETE FROM ${DISTRICT_TABLES.coursePages} WHERE offering_id = ?`, parsed.offeringId);
      for (const [position, module] of parsed.modules.entries()) {
        sql.exec(`INSERT INTO ${DISTRICT_TABLES.courseModules} (offering_id, position, module_json) VALUES (?, ?, ?)`, parsed.offeringId, position, JSON.stringify(module));
      }
      for (const [position, page] of parsed.pages.entries()) {
        sql.exec(`INSERT INTO ${DISTRICT_TABLES.coursePages} (offering_id, position, page_json) VALUES (?, ?, ?)`, parsed.offeringId, position, JSON.stringify(page));
      }
      sql.exec(
        `INSERT INTO ${DISTRICT_TABLES.courseOutlines} (offering_id, revision, updated_json) VALUES (?, ?, ?)
         ON CONFLICT (offering_id) DO UPDATE SET revision = excluded.revision, updated_json = excluded.updated_json`,
        parsed.offeringId,
        parsed.revision,
        parsed.updated === undefined ? null : JSON.stringify(parsed.updated),
      );
    });
  }

  #read(sql: DistrictSqlStorage["sql"], offeringId: OfferingId): CourseOutline | undefined {
    const [head] = sql.exec(`SELECT revision, updated_json FROM ${DISTRICT_TABLES.courseOutlines} WHERE offering_id = ?`, offeringId).toArray();
    if (head === undefined) return undefined;
    const what = `the course content of ${offeringId}`;
    const modules = sql.exec(`SELECT position, module_json FROM ${DISTRICT_TABLES.courseModules} WHERE offering_id = ? ORDER BY position`, offeringId).toArray();
    if (modules.some((row, i) => row.position !== i)) throw new DistrictStoreCorruptionError(`${what} is incomplete`);
    const pages = sql.exec(`SELECT position, page_json FROM ${DISTRICT_TABLES.coursePages} WHERE offering_id = ? ORDER BY position`, offeringId).toArray();
    if (pages.some((row, i) => row.position !== i)) throw new DistrictStoreCorruptionError(`${what} is incomplete`);
    const parsed = CourseOutline.safeParse({
      offeringId,
      revision: head.revision,
      modules: modules.map((row) => parseStored(CourseModule, row.module_json, what)),
      pages: pages.map((row) => parseStored(CoursePage, row.page_json, what)),
      ...(head.updated_json === null ? {} : { updated: JSON.parse(String(head.updated_json)) as unknown }),
    });
    if (!parsed.success) throw new DistrictStoreCorruptionError(`${what} does not match its schema`);
    return parsed.data;
  }
}

/**
 * A {@link ToolApprovalStore} in a Durable Object's SQLite: the queue of school tool calls waiting
 * for a person (SCHO-55). Each method is one transaction, so of two approvals racing for one
 * action exactly one transitions it.
 */
export class DurableObjectToolApprovalStore implements ToolApprovalStore {
  readonly #tables: Tables;

  constructor(storage: DistrictSqlStorage) {
    this.#tables = new Tables(storage, [
      `CREATE TABLE IF NOT EXISTS ${DISTRICT_TABLES.toolApprovals} (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, idempotency_key TEXT NOT NULL, state TEXT NOT NULL, action_json TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS ${DISTRICT_TABLES.toolApprovals}_key ON ${DISTRICT_TABLES.toolApprovals} (idempotency_key, state)`,
    ]);
  }

  async get(id: ToolApprovalId): Promise<PendingToolAction | undefined> {
    return this.#tables.transaction((sql) => this.#read(sql, id));
  }

  async insertUnlessOpen(action: PendingToolAction): Promise<PendingToolAction> {
    const parsed = PendingToolAction.parse(action);
    const open = [...OPEN_APPROVAL_STATES];
    return this.#tables.transaction((sql) => {
      const [stored] = sql.exec(
        `SELECT action_json FROM ${DISTRICT_TABLES.toolApprovals} WHERE idempotency_key = ? AND state IN (${open.map(() => "?").join(", ")}) ORDER BY seq LIMIT 1`,
        parsed.idempotencyKey,
        ...open,
      ).toArray();
      if (stored !== undefined) return parseStored(PendingToolAction, stored.action_json, "a queued tool action");
      if (this.#read(sql, parsed.id) !== undefined) throw new Error(`duplicate tool approval ID ${parsed.id}`);
      sql.exec(
        `INSERT INTO ${DISTRICT_TABLES.toolApprovals} (id, idempotency_key, state, action_json) VALUES (?, ?, ?, ?)`,
        parsed.id,
        parsed.idempotencyKey,
        parsed.state,
        JSON.stringify(parsed),
      );
      return parsed;
    });
  }

  async transition(id: ToolApprovalId, from: ToolApprovalState, next: PendingToolAction): Promise<boolean> {
    const parsed = PendingToolAction.parse(next);
    if (parsed.id !== id) throw new Error("a transition cannot change an action's ID");
    return this.#tables.transaction((sql) => {
      if (this.#read(sql, id)?.state !== from) return false;
      sql.exec(
        `UPDATE ${DISTRICT_TABLES.toolApprovals} SET idempotency_key = ?, state = ?, action_json = ? WHERE id = ?`,
        parsed.idempotencyKey,
        parsed.state,
        JSON.stringify(parsed),
        id,
      );
      return true;
    });
  }

  async list(): Promise<PendingToolAction[]> {
    return this.#tables.transaction((sql) =>
      sql.exec(`SELECT action_json FROM ${DISTRICT_TABLES.toolApprovals} ORDER BY seq`).toArray()
        .map((row) => parseStored(PendingToolAction, row.action_json, "a queued tool action"))
    );
  }

  #read(sql: DistrictSqlStorage["sql"], id: string): PendingToolAction | undefined {
    const [row] = sql.exec(`SELECT action_json FROM ${DISTRICT_TABLES.toolApprovals} WHERE id = ?`, id).toArray();
    return row === undefined ? undefined : parseStored(PendingToolAction, row.action_json, "a queued tool action");
  }
}

// Guardians (ADR-0012, SCHO-188)

/**
 * A {@link GuardianRelationshipStore} in a Durable Object's SQLite: one row per relationship, and
 * an append-only table of its audit events. A commit checks the stored relationship is the one the
 * caller planned against, writes it and appends its event, in one `transactionSync`.
 */
export class DurableObjectGuardianRelationshipStore implements GuardianRelationshipStore {
  readonly #tables: Tables;

  constructor(storage: DistrictSqlStorage) {
    this.#tables = new Tables(storage, [
      `CREATE TABLE IF NOT EXISTS ${DISTRICT_TABLES.guardianRelationships} (
        id TEXT PRIMARY KEY, guardian_id TEXT NOT NULL, student_id TEXT NOT NULL, relationship_json TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS ${DISTRICT_TABLES.guardianRelationships}_guardian ON ${DISTRICT_TABLES.guardianRelationships} (guardian_id)`,
      `CREATE INDEX IF NOT EXISTS ${DISTRICT_TABLES.guardianRelationships}_student ON ${DISTRICT_TABLES.guardianRelationships} (student_id)`,
      `CREATE TABLE IF NOT EXISTS ${DISTRICT_TABLES.guardianRelationshipEvents} (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, relationship_id TEXT NOT NULL, event_json TEXT NOT NULL
      )`,
      `CREATE TRIGGER IF NOT EXISTS ${DISTRICT_TABLES.guardianRelationshipEvents}_no_update BEFORE UPDATE ON ${DISTRICT_TABLES.guardianRelationshipEvents}
        BEGIN SELECT RAISE(ABORT, 'guardian relationship events are append-only'); END`,
      `CREATE TRIGGER IF NOT EXISTS ${DISTRICT_TABLES.guardianRelationshipEvents}_no_delete BEFORE DELETE ON ${DISTRICT_TABLES.guardianRelationshipEvents}
        BEGIN SELECT RAISE(ABORT, 'guardian relationship events are append-only'); END`,
    ]);
  }

  async get(id: GuardianRelationshipId): Promise<GuardianRelationship | undefined> {
    return this.#tables.transaction((sql) => this.#read(sql, id));
  }

  async listForGuardian(guardianPrincipalId: PrincipalId): Promise<GuardianRelationship[]> {
    return this.#list("guardian_id", guardianPrincipalId);
  }

  async listForStudent(studentPrincipalId: PrincipalId): Promise<GuardianRelationship[]> {
    return this.#list("student_id", studentPrincipalId);
  }

  async commit(next: GuardianRelationship, event: GuardianRelationshipAuditEvent, expected: GuardianRelationship | undefined): Promise<void> {
    const checked = checkGuardianRelationshipCommit(next, event);
    this.#tables.transaction((sql) => {
      if (!sameGuardianRelationship(this.#read(sql, checked.relationship.id), expected)) throw new SchoolOsError("conflict", GUARDIAN_RELATIONSHIP_CONFLICT);
      sql.exec(
        `INSERT INTO ${DISTRICT_TABLES.guardianRelationships} (id, guardian_id, student_id, relationship_json) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET guardian_id = excluded.guardian_id, student_id = excluded.student_id, relationship_json = excluded.relationship_json`,
        checked.relationship.id,
        checked.relationship.guardianPrincipalId,
        checked.relationship.studentPrincipalId,
        JSON.stringify(checked.relationship),
      );
      sql.exec(
        `INSERT INTO ${DISTRICT_TABLES.guardianRelationshipEvents} (relationship_id, event_json) VALUES (?, ?)`,
        checked.relationship.id,
        JSON.stringify(checked.event),
      );
    });
  }

  async history(id: GuardianRelationshipId): Promise<GuardianRelationshipAuditEvent[]> {
    return this.#tables.transaction((sql) =>
      sql.exec(`SELECT event_json FROM ${DISTRICT_TABLES.guardianRelationshipEvents} WHERE relationship_id = ? ORDER BY seq`, id).toArray()
        .map((row) => parseStored(GuardianRelationshipAuditEvent, row.event_json, "a guardian relationship event"))
    );
  }

  #list(column: "guardian_id" | "student_id", principalId: PrincipalId): GuardianRelationship[] {
    return this.#tables.transaction((sql) =>
      sql.exec(`SELECT relationship_json FROM ${DISTRICT_TABLES.guardianRelationships} WHERE ${column} = ? ORDER BY id`, principalId).toArray()
        .map((row) => parseStored(GuardianRelationship, row.relationship_json, "a guardian relationship"))
    );
  }

  #read(sql: DistrictSqlStorage["sql"], id: string): GuardianRelationship | undefined {
    const [row] = sql.exec(`SELECT relationship_json FROM ${DISTRICT_TABLES.guardianRelationships} WHERE id = ?`, id).toArray();
    return row === undefined ? undefined : parseStored(GuardianRelationship, row.relationship_json, "a guardian relationship");
  }
}

/**
 * A {@link GuardianInvitationStore} in a Durable Object's SQLite: one row per invitation, found by
 * its token's digest. A claim reads and writes the invitation in one `transactionSync`, so of two
 * redemptions racing for one invitation exactly one claims it.
 */
export class DurableObjectGuardianInvitationStore implements GuardianInvitationStore {
  readonly #tables: Tables;

  constructor(storage: DistrictSqlStorage) {
    this.#tables = new Tables(storage, [
      `CREATE TABLE IF NOT EXISTS ${DISTRICT_TABLES.guardianInvitations} (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, token_digest TEXT NOT NULL UNIQUE, student_id TEXT NOT NULL, invitation_json TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS ${DISTRICT_TABLES.guardianInvitations}_student ON ${DISTRICT_TABLES.guardianInvitations} (student_id)`,
    ]);
  }

  async findByTokenDigest(tokenDigest: string): Promise<GuardianInvitation | undefined> {
    const [row] = this.#tables.transaction((sql) =>
      sql.exec(`SELECT invitation_json FROM ${DISTRICT_TABLES.guardianInvitations} WHERE token_digest = ?`, tokenDigest).toArray()
    );
    return row === undefined ? undefined : parseStored(GuardianInvitation, row.invitation_json, "a guardian invitation");
  }

  async listForStudent(studentPrincipalId: PrincipalId): Promise<GuardianInvitation[]> {
    return this.#tables.transaction((sql) =>
      sql.exec(`SELECT invitation_json FROM ${DISTRICT_TABLES.guardianInvitations} WHERE student_id = ? ORDER BY seq`, studentPrincipalId).toArray()
        .map((row) => parseStored(GuardianInvitation, row.invitation_json, "a guardian invitation"))
    );
  }

  async add(invitation: GuardianInvitation): Promise<void> {
    const parsed = GuardianInvitation.parse(invitation);
    this.#tables.transaction((sql) =>
      sql.exec(
        `INSERT INTO ${DISTRICT_TABLES.guardianInvitations} (id, token_digest, student_id, invitation_json) VALUES (?, ?, ?, ?)`,
        parsed.id,
        parsed.tokenDigest,
        parsed.studentPrincipalId,
        JSON.stringify(parsed),
      )
    );
  }

  async claim(id: GuardianInvitationId, redemption: GuardianInvitationRedemption): Promise<boolean> {
    const redeemed = GuardianInvitationRedemption.parse(redemption);
    return this.#tables.transaction((sql) => {
      const [row] = sql.exec(`SELECT invitation_json FROM ${DISTRICT_TABLES.guardianInvitations} WHERE id = ?`, id).toArray();
      if (row === undefined) return false;
      const invitation = parseStored(GuardianInvitation, row.invitation_json, "a guardian invitation");
      if (invitation.redeemed !== undefined) return false;
      sql.exec(`UPDATE ${DISTRICT_TABLES.guardianInvitations} SET invitation_json = ? WHERE id = ?`, JSON.stringify(GuardianInvitation.parse({ ...invitation, redeemed })), id);
      return true;
    });
  }
}

/**
 * Every store of one district in one Durable Object's SQLite storage. The directory is seeded with
 * `seed` the first time, and kept thereafter (see `DurableObjectAcademicStore.open`). Create them
 * once per object instance: several stores cache what they read, which stays true only while this
 * object is the one writer.
 */
export function durableDistrictStores(storage: DistrictSqlStorage, seed: DistrictDirectorySnapshot): DistrictAppStores {
  const directory = DurableObjectAcademicStore.open(storage, seed);
  return {
    directory,
    rosterSources: new DurableObjectRosterSourceStore(storage),
    workspaces: new DurableObjectWorkspaceStore(storage),
    artifactRecords: new DurableObjectArtifactRecordStore(storage),
    artifactContent: new BackendArtifactStore({ text: new DurableObjectInlineTextTable(storage), r2: new DurableObjectBlobBucket(storage) }),
    assessment: new DurableObjectAssessmentRecordStore(storage),
    rubrics: new DurableObjectRubricReleaseStore(storage),
    assessmentRuns: new DurableObjectAssessmentRunStore(storage),
    contentStudio: new DurableObjectContentStudioStorage(storage),
    curriculum: new DurableObjectCurriculumStorage(storage),
    codex: new DurableObjectCodexPublisher(storage),
    courseContent: new DurableObjectCourseContentStorage(storage),
    catalog: new DurableObjectCatalogMirrorStorage(storage),
    ledger: new DurableObjectLedgerStore(storage),
    config: new DurableObjectConfigRevisionStore(storage),
    fundingAllocations: new DurableObjectFundingAllocationStore(storage),
    workshopUserLinks: new DurableObjectWorkshopUserLinkStore(storage),
    audit: new DurableObjectPolicyAuditSink(storage),
    // Guardians (ADR-0012, SCHO-188). The identity-link log is named by the seed's district, which
    // the stored directory is checked against when it opens.
    guardianRelationships: new DurableObjectGuardianRelationshipStore(storage),
    guardianInvitations: new DurableObjectGuardianInvitationStore(storage),
    identityLinks: new DurableObjectIdentityLinkStore(storage, seed.district.id),
  };
}
