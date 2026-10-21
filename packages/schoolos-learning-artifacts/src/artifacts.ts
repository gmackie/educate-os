import { z } from "zod";
import {
  ArtifactType,
  ContentDigest,
  ID_PREFIXES,
  PrincipalId,
  SchoolOsError,
  type Action,
  type ArtifactId,
  type AuthorizationRequest,
  type Caller,
  type DistrictDirectorySnapshot,
  type ResourceRef,
  type RevisionId,
  type TermState,
  WorkspaceId,
} from "@schoolos/contracts";
import type { AcademicStore } from "@schoolos/academics";
import type { PolicyDecider } from "@schoolos/policy";
import type { Workspace, WorkspaceState, WorkspaceStore } from "@schoolos/workspaces";
import { chooseBackend, isTextMediaType, type ArtifactStore } from "./content.ts";
import { canonicalTextBytes, sha256Digest } from "./digest.ts";
import {
  AiAssistance,
  EXTERNAL_REFERENCE_MEDIA_TYPE,
  MediaType,
  PinConsumer,
  type Artifact,
  type ArtifactRevision,
  type ArtifactState,
  type ContentRef,
  type Pin,
  type ProvenanceRecord,
  type ShareGrant,
} from "./model.ts";
import type { ArtifactRecordStore } from "./store.ts";

/**
 * New content for a revision:
 * - `text`: a `text/*` document, canonicalized before it is hashed (see `canonicalTextBytes`).
 * - `bytes`: any other media type, stored exactly as given.
 * - `external`: an `https` link to an approved host, with the digest of a snapshot if one was taken.
 */
export const RevisionContentInput = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("text"),
    mediaType: MediaType.refine((m) => m.startsWith("text/"), "text content needs a text/* media type"),
    text: z.string(),
  }),
  z.strictObject({
    kind: z.literal("bytes"),
    mediaType: MediaType.refine((m) => !m.startsWith("text/"), "send text/* content as text"),
    bytes: z.instanceof(Uint8Array),
  }),
  z.strictObject({
    kind: z.literal("external"),
    url: z.url({ protocol: /^https$/ }).max(2048),
    snapshotDigest: ContentDigest.optional(),
  }),
]);
/** New revision content. */
export type RevisionContentInput = z.infer<typeof RevisionContentInput>;

/** What creating an artifact takes. Its owner, classification and scope come from the workspace. */
export const NewArtifact = z.strictObject({
  workspaceId: WorkspaceId,
  type: ArtifactType,
  title: z.string().trim().min(1).max(200),
  content: RevisionContentInput,
  aiAssistance: AiAssistance,
});
/** A new artifact. */
export type NewArtifact = z.infer<typeof NewArtifact>;

/** What saving a revision takes. */
export const NewRevision = z.strictObject({
  content: RevisionContentInput,
  aiAssistance: AiAssistance,
});
/** A new revision. */
export type NewRevision = z.infer<typeof NewRevision>;

/** An artifact with its latest revision. */
export interface ArtifactView {
  artifact: Artifact;
  head: ArtifactRevision;
}

/** One revision's content as a caller receives it. An external reference is returned, never fetched. */
export type RevisionContent =
  | { kind: "text"; text: string }
  | { kind: "bytes"; bytes: Uint8Array<ArrayBuffer> }
  | { kind: "external"; url: string; snapshotDigest?: ContentDigest };

/**
 * What an export records about where its bytes came from, built only from stored records: the
 * artifact, the exported revision, and the revisions it was saved on top of, oldest first.
 */
export interface ProvenanceManifest {
  format: "schoolos.artifact-export.v1";
  exportedAt: string;
  exportedBy: PrincipalId;
  artifact: Artifact;
  revision: ArtifactRevision;
  /** The exported revision's stored ancestors, oldest first. */
  lineage: ArtifactRevision[];
}

/** An exported revision: its bytes, absent for an external reference, and its provenance manifest. */
export interface ArtifactExport {
  bytes?: Uint8Array<ArrayBuffer>;
  manifest: ProvenanceManifest;
}

/**
 * The check `@schoolos/workspaces`' `promoteArtifact` defers to this package: the artifact exists
 * in `fromWorkspaceId`, has not been deleted, and belongs to the caller. It resolves, or rejects
 * with `not-found`.
 */
