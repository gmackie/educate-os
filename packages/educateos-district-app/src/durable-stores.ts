// Durable stores for one district (SCHO-171), published as their own entry point
// (`@educateos/district-app/durable-stores`). Every `DistrictAppStores` member lives in one
// SQLite-backed Durable Object's storage: the domain packages' own Durable Object stores where they
// have one, and the implementations below for the rest. Like those, this module names the storage
// it needs structurally and imports nothing from `cloudflare:workers`, so it compiles and tests
// under the web-standard surface (ADR-0009) and the Worker chooses its own Durable Object class.
//
// Each store keeps its own tables (all prefixed, so none collide) and makes each of its writes in
// one `transactionSync`. No transaction spans two stores: an operation that writes two of them
// (a submission writes artifact records and then assessment records) commits each in turn, as it
// does over the in-memory stores. See `DistrictObject` in `@educateos/district-worker`.
//
// Nothing here uses D1 or R2: the hosted deploy service does not yet accept the placeholders a
// service Worker's D1 database or R2 bucket would need (SCHO-138), so revision content that would
// be an R2 object is kept in chunked SQLite rows (`DurableObjectBlobBucket`).
import { z } from "zod";
import { mergeLegacyDocument, migrateLegacyTables, renameIdentifiers, type LegacySql, type LegacyTablePlan } from "@educateos/contracts/legacy-tables";
import {
  ConfigurationRevision,
  GuardianRelationship,
  EducateOsError,
  IntegrationSyncRun,
  type ActivityDefinitionId,
  type ActivityId,
  type ConfigRevisionId,
  type DistrictDirectorySnapshot,
  type GuardianRelationshipId,
  type OfferingId,
  PrincipalId,
} from "@educateos/contracts";
import { DurableObjectAcademicStore } from "@educateos/academics/durable-object-store";
import { DurableObjectWorkspaceStore, legacyWorkspaceReplacements } from "@educateos/workspaces/durable-object-store";
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
} from "@educateos/learning-artifacts";
import {
  GradebookSettings,
  GradebookUpdate,
  GradeMarkerRecord,
  settingsConflict,
  type AssignmentId,
  type GradebookStore,
  type RubricReleaseRef,
  type StoredGradebook,
} from "@educateos/assessment";
import { DurableObjectAssessmentRecordStore } from "@educateos/assessment/durable-object-store";
import { RubricRelease, rubricDigest, verifyRubricRelease, type RubricReleaseStore } from "@educateos/assessment-ci";
import { DurableObjectAssessmentRunStore } from "@educateos/assessment-ci/durable-object-store";
import { DurableObjectContentStudioStorage } from "@educateos/content-studio/durable-object-store";
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
} from "@educateos/curriculum";
import { DurableObjectCatalogMirrorStorage } from "@educateos/catalog/durable-object-storage";
import { DurableObjectLedgerStore } from "@educateos/ai-governance/durable-object-store";
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
} from "@educateos/policy";
import { DurableObjectPolicyAuditSink } from "@educateos/policy/durable-object-audit-sink";
import { oneroster } from "@educateos/integrations";
import { WorkshopUserLink } from "@educateos/identity";
import {
  GuardianInvitation,
  GuardianInvitationRedemption,
  type GuardianInvitationId,
  type GuardianInvitationStore,
} from "@educateos/identity-links";
import { DurableObjectIdentityLinkStore } from "@educateos/identity-links/durable-object-store";
import {
  DISCUSSION_CONFLICT,
  DiscussionBoard,
  DiscussionPost,
  DiscussionSettings,
  DiscussionTopic,
  ModerationEvent,
  type BoardWrite,
  type DiscussionStorage,
} from "@educateos/discussions";
// Quizzes (SCHO-191)
import { QUIZ_CONFLICT, Quiz, QuizAttempt, QuizBook, QuizRelease, type QuizBookWrite, type QuizStorage } from "@educateos/quizzes";
import { FundingAllocationRevision } from "./routes.ts";
import { MAX_ROSTER_SYNC_RUNS, RosterSyncRecord } from "./stores.ts";
// Devices (SCHO-261)
import {
  DeviceId,
  DevicePlatform,
  DevicePublicJwk,
  DeviceRevocationReason,
  DeviceStatus,
  type DeviceRecord,
  type DeviceRevocation,
  type DeviceStore,
  type RefreshTokenRecord,
  type RotationOutcome,
} from "./devices.ts";
// Pairing (SCHO-261)
import { PairRoom, type PairRoomStore } from "./pairing.ts";
// Operations (SCHO-263)
import { OpsPublicJwk, type OpsAuditRecord, type OpsKeyRecord, type OpsStore } from "./ops.ts";
import { KeyId, OpsScope } from "@educateos/fleet/ops";
import type { ConfigRevisionStore, DistrictAppStores, FundingAllocationStore, RosterSourceStore, RosterSyncStore, WorkshopUserLinkStore } from "./stores.ts";
// Communication (SCHO-189)
import {
  Announcement,
  CalendarFeed,
  DigestLedgerEntry,
  EmailPreferences,
  Notification,
  WeeklyNote,
  type AnnouncementId,
  type IsoWeek,
  type AnnouncementStore,
  type CalendarFeedStore,
  type CommunicationStores,
  type DigestLedgerStore,
  type NotificationStore,
  type PreferenceStore,
  type WeeklyNoteStore,
} from "./communication/index.ts";

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
  configRevisions: "educateos_district_config_revisions",
  fundingRevisions: "educateos_district_funding_revisions",
  workshopUserLinks: "educateos_district_workshop_user_links",
  rosterSources: "educateos_district_roster_sources",
  rosterSync: "educateos_district_roster_sync",
  rosterSyncRuns: "educateos_district_roster_sync_runs",
  artifactRecords: "educateos_artifact_records",
  inlineText: "educateos_artifact_inline_text",
  blobs: "educateos_artifact_blobs",
  blobParts: "educateos_artifact_blob_parts",
  rubricReleases: "educateos_rubric_releases",
  definitions: "educateos_curriculum_definitions",
  installations: "educateos_curriculum_installations",
  codexCollections: "educateos_codex_collections",
  courseOutlines: "educateos_course_outlines",
  courseModules: "educateos_course_modules",
  coursePages: "educateos_course_pages",
  codexDocuments: "educateos_codex_documents",
  toolApprovals: "educateos_tool_approvals",
  // Guardians (ADR-0012, SCHO-188)
  guardianRelationships: "educateos_guardian_relationships",
  guardianRelationshipEvents: "educateos_guardian_relationship_events",
  guardianInvitations: "educateos_guardian_invitations",
  // Gradebook (SCHO-187)
  gradebookSettings: "educateos_gradebook_settings",
  gradebookMarkers: "educateos_gradebook_markers",
  // Discussions (SCHO-190).
  discussionBoards: "educateos_discussion_boards",
  discussionTopics: "educateos_discussion_topics",
  discussionPosts: "educateos_discussion_posts",
  discussionModeration: "educateos_discussion_moderation",
  // Quizzes (SCHO-191)
  quizBooks: "educateos_quiz_books",
  quizzes: "educateos_quizzes",
  quizAttempts: "educateos_quiz_attempts",
  quizReleases: "educateos_quiz_releases",
  // Devices (SCHO-261)
  devices: "educateos_devices",
  deviceRefreshTokens: "educateos_device_refresh_tokens",
  deviceProofs: "educateos_device_proofs",
  // Pairing (SCHO-261)
  pairRooms: "educateos_pair_rooms",
  // Operations (SCHO-263)
  opsKeys: "educateos_ops_keys",
  opsNonces: "educateos_ops_nonces",
  opsAudit: "educateos_ops_audit",
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

/**
 * Runs `statements` once per storage object, then recovers the rows the rename orphaned in the
 * tables' legacy twins (`legacy`, SCHO-232, see `@educateos/contracts/legacy-tables`), then
 * `closure`, in one transaction: a migration whose result `closure` cannot read rolls back with it.
 */
class Tables {
  readonly storage: DistrictSqlStorage;
  readonly #schema: readonly string[];
  readonly #legacy: readonly LegacyTablePlan[];
  #ready = false;

  constructor(storage: DistrictSqlStorage, schema: readonly string[], legacy: readonly LegacyTablePlan[]) {
    this.storage = storage;
    this.#schema = schema;
    this.#legacy = legacy;
  }

