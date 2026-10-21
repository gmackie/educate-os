import {
  SchoolOsError,
  type Action,
  type ArtifactId,
  type AuthorizationRequest,
  type Caller,
  type ContentDigest,
  type DistrictDirectorySnapshot,
  type DistrictId,
  type OfferingId,
  type PrincipalId,
  type ResourceRef,
  type RevisionId,
  type Scope,
  type TermState,
} from "@schoolos/contracts";
import type { AcademicStore } from "@schoolos/academics";
import { sha256Digest, type Artifact, type ArtifactRevision, type LearningArtifacts } from "@schoolos/learning-artifacts";
import type { PolicyDecider } from "@schoolos/policy";
import type { WorkspaceDirectory, WorkspaceLifecycle } from "@schoolos/workspaces";
import {
  JSON_MEDIA_TYPE,
  PROVENANCE_PATH,
  canonicalJsonBytes,
  extensionFor,
  mayRedistribute,
  writeArchive,
  type ArchiveFile,
  type ArchiveProvenance,
  type ArchivedRevision,
  type ArtifactRecord,
  type ExportDecision,
  type ExportId,
  type FeedbackRecord,
  type ResourceRecord,
  type SourceRights,
  type StudentArchiveManifest,
  type SubjectRef,
  type SubmissionPart,
  type SubmissionRecord,
  type WorkContext,
} from "./archive.ts";
import type { ResourceSourceRecord, StudentRecordSource } from "./records.ts";
import { findSecretShapes } from "./secrets.ts";

/**
 * The course workspace states whose artifacts are exported: the term is over (roadmap §6.1). Work
 * in a course that is still running or being graded is exported once it closes; until then a
 * learner exports it through their submissions.
 */
export const EXPORTABLE_COURSE_LIFECYCLES: readonly WorkspaceLifecycle[] = ["completed", "retained", "eligible-for-deletion"];

/** One export-local ID and the district ID it stands for. */
export interface ExportMappingEntry {
  localId: string;
  internalId: string;
}

/**
 * How an export's local IDs map back to district IDs. It stays with the district, never in the
 * archive, so a later import (P02) into the same district can be reconciled and nobody holding
 * only the archive can learn a district ID from it.
 */
export interface ExportMapping {
  exportId: ExportId;
  districtId: DistrictId;
  principalId: PrincipalId;
  subject: SubjectRef;
  exportedAt: string;
  entries: ExportMappingEntry[];
}

/** Where export mappings are kept, server-side. */
export interface ExportMappingStore {
  /** Records one export's mapping. */
  record(mapping: ExportMapping): Promise<void>;
}

/** An {@link ExportMappingStore} held in memory, for tests and the local harness. */
export class InMemoryExportMappingStore implements ExportMappingStore {
  readonly #mappings = new Map<string, ExportMapping>();

  async record(mapping: ExportMapping): Promise<void> {
    this.#mappings.set(mapping.exportId, structuredClone(mapping));
  }

  /** The mapping recorded for `exportId`, if any. */
  get(exportId: string): ExportMapping | undefined {
    const mapping = this.#mappings.get(exportId);
    return mapping === undefined ? undefined : structuredClone(mapping);
  }
}

/**
 * Something the learner may export but that was left out because it holds text shaped like a
 * password, key or token. The learner can remove it and export again.
 */
export interface WithheldItem {
  kind: "artifact" | "submission" | "feedback" | "resource";
  /** The learner-facing title, such as the artifact's or activity's. */
  label: string;
  /** The kinds of secret-shaped text found (see `findSecretShapes`). */
  found: string[];
}

/** A finished export. The mapping has already been recorded; it is not part of this result. */
export interface StudentArchiveExport {
  exportId: ExportId;
  /** The `.schoolos` file. */
  bytes: Uint8Array<ArrayBuffer>;
  manifest: StudentArchiveManifest;
  withheld: WithheldItem[];
}

