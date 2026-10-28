import {
  EducateOsError,
  IntegrationSyncRun,
  type ConfigRevisionId,
  type ConfigurationRevision,
  type DistrictDirectorySnapshot,
} from "@educateos/contracts";
import { InMemoryAcademicStore, type AcademicStore } from "@educateos/academics";
import type { PolicyAuditEvent, PolicyAuditSink } from "@educateos/policy";
import { InMemoryWorkspaceStore, type WorkspaceStore } from "@educateos/workspaces";
import {
  BackendArtifactStore,
  InMemoryArtifactRecordStore,
  InMemoryInlineTextTable,
  InMemoryR2Bucket,
  type ArtifactRecordStore,
  type ArtifactStore,
} from "@educateos/learning-artifacts";
import { InMemoryAssessmentRecordStore, InMemoryGradebookStore, type AssessmentRecordStore, type GradebookStore } from "@educateos/assessment";
import { InMemoryAssessmentRunStore, InMemoryRubricReleaseStore, type AssessmentRunStore, type RubricReleaseStore } from "@educateos/assessment-ci";
import { InMemoryContentStudioStorage, type ContentStudioStorage } from "@educateos/content-studio";
import {
  InMemoryCodexPublisher,
  InMemoryCourseContentStorage,
  InMemoryCurriculumStorage,
  type CodexPublisher,
  type CourseContentStorage,
  type CurriculumStorage,
} from "@educateos/curriculum";
import { InMemoryCatalogMirrorStorage, type CatalogMirrorStorage } from "@educateos/catalog";
import { InMemoryLedgerStore, type LedgerStore } from "@educateos/ai-governance";
import { oneroster } from "@educateos/integrations";
import { z } from "zod";
import { InMemoryDiscussionStorage, type DiscussionStorage } from "@educateos/discussions";
// Quizzes (SCHO-191)
import { InMemoryQuizStorage, type QuizStorage } from "@educateos/quizzes";
import type { WorkshopUserLink } from "@educateos/identity";
import { InMemoryGuardianRelationshipStore, type GuardianRelationshipStore } from "@educateos/policy";
import { InMemoryGuardianInvitationStore, InMemoryIdentityLinkStore, type GuardianInvitationStore, type IdentityLinkStore } from "@educateos/identity-links";
import type { FundingAllocationRevision } from "./routes.ts";
// Communication (SCHO-189)
import { inMemoryCommunicationStores, type CommunicationStores } from "./communication/stores.ts";
// Devices (SCHO-261)
import { InMemoryDeviceStore, type DeviceStore } from "./devices.ts";
// Pairing (SCHO-261)
import { InMemoryPairRoomStore, type PairRoomStore } from "./pairing.ts";

/**
 * A district's configuration revisions, oldest first. Only applied revisions are kept: a draft or
 * plan is computed per request and never stored. A revision is appended only if the head is still
 * the one the caller planned against, so two administrators cannot both apply over the same head.
 */
export interface ConfigRevisionStore {
  /** Every applied revision, oldest first. */
  list(): Promise<ConfigurationRevision[]>;
  /** Appends `revision` if the head is still `expectedHeadId` (absent for none), else throws `conflict`. */
  append(revision: ConfigurationRevision, expectedHeadId: ConfigRevisionId | undefined): Promise<void>;
}

/** A {@link ConfigRevisionStore} in memory. */
export class InMemoryConfigRevisionStore implements ConfigRevisionStore {
  readonly #revisions: ConfigurationRevision[] = [];