  transaction<T>(closure: (sql: DistrictSqlStorage["sql"]) => T): T {
    const result = this.storage.transactionSync(() => {
      if (!this.#ready) {
        for (const statement of this.#schema) this.storage.sql.exec(statement);
        migrateLegacyTables(this.storage.sql, this.#legacy);
      }
      return closure(this.storage.sql);
    });
    // Only once the transaction that created and migrated the tables has committed.
    this.#ready = true;
    return result;
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

  /**
   * The document's plan for recovering its legacy tables (SCHO-232): `merge` makes the document from
   * the legacy one and this one, if it exists, and validates the result (throwing to roll the
   * migration back). It is written under the legacy version, or a version past both.
   */
  legacy(merge: (sql: LegacySql, legacy: string, current: string | undefined) => string): LegacyTablePlan {
    return {
      tables: [this.#table, `${this.#table}_parts`],
      migrate: (sql: LegacySql, legacyName: (table: string) => string) => {
        const stored = new ChunkedDocument(legacyName(this.#table)).read(sql);
        if (stored === undefined) return "no legacy document";
        const current = this.read(sql);
        const version = current === undefined ? stored.version : Math.max(stored.version, current.version) + 1;
        this.write(sql, version, merge(sql, stored.json, current?.json));
        return current === undefined ? "copied" : "merged";
      },
    };
  }

  read(sql: LegacySql): { version: number; json: string } | undefined {
    const [head] = sql.exec(`SELECT version, parts FROM ${this.#table} WHERE id = 1`).toArray();
    if (head === undefined) return undefined;
    const parts = sql.exec(`SELECT part, data FROM ${this.#table}_parts ORDER BY part`).toArray();
    if (typeof head.version !== "number" || parts.length !== head.parts || parts.some((p, i) => p.part !== i || typeof p.data !== "string")) {
      throw new DistrictStoreCorruptionError(`${this.#table} is incomplete`);
    }
    return { version: head.version, json: parts.map((p) => p.data as string).join("") };
  }

  write(sql: LegacySql, version: number, json: string): void {
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
    // A revision's ID derives from its content and predecessor, so one written again since under a
    // legacy ID is the same revision: it keeps its legacy place, and the head cannot fall back to it.
    ], [{ table, sameRecordKey: ["id"] }]);
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
      if (head?.id !== expectedHeadId) throw new EducateOsError("conflict", this.#conflict);
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
    ], [DISTRICT_TABLES.workshopUserLinks]);
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

/**
 * Both source maps, for a district that wrote one before the rename and one since (SCHO-232): the
 * entries of both, where both map one record the current source winning.
 */
function mergeRosterSources(_sql: LegacySql, legacy: string, current: string | undefined): string {
  if (current === undefined) return legacy;
  const read = (json: string) => parseStored(oneroster.OneRosterSourceMap, json, "the roster source map");
  return JSON.stringify(oneroster.OneRosterSourceMap.parse(mergeLegacyDocument(read(legacy), read(current))));
}

/**
 * The artifact records from before the rename (SCHO-232), with each artifact in a legacy workspace
 * that a workspace created since replaced moved to that workspace (same owner, kind and offering,
 * see `legacyWorkspaceReplacements`), merged with the records saved since: every artifact,
 * revision, pin and share of both, which must be a state either side could have become
 * (`assertRevisionInvariants`), or the migration is refused and rolled back.
 */
function mergeArtifactRecords(sql: LegacySql, legacy: string, current: string | undefined): string {
  const read = (json: string) => parseStored(ArtifactState, json, "the artifact records");
  const before = ArtifactState.parse(renameIdentifiers(read(legacy), legacyWorkspaceReplacements(sql)));
  if (current === undefined) return JSON.stringify(before);
  const after = read(current);
  const merged = ArtifactState.parse(mergeLegacyDocument(before, after));
  assertRevisionInvariants(before, merged);
  assertRevisionInvariants(after, merged);
  return JSON.stringify(merged);
}

/** A {@link RosterSourceStore} in a Durable Object's SQLite: the source map as one chunked document. */
export class DurableObjectRosterSourceStore implements RosterSourceStore {
  readonly #document = new ChunkedDocument(DISTRICT_TABLES.rosterSources);
  readonly #tables: Tables;

  constructor(storage: DistrictSqlStorage) {
    this.#tables = new Tables(storage, this.#document.schema(), [this.#document.legacy(mergeRosterSources)]);
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

/**
 * A {@link RosterSyncStore} in a Durable Object's SQLite (SCHO-203): the record as one chunked
 * document, and one row per run, trimmed to {@link MAX_ROSTER_SYNC_RUNS}.
 */
export class DurableObjectDistrictRosterSyncStore implements RosterSyncStore {
  readonly #document = new ChunkedDocument(DISTRICT_TABLES.rosterSync);
  readonly #tables: Tables;

  constructor(storage: DistrictSqlStorage) {
    this.#tables = new Tables(storage, [
      ...this.#document.schema(),
      `CREATE TABLE IF NOT EXISTS ${DISTRICT_TABLES.rosterSyncRuns} (seq INTEGER PRIMARY KEY AUTOINCREMENT, run_json TEXT NOT NULL)`,
    ], []);
  }

  async load(): Promise<RosterSyncRecord> {
    const stored = this.#tables.transaction((sql) => this.#document.read(sql));
    return stored === undefined ? {} : parseStored(RosterSyncRecord, stored.json, "the roster sync record");
  }

  async save(record: RosterSyncRecord): Promise<void> {
    const json = JSON.stringify(RosterSyncRecord.parse(record));
    this.#tables.transaction((sql) => this.#document.write(sql, 0, json));
  }

  async recordRun(run: IntegrationSyncRun): Promise<void> {
    const json = JSON.stringify(IntegrationSyncRun.parse(run));
    this.#tables.transaction((sql) => {
      sql.exec(`INSERT INTO ${DISTRICT_TABLES.rosterSyncRuns} (run_json) VALUES (?)`, json);
      sql.exec(`DELETE FROM ${DISTRICT_TABLES.rosterSyncRuns} WHERE seq <= (SELECT MAX(seq) FROM ${DISTRICT_TABLES.rosterSyncRuns}) - ?`, MAX_ROSTER_SYNC_RUNS);
    });
  }

  async runs(limit = MAX_ROSTER_SYNC_RUNS): Promise<IntegrationSyncRun[]> {
    return this.#tables.transaction((sql) =>
      sql.exec(`SELECT run_json FROM ${DISTRICT_TABLES.rosterSyncRuns} ORDER BY seq DESC LIMIT ?`, limit).toArray()
        .map((row) => parseStored(IntegrationSyncRun, row.run_json, "a roster sync run"))
        .toReversed()
    );
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
    this.#tables = new Tables(storage, this.#document.schema(), [this.#document.legacy(mergeArtifactRecords)]);
  }

  async load(): Promise<StoredArtifacts> {
    return this.#tables.transaction((sql) => this.#read(sql));
  }

  async commit(next: ArtifactState, expectedVersion: number): Promise<void> {
    const parsed = ArtifactState.parse(next);
    this.#tables.transaction((sql) => {
      const current = this.#read(sql);
      if (current.version !== expectedVersion) {
        throw new EducateOsError("conflict", "The artifacts changed while this request was in progress; retry it.");
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
    ], [{ table: DISTRICT_TABLES.inlineText, merge: { kind: "keyed" } }]);
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
    ], [
      // A legacy blob's parts are copied only with the blob: under a key both tables hold, the current blob and its parts win whole.
      { table: DISTRICT_TABLES.blobParts, merge: { kind: "keyed" }, skipLegacyWhere: `EXISTS (SELECT 1 FROM ${DISTRICT_TABLES.blobs} AS current WHERE current.key = legacy.key)` },
      { table: DISTRICT_TABLES.blobs, merge: { kind: "keyed" } },
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
    ], [DISTRICT_TABLES.rubricReleases]);
  }

  async get(ref: RubricReleaseRef): Promise<RubricRelease | undefined> {
    return this.#tables.transaction((sql) => this.#read(sql, ref));
  }

  async put(release: RubricRelease): Promise<void> {
    await verifyRubricRelease(release);
    const parsed = RubricRelease.parse(release);
    // A release stored before the rename is signed under its legacy format (SCHO-232): the same
    // content signed again since is the same release when its digest under that format matches.
    const stored = this.#tables.transaction((sql) => this.#read(sql, parsed));
    const sameAsStored = stored !== undefined && stored.format !== parsed.format && (await rubricDigest(parsed, stored.format)) === stored.signature.digest;
    this.#tables.transaction((sql) => {
      const existing = this.#read(sql, parsed);
      if (existing !== undefined) {
        if (existing.signature.digest === parsed.signature.digest || (sameAsStored && existing.signature.digest === stored.signature.digest)) return;
        throw new EducateOsError("conflict", `Rubric ${parsed.rubricId} version ${parsed.version} is already released and cannot change.`);
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
    ], [DISTRICT_TABLES.definitions, DISTRICT_TABLES.installations]);
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
      if (existing?.status === "published") throw new EducateOsError("conflict", `${parsed.id} version ${parsed.version} is published`);
      if (existing === undefined) {
        const [count] = sql.exec(`SELECT COUNT(*) AS n FROM ${DISTRICT_TABLES.definitions} WHERE id = ?`, parsed.id).toArray();
        if (parsed.version !== Number(count?.n ?? 0) + 1) throw new EducateOsError("conflict", `${parsed.id} has no version ${parsed.version - 1}`);
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
        throw new EducateOsError("conflict", `${parsed.id} already exists`);
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
    ], [{ table: DISTRICT_TABLES.codexCollections, merge: { kind: "revision", key: ["collection_key"], revision: "revision" } }, DISTRICT_TABLES.codexDocuments]);
  }

  async publish(codex: StudentCodex): Promise<CodexPublication> {
    const parsed = StudentCodex.safeParse(codex);
    if (!parsed.success) throw new EducateOsError("validation-failed", "only a student-visible Codex can be published");
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
    ], [
      { table: DISTRICT_TABLES.courseOutlines, merge: { kind: "revision", key: ["offering_id"], revision: "revision" } },
      { table: DISTRICT_TABLES.courseModules, merge: { kind: "positions", parent: ["offering_id"], position: "position" } },
      { table: DISTRICT_TABLES.coursePages, merge: { kind: "positions", parent: ["offering_id"], position: "position" } },
    ]);
  }

  async load(offeringId: OfferingId): Promise<CourseOutline | undefined> {
    return this.#tables.transaction((sql) => this.#read(sql, offeringId));
  }

  async commit(outline: CourseOutline, expectedRevision: number): Promise<void> {
    const parsed = CourseOutline.parse(outline);
    this.#tables.transaction((sql) => {
      if ((this.#read(sql, parsed.offeringId)?.revision ?? 0) !== expectedRevision) {
        throw new EducateOsError("conflict", "The course content changed while this request was in progress; reload it and try again.");
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
    ], [DISTRICT_TABLES.toolApprovals]);
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
    ], [
      // A guardian has one open relationship to a student. One re-created since the rename is the
      // one in use, so a legacy open relationship to the same student stays in the backup; its
      // audit events are still copied, so its history is kept.
      {
        table: DISTRICT_TABLES.guardianRelationships,
        skipLegacyWhere: `json_extract(legacy.relationship_json, '$.status') IN ('pending', 'active') AND EXISTS (
          SELECT 1 FROM ${DISTRICT_TABLES.guardianRelationships} AS current WHERE current.guardian_id = legacy.guardian_id
            AND current.student_id = legacy.student_id AND json_extract(current.relationship_json, '$.status') IN ('pending', 'active'))`,
      },
      DISTRICT_TABLES.guardianRelationshipEvents,
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
      if (!sameGuardianRelationship(this.#read(sql, checked.relationship.id), expected)) throw new EducateOsError("conflict", GUARDIAN_RELATIONSHIP_CONFLICT);
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
    ], [DISTRICT_TABLES.guardianInvitations]);
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
    rosterSync: new DurableObjectDistrictRosterSyncStore(storage),
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
    // Gradebook (SCHO-187)
    gradebooks: new DurableObjectGradebookStore(storage),
    // Communication (SCHO-189)
    communication: durableCommunicationStores(storage),
    // Discussions (SCHO-190).
    discussions: new DurableObjectDiscussionStorage(storage),
    // Quizzes (SCHO-191)
    quizzes: new DurableObjectQuizStorage(storage),
    // Devices (SCHO-261)
    devices: new DurableObjectDeviceStore(storage),
    // Pairing (SCHO-261)
    pairRooms: new DurableObjectPairRoomStore(storage),
    // Operations (SCHO-263)
    ops: new DurableObjectOpsStore(storage),
  };
}