/** What a {@link StudentArchiveExporter} is built from. */
export interface StudentArchiveExporterOptions {
  /** The artifact service, through which every artifact is read and exported as the learner. */
  artifacts: LearningArtifacts;
  /** The workspace directory, for the learner's workspaces and their lifecycle. */
  workspaces: WorkspaceDirectory;
  /** The academic directory, for the district's name and every offering's scope, names and term. */
  directory: AcademicStore;
  /** Asked about every item before it goes in. */
  policy: PolicyDecider;
  /** The learner's submissions, feedback and cited resources. */
  records: StudentRecordSource;
  /** Where each export's ID mapping is kept. */
  mappings: ExportMappingStore;
  /** The clock. Defaults to the system clock. */
  now?: () => Date;
  /** 32 random lowercase hex digits, for export IDs and subject references. Defaults to `crypto`. */
  randomHex?: () => string;
}

/** An offering as the exporter needs it: its policy scope, term state and display names. */
interface OfferingFacts {
  scope: Scope;
  termState: TermState;
  context: WorkContext;
}

/** A revision already in the archive, by district IDs. */
interface ExportedRevision {
  artifact: string;
  revision: string;
  digest: ContentDigest;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Builds a learner's `.schoolos` archive (roadmap P01). It collects only what the learner may
 * export, asking the policy engine for `export` on each item:
 *
 * - every artifact in their personal workspace, and every artifact in a course workspace whose
 *   term is over ({@link EXPORTABLE_COURSE_LIFECYCLES}), with its whole revision lineage;
 * - their own submissions;
 * - feedback their teachers shared with them;
 * - resources their work cites, as content only when policy allows the export and the resource's
 *   rights permit redistribution, and otherwise as a reference if they may read it.
 *
 * It never includes another learner's work, teacher-only notes, tokens or credentials (nothing
 * secret-shaped: an item that has any is withheld and reported), storage keys, or district IDs,
 * which are replaced with export-local IDs whose mapping is recorded server-side.
 */
export class StudentArchiveExporter {
  readonly #artifacts: LearningArtifacts;
  readonly #workspaces: WorkspaceDirectory;
  readonly #directory: AcademicStore;
  readonly #policy: PolicyDecider;
  readonly #records: StudentRecordSource;
  readonly #mappings: ExportMappingStore;
  readonly #now: () => Date;
  readonly #randomHex: () => string;

  constructor(options: StudentArchiveExporterOptions) {
    this.#artifacts = options.artifacts;
    this.#workspaces = options.workspaces;
    this.#directory = options.directory;
    this.#policy = options.policy;
    this.#records = options.records;
    this.#mappings = options.mappings;
    this.#now = options.now ?? (() => new Date());
    this.#randomHex = options.randomHex ?? (() => crypto.randomUUID().replaceAll("-", ""));
  }

