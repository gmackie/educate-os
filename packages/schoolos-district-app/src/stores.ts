import {
  SchoolOsError,
  type ConfigRevisionId,
  type ConfigurationRevision,
  type DistrictDirectorySnapshot,
} from "@schoolos/contracts";
import { InMemoryAcademicStore, type AcademicStore } from "@schoolos/academics";
import type { PolicyAuditEvent, PolicyAuditSink } from "@schoolos/policy";
import { InMemoryWorkspaceStore, type WorkspaceStore } from "@schoolos/workspaces";
import {
  BackendArtifactStore,
  InMemoryArtifactRecordStore,
  InMemoryInlineTextTable,
  InMemoryR2Bucket,
  type ArtifactRecordStore,
  type ArtifactStore,
} from "@schoolos/learning-artifacts";
import { InMemoryAssessmentRecordStore, type AssessmentRecordStore } from "@schoolos/assessment";
import { InMemoryAssessmentRunStore, InMemoryRubricReleaseStore, type AssessmentRunStore, type RubricReleaseStore } from "@schoolos/assessment-ci";
import { InMemoryContentStudioStorage, type ContentStudioStorage } from "@schoolos/content-studio";
import {
  InMemoryCodexPublisher,
  InMemoryCourseContentStorage,
  InMemoryCurriculumStorage,
  type CodexPublisher,
  type CourseContentStorage,
  type CurriculumStorage,
} from "@schoolos/curriculum";
import { InMemoryCatalogMirrorStorage, type CatalogMirrorStorage } from "@schoolos/catalog";
import { InMemoryLedgerStore, type LedgerStore } from "@schoolos/ai-governance";
import { oneroster } from "@schoolos/integrations";
import type { WorkshopUserLink } from "@schoolos/identity";
import { InMemoryGuardianRelationshipStore, type GuardianRelationshipStore } from "@schoolos/policy";
import { InMemoryGuardianInvitationStore, InMemoryIdentityLinkStore, type GuardianInvitationStore, type IdentityLinkStore } from "@schoolos/identity-links";
import type { FundingAllocationRevision } from "./routes.ts";

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
      throw new SchoolOsError("conflict", "The configuration changed since this plan was made; plan it again.");
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
      throw new SchoolOsError("conflict", "The funding allocations changed since you loaded them; review them again.");
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
 * The district's administrator-confirmed Workshop user links (`@schoolos/identity`), oldest first.
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
}

/** In-memory stores for one district, seeded with its directory. */
export function inMemoryDistrictStores(directory: DistrictDirectorySnapshot): DistrictAppStores {
  return {
    directory: InMemoryAcademicStore.seeded(directory),
    rosterSources: new InMemoryRosterSourceStore(),
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
  };
}