// Gradebook (SCHO-187)

/**
 * A {@link GradebookStore} in a Durable Object's SQLite: per offering, one settings row carrying
 * the revision a save checks, and one row per marked cell, so a large class never makes one value
 * approach SQLite's row limit and setting a marker rewrites only its own row.
 */
export class DurableObjectGradebookStore implements GradebookStore {
  readonly #tables: Tables;

  constructor(storage: DistrictSqlStorage) {
    this.#tables = new Tables(storage, [
      `CREATE TABLE IF NOT EXISTS ${DISTRICT_TABLES.gradebookSettings} (
        offering_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, settings_json TEXT NOT NULL, updated_json TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS ${DISTRICT_TABLES.gradebookMarkers} (
        offering_id TEXT NOT NULL, assignment_id TEXT NOT NULL, student_id TEXT NOT NULL, marker_json TEXT NOT NULL,
        PRIMARY KEY (offering_id, assignment_id, student_id)
      )`,
    ], [{ table: DISTRICT_TABLES.gradebookSettings, merge: { kind: "revision", key: ["offering_id"], revision: "revision" } }, DISTRICT_TABLES.gradebookMarkers]);
  }

  async load(offeringId: OfferingId): Promise<StoredGradebook> {
    return this.#tables.transaction((sql) => {
      const what = `the gradebook of ${offeringId}`;
      const [head] = sql.exec(`SELECT revision, settings_json, updated_json FROM ${DISTRICT_TABLES.gradebookSettings} WHERE offering_id = ?`, offeringId).toArray();
      const markers = sql.exec(
        `SELECT marker_json FROM ${DISTRICT_TABLES.gradebookMarkers} WHERE offering_id = ? ORDER BY assignment_id, student_id`,
        offeringId,
      ).toArray().map((row) => parseStored(GradeMarkerRecord, row.marker_json, what));
      if (head === undefined) return { revision: 0, markers };
      if (typeof head.revision !== "number") throw new DistrictStoreCorruptionError(`${what} has an unexpected shape`);
      return {
        revision: head.revision,
        settings: parseStored(GradebookSettings, head.settings_json, what),
        updated: parseStored(GradebookUpdate, head.updated_json, what),
        markers,
      };
    });
  }

  async saveSettings(offeringId: OfferingId, settings: GradebookSettings, updated: GradebookUpdate, expectedRevision: number): Promise<number> {
    const parsed = GradebookSettings.parse(settings);
    const by = GradebookUpdate.parse(updated);
    return this.#tables.transaction((sql) => {
      const [head] = sql.exec(`SELECT revision FROM ${DISTRICT_TABLES.gradebookSettings} WHERE offering_id = ?`, offeringId).toArray();
      const current = head === undefined ? 0 : Number(head.revision);
      if (current !== expectedRevision) throw settingsConflict();
      sql.exec(
        `INSERT INTO ${DISTRICT_TABLES.gradebookSettings} (offering_id, revision, settings_json, updated_json) VALUES (?, ?, ?, ?)
         ON CONFLICT (offering_id) DO UPDATE SET revision = excluded.revision, settings_json = excluded.settings_json, updated_json = excluded.updated_json`,
        offeringId,
        current + 1,
        JSON.stringify(parsed),
        JSON.stringify(by),
      );
      return current + 1;
    });
  }

  async setMarker(offeringId: OfferingId, assignmentId: AssignmentId, studentPrincipalId: PrincipalId, marker: GradeMarkerRecord | undefined): Promise<void> {
    const parsed = marker === undefined ? undefined : GradeMarkerRecord.parse(marker);
    if (parsed !== undefined && (parsed.assignmentId !== assignmentId || parsed.studentPrincipalId !== studentPrincipalId)) {
      throw new EducateOsError("validation-failed", "A marker is stored on its own cell.");
    }
    this.#tables.transaction((sql) => {
      if (parsed === undefined) {
        sql.exec(`DELETE FROM ${DISTRICT_TABLES.gradebookMarkers} WHERE offering_id = ? AND assignment_id = ? AND student_id = ?`, offeringId, assignmentId, studentPrincipalId);
        return;
      }
      sql.exec(
        `INSERT INTO ${DISTRICT_TABLES.gradebookMarkers} (offering_id, assignment_id, student_id, marker_json) VALUES (?, ?, ?, ?)
         ON CONFLICT (offering_id, assignment_id, student_id) DO UPDATE SET marker_json = excluded.marker_json`,
        offeringId,
        assignmentId,
        studentPrincipalId,
        JSON.stringify(parsed),
      );
    });
  }
}

// Communication (SCHO-189): announcements, weekly notes, notifications, calendar feeds, email
// preferences and the digest ledger, one row per record in the district's object.

/** The communication stores' tables. Exported so tests and operators can name them. */
export const COMMUNICATION_TABLES = {
  announcements: "educateos_comm_announcements",
  weeklyNotes: "educateos_comm_weekly_notes",
  notifications: "educateos_comm_notifications",
  calendarFeeds: "educateos_comm_calendar_feeds",
  preferences: "educateos_comm_preferences",
  digestLedger: "educateos_comm_digest_ledger",
} as const;

/** An {@link AnnouncementStore} in a Durable Object's SQLite: one row per announcement. */
export class DurableObjectAnnouncementStore implements AnnouncementStore {
  readonly #tables: Tables;

  constructor(storage: DistrictSqlStorage) {
    this.#tables = new Tables(storage, [
      `CREATE TABLE IF NOT EXISTS ${COMMUNICATION_TABLES.announcements} (
        id TEXT PRIMARY KEY, offering_id TEXT NOT NULL, publish_at TEXT NOT NULL, announcement_json TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS ${COMMUNICATION_TABLES.announcements}_offering ON ${COMMUNICATION_TABLES.announcements} (offering_id, publish_at)`,
    ], [COMMUNICATION_TABLES.announcements]);
  }

  async list(offeringId: OfferingId): Promise<Announcement[]> {
    return this.#tables.transaction((sql) =>
      sql.exec(`SELECT announcement_json FROM ${COMMUNICATION_TABLES.announcements} WHERE offering_id = ? ORDER BY publish_at, id`, offeringId).toArray()
        .map((row) => parseStored(Announcement, row.announcement_json, "an announcement"))
    );
  }

  async get(id: AnnouncementId): Promise<Announcement | undefined> {
    const [row] = this.#tables.transaction((sql) => sql.exec(`SELECT announcement_json FROM ${COMMUNICATION_TABLES.announcements} WHERE id = ?`, id).toArray());
    return row === undefined ? undefined : parseStored(Announcement, row.announcement_json, "an announcement");
  }

  async put(announcement: Announcement): Promise<void> {
    const parsed = Announcement.parse(announcement);
    this.#tables.transaction((sql) =>
      sql.exec(
        `INSERT INTO ${COMMUNICATION_TABLES.announcements} (id, offering_id, publish_at, announcement_json) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET offering_id = excluded.offering_id, publish_at = excluded.publish_at, announcement_json = excluded.announcement_json`,
        parsed.id,
        parsed.offeringId,
        parsed.publishAt,
        JSON.stringify(parsed),
      )
    );
  }
}