  /** Exports everything the caller may take with them, as one archive about the caller. */
  async exportStudentArchive(caller: Caller): Promise<StudentArchiveExport> {
    const me = caller.principal.principalId;
    const { snapshot } = await this.#directory.load();
    const principal = snapshot.principals.find((p) => p.id === me && p.districtId === caller.principal.districtId);
    if (principal === undefined || principal.kind === "service") throw new SchoolOsError("not-found", `principal ${me} was not found.`);

    const run = new ExportRun(caller, this.#policy, this.#randomHex(), this.#randomHex());
    await this.#collectArtifacts(run, snapshot);
    await this.#collectSubmissions(run, snapshot);
    await this.#collectFeedback(run, snapshot);
    await this.#collectResources(run);

    const exportedAt = this.#now().toISOString();
    const provenance: ArchiveProvenance = {
      format: "schoolos.student-archive.provenance",
      formatVersion: 1,
      exportId: run.exportId,
      generator: "@schoolos/portability",
      decisions: run.decisions,
    };
    run.files.push({ path: PROVENANCE_PATH, kind: "provenance", mediaType: JSON_MEDIA_TYPE, rights: { mode: "export-metadata" }, bytes: canonicalJsonBytes(provenance) });
    for (const file of run.files) {
      if (isTextual(file.mediaType) && findSecretShapes(decoder.decode(file.bytes)).length > 0) {
        // Every item was screened as it was collected, so this is a bug in the exporter.
        throw new Error(`export ${run.exportId}: ${file.path} is secret-shaped after screening`);
      }
    }

    const { bytes, manifest } = await writeArchive(
      { exportId: run.exportId, district: { displayName: snapshot.district.name }, exportedAt, subject: run.subject },
      run.files,
    );
    await this.#mappings.record({
      exportId: run.exportId,
      districtId: caller.principal.districtId,
      principalId: me,
      subject: run.subject,
      exportedAt,
      entries: run.mapping,
    });
    return { exportId: run.exportId, bytes, manifest, withheld: run.withheld };
  }

  async #collectArtifacts(run: ExportRun, snapshot: DistrictDirectorySnapshot): Promise<void> {
    const caller = run.caller;
    const workspaces = (await this.#workspaces.listMyWorkspaces(caller))
      .filter((w) => w.ownerPrincipalId === caller.principal.principalId)
      .filter((w) => w.kind === "personal" || EXPORTABLE_COURSE_LIFECYCLES.includes(w.lifecycle))
      .toSorted((a, b) => (a.kind === b.kind ? byTimeThenId(a.createdAt, a.id, b.createdAt, b.id) : a.kind === "personal" ? -1 : 1));
    for (const workspace of workspaces) {
      const facts = workspace.kind === "course" ? offeringFacts(snapshot, workspace.offeringId) : undefined;
      if (workspace.kind === "course" && facts === undefined) continue;
      const context: WorkContext = facts?.context ?? { kind: "personal" };
      const views = (await this.#artifacts.listArtifacts(caller, workspace.id))
        .filter((v) => v.artifact.ownerPrincipalId === caller.principal.principalId)
        .toSorted((a, b) => byTimeThenId(a.artifact.createdAt, a.artifact.id, b.artifact.createdAt, b.artifact.id));
      for (const { artifact } of views) {
        const ruleId = await run.allows("export", {
          resource: { kind: "artifact", id: artifact.id, scope: artifact.scope, classification: artifact.classification, ownerPrincipalId: artifact.ownerPrincipalId },
          ...(facts === undefined ? {} : { termState: facts.termState }),
        });
        if (ruleId === undefined) continue;
        await this.#collectArtifact(run, artifact, context, ruleId);
      }
    }
  }

  async #collectArtifact(run: ExportRun, artifact: Artifact, context: WorkContext, ruleId: string): Promise<void> {
    const caller = run.caller;
    const revisions = (await this.#artifacts.history(caller, artifact.id)).toReversed();
    const held: { revision: ArtifactRevision; bytes?: Uint8Array<ArrayBuffer> }[] = [];
    for (const revision of revisions) {
      if (revision.content.backend === "external") {
        held.push({ revision });
      } else {
        const { bytes } = await this.#artifacts.exportArtifact(caller, artifact.id, revision.id);
        held.push({ revision, ...(bytes === undefined ? {} : { bytes }) });
      }
    }

    const screened = [
      artifact.title,
      // A link is screened as it will be exported: without the query and fragment it is stripped of.
      ...held.map(({ revision }) => (revision.content.backend === "external" ? sanitizedUrl(revision.content.key) : "")),
      ...held.flatMap(({ revision, bytes }) => (bytes !== undefined && isTextual(revision.mediaType) ? [decoder.decode(bytes)] : [])),
    ];
    const found = secretsIn(screened);
    if (found.length > 0) {
      run.withheld.push({ kind: "artifact", label: artifact.title, found });
      return;
    }

    const local = run.assign("a", artifact.id);
    const localRevision = (revision: ArtifactRevision) => `${local}-r${revision.number}`;
    const archived: ArchivedRevision[] = [];
    for (const { revision, bytes } of held) {
      const id = localRevision(revision);
      run.map(id, revision.id);
      const parent = revisions.find((r) => r.id === revision.parentRevisionId);
      let content: ArchivedRevision["content"];
      if (revision.content.backend === "external") {
        content = {
          kind: "reference",
          url: sanitizedUrl(revision.content.key),
          ...(revision.content.snapshotDigest === undefined ? {} : { snapshotDigest: revision.content.snapshotDigest }),
        };
      } else {
        if (bytes === undefined) throw new Error(`revision ${revision.id} exported no bytes`);
        const path = `artifacts/${local}/r${revision.number}.${extensionFor(revision.mediaType)}`;
        run.files.push({ path, kind: "artifact-revision", mediaType: revision.mediaType, rights: { mode: "learner-work" }, bytes });
        content = { kind: "file", path };
        run.exportedRevisions.push({ artifact: artifact.id, revision: revision.id, digest: revision.content.digest });
      }
      archived.push({
        id,
        number: revision.number,
        ...(parent === undefined ? {} : { parent: localRevision(parent) }),
        createdAt: revision.createdAt,
        author: run.person(revision.authorPrincipalId),
        mediaType: revision.mediaType,
        digest: revision.content.digest,
        sizeBytes: revision.sizeBytes,
        aiAssistance: revision.aiAssistance,
        origin: revision.provenance.origin,
        content,
      });
    }
    const record: ArtifactRecord = { id: local, type: artifact.type, title: artifact.title, context, createdAt: artifact.createdAt, revisions: archived };
    const rights: SourceRights = artifact.type === "external-ref" ? { mode: "link" } : { mode: "learner-work" };
    run.files.push({ path: `artifacts/${local}/artifact.json`, kind: "artifact", mediaType: JSON_MEDIA_TYPE, rights, bytes: canonicalJsonBytes(record) });
    run.decisions.push({ item: local, action: "export", ruleId });
  }

  async #collectSubmissions(run: ExportRun, snapshot: DistrictDirectorySnapshot): Promise<void> {
    const caller = run.caller;
    const me = caller.principal.principalId;
    const submissions = (await this.#records.submissions(me))
      .filter((s) => s.ownerPrincipalId === me)
      .toSorted((a, b) => byTimeThenId(a.submittedAt, a.id, b.submittedAt, b.id));
    for (const submission of submissions) {
      const facts = offeringFacts(snapshot, submission.offeringId);
      if (facts === undefined) continue;
      const ruleId = await run.allows("export", {
        resource: { kind: "submission", id: submission.id, scope: facts.scope, classification: "course", ownerPrincipalId: me },
        termState: facts.termState,
      });
      if (ruleId === undefined) continue;
      if (secretsIn([submission.activityTitle]).length > 0) {
        run.withheld.push({ kind: "submission", label: "A submission", found: secretsIn([submission.activityTitle]) });
        continue;
      }

      const local = run.assign("s", submission.id);
      const parts: SubmissionPart[] = [];
      const files: ArchiveFile[] = [];
      for (const submitted of submission.revisions) {
        const exported = run.exportedRevisions.find((r) => r.artifact === submitted.artifactId && r.revision === submitted.revisionId);
        if (exported !== undefined && exported.digest === submitted.digest) {
          const revision = run.localOf(submitted.revisionId);
          const artifact = run.localOf(submitted.artifactId);
          if (revision !== undefined && artifact !== undefined) {
            parts.push({ digest: submitted.digest, content: { kind: "revision", artifact, revision } });
            continue;
          }
        }
        const file = await this.#submittedFile(caller, submitted.artifactId, submitted.revisionId, submitted.digest);
        if (file === undefined) {
          parts.push({ digest: submitted.digest, content: { kind: "not-included" } });
          continue;
        }
        const path = `submissions/${local}/part${parts.length + 1}.${extensionFor(file.mediaType)}`;
        files.push({ path, kind: "submission-file", mediaType: file.mediaType, rights: { mode: "learner-work" }, bytes: file.bytes });
        parts.push({ digest: submitted.digest, content: { kind: "file", path, mediaType: file.mediaType, sizeBytes: file.bytes.byteLength } });
      }
      const record: SubmissionRecord = { id: local, activity: submission.activityTitle, context: facts.context, submittedAt: submission.submittedAt, parts };
      run.files.push(...files, { path: `submissions/${local}/submission.json`, kind: "submission", mediaType: JSON_MEDIA_TYPE, rights: { mode: "learner-work" }, bytes: canonicalJsonBytes(record) });
      run.decisions.push({ item: local, action: "export", ruleId });
    }
  }

  /**
   * The content of a submitted revision not already in the archive, exported through the artifact
   * service as the learner. Undefined when it may not be exported, is no longer held, is a link,
   * does not match the submitted digest, or is secret-shaped.
   */
  async #submittedFile(
    caller: Caller,
    artifactId: ArtifactId,
    revisionId: RevisionId,
    digest: ContentDigest,
  ): Promise<{ bytes: Uint8Array<ArrayBuffer>; mediaType: ArtifactRevision["mediaType"] } | undefined> {
    try {
      const { bytes, manifest } = await this.#artifacts.exportArtifact(caller, artifactId, revisionId);
      if (bytes === undefined || manifest.revision.content.digest !== digest || manifest.artifact.ownerPrincipalId !== caller.principal.principalId) return undefined;
      if (isTextual(manifest.revision.mediaType) && secretsIn([decoder.decode(bytes)]).length > 0) return undefined;
      return { bytes, mediaType: manifest.revision.mediaType };
    } catch (error) {
      if (error instanceof SchoolOsError && (error.code === "not-found" || error.code === "forbidden" || error.code === "unavailable")) return undefined;
      throw error;
    }
  }

  async #collectFeedback(run: ExportRun, snapshot: DistrictDirectorySnapshot): Promise<void> {
    const me = run.caller.principal.principalId;
    const feedback = (await this.#records.feedback(me))
      .filter((f) => f.subjectPrincipalId === me && f.visibility === "shared-with-learner")
      .toSorted((a, b) => byTimeThenId(a.createdAt, a.id, b.createdAt, b.id));
    for (const note of feedback) {
      const facts = offeringFacts(snapshot, note.offeringId);
      if (facts === undefined) continue;
      const ruleId = await run.allows("export", {
        resource: { kind: "feedback", id: note.id, scope: facts.scope, classification: "course", ownerPrincipalId: me },
        termState: facts.termState,
      });
      if (ruleId === undefined) continue;
      const found = secretsIn([note.body]);
      if (found.length > 0) {
        run.withheld.push({ kind: "feedback", label: "Feedback", found });
        continue;
      }
      const local = run.assign("f", note.id);
      const submission = note.submissionId === undefined ? undefined : run.localOf(note.submissionId);
      const record: FeedbackRecord = {
        id: local,
        ...(submission === undefined ? {} : { submission }),
        author: run.person(note.authorPrincipalId),
        createdAt: note.createdAt,
        body: note.body,
      };
      run.files.push({ path: `feedback/${local}.json`, kind: "feedback", mediaType: JSON_MEDIA_TYPE, rights: { mode: "shared-feedback" }, bytes: canonicalJsonBytes(record) });
      run.decisions.push({ item: local, action: "export", ruleId });
    }
  }

  async #collectResources(run: ExportRun): Promise<void> {
    const resources = (await this.#records.resources(run.caller.principal.principalId)).toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const resource of resources) {
      const target: Target = { resource: { kind: "learning-resource", id: resource.id, scope: resource.scope, classification: resource.classification } };
      const exportRule = await run.allows("export", target);
      const asContent = exportRule !== undefined && mayRedistribute(resource.rights) && resource.contentMediaType !== undefined;
      const readRule = exportRule ?? (resource.url === undefined ? undefined : await run.allows("read", target));
      if (!asContent && (resource.url === undefined || readRule === undefined)) continue;

      const bytes = asContent ? await this.#records.resourceContent(resource.id) : undefined;
      const found = secretsIn([resource.title, ...(bytes !== undefined && isTextual(resource.contentMediaType!) ? [decoder.decode(bytes)] : [])]);
      if (found.length > 0) {
        run.withheld.push({ kind: "resource", label: resource.title, found });
        continue;
      }
      const local = run.assign("res", resource.id);
      const record = await resourceRecord(local, resource, bytes);
      if (record.content !== undefined && bytes !== undefined) {
        run.files.push({ path: record.content.path, kind: "resource-content", mediaType: record.content.mediaType, rights: resource.rights, bytes });
      }
      run.files.push({ path: `resources/${local}/resource.json`, kind: "resource", mediaType: JSON_MEDIA_TYPE, rights: resource.rights, bytes: canonicalJsonBytes(record) });
      // `readRule` is the export rule whenever export was allowed, so it is the rule that let the item in.
      run.decisions.push({ item: local, action: exportRule === undefined ? "read" : "export", ruleId: readRule! });
    }
  }
}