export type PromotionCheck = (caller: Caller, fromWorkspaceId: WorkspaceId, artifactId: ArtifactId) => Promise<void>;

/** What a {@link LearningArtifacts} service is built from. */
export interface LearningArtifactsOptions {
  /** Where the district's artifact records are kept. */
  records: ArtifactRecordStore;
  /** Where revision content is kept. */
  content: ArtifactStore;
  /** The district's workspace directory, read for each artifact's workspace. Never written. */
  workspaces: WorkspaceStore;
  /** The district's academic directory, read for terms and principals. Never written. */
  directory: AcademicStore;
  /** Decides and audits every access. */
  policy: PolicyDecider;
  /** Hosts whose `https` links may be saved as external references: the district's approved Docs, Drive or LMS. */
  approvedExternalHosts: readonly string[];
  /** The clock. Defaults to the system clock. */
  now?: () => Date;
}

/** A resource to authorize against, with the state of the term it belongs to, if any. */
interface Target {
  resource: ResourceRef;
  termState?: TermState;
}

/** Everything one call reads. */
interface Loaded {
  state: ArtifactState;
  workspaces: WorkspaceState;
  snapshot: DistrictDirectorySnapshot;
}

/** One attempt at a change: the state to commit, if anything changed, and the result to return. */
interface Mutation<T> {
  next?: ArtifactState;
  result: T;
}

/** Content ready to store: its canonical bytes (or reference descriptor) and digest. */
interface PreparedContent {
  bytes: Uint8Array<ArrayBuffer>;
  digest: ContentDigest;
  mediaType: MediaType;
  origin: ProvenanceRecord["origin"];
  external?: { url: string; snapshotDigest?: ContentDigest };
}

/** Commit attempts before a write gives up on concurrent changes and reports the conflict. */
const COMMIT_ATTEMPTS = 3;

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

function notFound(kind: string, id: string): SchoolOsError {
  return new SchoolOsError("not-found", `${kind} ${id} was not found.`);
}

/**
 * The SchoolOS learning artifact service (roadmap W02): Save, History, Share, Export and pinning
 * for the artifacts in a district's workspaces. Students never see Git or storage keys.
 *
 * - Every revision is immutable and content-addressed: its digest is SHA-256 over canonical bytes,
 *   and every read checks the stored bytes against it.
 * - Every operation is decided by the policy engine from a `ResourceRef` built only from stored
 *   records: the artifact's owner, its workspace's classification and scope, and the term's state.
 *   A teacher therefore reads course artifacts in their offering and never a `personal-private`
 *   one, and a student never reads another student's work. Reads the caller may not make answer
 *   `not-found`.
 * - A pinned revision is never collected, even after its artifact is deleted.
 */
export class LearningArtifacts {
  readonly #records: ArtifactRecordStore;
  readonly #content: ArtifactStore;
  readonly #workspaces: WorkspaceStore;
  readonly #directory: AcademicStore;
  readonly #policy: PolicyDecider;
  readonly #approvedHosts: ReadonlySet<string>;
  readonly #now: () => Date;

  constructor(options: LearningArtifactsOptions) {
    this.#records = options.records;
    this.#content = options.content;
    this.#workspaces = options.workspaces;
    this.#directory = options.directory;
    this.#policy = options.policy;
    this.#approvedHosts = new Set(options.approvedExternalHosts.map((h) => h.toLowerCase()));
    this.#now = options.now ?? (() => new Date());
  }

  // Save