/** A {@link WeeklyNoteStore} in a Durable Object's SQLite: one row per offering and week. */
export class DurableObjectWeeklyNoteStore implements WeeklyNoteStore {
  readonly #tables: Tables;

  constructor(storage: DistrictSqlStorage) {
    this.#tables = new Tables(storage, [
      `CREATE TABLE IF NOT EXISTS ${COMMUNICATION_TABLES.weeklyNotes} (
        offering_id TEXT NOT NULL, week TEXT NOT NULL, note_json TEXT NOT NULL, PRIMARY KEY (offering_id, week)
      )`,
    ], [COMMUNICATION_TABLES.weeklyNotes]);
  }

  async get(offeringId: OfferingId, week: IsoWeek): Promise<WeeklyNote | undefined> {
    const [row] = this.#tables.transaction((sql) =>
      sql.exec(`SELECT note_json FROM ${COMMUNICATION_TABLES.weeklyNotes} WHERE offering_id = ? AND week = ?`, offeringId, week).toArray()
    );
    return row === undefined ? undefined : parseStored(WeeklyNote, row.note_json, "a weekly note");
  }

  async put(note: WeeklyNote): Promise<void> {
    const parsed = WeeklyNote.parse(note);
    this.#tables.transaction((sql) =>
      sql.exec(
        `INSERT INTO ${COMMUNICATION_TABLES.weeklyNotes} (offering_id, week, note_json) VALUES (?, ?, ?)
         ON CONFLICT (offering_id, week) DO UPDATE SET note_json = excluded.note_json`,
        parsed.offeringId,
        parsed.week,
        JSON.stringify(parsed),
      )
    );
  }

  async delete(offeringId: OfferingId, week: IsoWeek): Promise<void> {
    this.#tables.transaction((sql) => sql.exec(`DELETE FROM ${COMMUNICATION_TABLES.weeklyNotes} WHERE offering_id = ? AND week = ?`, offeringId, week));
  }
}

/**
 * A {@link NotificationStore} in a Durable Object's SQLite: one row per notification, keyed by its
 * derived ID, so adding one already stored is a no-op inside the same transaction as the check.
 */
export class DurableObjectNotificationStore implements NotificationStore {
  readonly #tables: Tables;

  constructor(storage: DistrictSqlStorage) {
    this.#tables = new Tables(storage, [
      `CREATE TABLE IF NOT EXISTS ${COMMUNICATION_TABLES.notifications} (
        id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, occurred_at TEXT NOT NULL, email_pending INTEGER NOT NULL, notification_json TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS ${COMMUNICATION_TABLES.notifications}_principal ON ${COMMUNICATION_TABLES.notifications} (principal_id, occurred_at)`,
      `CREATE INDEX IF NOT EXISTS ${COMMUNICATION_TABLES.notifications}_pending ON ${COMMUNICATION_TABLES.notifications} (email_pending, occurred_at)`,
    ], [COMMUNICATION_TABLES.notifications]);
  }

  async list(principalId: PrincipalId): Promise<Notification[]> {
    return this.#tables.transaction((sql) =>
      sql.exec(`SELECT notification_json FROM ${COMMUNICATION_TABLES.notifications} WHERE principal_id = ? ORDER BY occurred_at DESC, id`, principalId).toArray()
        .map((row) => parseStored(Notification, row.notification_json, "a notification"))
    );
  }

  async addIfAbsent(notifications: readonly Notification[]): Promise<Notification[]> {
    const parsed = notifications.map((n) => Notification.parse(n));
    return this.#tables.transaction((sql) =>
      parsed.filter((n) =>
        sql.exec(
          `INSERT INTO ${COMMUNICATION_TABLES.notifications} (id, principal_id, occurred_at, email_pending, notification_json) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (id) DO NOTHING RETURNING id`,
          n.id,
          n.principalId,
          n.occurredAt,
          n.email === undefined ? 1 : 0,
          JSON.stringify(n),
        ).toArray().length > 0
      )
    );
  }

  async update(notifications: readonly Notification[]): Promise<void> {
    const parsed = notifications.map((n) => Notification.parse(n));
    this.#tables.transaction((sql) => {
      for (const n of parsed) {
        sql.exec(
          `UPDATE ${COMMUNICATION_TABLES.notifications} SET email_pending = ?, notification_json = ? WHERE id = ? AND principal_id = ?`,
          n.email === undefined ? 1 : 0,
          JSON.stringify(n),
          n.id,
          n.principalId,
        );
      }
    });
  }

  async pendingEmail(): Promise<Notification[]> {
    return this.#tables.transaction((sql) =>
      sql.exec(`SELECT notification_json FROM ${COMMUNICATION_TABLES.notifications} WHERE email_pending = 1 ORDER BY occurred_at, id`).toArray()
        .map((row) => parseStored(Notification, row.notification_json, "a notification"))
    );
  }
}

/** A {@link CalendarFeedStore} in a Durable Object's SQLite: one row per principal, the token hash unique. */
export class DurableObjectCalendarFeedStore implements CalendarFeedStore {
  readonly #tables: Tables;

  constructor(storage: DistrictSqlStorage) {
    this.#tables = new Tables(storage, [
      `CREATE TABLE IF NOT EXISTS ${COMMUNICATION_TABLES.calendarFeeds} (
        principal_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, feed_json TEXT NOT NULL
      )`,
    ], [COMMUNICATION_TABLES.calendarFeeds]);
  }

  async get(principalId: PrincipalId): Promise<CalendarFeed | undefined> {
    const [row] = this.#tables.transaction((sql) => sql.exec(`SELECT feed_json FROM ${COMMUNICATION_TABLES.calendarFeeds} WHERE principal_id = ?`, principalId).toArray());
    return row === undefined ? undefined : parseStored(CalendarFeed, row.feed_json, "a calendar feed");
  }

  async findByHash(tokenHash: string): Promise<CalendarFeed | undefined> {
    const [row] = this.#tables.transaction((sql) => sql.exec(`SELECT feed_json FROM ${COMMUNICATION_TABLES.calendarFeeds} WHERE token_hash = ?`, tokenHash).toArray());
    return row === undefined ? undefined : parseStored(CalendarFeed, row.feed_json, "a calendar feed");
  }

  async put(feed: CalendarFeed): Promise<void> {
    const parsed = CalendarFeed.parse(feed);
    this.#tables.transaction((sql) => {
      const [taken] = sql.exec(`SELECT principal_id FROM ${COMMUNICATION_TABLES.calendarFeeds} WHERE token_hash = ?`, parsed.tokenHash).toArray();
      if (taken !== undefined && taken.principal_id !== parsed.principalId) throw new EducateOsError("conflict", "That calendar token is already in use.");
      sql.exec(
        `INSERT INTO ${COMMUNICATION_TABLES.calendarFeeds} (principal_id, token_hash, feed_json) VALUES (?, ?, ?)
         ON CONFLICT (principal_id) DO UPDATE SET token_hash = excluded.token_hash, feed_json = excluded.feed_json`,
        parsed.principalId,
        parsed.tokenHash,
        JSON.stringify(parsed),
      );
    });
  }

  async delete(principalId: PrincipalId): Promise<void> {
    this.#tables.transaction((sql) => sql.exec(`DELETE FROM ${COMMUNICATION_TABLES.calendarFeeds} WHERE principal_id = ?`, principalId));
  }
}

/** A {@link PreferenceStore} in a Durable Object's SQLite: one row per principal. */
export class DurableObjectPreferenceStore implements PreferenceStore {
  readonly #tables: Tables;

  constructor(storage: DistrictSqlStorage) {
    this.#tables = new Tables(storage, [
      `CREATE TABLE IF NOT EXISTS ${COMMUNICATION_TABLES.preferences} (principal_id TEXT PRIMARY KEY, preferences_json TEXT NOT NULL)`,
    ], [COMMUNICATION_TABLES.preferences]);
  }

  async get(principalId: PrincipalId): Promise<EmailPreferences | undefined> {
    const [row] = this.#tables.transaction((sql) => sql.exec(`SELECT preferences_json FROM ${COMMUNICATION_TABLES.preferences} WHERE principal_id = ?`, principalId).toArray());
    return row === undefined ? undefined : parseStored(EmailPreferences, row.preferences_json, "email preferences");
  }

  async put(principalId: PrincipalId, preferences: EmailPreferences): Promise<void> {
    const json = JSON.stringify(EmailPreferences.parse(preferences));
    this.#tables.transaction((sql) =>
      sql.exec(
        `INSERT INTO ${COMMUNICATION_TABLES.preferences} (principal_id, preferences_json) VALUES (?, ?)
         ON CONFLICT (principal_id) DO UPDATE SET preferences_json = excluded.preferences_json`,
        principalId,
        json,
      )
    );
  }
}