  async list(): Promise<ConfigurationRevision[]> {
    return structuredClone(this.#revisions);
  }

  async append(revision: ConfigurationRevision, expectedHeadId: ConfigRevisionId | undefined): Promise<void> {
    if (this.#revisions.at(-1)?.id !== expectedHeadId) {
      throw new EducateOsError("conflict", "The configuration changed since this plan was made; plan it again.");
    }
    this.#revisions.push(structuredClone(revision));
  }
}

/**
 * The district's funding pool allocations, as administrators set them, oldest revision first. The
 * pools themselves (scope, purpose, allowed models) are deployment configuration
 * (`DistrictAppOptions.fundingPools`); a revision records only the monthly allocation of each, and
 * the head revision's allocations replace the configured ones wherever it names a pool. Revisions
 * are append-only, so the history of who changed which allocation, and when, is never rewritten.
 * As with configuration, a revision is appended only over the head the administrator saw.
 */
export interface FundingAllocationStore {
  /** Every revision, oldest first. */
  list(): Promise<FundingAllocationRevision[]>;
  /** Appends `revision` if the head is still `expectedHeadId` (absent for none), else throws `conflict`. */
  append(revision: FundingAllocationRevision, expectedHeadId: string | undefined): Promise<void>;
}

/** A {@link FundingAllocationStore} in memory. */
export class InMemoryFundingAllocationStore implements FundingAllocationStore {
  readonly #revisions: FundingAllocationRevision[] = [];

  async list(): Promise<FundingAllocationRevision[]> {
    return structuredClone(this.#revisions);
  }

  async append(revision: FundingAllocationRevision, expectedHeadId: string | undefined): Promise<void> {
    if (this.#revisions.at(-1)?.id !== expectedHeadId) {
      throw new EducateOsError("conflict", "The funding allocations changed since you loaded them; review them again.");
    }
    this.#revisions.push(structuredClone(revision));
  }
}

/**
 * Which directory records came from the OneRoster roster, alongside the directory itself. The
 * OneRoster importer needs it to tell a record it manages from one it does not.
 */
export interface RosterSourceStore {
  /** The current source map. */
  load(): Promise<oneroster.OneRosterSourceMap>;
  /** Replaces the source map. */
  save(sources: oneroster.OneRosterSourceMap): Promise<void>;
}

/** A {@link RosterSourceStore} in memory. */
export class InMemoryRosterSourceStore implements RosterSourceStore {
  #sources: oneroster.OneRosterSourceMap = oneroster.EMPTY_SOURCE_MAP;

  async load(): Promise<oneroster.OneRosterSourceMap> {
    return structuredClone(this.#sources);
  }

  async save(sources: oneroster.OneRosterSourceMap): Promise<void> {
    this.#sources = structuredClone(sources);
  }
}

/**
 * What a scheduled roster sync keeps between runs (SCHO-203), beside the directory and source map
 * it writes: the roster's rows as last applied, where the next delta starts, and a held removal an
 * administrator approved. The directory itself is never copied here.
 */
export const RosterSyncRecord = z.strictObject({
  /** The roster's rows as the last applied sync left them. Absent until a complete sync applies. */
  mirror: oneroster.RosterMirror.optional(),
  /** Where each file's next `dateLastModified` delta starts. */
  cursors: oneroster.RosterCursors.optional(),
  /** Where the source's own change feed resumes (Clever's events). */
  sourceCursor: oneroster.SourceCursor.optional(),
  /** The fingerprint of a held removal an administrator approved, which the next sync consumes. */
  approvedRemoval: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});
/** A roster sync record. */
export type RosterSyncRecord = z.infer<typeof RosterSyncRecord>;

/** How many sync runs a {@link RosterSyncStore} keeps. Older ones are dropped. */
export const MAX_ROSTER_SYNC_RUNS = 500;

/** Where a scheduled roster sync keeps its {@link RosterSyncRecord} and its run history. */
export interface RosterSyncStore {
  /** The record, empty before the first sync. */
  load(): Promise<RosterSyncRecord>;
  /** Replaces the record. */
  save(record: RosterSyncRecord): Promise<void>;
  /** Records a run, dropping the oldest past {@link MAX_ROSTER_SYNC_RUNS}. Runs hold counts and codes, never roster data. */
  recordRun(run: IntegrationSyncRun): Promise<void>;
  /** The most recent runs, at most `limit`, oldest first. */
  runs(limit?: number): Promise<IntegrationSyncRun[]>;
}

/** A {@link RosterSyncStore} in memory. */
export class InMemoryRosterSyncStore implements RosterSyncStore {
  #record: RosterSyncRecord = {};
  #runs: IntegrationSyncRun[] = [];