  /**
   * Creates an artifact in one of the caller's own workspaces, with its first revision. It is
   * `personal-private` in a personal workspace and `course` in a course workspace.
   */
  async createArtifact(caller: Caller, rawInput: NewArtifact): Promise<ArtifactView> {
    const input = parse(NewArtifact, rawInput);
    const prepared = await this.#prepare(input.type, input.content);
    const decisions = this.#decisions(caller);
    return this.#mutate(async ({ state, workspaces, snapshot }) => {
      const workspace = workspaces.workspaces.find((w) => w.id === input.workspaceId);
      if (workspace === undefined || workspace.ownerPrincipalId !== caller.principal.principalId) {
        throw notFound("workspace", input.workspaceId);
      }
      const artifact: Artifact = {
        id: `${ID_PREFIXES.artifact}_${crypto.randomUUID()}` as ArtifactId,
        districtId: workspace.districtId,
        workspaceId: workspace.id,
        ownerPrincipalId: workspace.ownerPrincipalId,
        type: input.type,
        title: input.title,
        classification: workspace.kind === "personal" ? "personal-private" : "course",
        scope: workspace.kind === "personal"
          ? { level: "district", districtId: workspace.districtId }
          : { level: "offering", districtId: workspace.districtId, schoolId: workspace.schoolId, offeringId: workspace.offeringId },
        createdAt: this.#now().toISOString(),
      };
      if (!(await decisions.allows("create", creationOf(artifactTarget(artifact, termStateOf(workspace, snapshot)))))) {
        throw new SchoolOsError("forbidden", "You may not add work to this workspace.");
      }
      const revision = await this.#revision(caller, artifact, prepared, input.aiAssistance, undefined);
      const next = { ...state, artifacts: [...state.artifacts, artifact], revisions: [...state.revisions, revision] };
      return { next, result: { artifact, head: revision } };
    });
  }

  /** Saves a new revision on top of the artifact's latest one. Earlier revisions are never changed. */
  async saveRevision(caller: Caller, artifactId: ArtifactId, rawInput: NewRevision): Promise<ArtifactView> {
    const input = parse(NewRevision, rawInput);
    const decisions = this.#decisions(caller);
    return this.#mutate(async (loaded) => {
      const artifact = await this.#readable(decisions, loaded, artifactId);
      const prepared = await this.#prepare(artifact.type, input.content);
      if (!(await decisions.allows("update", this.#target(artifact, loaded)))) {
        throw new SchoolOsError("forbidden", "This work can no longer be changed.");
      }
      const parent = headOf(loaded.state, artifact.id);
      const revision = await this.#revision(caller, artifact, prepared, input.aiAssistance, parent);
      return { next: { ...loaded.state, revisions: [...loaded.state.revisions, revision] }, result: { artifact, head: revision } };
    });
  }

  // View and History

  /** An artifact and its latest revision, if the caller may read it. */
  async getArtifact(caller: Caller, artifactId: ArtifactId): Promise<ArtifactView> {
    const loaded = await this.#load();
    const artifact = await this.#readable(this.#decisions(caller), loaded, artifactId);
    return { artifact, head: headOf(loaded.state, artifact.id) };
  }

  /**
   * The artifacts in a workspace that the caller may read: an owner sees all of theirs, a teacher
   * sees the course artifacts of their offering's students and nothing in a personal workspace.
   */
  async listArtifacts(caller: Caller, workspaceId: WorkspaceId): Promise<ArtifactView[]> {
    const loaded = await this.#load();
    const decisions = this.#decisions(caller);
    const workspace = loaded.workspaces.workspaces.find((w) => w.id === workspaceId);
    if (workspace === undefined) throw notFound("workspace", workspaceId);
    const collection = workspaceCollection(workspace, loaded.snapshot);
    if (!(await decisions.allows("list", collection))) throw notFound("workspace", workspaceId);
    const views: ArtifactView[] = [];
    for (const artifact of loaded.state.artifacts) {
      if (artifact.workspaceId !== workspaceId || artifact.deletedAt !== undefined) continue;
      if (await decisions.allows("read", this.#target(artifact, loaded))) views.push({ artifact, head: headOf(loaded.state, artifact.id) });
    }
    return views;
  }

  /** The artifact's revisions, newest first. */
  async history(caller: Caller, artifactId: ArtifactId): Promise<ArtifactRevision[]> {
    const loaded = await this.#load();
    const artifact = await this.#readable(this.#decisions(caller), loaded, artifactId);
    return revisionsOf(loaded.state, artifact.id).toReversed();
  }

  /**
   * One revision and its verified content, the latest if `revisionId` is omitted. A pinned revision
   * of a deleted artifact stays readable to whoever may read the artifact.
   */
  async readRevision(
    caller: Caller,
    artifactId: ArtifactId,
    revisionId?: RevisionId,
  ): Promise<{ revision: ArtifactRevision; content: RevisionContent }> {
    const loaded = await this.#load();
    const artifact = await this.#readable(this.#decisions(caller), loaded, artifactId, { includeDeleted: true });
    const revision = revisionId === undefined
      ? (artifact.deletedAt === undefined ? headOf(loaded.state, artifact.id) : undefined)
      : loaded.state.revisions.find((r) => r.id === revisionId && r.artifactId === artifact.id);
    if (revision === undefined) throw notFound("revision", revisionId ?? artifactId);
    return { revision, content: await this.#contentOf(revision) };
  }

  // Pin

  /**
   * Pins a revision for a consumer, so it is never collected. A submission pin is authorized as
   * submitting the artifact; keeping a version is authorized as changing it. Idempotent.
   */
  async pin(caller: Caller, artifactId: ArtifactId, revisionId: RevisionId, rawConsumer: PinConsumer): Promise<Pin> {
    const consumer = parse(PinConsumer, rawConsumer);
    const decisions = this.#decisions(caller);
    return this.#mutate(async (loaded) => {
      const artifact = await this.#readable(decisions, loaded, artifactId);
      const revision = loaded.state.revisions.find((r) => r.id === revisionId && r.artifactId === artifact.id);
      if (revision === undefined) throw notFound("revision", revisionId);
      const action: Action = consumer.kind === "submission" ? "submit" : "update";
      if (!(await decisions.allows(action, this.#target(artifact, loaded)))) {
        throw new SchoolOsError("forbidden", "You may not pin this work.");
      }
      const me = caller.principal.principalId;
      const existing = loaded.state.pins.find((p) => p.revisionId === revision.id && samePinHolder(p, consumer, me));
      if (existing !== undefined) return { result: existing };
      const pin: Pin = { artifactId: artifact.id, revisionId: revision.id, consumer, pinnedBy: me, pinnedAt: this.#now().toISOString() };
      return { next: { ...loaded.state, pins: [...loaded.state.pins, pin] }, result: pin };
    });
  }

  /**
   * Releases the caller's own `keep` pin on a revision. Submission pins belong to their submission
   * and are released only by it. If the artifact was deleted and nothing else pins the revision, it
   * is then collected.
   */
  async unpin(caller: Caller, artifactId: ArtifactId, revisionId: RevisionId): Promise<void> {
    const decisions = this.#decisions(caller);
    const me = caller.principal.principalId;
    await this.#mutate(async (loaded) => {
      const artifact = await this.#readable(decisions, loaded, artifactId, { includeDeleted: true });
      const mine = (p: Pin) => p.revisionId === revisionId && p.artifactId === artifact.id && samePinHolder(p, { kind: "keep" }, me);
      if (!loaded.state.pins.some(mine)) throw notFound("pin", revisionId);
      if (!(await decisions.allows("update", this.#target(artifact, loaded)))) {
        throw new SchoolOsError("forbidden", "You may not change this work.");
      }
      return { next: { ...loaded.state, pins: loaded.state.pins.filter((p) => !mine(p)) }, result: undefined };
    });
    // Collection is a second commit, since a store refuses to drop a revision in the same change
    // that releases its pin.
    await this.#mutate(async ({ state }) => {
      const next = collect(state, artifactId);
      return next === state ? { result: undefined } : { next, result: undefined };
    });
  }

  // Share

  /**
   * Records that the artifact's owner shared it with another principal of the district. The record
   * grants nothing by itself: reads stay decided by policy, through `artifactShareRelationships`
   * (see `ShareGrant`). Idempotent.
   */
  async share(caller: Caller, artifactId: ArtifactId, rawGrantee: PrincipalId): Promise<ShareGrant> {
    const grantee = parse(PrincipalId, rawGrantee);
    const decisions = this.#decisions(caller);
    return this.#mutate(async (loaded) => {
      const artifact = await this.#readable(decisions, loaded, artifactId);
      if (!(await decisions.allows("share", this.#target(artifact, loaded)))) {
        throw new SchoolOsError("forbidden", "This work cannot be shared.");
      }
      const principal = loaded.snapshot.principals.find((p) => p.id === grantee && p.districtId === artifact.districtId);
      if (principal === undefined || principal.kind === "service") throw notFound("principal", grantee);
      if (principal.id === artifact.ownerPrincipalId) {
        throw new SchoolOsError("validation-failed", "An artifact cannot be shared with its owner.");
      }
      const existing = loaded.state.shares.find((s) => s.artifactId === artifact.id && s.granteePrincipalId === grantee);
      if (existing !== undefined) return { result: existing };
      const grant: ShareGrant = {
        artifactId: artifact.id,
        granteePrincipalId: grantee,
        grantedBy: caller.principal.principalId,
        grantedAt: this.#now().toISOString(),
      };
      return { next: { ...loaded.state, shares: [...loaded.state.shares, grant] }, result: grant };
    });
  }

  // Export

  /** A revision's bytes, the latest if `revisionId` is omitted, with its provenance manifest. */
  async exportArtifact(caller: Caller, artifactId: ArtifactId, revisionId?: RevisionId): Promise<ArtifactExport> {
    const loaded = await this.#load();
    const decisions = this.#decisions(caller);
    const artifact = await this.#readable(decisions, loaded, artifactId);
    const revision = revisionId === undefined
      ? headOf(loaded.state, artifact.id)
      : loaded.state.revisions.find((r) => r.id === revisionId && r.artifactId === artifact.id);
    if (revision === undefined) throw notFound("revision", revisionId ?? artifactId);
    if (!(await decisions.allows("export", this.#target(artifact, loaded)))) {
      throw new SchoolOsError("forbidden", "This work cannot be exported.");
    }
    const manifest: ProvenanceManifest = {
      format: "schoolos.artifact-export.v1",
      exportedAt: this.#now().toISOString(),
      exportedBy: caller.principal.principalId,
      artifact,
      revision,
      lineage: lineageOf(loaded.state, revision),
    };
    if (revision.content.backend === "external") return { manifest };
    return { bytes: await this.#content.read(revision.content), manifest };
  }

  // Delete

  /**
   * Deletes an artifact the caller may delete. Its unpinned revisions are collected at once; pinned
   * ones are kept, and stay readable, until their last pin is released.
   */
  async deleteArtifact(caller: Caller, artifactId: ArtifactId): Promise<{ keptRevisions: number }> {
    const decisions = this.#decisions(caller);
    return this.#mutate(async (loaded) => {
      const artifact = await this.#readable(decisions, loaded, artifactId);
      if (!(await decisions.allows("delete", this.#target(artifact, loaded)))) {
        throw new SchoolOsError("forbidden", "This work cannot be deleted.");
      }
      const deleted: Artifact = { ...artifact, deletedAt: this.#now().toISOString() };
      const marked: ArtifactState = {
        ...loaded.state,
        artifacts: loaded.state.artifacts.map((a) => (a.id === artifact.id ? deleted : a)),
        shares: loaded.state.shares.filter((s) => s.artifactId !== artifact.id),
      };
      const next = collect(marked, artifact.id);
      return { next, result: { keptRevisions: revisionsOf(next, artifact.id).length } };
    });
  }

  // Baselines and promotion

  /**
   * Publishes a sanitized baseline from one of the caller's own revisions: a new artifact in the
   * same workspace whose single revision has that revision's content and no parent. Nothing from
   * the source's earlier or later revisions, such as an answer key removed before publishing, is
   * reachable from the baseline (roadmap §14).
   */
  async publishBaseline(caller: Caller, artifactId: ArtifactId, revisionId: RevisionId, rawTitle: string): Promise<ArtifactView> {
    const title = parse(z.string().trim().min(1).max(200), rawTitle);
    const decisions = this.#decisions(caller);
    return this.#mutate(async (loaded) => {
      const source = await this.#readable(decisions, loaded, artifactId);
      const chosen = loaded.state.revisions.find((r) => r.id === revisionId && r.artifactId === source.id);
      if (chosen === undefined) throw notFound("revision", revisionId);
      if (source.ownerPrincipalId !== caller.principal.principalId) {
        throw new SchoolOsError("forbidden", "Only the owner of this work can publish a baseline from it.");
      }
      if (!(await decisions.allows("export", this.#target(source, loaded)))) {
        throw new SchoolOsError("forbidden", "This work cannot be published.");
      }
      const baseline: Artifact = {
        ...source,
        id: `${ID_PREFIXES.artifact}_${crypto.randomUUID()}` as ArtifactId,
        title,
        createdAt: this.#now().toISOString(),
      };
      if (!(await decisions.allows("create", creationOf(this.#target(baseline, loaded))))) {
        throw new SchoolOsError("forbidden", "You may not add work to this workspace.");
      }
      const revision: ArtifactRevision = {
        id: newRevisionId(),
        artifactId: baseline.id,
        number: 1,
        content: chosen.content,
        sizeBytes: chosen.sizeBytes,
        mediaType: chosen.mediaType,
        authorPrincipalId: caller.principal.principalId,
        createdAt: baseline.createdAt,
        aiAssistance: chosen.aiAssistance,
        provenance: { origin: "baseline", channel: caller.channel },
      };
      const next = { ...loaded.state, artifacts: [...loaded.state.artifacts, baseline], revisions: [...loaded.state.revisions, revision] };
      return { next, result: { artifact: baseline, head: revision } };
    });
  }

  /**
   * The ownership check `@schoolos/workspaces`' `promoteArtifact` needs (see {@link PromotionCheck}).
   * Bound, so it can be handed over as a function.
   */
  readonly confirmPromotable: PromotionCheck = async (caller, fromWorkspaceId, artifactId) => {
    const loaded = await this.#load();
    const artifact = await this.#readable(this.#decisions(caller), loaded, artifactId);
    if (artifact.workspaceId !== fromWorkspaceId || artifact.ownerPrincipalId !== caller.principal.principalId) {
      throw notFound("artifact", artifactId);
    }
  };

  // Internals

  #decisions(caller: Caller): Decisions {
    return new Decisions(caller, this.#policy, caller.correlationId ?? crypto.randomUUID());
  }

  /** The artifact, if it exists (and is not deleted, unless asked) and the caller may read it; else `not-found`. */
  async #readable(decisions: Decisions, loaded: Loaded, artifactId: ArtifactId, options: { includeDeleted?: boolean } = {}): Promise<Artifact> {
    const artifact = loaded.state.artifacts.find((a) => a.id === artifactId);
    if (artifact === undefined || (artifact.deletedAt !== undefined && options.includeDeleted !== true)) {
      throw notFound("artifact", artifactId);
    }
    if (!(await decisions.allows("read", this.#target(artifact, loaded)))) throw notFound("artifact", artifactId);
    return artifact;
  }

  #target(artifact: Artifact, loaded: Loaded): Target {
    const workspace = loaded.workspaces.workspaces.find((w) => w.id === artifact.workspaceId);
    if (workspace === undefined) throw new Error(`artifact ${artifact.id} has no workspace ${artifact.workspaceId}`);
    return artifactTarget(artifact, termStateOf(workspace, loaded.snapshot));
  }

  /** Canonical bytes and digest for new content, checking it suits the artifact's type. */
  async #prepare(type: ArtifactType, content: RevisionContentInput): Promise<PreparedContent> {
    if ((type === "external-ref") !== (content.kind === "external")) {
      throw new SchoolOsError("validation-failed", "An external-ref artifact holds a link, and only it does.");
    }
    if (content.kind === "external") {
      const url = new URL(content.url);
      if (url.username !== "" || url.password !== "" || !this.#approvedHosts.has(url.hostname.toLowerCase())) {
        throw new SchoolOsError("validation-failed", "Links can only point to the district's approved document services.");
      }
      const external = { url: url.href, ...(content.snapshotDigest === undefined ? {} : { snapshotDigest: content.snapshotDigest }) };
      const bytes = externalDescriptor(external);
      return { bytes, digest: await sha256Digest(bytes), mediaType: EXTERNAL_REFERENCE_MEDIA_TYPE, origin: "external-reference", external };
    }
    const bytes = content.kind === "text" ? canonicalTextBytes(content.text) : new Uint8Array(content.bytes);
    return {
      bytes,
      digest: await sha256Digest(bytes),
      mediaType: content.mediaType,
      origin: content.kind === "text" ? "authored" : "uploaded",
    };
  }

  /** Stores prepared content and builds the revision that points at it. */
  async #revision(
    caller: Caller,
    artifact: Artifact,
    prepared: PreparedContent,
    aiAssistance: AiAssistance,
    parent: ArtifactRevision | undefined,
  ): Promise<ArtifactRevision> {
    let content: ContentRef;
    if (prepared.external !== undefined) {
      content = { backend: "external", key: prepared.external.url, digest: prepared.digest, ...(prepared.external.snapshotDigest === undefined ? {} : { snapshotDigest: prepared.external.snapshotDigest }) };
    } else {
      const backend = chooseBackend({ type: artifact.type, mediaType: prepared.mediaType, sizeBytes: prepared.bytes.byteLength });
      if (backend === "external") throw new Error("held content cannot use the external backend");
      content = await this.#content.write(backend, prepared.bytes, prepared.digest);
    }
    return {
      id: newRevisionId(),
      artifactId: artifact.id,
      number: (parent?.number ?? 0) + 1,
      ...(parent === undefined ? {} : { parentRevisionId: parent.id }),
      content,
      sizeBytes: prepared.bytes.byteLength,
      mediaType: prepared.mediaType,
      authorPrincipalId: caller.principal.principalId,
      createdAt: this.#now().toISOString(),
      aiAssistance,
      provenance: { origin: prepared.origin, channel: caller.channel },
    };
  }

  async #contentOf(revision: ArtifactRevision): Promise<RevisionContent> {
    const ref = revision.content;
    if (ref.backend === "external") {
      return { kind: "external", url: ref.key, ...(ref.snapshotDigest === undefined ? {} : { snapshotDigest: ref.snapshotDigest }) };
    }
    const bytes = await this.#content.read(ref);
    return isTextMediaType(revision.mediaType) ? { kind: "text", text: decoder.decode(bytes) } : { kind: "bytes", bytes };
  }

  async #load(): Promise<Loaded> {
    const [{ state }, { state: workspaces }, { snapshot }] = await Promise.all([
      this.#records.load(),
      this.#workspaces.load(),
      this.#directory.load(),
    ]);
    return { state, workspaces, snapshot };
  }

  /** Runs `change` against fresh state and commits what it returns, retrying when a concurrent write wins. */
  async #mutate<T>(change: (loaded: Loaded) => Promise<Mutation<T>>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const [{ state, version }, { state: workspaces }, { snapshot }] = await Promise.all([
        this.#records.load(),
        this.#workspaces.load(),
        this.#directory.load(),
      ]);
      const { next, result } = await change({ state, workspaces, snapshot });
      if (next === undefined) return result;
      try {
        await this.#records.commit(next, version);
        return result;
      } catch (error) {
        if (!(error instanceof SchoolOsError && error.code === "conflict") || attempt >= COMMIT_ATTEMPTS) throw error;
      }
    }
  }
}

/** One caller's policy decisions within one call, audited under one correlation ID. */
class Decisions {
  readonly #caller: Caller;
  readonly #policy: PolicyDecider;
  readonly #correlationId: string;

  constructor(caller: Caller, policy: PolicyDecider, correlationId: string) {
    this.#caller = caller;
    this.#policy = policy;
    this.#correlationId = correlationId;
  }

  async allows(action: Action, target: Target): Promise<boolean> {
    const request: AuthorizationRequest = {
      subject: this.#caller.principal,
      action,
      resource: target.resource,
      context: { channel: this.#caller.channel, ...(target.termState === undefined ? {} : { termState: target.termState }) },
    };
    const { decision } = await this.#policy.decide(request, { correlationId: this.#correlationId });
    return decision.effect === "allow";
  }
}

/** Parses caller input, answering `validation-failed` rather than a raw Zod error. */
function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new SchoolOsError("validation-failed", z.prettifyError(parsed.error).slice(0, 1000));
  return parsed.data;
}

function newRevisionId(): RevisionId {
  return `rev_${crypto.randomUUID()}` as RevisionId;
}

/** An artifact as policy sees it: an owned artifact with its workspace's classification and scope. */
function artifactTarget(artifact: Artifact, termState: TermState | undefined): Target {
  return {
    resource: {
      kind: "artifact",
      id: artifact.id,
      scope: artifact.scope,
      classification: artifact.classification,
      ownerPrincipalId: artifact.ownerPrincipalId,
    },
    ...(termState === undefined ? {} : { termState }),
  };
}

/** The request to create `target`: the same resource, before it has an ID. */
function creationOf(target: Target): Target {
  const { id: _unassigned, ...resource } = target.resource;
  return { ...target, resource };
}

/** The artifacts of a workspace as a collection to list: what each of its artifacts would be. */
function workspaceCollection(workspace: Workspace, snapshot: DistrictDirectorySnapshot): Target {
  return {
    resource: {
      kind: "artifact",
      scope: workspace.kind === "personal"
        ? { level: "district", districtId: workspace.districtId }
        : { level: "offering", districtId: workspace.districtId, schoolId: workspace.schoolId, offeringId: workspace.offeringId },
      classification: workspace.kind === "personal" ? "personal-private" : "course",
      ownerPrincipalId: workspace.ownerPrincipalId,
    },
    ...termOf(workspace, snapshot),
  };
}

function termStateOf(workspace: Workspace, snapshot: DistrictDirectorySnapshot): TermState | undefined {
  if (workspace.kind === "personal") return undefined;
  const term = snapshot.terms.find((t) => t.id === workspace.termId);
  if (term === undefined) throw new Error(`term ${workspace.termId} is missing from the directory`);
  return term.state;
}

function termOf(workspace: Workspace, snapshot: DistrictDirectorySnapshot): { termState?: TermState } {
  const termState = termStateOf(workspace, snapshot);
  return termState === undefined ? {} : { termState };
}

function revisionsOf(state: ArtifactState, artifactId: ArtifactId): ArtifactRevision[] {
  return state.revisions.filter((r) => r.artifactId === artifactId).toSorted((a, b) => a.number - b.number);
}

function headOf(state: ArtifactState, artifactId: ArtifactId): ArtifactRevision {
  const head = revisionsOf(state, artifactId).at(-1);
  if (head === undefined) throw new Error(`artifact ${artifactId} has no revisions`);
  return head;
}

/** The stored ancestors of `revision`, oldest first. A collected ancestor ends the chain. */
function lineageOf(state: ArtifactState, revision: ArtifactRevision): ArtifactRevision[] {
  const lineage: ArtifactRevision[] = [];
  let parentId = revision.parentRevisionId;
  while (parentId !== undefined) {
    const parent = state.revisions.find((r) => r.id === parentId);
    if (parent === undefined) break;
    lineage.unshift(parent);
    parentId = parent.parentRevisionId;
  }
  return lineage;
}

function samePinHolder(pin: Pin, consumer: PinConsumer, pinnedBy: PrincipalId): boolean {
  if (consumer.kind === "submission") return pin.consumer.kind === "submission" && pin.consumer.submissionId === consumer.submissionId;
  return pin.consumer.kind === "keep" && pin.pinnedBy === pinnedBy;
}

/**
 * Drops a deleted artifact's unpinned revisions, and the artifact itself once none is left.
 * Returns `state` unchanged when there is nothing to collect.
 */
function collect(state: ArtifactState, artifactId: ArtifactId): ArtifactState {
  const artifact = state.artifacts.find((a) => a.id === artifactId);
  if (artifact?.deletedAt === undefined) return state;
  const pinned = new Set(state.pins.map((p) => p.revisionId));
  const doomed = new Set(state.revisions.filter((r) => r.artifactId === artifactId && !pinned.has(r.id)).map((r) => r.id));
  const remaining = state.revisions.filter((r) => r.artifactId === artifactId).length - doomed.size;
  if (doomed.size === 0 && remaining > 0) return state;
  return {
    ...state,
    artifacts: remaining > 0 ? state.artifacts : state.artifacts.filter((a) => a.id !== artifactId),
    revisions: state.revisions.filter((r) => !doomed.has(r.id)),
  };
}

/**
 * The canonical descriptor of an external reference, which its digest covers: JSON with keys in
 * sorted order and no whitespace, so the same reference always gives the same bytes.
 */
function externalDescriptor(external: { url: string; snapshotDigest?: ContentDigest }): Uint8Array<ArrayBuffer> {
  const sorted = external.snapshotDigest === undefined
    ? { url: external.url }
    : { snapshotDigest: external.snapshotDigest, url: external.url };
  return encoder.encode(JSON.stringify(sorted));
}