/**
 * A {@link DigestLedgerStore} in a Durable Object's SQLite: one row per guardian and week. A claim
 * checks and writes in one transaction, so of two runs exactly one claims a week.
 */
export class DurableObjectDigestLedgerStore implements DigestLedgerStore {
  readonly #tables: Tables;

  constructor(storage: DistrictSqlStorage) {
    this.#tables = new Tables(storage, [
      `CREATE TABLE IF NOT EXISTS ${COMMUNICATION_TABLES.digestLedger} (
        guardian_id TEXT NOT NULL, week TEXT NOT NULL, status TEXT NOT NULL, entry_json TEXT NOT NULL, PRIMARY KEY (guardian_id, week)
      )`,
    ], [COMMUNICATION_TABLES.digestLedger]);
  }

  async get(guardianPrincipalId: PrincipalId, week: IsoWeek): Promise<DigestLedgerEntry | undefined> {
    return this.#tables.transaction((sql) => this.#read(sql, guardianPrincipalId, week));
  }

  async claim(entry: DigestLedgerEntry): Promise<boolean> {
    const parsed = DigestLedgerEntry.parse(entry);
    return this.#tables.transaction((sql) => {
      const existing = this.#read(sql, parsed.guardianPrincipalId, parsed.week);
      if (existing !== undefined && existing.status !== "failed") return false;
      this.#write(sql, parsed);
      return true;
    });
  }

  async finish(entry: DigestLedgerEntry): Promise<void> {
    const parsed = DigestLedgerEntry.parse(entry);
    this.#tables.transaction((sql) => this.#write(sql, parsed));
  }

  #read(sql: DistrictSqlStorage["sql"], guardianPrincipalId: string, week: string): DigestLedgerEntry | undefined {
    const [row] = sql.exec(`SELECT entry_json FROM ${COMMUNICATION_TABLES.digestLedger} WHERE guardian_id = ? AND week = ?`, guardianPrincipalId, week).toArray();
    return row === undefined ? undefined : parseStored(DigestLedgerEntry, row.entry_json, "a digest ledger entry");
  }

  #write(sql: DistrictSqlStorage["sql"], entry: DigestLedgerEntry): void {
    sql.exec(
      `INSERT INTO ${COMMUNICATION_TABLES.digestLedger} (guardian_id, week, status, entry_json) VALUES (?, ?, ?, ?)
       ON CONFLICT (guardian_id, week) DO UPDATE SET status = excluded.status, entry_json = excluded.entry_json`,
      entry.guardianPrincipalId,
      entry.week,
      entry.status,
      JSON.stringify(entry),
    );
  }
}

/** Every communication store in one Durable Object's SQLite storage. */
export function durableCommunicationStores(storage: DistrictSqlStorage): CommunicationStores {
  return {
    announcements: new DurableObjectAnnouncementStore(storage),
    weeklyNotes: new DurableObjectWeeklyNoteStore(storage),
    notifications: new DurableObjectNotificationStore(storage),
    calendarFeeds: new DurableObjectCalendarFeedStore(storage),
    preferences: new DurableObjectPreferenceStore(storage),
    digestLedger: new DurableObjectDigestLedgerStore(storage),
  };
}

// Discussions (SCHO-190).

/**
 * {@link DiscussionStorage} in a Durable Object's SQLite: per offering, a board row holding its
 * revision and settings, one row per topic, one per post and one per moderation trail entry, so no
 * single value approaches SQLite's row limit and a change writes only the rows it touched. Rows are
 * read in the order they were first written (an upsert keeps its row). A commit checks the revision
 * and applies its write in one transaction.
 */
export class DurableObjectDiscussionStorage implements DiscussionStorage {
  readonly #tables: Tables;

  constructor(storage: DistrictSqlStorage) {
    const t = DISTRICT_TABLES;
    this.#tables = new Tables(storage, [
      `CREATE TABLE IF NOT EXISTS ${t.discussionBoards} (offering_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, settings_json TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS ${t.discussionTopics} (offering_id TEXT NOT NULL, topic_id TEXT NOT NULL, topic_json TEXT NOT NULL, PRIMARY KEY (offering_id, topic_id))`,
      `CREATE TABLE IF NOT EXISTS ${t.discussionPosts} (
        offering_id TEXT NOT NULL, post_id TEXT NOT NULL, topic_id TEXT NOT NULL, post_json TEXT NOT NULL, PRIMARY KEY (offering_id, post_id)
      )`,
      `CREATE TABLE IF NOT EXISTS ${t.discussionModeration} (offering_id TEXT NOT NULL, position INTEGER NOT NULL, event_json TEXT NOT NULL, PRIMARY KEY (offering_id, position))`,
    ], [
      { table: t.discussionBoards, merge: { kind: "revision", key: ["offering_id"], revision: "revision" } },
      t.discussionTopics,
      t.discussionPosts,
      { table: t.discussionModeration, merge: { kind: "positions", parent: ["offering_id"], position: "position" } },
    ]);
  }

  async load(offeringId: OfferingId): Promise<DiscussionBoard | undefined> {
    return this.#tables.transaction((sql) => this.#read(sql, offeringId));
  }

  async commit(offeringId: OfferingId, write: BoardWrite, expectedRevision: number): Promise<void> {
    const t = DISTRICT_TABLES;
    const settings = DiscussionSettings.parse(write.settings);
    const topics = write.topics.map((topic) => DiscussionTopic.parse(topic));
    const posts = write.posts.map((post) => DiscussionPost.parse(post));
    const moderation = write.moderation.map((event) => ModerationEvent.parse(event));
    if ([...topics, ...posts].some((record) => record.offeringId !== offeringId)) throw new Error("a discussion write names another offering");
    this.#tables.transaction((sql) => {
      const [head] = sql.exec(`SELECT revision FROM ${t.discussionBoards} WHERE offering_id = ?`, offeringId).toArray();
      if (Number(head?.revision ?? 0) !== expectedRevision) throw new EducateOsError("conflict", DISCUSSION_CONFLICT);
      for (const topicId of write.deletedTopicIds) {
        sql.exec(`DELETE FROM ${t.discussionTopics} WHERE offering_id = ? AND topic_id = ?`, offeringId, topicId);
        sql.exec(`DELETE FROM ${t.discussionPosts} WHERE offering_id = ? AND topic_id = ?`, offeringId, topicId);
      }
      for (const topic of topics) {
        sql.exec(
          `INSERT INTO ${t.discussionTopics} (offering_id, topic_id, topic_json) VALUES (?, ?, ?)
           ON CONFLICT (offering_id, topic_id) DO UPDATE SET topic_json = excluded.topic_json`,
          offeringId, topic.id, JSON.stringify(topic),
        );
      }
      for (const post of posts) {
        sql.exec(
          `INSERT INTO ${t.discussionPosts} (offering_id, post_id, topic_id, post_json) VALUES (?, ?, ?, ?)
           ON CONFLICT (offering_id, post_id) DO UPDATE SET topic_id = excluded.topic_id, post_json = excluded.post_json`,
          offeringId, post.id, post.topicId, JSON.stringify(post),
        );
      }
      const [{ count }] = sql.exec(`SELECT COUNT(*) AS count FROM ${t.discussionModeration} WHERE offering_id = ?`, offeringId).toArray() as [{ count: number }];
      for (const [i, event] of moderation.entries()) {
        sql.exec(`INSERT INTO ${t.discussionModeration} (offering_id, position, event_json) VALUES (?, ?, ?)`, offeringId, Number(count) + i, JSON.stringify(event));
      }
      sql.exec(
        `INSERT INTO ${t.discussionBoards} (offering_id, revision, settings_json) VALUES (?, ?, ?)
         ON CONFLICT (offering_id) DO UPDATE SET revision = excluded.revision, settings_json = excluded.settings_json`,
        offeringId, write.revision, JSON.stringify(settings),
      );
    });
  }

  #read(sql: DistrictSqlStorage["sql"], offeringId: OfferingId): DiscussionBoard | undefined {
    const t = DISTRICT_TABLES;
    const [head] = sql.exec(`SELECT revision, settings_json FROM ${t.discussionBoards} WHERE offering_id = ?`, offeringId).toArray();
    if (head === undefined) return undefined;
    const what = `the discussions of ${offeringId}`;
    const moderation = sql.exec(`SELECT position, event_json FROM ${t.discussionModeration} WHERE offering_id = ? ORDER BY position`, offeringId).toArray();
    if (moderation.some((row, i) => row.position !== i)) throw new DistrictStoreCorruptionError(`${what} have an incomplete moderation trail`);
    const parsed = DiscussionBoard.safeParse({
      offeringId,
      revision: head.revision,
      settings: parseStored(DiscussionSettings, head.settings_json, what),
      topics: sql.exec(`SELECT topic_json FROM ${t.discussionTopics} WHERE offering_id = ? ORDER BY rowid`, offeringId).toArray()
        .map((row) => parseStored(DiscussionTopic, row.topic_json, what)),
      posts: sql.exec(`SELECT post_json FROM ${t.discussionPosts} WHERE offering_id = ? ORDER BY rowid`, offeringId).toArray()
        .map((row) => parseStored(DiscussionPost, row.post_json, what)),
      moderation: moderation.map((row) => parseStored(ModerationEvent, row.event_json, what)),
    });
    if (!parsed.success) throw new DistrictStoreCorruptionError(`${what} do not match their schema`);
    return parsed.data;
  }
}