/** A resource to authorize against, with the state of the term it belongs to, if any. */
interface Target {
  resource: ResourceRef;
  termState?: TermState;
}

/** The state of one export while it is collected: its IDs, files, decisions and withheld items. */
class ExportRun {
  readonly caller: Caller;
  readonly exportId: ExportId;
  readonly subject: SubjectRef;
  readonly files: ArchiveFile[] = [];
  readonly decisions: ExportDecision[] = [];
  readonly withheld: WithheldItem[] = [];
  readonly mapping: ExportMappingEntry[] = [];
  readonly exportedRevisions: ExportedRevision[] = [];
  readonly #policy: PolicyDecider;
  readonly #counters = new Map<string, number>();
  readonly #local = new Map<string, string>();
  readonly #staff = new Map<string, string>();

  constructor(caller: Caller, policy: PolicyDecider, exportHex: string, subjectHex: string) {
    if (!/^[0-9a-f]{32}$/.test(exportHex) || !/^[0-9a-f]{32}$/.test(subjectHex)) throw new Error("randomHex must return 32 lowercase hex digits");
    this.caller = caller;
    this.#policy = policy;
    this.exportId = exportHex as ExportId;
    this.subject = `learner-${subjectHex.slice(0, 16)}` as SubjectRef;
    this.map(this.subject, caller.principal.principalId);
  }