  async load(): Promise<RosterSyncRecord> {
    return structuredClone(this.#record);
  }

  async save(record: RosterSyncRecord): Promise<void> {
    this.#record = structuredClone(RosterSyncRecord.parse(record));
  }

  async recordRun(run: IntegrationSyncRun): Promise<void> {
    this.#runs = [...this.#runs, IntegrationSyncRun.parse(run)].slice(-MAX_ROSTER_SYNC_RUNS);
  }

  async runs(limit = MAX_ROSTER_SYNC_RUNS): Promise<IntegrationSyncRun[]> {
    return structuredClone(this.#runs.slice(-limit));
  }
}

/**
 * The district's administrator-confirmed Workshop user links (`@educateos/identity`), oldest first.
 * Append-only; `confirmWorkshopUserLink` checks a link against these before it is added.
 */
export interface WorkshopUserLinkStore {
  /** Every link, oldest first. */
  list(): Promise<WorkshopUserLink[]>;
  /** Appends a confirmed link. */
  add(link: WorkshopUserLink): Promise<void>;
}

/** A {@link WorkshopUserLinkStore} in memory. */
export class InMemoryWorkshopUserLinkStore implements WorkshopUserLinkStore {
  readonly #links: WorkshopUserLink[] = [];

  async list(): Promise<WorkshopUserLink[]> {
    return structuredClone(this.#links);
  }

  async add(link: WorkshopUserLink): Promise<void> {
    this.#links.push(structuredClone(link));
  }
}

/** A {@link PolicyAuditSink} that keeps events in memory, for tests and the local harness. */
export class InMemoryPolicyAuditLog implements PolicyAuditSink {
  readonly #events: PolicyAuditEvent[] = [];

  async record(event: PolicyAuditEvent): Promise<void> {
    this.#events.push(structuredClone(event));
  }

  /** Every recorded event, oldest first. */
  events(): PolicyAuditEvent[] {
    return structuredClone(this.#events);
  }
}

/**
 * Every store one district's application keeps its state in. Each is the domain package's own
 * storage interface, so a durable implementation (D1, R2, a Durable Object) replaces the in-memory
 * one without the application changing.
 */
export interface DistrictAppStores {
  /** The academic directory (A01). */
  directory: AcademicStore;
  /** Which directory records the roster owns (A03). */
  rosterSources: RosterSourceStore;
  /** A scheduled roster sync's mirror, cursors, approval and run history (SCHO-203). */
  rosterSync: RosterSyncStore;
  /** Workspace records (W01). */
  workspaces: WorkspaceStore;
  /** Artifact records (W02). */
  artifactRecords: ArtifactRecordStore;
  /** Artifact revision content (W02). */
  artifactContent: ArtifactStore;
  /** Assignments, submissions, feedback and grades (E01). */
  assessment: AssessmentRecordStore;
  /** Signed rubric releases (E02). */
  rubrics: RubricReleaseStore;
  /** Assessment CI runs (E02). */
  assessmentRuns: AssessmentRunStore;
  /** The Content Studio's items, snapshots and releases (C03). */
  contentStudio: ContentStudioStorage;
  /** Activity definitions and installations (C05). */
  curriculum: CurriculumStorage;
  /** Where published class Codex documents go (C05). */
  codex: CodexPublisher;
  /** Each offering's modules and pages (SCHO-186). */
  courseContent: CourseContentStorage;
  /** The district's framework catalog mirror (C02). */
  catalog: CatalogMirrorStorage;
  /** The AI spend ledger (G01). */
  ledger: LedgerStore;
  /** Applied configuration revisions (F03). */
  config: ConfigRevisionStore;
  /** Funding pool allocation revisions (UI-02). */
  fundingAllocations: FundingAllocationStore;
  /** Administrator-confirmed Workshop user links (F04), which the AI call guard resolves through. */
  workshopUserLinks: WorkshopUserLinkStore;
  /** The policy decision audit trail (A02). Every decision every service makes lands here. */
  audit: PolicyAuditSink;
  // Guardians (ADR-0012, SCHO-188)
  /** Guardian relationships and their change history. */
  guardianRelationships: GuardianRelationshipStore;
  /** Single-use guardian invitations. */
  guardianInvitations: GuardianInvitationStore;
  /** Pending identity links and Workshop user adoptions (ADR-0003, SCHO-38), which guardian sign-ins wait in. */
  identityLinks: IdentityLinkStore;

  // Gradebook (SCHO-187)
  /** Each offering's gradebook settings and cell markers. */
  gradebooks: GradebookStore;
  // Communication (SCHO-189)
  /** Announcements, weekly notes, notifications, calendar feeds, email preferences and the digest ledger. */
  communication: CommunicationStores;
  // Discussions (SCHO-190).
  /** Each offering's discussion topics, posts, settings and moderation trail. */
  discussions: DiscussionStorage;
  // Quizzes (SCHO-191)
  /** Each offering's quizzes, attempts and score releases. */
  quizzes: QuizStorage;
  // Devices (SCHO-261)
  /** Registered phones, their refresh tokens and recently seen proof IDs. */
  devices: DeviceStore;
  // Pairing (SCHO-261)
  /** Phone pairing rooms, open and recently finished. */
  pairRooms: PairRoomStore;
}

/** In-memory stores for one district, seeded with its directory. */
export function inMemoryDistrictStores(directory: DistrictDirectorySnapshot): DistrictAppStores {
  return {
    directory: InMemoryAcademicStore.seeded(directory),
    rosterSources: new InMemoryRosterSourceStore(),
    rosterSync: new InMemoryRosterSyncStore(),
    workspaces: new InMemoryWorkspaceStore(),
    artifactRecords: new InMemoryArtifactRecordStore(),
    artifactContent: new BackendArtifactStore({ text: new InMemoryInlineTextTable(), r2: new InMemoryR2Bucket() }),
    assessment: new InMemoryAssessmentRecordStore(),
    rubrics: new InMemoryRubricReleaseStore(),
    assessmentRuns: new InMemoryAssessmentRunStore(),
    contentStudio: new InMemoryContentStudioStorage(),
    curriculum: new InMemoryCurriculumStorage(),
    codex: new InMemoryCodexPublisher(),
    courseContent: new InMemoryCourseContentStorage(),
    catalog: new InMemoryCatalogMirrorStorage(),
    ledger: new InMemoryLedgerStore(),
    config: new InMemoryConfigRevisionStore(),
    fundingAllocations: new InMemoryFundingAllocationStore(),
    workshopUserLinks: new InMemoryWorkshopUserLinkStore(),
    audit: new InMemoryPolicyAuditLog(),
    // Guardians (ADR-0012, SCHO-188)
    guardianRelationships: new InMemoryGuardianRelationshipStore(),
    guardianInvitations: new InMemoryGuardianInvitationStore(),
    identityLinks: new InMemoryIdentityLinkStore(directory.district.id),
    // Gradebook (SCHO-187)
    gradebooks: new InMemoryGradebookStore(),
    // Communication (SCHO-189)
    communication: inMemoryCommunicationStores(),
    // Discussions (SCHO-190).
    discussions: new InMemoryDiscussionStorage(),
    // Quizzes (SCHO-191)
    quizzes: new InMemoryQuizStorage(),
    // Devices (SCHO-261)
    devices: new InMemoryDeviceStore(),
    // Pairing (SCHO-261)
    pairRooms: new InMemoryPairRoomStore(),
  };
}