// Quizzes (SCHO-191)

/**
 * {@link QuizStorage} in a Durable Object's SQLite: per offering, a book row holding its revision,
 * one row per quiz, one per attempt and one per release, so a student's autosave writes only their
 * attempt's row and no single value approaches SQLite's row limit. Rows are read in the order they
 * were first written (an upsert keeps its row). A commit checks the revision and applies its write
 * in one transaction.
 */
export class DurableObjectQuizStorage implements QuizStorage {
  readonly #tables: Tables;

  constructor(storage: DistrictSqlStorage) {
    const t = DISTRICT_TABLES;
    this.#tables = new Tables(storage, [
      `CREATE TABLE IF NOT EXISTS ${t.quizBooks} (offering_id TEXT PRIMARY KEY, revision INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS ${t.quizzes} (offering_id TEXT NOT NULL, quiz_id TEXT NOT NULL, quiz_json TEXT NOT NULL, PRIMARY KEY (offering_id, quiz_id))`,
      `CREATE TABLE IF NOT EXISTS ${t.quizAttempts} (
        offering_id TEXT NOT NULL, attempt_id TEXT NOT NULL, quiz_id TEXT NOT NULL, attempt_json TEXT NOT NULL, PRIMARY KEY (offering_id, attempt_id)
      )`,
      `CREATE TABLE IF NOT EXISTS ${t.quizReleases} (offering_id TEXT NOT NULL, position INTEGER NOT NULL, release_json TEXT NOT NULL, PRIMARY KEY (offering_id, position))`,
    ], [
      { table: t.quizBooks, merge: { kind: "revision", key: ["offering_id"], revision: "revision" } },
      t.quizzes,
      t.quizAttempts,
      { table: t.quizReleases, merge: { kind: "positions", parent: ["offering_id"], position: "position" } },
    ]);
  }

  async load(offeringId: OfferingId): Promise<QuizBook | undefined> {
    return this.#tables.transaction((sql) => this.#read(sql, offeringId));
  }

  async commit(offeringId: OfferingId, write: QuizBookWrite, expectedRevision: number): Promise<void> {
    const t = DISTRICT_TABLES;
    const quizzes = write.quizzes.map((quiz) => Quiz.parse(quiz));
    const attempts = write.attempts.map((attempt) => QuizAttempt.parse(attempt));
    const releases = write.releases.map((release) => QuizRelease.parse(release));
    if ([...quizzes, ...attempts].some((record) => record.offeringId !== offeringId)) throw new Error("a quiz write names another offering");
    this.#tables.transaction((sql) => {
      const [head] = sql.exec(`SELECT revision FROM ${t.quizBooks} WHERE offering_id = ?`, offeringId).toArray();
      if (Number(head?.revision ?? 0) !== expectedRevision) throw new EducateOsError("conflict", QUIZ_CONFLICT);
      for (const quizId of write.deletedQuizIds) {
        const [{ count }] = sql.exec(`SELECT COUNT(*) AS count FROM ${t.quizAttempts} WHERE offering_id = ? AND quiz_id = ?`, offeringId, quizId).toArray() as [{ count: number }];
        if (Number(count) > 0) throw new EducateOsError("conflict", "A quiz students have started can't be deleted.");
        sql.exec(`DELETE FROM ${t.quizzes} WHERE offering_id = ? AND quiz_id = ?`, offeringId, quizId);
      }
      for (const quiz of quizzes) {
        sql.exec(
          `INSERT INTO ${t.quizzes} (offering_id, quiz_id, quiz_json) VALUES (?, ?, ?)
           ON CONFLICT (offering_id, quiz_id) DO UPDATE SET quiz_json = excluded.quiz_json`,
          offeringId, quiz.id, JSON.stringify(quiz),
        );
      }
      for (const attempt of attempts) {
        sql.exec(
          `INSERT INTO ${t.quizAttempts} (offering_id, attempt_id, quiz_id, attempt_json) VALUES (?, ?, ?, ?)
           ON CONFLICT (offering_id, attempt_id) DO UPDATE SET quiz_id = excluded.quiz_id, attempt_json = excluded.attempt_json`,
          offeringId, attempt.id, attempt.quizId, JSON.stringify(attempt),
        );
      }
      const [{ count }] = sql.exec(`SELECT COUNT(*) AS count FROM ${t.quizReleases} WHERE offering_id = ?`, offeringId).toArray() as [{ count: number }];
      for (const [i, release] of releases.entries()) {
        sql.exec(`INSERT INTO ${t.quizReleases} (offering_id, position, release_json) VALUES (?, ?, ?)`, offeringId, Number(count) + i, JSON.stringify(release));
      }
      sql.exec(
        `INSERT INTO ${t.quizBooks} (offering_id, revision) VALUES (?, ?)
         ON CONFLICT (offering_id) DO UPDATE SET revision = excluded.revision`,
        offeringId, write.revision,
      );
    });
  }

  #read(sql: DistrictSqlStorage["sql"], offeringId: OfferingId): QuizBook | undefined {
    const t = DISTRICT_TABLES;
    const [head] = sql.exec(`SELECT revision FROM ${t.quizBooks} WHERE offering_id = ?`, offeringId).toArray();
    if (head === undefined) return undefined;
    const what = `the quizzes of ${offeringId}`;
    const releases = sql.exec(`SELECT position, release_json FROM ${t.quizReleases} WHERE offering_id = ? ORDER BY position`, offeringId).toArray();
    if (releases.some((row, i) => row.position !== i)) throw new DistrictStoreCorruptionError(`${what} have an incomplete release history`);
    const parsed = QuizBook.safeParse({
      offeringId,
      revision: head.revision,
      quizzes: sql.exec(`SELECT quiz_json FROM ${t.quizzes} WHERE offering_id = ? ORDER BY rowid`, offeringId).toArray()
        .map((row) => parseStored(Quiz, row.quiz_json, what)),
      attempts: sql.exec(`SELECT attempt_json FROM ${t.quizAttempts} WHERE offering_id = ? ORDER BY rowid`, offeringId).toArray()
        .map((row) => parseStored(QuizAttempt, row.attempt_json, what)),
      releases: releases.map((row) => parseStored(QuizRelease, row.release_json, what)),
    });
    if (!parsed.success) throw new DistrictStoreCorruptionError(`${what} do not match their schema`);
    return parsed.data;
  }
}

// Devices (SCHO-261)

/** A device row as stored; columns are checked as they are read. */
const StoredDevice = z.object({
  id: DeviceId,
  principal_id: z.string(),
  label: z.string(),
  platform: DevicePlatform,
  model: z.string(),
  app_version: z.string(),
  key_thumbprint: z.string(),
  public_jwk: z.string(),
  created_at: z.string(),
  last_seen_at: z.string(),
  last_country: z.string().nullable(),
  push_token: z.string().nullable(),
  status: DeviceStatus,
  revoked_at: z.string().nullable(),
  revoked_by: z.string().nullable(),
  revoked_reason: DeviceRevocationReason.nullable(),
});

function deviceFromRow(row: Record<string, unknown>): DeviceRecord {
  const parsed = StoredDevice.safeParse(row);
  if (!parsed.success) throw new DistrictStoreCorruptionError("a device does not match its schema");
  const d = parsed.data;
  return {
    id: d.id,
    principalId: d.principal_id as PrincipalId,
    label: d.label,
    platform: d.platform,
    model: d.model,
    appVersion: d.app_version,
    keyThumbprint: d.key_thumbprint,
    publicJwk: parseStored(DevicePublicJwk, d.public_jwk, "a device key"),
    createdAt: d.created_at,
    lastSeenAt: d.last_seen_at,
    lastCountry: d.last_country,
    pushToken: d.push_token,
    status: d.status,
    revokedAt: d.revoked_at,
    revokedBy: d.revoked_by,
    revokedReason: d.revoked_reason,
  };
}

/**
 * A {@link DeviceStore} in a Durable Object's SQLite: one row per device; one row per refresh token,
 * by its hash, kept after use so a second use is recognised; and the proof IDs each device used
 * within the last minute, so a proof is accepted once. New tables, so they have no legacy twins.
 */
export class DurableObjectDeviceStore implements DeviceStore {
  readonly #tables: Tables;