  /** The rule that allows the caller `action` on `target`, or undefined if it is not allowed. */
  async allows(action: Action, target: Target): Promise<string | undefined> {
    const request: AuthorizationRequest = {
      subject: this.caller.principal,
      action,
      resource: target.resource,
      context: { channel: this.caller.channel, ...(target.termState === undefined ? {} : { termState: target.termState }) },
    };
    const { decision, ruleId } = await this.#policy.decide(request, { correlationId: this.exportId });
    return decision.effect === "allow" ? ruleId : undefined;
  }

  /** Assigns the next local ID with `prefix` to `internalId`. */
  assign(prefix: string, internalId: string): string {
    const next = (this.#counters.get(prefix) ?? 0) + 1;
    this.#counters.set(prefix, next);
    const local = `${prefix}${next}`;
    this.map(local, internalId);
    return local;
  }

  /** Records that `local` stands for `internalId`. */
  map(local: string, internalId: string): void {
    this.mapping.push({ localId: local, internalId });
    this.#local.set(internalId, local);
  }

  /** The local ID already assigned to `internalId`, if any. */
  localOf(internalId: string): string | undefined {
    return this.#local.get(internalId);
  }

  /** The learner's subject reference, or a staff pseudonym for anyone else. */
  person(principalId: PrincipalId): string {
    if (principalId === this.caller.principal.principalId) return this.subject;
    let pseudonym = this.#staff.get(principalId);
    if (pseudonym === undefined) {
      pseudonym = `staff-${this.#staff.size + 1}`;
      this.#staff.set(principalId, pseudonym);
      this.map(pseudonym, principalId);
    }
    return pseudonym;
  }
}

function offeringFacts(snapshot: DistrictDirectorySnapshot, offeringId: OfferingId): OfferingFacts | undefined {
  const offering = snapshot.offerings.find((o) => o.id === offeringId);
  const term = snapshot.terms.find((t) => t.id === offering?.termId);
  const course = snapshot.courses.find((c) => c.id === offering?.courseId);
  if (offering === undefined || term === undefined || course === undefined) return undefined;
  return {
    scope: { level: "offering", districtId: offering.districtId, schoolId: offering.schoolId, offeringId: offering.id },
    termState: term.state,
    context: { kind: "course", course: course.title, section: offering.sectionName, term: term.name },
  };
}

async function resourceRecord(local: string, resource: ResourceSourceRecord, bytes: Uint8Array<ArrayBuffer> | undefined): Promise<ResourceRecord> {
  const record: ResourceRecord = {
    id: local,
    title: resource.title,
    ...(resource.url === undefined ? {} : { reference: { url: sanitizedUrl(resource.url) } }),
  };
  if (bytes === undefined || resource.contentMediaType === undefined) return record;
  return {
    ...record,
    content: {
      path: `resources/${local}/content.${extensionFor(resource.contentMediaType)}`,
      mediaType: resource.contentMediaType,
      digest: await sha256Digest(bytes),
      sizeBytes: bytes.byteLength,
    },
  };
}

/** An `https` URL without credentials, query or fragment, where share tokens and signatures live. */
export function sanitizedUrl(raw: string): string {
  const url = new URL(raw);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.href;
}

function isTextual(mediaType: string): boolean {
  return mediaType.startsWith("text/") || mediaType === JSON_MEDIA_TYPE;
}

function secretsIn(texts: readonly string[]): string[] {
  return [...new Set(texts.flatMap((text) => findSecretShapes(text)))];
}

function byTimeThenId(aTime: string, aId: string, bTime: string, bId: string): number {
  if (aTime !== bTime) return aTime < bTime ? -1 : 1;
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}