  constructor(storage: DistrictSqlStorage) {
    const t = DISTRICT_TABLES;
    this.#tables = new Tables(storage, [
      `CREATE TABLE IF NOT EXISTS ${t.devices} (
        id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, label TEXT NOT NULL, platform TEXT NOT NULL, model TEXT NOT NULL,
        app_version TEXT NOT NULL, key_thumbprint TEXT NOT NULL, public_jwk TEXT NOT NULL, created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL, last_country TEXT, push_token TEXT,
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')), revoked_at TEXT, revoked_by TEXT, revoked_reason TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS ${t.devices}_principal ON ${t.devices} (principal_id)`,
      // One active device per key: a phone that pairs again makes a new key.
      `CREATE UNIQUE INDEX IF NOT EXISTS ${t.devices}_active_key ON ${t.devices} (key_thumbprint) WHERE status = 'active'`,
      `CREATE TABLE IF NOT EXISTS ${t.deviceRefreshTokens} (
        token_hash TEXT PRIMARY KEY, device_id TEXT NOT NULL, family TEXT NOT NULL, issued_at TEXT NOT NULL, used_at TEXT, expires_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS ${t.deviceRefreshTokens}_device ON ${t.deviceRefreshTokens} (device_id)`,
      `CREATE TABLE IF NOT EXISTS ${t.deviceProofs} (device_id TEXT NOT NULL, jti TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (device_id, jti))`,
    ], []);
  }

  async register(device: DeviceRecord, refresh: RefreshTokenRecord): Promise<void> {
    const t = DISTRICT_TABLES;
    this.#tables.transaction((sql) => {
      const [existing] = sql.exec(`SELECT id FROM ${t.devices} WHERE id = ? OR (key_thumbprint = ? AND status = 'active')`, device.id, device.keyThumbprint).toArray();
      if (existing !== undefined) throw new EducateOsError("conflict", "That device key is already registered.");
      sql.exec(
        `INSERT INTO ${t.devices} (id, principal_id, label, platform, model, app_version, key_thumbprint, public_jwk, created_at, last_seen_at,
           last_country, push_token, status, revoked_at, revoked_by, revoked_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        device.id, device.principalId, device.label, device.platform, device.model, device.appVersion, device.keyThumbprint,
        JSON.stringify(device.publicJwk), device.createdAt, device.lastSeenAt, device.lastCountry, device.pushToken, device.status,
        device.revokedAt, device.revokedBy, device.revokedReason,
      );
      this.#insertRefresh(sql, refresh);
    });
  }

  async get(id: DeviceId): Promise<DeviceRecord | undefined> {
    const [row] = this.#tables.transaction((sql) => sql.exec(`SELECT * FROM ${DISTRICT_TABLES.devices} WHERE id = ?`, id).toArray());
    return row === undefined ? undefined : deviceFromRow(row);
  }

  async list(principalId?: PrincipalId): Promise<DeviceRecord[]> {
    const t = DISTRICT_TABLES;
    const rows = this.#tables.transaction((sql) =>
      principalId === undefined
        ? sql.exec(`SELECT * FROM ${t.devices} ORDER BY rowid DESC`).toArray()
        : sql.exec(`SELECT * FROM ${t.devices} WHERE principal_id = ? ORDER BY rowid DESC`, principalId).toArray()
    );
    return rows.map(deviceFromRow);
  }

  async touch(id: DeviceId, at: string, country: string | null): Promise<void> {
    this.#tables.transaction((sql) =>
      sql.exec(`UPDATE ${DISTRICT_TABLES.devices} SET last_seen_at = ?, last_country = COALESCE(?, last_country) WHERE id = ?`, at, country, id)
    );
  }

  async revoke(ids: readonly DeviceId[], at: string, revocation: DeviceRevocation): Promise<DeviceId[]> {
    const t = DISTRICT_TABLES;
    return this.#tables.transaction((sql) => {
      const revoked: DeviceId[] = [];
      for (const id of ids) {
        const [row] = sql.exec(`SELECT status FROM ${t.devices} WHERE id = ?`, id).toArray();
        if (row?.status !== "active") continue;
        sql.exec(
          `UPDATE ${t.devices} SET status = 'revoked', revoked_at = ?, revoked_by = ?, revoked_reason = ? WHERE id = ?`,
          at, revocation.by, revocation.reason, id,
        );
        revoked.push(id);
      }
      return revoked;
    });
  }

  async findRefreshToken(tokenHash: string): Promise<RefreshTokenRecord | undefined> {
    const [row] = this.#tables.transaction((sql) => sql.exec(`SELECT * FROM ${DISTRICT_TABLES.deviceRefreshTokens} WHERE token_hash = ?`, tokenHash).toArray());
    return row === undefined ? undefined : refreshFromRow(row);
  }

  async rotateRefreshToken(tokenHash: string, next: RefreshTokenRecord, at: string): Promise<RotationOutcome> {
    const t = DISTRICT_TABLES;
    return this.#tables.transaction((sql): RotationOutcome => {
      const [row] = sql.exec(`SELECT used_at FROM ${t.deviceRefreshTokens} WHERE token_hash = ?`, tokenHash).toArray();
      if (row === undefined) return "missing";
      if (row.used_at !== null) return "reused";
      sql.exec(`UPDATE ${t.deviceRefreshTokens} SET used_at = ? WHERE token_hash = ?`, at, tokenHash);
      // Tokens are kept, spent or a revoked device's, so a later use is recognised, until they expire.
      sql.exec(`DELETE FROM ${t.deviceRefreshTokens} WHERE expires_at < ?`, at);
      this.#insertRefresh(sql, next);
      return "rotated";
    });
  }

  async claimProofId(deviceId: DeviceId, jti: string, expiresAtMs: number, nowMs: number): Promise<boolean> {
    const t = DISTRICT_TABLES;
    return this.#tables.transaction((sql) => {
      sql.exec(`DELETE FROM ${t.deviceProofs} WHERE expires_at < ?`, nowMs);
      const [row] = sql.exec(`SELECT 1 AS seen FROM ${t.deviceProofs} WHERE device_id = ? AND jti = ?`, deviceId, jti).toArray();
      if (row !== undefined) return false;
      sql.exec(`INSERT INTO ${t.deviceProofs} (device_id, jti, expires_at) VALUES (?, ?, ?)`, deviceId, jti, expiresAtMs);
      return true;
    });
  }

  async setPushToken(id: DeviceId, token: string | null): Promise<void> {
    this.#tables.transaction((sql) => sql.exec(`UPDATE ${DISTRICT_TABLES.devices} SET push_token = ? WHERE id = ?`, token, id));
  }

  #insertRefresh(sql: DistrictSqlStorage["sql"], record: RefreshTokenRecord): void {
    sql.exec(
      `INSERT INTO ${DISTRICT_TABLES.deviceRefreshTokens} (token_hash, device_id, family, issued_at, used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
      record.tokenHash, record.deviceId, record.family, record.issuedAt, record.usedAt, record.expiresAt,
    );
  }
}

const StoredRefreshToken = z.object({
  token_hash: z.string(),
  device_id: DeviceId,
  family: z.string(),
  issued_at: z.string(),
  used_at: z.string().nullable(),
  expires_at: z.string(),
});

function refreshFromRow(row: Record<string, unknown>): RefreshTokenRecord {
  const parsed = StoredRefreshToken.safeParse(row);
  if (!parsed.success) throw new DistrictStoreCorruptionError("a refresh token does not match its schema");
  const r = parsed.data;
  return { tokenHash: r.token_hash, deviceId: r.device_id, family: r.family, issuedAt: r.issued_at, usedAt: r.used_at, expiresAt: r.expires_at };
}

// Pairing (SCHO-261)

/**
 * A {@link PairRoomStore} in a Durable Object's SQLite: one row per room, its JSON beside the columns
 * the store queries by. A room is changed only where its version still matches, so concurrent
 * claims, approvals and polls cannot both win. A new table, so it has no legacy twin.
 */
export class DurableObjectPairRoomStore implements PairRoomStore {
  readonly #tables: Tables;

  constructor(storage: DistrictSqlStorage) {
    const t = DISTRICT_TABLES;
    this.#tables = new Tables(storage, [
      `CREATE TABLE IF NOT EXISTS ${t.pairRooms} (
        id TEXT PRIMARY KEY, version INTEGER NOT NULL, kind TEXT NOT NULL, creator_principal_id TEXT, state TEXT NOT NULL,
        expires_at INTEGER NOT NULL, room_json TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS ${t.pairRooms}_creator ON ${t.pairRooms} (creator_principal_id)`,
      `CREATE INDEX IF NOT EXISTS ${t.pairRooms}_expires ON ${t.pairRooms} (expires_at)`,
    ], []);
  }

  async get(id: string): Promise<PairRoom | undefined> {
    const [row] = this.#tables.transaction((sql) => sql.exec(`SELECT room_json FROM ${DISTRICT_TABLES.pairRooms} WHERE id = ?`, id).toArray());
    return row === undefined ? undefined : parseStored(PairRoom, row.room_json, "a pairing room");
  }

  async insert(room: PairRoom): Promise<void> {
    const t = DISTRICT_TABLES;
    this.#tables.transaction((sql) => {
      const [existing] = sql.exec(`SELECT id FROM ${t.pairRooms} WHERE id = ?`, room.id).toArray();
      if (existing !== undefined) throw new EducateOsError("conflict", "That pairing room already exists.");
      sql.exec(
        `INSERT INTO ${t.pairRooms} (id, version, kind, creator_principal_id, state, expires_at, room_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        room.id, room.version, room.kind, room.creatorPrincipalId, room.state, room.expiresAt, JSON.stringify(room),
      );
    });
  }

  async replace(next: PairRoom): Promise<boolean> {
    const t = DISTRICT_TABLES;
    return this.#tables.transaction((sql) => {
      const [row] = sql.exec(`SELECT version FROM ${t.pairRooms} WHERE id = ?`, next.id).toArray();
      if (row === undefined || row.version !== next.version - 1) return false;
      sql.exec(
        `UPDATE ${t.pairRooms} SET version = ?, creator_principal_id = ?, state = ?, expires_at = ?, room_json = ? WHERE id = ?`,
        next.version, next.creatorPrincipalId, next.state, next.expiresAt, JSON.stringify(next), next.id,
      );
      return true;
    });
  }

  async expireOpen(creatorPrincipalId: string, nowMs: number): Promise<void> {
    const t = DISTRICT_TABLES;
    this.#tables.transaction((sql) => {
      const rows = sql.exec(
        `SELECT room_json FROM ${t.pairRooms} WHERE creator_principal_id = ? AND state IN ('waiting', 'claimed') AND expires_at > ?`,
        creatorPrincipalId, nowMs,
      ).toArray();
      for (const row of rows) {
        const room = parseStored(PairRoom, row.room_json, "a pairing room");
        const next: PairRoom = { ...room, version: room.version + 1, state: "expired", expiresAt: nowMs };
        sql.exec(
          `UPDATE ${t.pairRooms} SET version = ?, state = ?, expires_at = ?, room_json = ? WHERE id = ?`,
          next.version, next.state, next.expiresAt, JSON.stringify(next), next.id,
        );
      }
    });
  }

  async countOpenSelfRooms(nowMs: number): Promise<number> {
    const [row] = this.#tables.transaction((sql) =>
      sql.exec(`SELECT COUNT(*) AS open FROM ${DISTRICT_TABLES.pairRooms} WHERE kind = 'self' AND state = 'claimed' AND expires_at > ?`, nowMs).toArray()
    );
    return Number(row?.open ?? 0);
  }

  async purge(beforeMs: number): Promise<void> {
    this.#tables.transaction((sql) => sql.exec(`DELETE FROM ${DISTRICT_TABLES.pairRooms} WHERE expires_at < ?`, beforeMs));
  }
}

// Operations (SCHO-263)

const StoredOpsKey = z.object({
  key_id: KeyId,
  public_jwk: z.string(),
  scopes_json: z.string(),
  requested_scopes_json: z.string(),
  label: z.string(),
  admin_origin: z.string(),
  enrolled_at: z.string(),
  enrolled_by: PrincipalId,
  revoked_at: z.string().nullable(),
  revoked_by: PrincipalId.nullable(),
});

function opsKeyFromRow(row: Record<string, unknown>): OpsKeyRecord {
  const parsed = StoredOpsKey.safeParse(row);
  if (!parsed.success) throw new DistrictStoreCorruptionError("an ops key does not match its schema");
  const r = parsed.data;
  return {
    keyId: r.key_id,
    publicJwk: parseStored(OpsPublicJwk, r.public_jwk, "an ops key's public key"),
    scopes: parseStored(z.array(OpsScope), r.scopes_json, "an ops key's scopes"),
    requestedScopes: parseStored(z.array(OpsScope), r.requested_scopes_json, "an ops key's requested scopes"),
    label: r.label,
    adminOrigin: r.admin_origin,
    enrolledAt: r.enrolled_at,
    enrolledBy: r.enrolled_by,
    revokedAt: r.revoked_at,
    revokedBy: r.revoked_by,
  };
}

const StoredOpsAudit = z.object({
  id: z.string(),
  key_id: z.string(),
  operator: z.string(),
  route: z.string(),
  target: z.string().nullable(),
  result: z.string(),
  at: z.string(),
});

/**
 * An {@link OpsStore} in a Durable Object's SQLite: the enrolled admin keys, the ops nonces seen
 * recently, and the district's ops audit log. A nonce is claimed by an insert the table's primary
 * key makes unique, in the same transaction that forgets expired ones, so of two copies of one
 * signed request exactly one is served, whatever restarts the object between them. New tables, so
 * they have no legacy twins.
 */
export class DurableObjectOpsStore implements OpsStore {
  readonly #tables: Tables;

  constructor(storage: DistrictSqlStorage) {
    const t = DISTRICT_TABLES;
    this.#tables = new Tables(storage, [
      `CREATE TABLE IF NOT EXISTS ${t.opsKeys} (
        key_id TEXT PRIMARY KEY, public_jwk TEXT NOT NULL, scopes_json TEXT NOT NULL, requested_scopes_json TEXT NOT NULL,
        label TEXT NOT NULL, admin_origin TEXT NOT NULL, enrolled_at TEXT NOT NULL, enrolled_by TEXT NOT NULL,
        revoked_at TEXT, revoked_by TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS ${t.opsNonces} (key_id TEXT NOT NULL, nonce TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (key_id, nonce))`,
      `CREATE INDEX IF NOT EXISTS ${t.opsNonces}_expires ON ${t.opsNonces} (expires_at)`,
      `CREATE TABLE IF NOT EXISTS ${t.opsAudit} (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, key_id TEXT NOT NULL, operator TEXT NOT NULL,
        route TEXT NOT NULL, target TEXT, result TEXT NOT NULL, at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS ${t.opsAudit}_at ON ${t.opsAudit} (at)`,
    ], []);
  }

  async listKeys(): Promise<OpsKeyRecord[]> {
    const rows = this.#tables.transaction((sql) => sql.exec(`SELECT * FROM ${DISTRICT_TABLES.opsKeys} ORDER BY enrolled_at DESC, rowid DESC`).toArray());
    return rows.map(opsKeyFromRow);
  }

  async findKey(keyId: string): Promise<OpsKeyRecord | undefined> {
    const [row] = this.#tables.transaction((sql) => sql.exec(`SELECT * FROM ${DISTRICT_TABLES.opsKeys} WHERE key_id = ?`, keyId).toArray());
    return row === undefined ? undefined : opsKeyFromRow(row);
  }

  async enrollKey(record: OpsKeyRecord): Promise<void> {
    const t = DISTRICT_TABLES;
    this.#tables.transaction((sql) => {
      const [existing] = sql.exec(`SELECT revoked_at FROM ${t.opsKeys} WHERE key_id = ?`, record.keyId).toArray();
      if (existing !== undefined && existing.revoked_at === null) throw new EducateOsError("conflict", "That admin key is already enrolled.");
      sql.exec(`DELETE FROM ${t.opsKeys} WHERE key_id = ?`, record.keyId);
      sql.exec(
        `INSERT INTO ${t.opsKeys} (key_id, public_jwk, scopes_json, requested_scopes_json, label, admin_origin, enrolled_at, enrolled_by, revoked_at, revoked_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        record.keyId, JSON.stringify(record.publicJwk), JSON.stringify(record.scopes), JSON.stringify(record.requestedScopes),
        record.label, record.adminOrigin, record.enrolledAt, record.enrolledBy, record.revokedAt, record.revokedBy,
      );
    });
  }

  async setScopes(keyId: string, scopes: readonly OpsScope[]): Promise<boolean> {
    return this.#tables.transaction((sql) =>
      sql.exec(`UPDATE ${DISTRICT_TABLES.opsKeys} SET scopes_json = ? WHERE key_id = ? AND revoked_at IS NULL RETURNING key_id`, JSON.stringify(scopes), keyId)
        .toArray().length > 0
    );
  }

  async removeKey(keyId: string, at: string, by: PrincipalId): Promise<boolean> {
    return this.#tables.transaction((sql) =>
      sql.exec(`UPDATE ${DISTRICT_TABLES.opsKeys} SET revoked_at = ?, revoked_by = ? WHERE key_id = ? AND revoked_at IS NULL RETURNING key_id`, at, by, keyId)
        .toArray().length > 0
    );
  }

  async claimNonce(keyId: string, nonce: string, expiresAtMs: number, nowMs: number): Promise<boolean> {
    const t = DISTRICT_TABLES;
    return this.#tables.transaction((sql) => {
      sql.exec(`DELETE FROM ${t.opsNonces} WHERE expires_at < ?`, nowMs);
      return sql.exec(
        `INSERT INTO ${t.opsNonces} (key_id, nonce, expires_at) VALUES (?, ?, ?) ON CONFLICT (key_id, nonce) DO NOTHING RETURNING nonce`,
        keyId, nonce, expiresAtMs,
      ).toArray().length > 0;
    });
  }

  async appendAudit(entry: OpsAuditRecord, retainAfter: string): Promise<void> {
    const t = DISTRICT_TABLES;
    this.#tables.transaction((sql) => {
      sql.exec(`DELETE FROM ${t.opsAudit} WHERE at < ?`, retainAfter);
      sql.exec(
        `INSERT INTO ${t.opsAudit} (id, key_id, operator, route, target, result, at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        entry.id, entry.keyId, entry.operator, entry.route, entry.target, entry.result, entry.at,
      );
    });
  }

  async listAudit(limit: number): Promise<OpsAuditRecord[]> {
    const rows = this.#tables.transaction((sql) => sql.exec(`SELECT * FROM ${DISTRICT_TABLES.opsAudit} ORDER BY seq DESC LIMIT ?`, limit).toArray());
    return rows.map((row) => {
      const parsed = StoredOpsAudit.safeParse(row);
      if (!parsed.success) throw new DistrictStoreCorruptionError("an ops audit entry does not match its schema");
      const r = parsed.data;
      return { id: r.id, keyId: r.key_id, operator: r.operator, route: r.route, target: r.target, result: r.result, at: r.at };
    });
  }
}
