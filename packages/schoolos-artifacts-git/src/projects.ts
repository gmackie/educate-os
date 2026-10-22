import { z } from "zod";
import type { GitOid } from "@gadgets/gatekeeper-kit/git-objects";
import { diffGitTrees, parseGitTreePayload, type GitDiffHunk, type TreeDiffSource } from "@gadgets/gatekeeper-kit/git-diff";
import {
  ArtifactId,
  RevisionId,
  SchoolOsError,
  WorkspaceId,
  type AuthorizationRequest,
  type Caller,
  type TermState,
} from "@schoolos/contracts";
import type { AcademicStore } from "@schoolos/academics";
import {
  AiAssistance,
  sha256Digest,
  type Artifact,
  type ArtifactRevision,
  type LearningArtifacts,
  type RevisionContentInput,
} from "@schoolos/learning-artifacts";
import type { PolicyDecider } from "@schoolos/policy";
import type { WorkspaceState, WorkspaceStore } from "@schoolos/workspaces";
import { ARTIFACTS_TOKEN_USERNAME, type GitAccess } from "./artifacts-api.ts";
import { ARTIFACTS_GIT_PROVIDER, ArtifactsGitBackend, type PushedVersion } from "./backend.ts";
import { CREDENTIAL_TTL_SECONDS, GitCredential } from "./credentials.ts";
import { globMatcher, TeacherOnlyRules } from "./globs.ts";
import { gitObject } from "./git-objects.ts";
import {
  buildTree,
  PROJECT_MANIFEST_MEDIA_TYPE,
  ProjectManifest,
  WorkingTree,
  type BuiltTree,
  type ProjectVersion,
} from "./model.ts";

/** The artifact types that hold a multi-file project: notebooks, code and datasets. */
export const ProjectArtifactType = z.enum(["notebook", "dataset", "interactive"]);
/** A project artifact type. */
export type ProjectArtifactType = z.infer<typeof ProjectArtifactType>;

/** A short description of a saved version, as Save asks for it. */
const SaveMessage = z.string().trim().min(1).max(500).transform((m) => m.normalize("NFC"));

/** What creating a project takes. */
export const NewProject = z.strictObject({
  workspaceId: WorkspaceId,
  type: ProjectArtifactType,
  title: z.string().trim().min(1).max(200),
  files: WorkingTree,
  message: SaveMessage,
  aiAssistance: AiAssistance,
});
/** A new project. */
export type NewProject = z.input<typeof NewProject>;

/** What saving a version of a project takes: the whole working tree, and what changed. */
export const SaveInput = z.strictObject({
  files: WorkingTree,
  message: SaveMessage,
  aiAssistance: AiAssistance,
});
/** A save. */
export type SaveInput = z.input<typeof SaveInput>;

/** A project and its latest version. */
export interface ProjectView {
  artifact: Artifact;
  latest: ProjectVersion;
}

/** One file of a saved version, with its content. */
export interface VersionFile {
  path: string;
  bytes: Uint8Array<ArrayBuffer>;
  teacherOnly: boolean;
}

/** How one file differs between two versions, line by line where it is text. */
export interface FileChange {
  path: string;
  change: "added" | "modified" | "removed";
  additions: number;
  deletions: number;
  /** True for binary and very large files, whose lines are not compared. */
  linesOmitted: boolean;
  hunks: GitDiffHunk[];
}

/** The differences between two versions of a project. */
export interface VersionDiff {
  from: RevisionId;
  to: RevisionId;
  files: FileChange[];
}

/** A version of a project to fork from. */
export const BaselineRef = z.strictObject({ artifactId: ArtifactId, revisionId: RevisionId });
/** A baseline reference. */
export type BaselineRef = z.infer<typeof BaselineRef>;

/** One teacher-only file found in a baseline's history. */
export interface BaselineFinding {
  path: string;
  /** The saved version holding it, when the history scan can tie it to one. */
  versionNumber?: number;
  /** Whether it is in the version chosen for the fork, not only in its history. */
  inChosenVersion: boolean;
  /** Why it is teacher-only: a pattern the assignment configured, or a mark made when it was saved. */
  reason: { kind: "pattern"; pattern: string } | { kind: "marked-teacher-only" };
}

/**
 * The result of checking a baseline before it is forked: clean only if no version reachable from
 * the chosen one holds a teacher-only file.
 */
export interface BaselineReport {
  clean: boolean;
  /** How many versions were checked. */
  versionsChecked: number;
  findings: BaselineFinding[];
}

/** A fork: made from a clean baseline, or refused with the report saying why. */
export type ForkResult = { status: "forked"; project: ProjectView } | { status: "blocked"; report: BaselineReport };

/** What {@link ProjectArtifacts.revokeEndedCourseAccess} did. */
export interface CourseAccessRevocation {
  /** Credentials revoked. */
  revoked: number;
  /** Workspaces some of whose credentials still could not be revoked. Run it again to finish them. */
  pending: WorkspaceId[];
}

/** Attempts per workspace before `revokeEndedCourseAccess` leaves it pending, and the pause between them. */
const REVOKE_ATTEMPTS = 3;
const REVOKE_RETRY_MS = 200;

/** What a {@link ProjectArtifacts} service is built from. */
export interface ProjectArtifactsOptions {
  /** The learning artifact service that records every version and decides every read. */
  artifacts: LearningArtifacts;
  /** The Artifacts backend, which reports itself unavailable where the plan has none. */
  git: ArtifactsGitBackend;
  /** The workspace directory, read to authorize a save before it is pushed. Never written. */
  workspaces: WorkspaceStore;
  /** The academic directory, read for term states. Never written. */
  directory: AcademicStore;
  /** Decides and audits the pre-push checks; learning-artifacts decides again when it records. */
  policy: PolicyDecider;
  /** The clock. Defaults to the system clock. */
  now?: () => Date;
}

/**
 * Projects (roadmap W03): multi-file artifacts with Save, History and Diff. Each version is a
 * learning-artifacts revision whose content is a {@link ProjectManifest}, so pinning, submission,
 * export and every policy decision work as for any artifact. With Artifacts on the plan the files
 * are a commit in the project's own repository, kept reachable by a protected version ref whose
 * commit also holds the manifest (registered `artifacts-git` content where learning-artifacts has
 * the provider); without it they are a bundle inside the manifest. No Git term appears here:
 * students save versions, see history and compare versions.
 */
export class ProjectArtifacts {
  readonly #artifacts: LearningArtifacts;
  readonly #git: ArtifactsGitBackend;
  readonly #workspaces: WorkspaceStore;
  readonly #directory: AcademicStore;
  readonly #policy: PolicyDecider;
  readonly #now: () => Date;

  constructor(options: ProjectArtifactsOptions) {
    this.#artifacts = options.artifacts;
    this.#git = options.git;
    this.#workspaces = options.workspaces;
    this.#directory = options.directory;
    this.#policy = options.policy;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Creates a project in one of the caller's own workspaces with its first version, in its own new
   * Artifacts repository when the plan has Artifacts. If the record cannot be saved, the
   * repository is deleted again.
   */
  async createProject(caller: Caller, rawInput: NewProject): Promise<ProjectView> {
    const input = parse(NewProject, rawInput);
    const built = await buildTree(input.files);
    if (this.#git.availability().status === "unavailable") {
      const manifest = bundleManifest(built, input.message);
      return this.#record(caller, input, manifest, manifestText(manifest));
    }
    const repository = await this.#git.createRepository();
    try {
      const { manifest, pushed } = await this.#pushVersion(caller, { repository, workspaceId: input.workspaceId, built, parent: undefined, message: input.message });
      return await this.#record(caller, input, manifest, await this.#versionContent(manifest, pushed));
    } catch (error) {
      await this.#git.deleteRepository(repository).catch(() => {});
      throw error;
    }
  }

  /**
   * Save (`checkpoint`): records the working tree as a new version on top of the latest one. The caller must be
   * allowed to change the project (its owner, while the term is open) before anything is written.
   */
  async checkpoint(caller: Caller, artifactId: ArtifactId, rawInput: SaveInput): Promise<ProjectVersion> {
    const input = parse(SaveInput, rawInput);
    const { artifact, head } = await this.#artifacts.getArtifact(caller, artifactId);
    const latest = await this.#manifestOf(caller, artifact.id, head);
    await this.#assertMayChange(caller, artifact);
    const built = await buildTree(input.files);
    let manifest: ProjectManifest;
    let content: RevisionContentInput;
    if (latest.storage.kind === "bundle") {
      manifest = bundleManifest(built, input.message);
      content = manifestText(manifest);
    } else {
      const repository = latest.storage.repository;
      const version = await this.#pushVersion(caller, { repository, workspaceId: artifact.workspaceId, built, parent: latest.storage.commit, message: input.message });
      manifest = version.manifest;
      content = await this.#versionContent(manifest, version.pushed);
    }
    const saved = await this.#artifacts.saveRevision(caller, artifact.id, { content, aiAssistance: input.aiAssistance });
    return versionOf(saved.head, manifest);
  }

  /** History: the project's versions, newest first. */
  async history(caller: Caller, artifactId: ArtifactId): Promise<ProjectVersion[]> {
    const revisions = await this.#artifacts.history(caller, artifactId);
    const versions: ProjectVersion[] = [];
    for (const revision of revisions) versions.push(versionOf(revision, await this.#manifestOf(caller, artifactId, revision)));
    return versions;
  }

  /** One version's files, the latest if `revisionId` is omitted, each verified against the version. */
  async readVersion(caller: Caller, artifactId: ArtifactId, revisionId?: RevisionId): Promise<{ version: ProjectVersion; files: VersionFile[] }> {
    const { revision, manifest } = await this.#readManifest(caller, artifactId, revisionId);
    return { version: versionOf(revision, manifest), files: await this.#filesOf(manifest) };
  }

  /** Diff: how two versions of the same project differ, file by file and line by line. */
  async diff(caller: Caller, artifactId: ArtifactId, fromRevisionId: RevisionId, toRevisionId: RevisionId): Promise<VersionDiff> {
    const from = await this.#readManifest(caller, artifactId, parse(RevisionId, fromRevisionId));
    const to = await this.#readManifest(caller, artifactId, parse(RevisionId, toRevisionId));
    const files = await this.#withSource([from.manifest, to.manifest], (source) => diffGitTrees(source, from.manifest.tree, to.manifest.tree));
    return {
      from: from.revision.id,
      to: to.revision.id,
      files: files.map((f) => ({
        path: f.path,
        change: f.status,
        additions: f.additions,
        deletions: f.deletions,
        linesOmitted: f.diffOmitted === true,
        hunks: f.hunks,
      })),
    };
  }

  /**
   * A short-lived Git credential for the caller's own Git client, scoped to this one project:
   * `write` for its owner while they may change it, `read` for anyone policy lets read it (a
   * teacher, for course work only). Credentials go only to a person's own HTTP session, never to an
   * agent or tool, and are never stored with the artifact.
   */
  async issueCredential(caller: Caller, artifactId: ArtifactId, rawAccess: GitAccess): Promise<GitCredential> {
    const access = parse(z.enum(["read", "write"]), rawAccess);
    if (caller.channel !== "http") throw new SchoolOsError("forbidden", "Project credentials are issued only to a person's own session.");
    const { artifact, head } = await this.#artifacts.getArtifact(caller, artifactId);
    const manifest = await this.#manifestOf(caller, artifact.id, head);
    if (manifest.storage.kind !== "artifacts-git") throw new SchoolOsError("unavailable", "This project is not kept in Git storage.");
    const isOwner = artifact.ownerPrincipalId === caller.principal.principalId;
    if (!isOwner && artifact.classification !== "course") throw notFound("artifact", artifact.id);
    if (access === "write") {
      if (!isOwner) throw new SchoolOsError("forbidden", "Only a project's owner can change it.");
      await this.#assertMayChange(caller, artifact);
    }
    const token = await this.#git.credentials.mint({
      repository: manifest.storage.repository,
      workspaceId: artifact.workspaceId,
      principalId: caller.principal.principalId,
      scope: access,
      holder: "principal",
      ttlSeconds: CREDENTIAL_TTL_SECONDS,
    });
    return new GitCredential({
      remote: await this.#git.remote(manifest.storage.repository),
      username: ARTIFACTS_TOKEN_USERNAME,
      scope: access,
      expiresAt: token.expiresAt,
      token: token.plaintext,
    });
  }

  /**
   * Revokes every credential minted for a workspace's projects. {@link revokeEndedCourseAccess}
   * calls it for every course workspace whose course access has ended.
   */
  async revokeAll(workspaceId: WorkspaceId): Promise<{ revoked: number }> {
    if (this.#git.availability().status === "unavailable") return { revoked: 0 };
    return this.#git.credentials.revokeAll(workspaceId);
  }

  /**
   * W01's grant revocation, applied to Git access: revokes every credential minted for a course
   * workspace whose course grants the workspace directory has revoked and not reissued, which is
   * what `closeTerm` does to a closed term's workspaces and `reconcileCourseGrants` to a dropped
   * student's. Run it right after either. A workspace whose revocation answers `unavailable` is
   * retried, then reported `pending`; running it again is safe and finishes the job.
   */
  async revokeEndedCourseAccess(): Promise<CourseAccessRevocation> {
    const result: CourseAccessRevocation = { revoked: 0, pending: [] };
    if (this.#git.availability().status === "unavailable") return result;
    const { state } = await this.#workspaces.load();
    for (const workspaceId of endedCourseWorkspaces(state)) {
      for (let attempt = 1; ; attempt++) {
        try {
          result.revoked += (await this.#git.credentials.revokeAll(workspaceId)).revoked;
          break;
        } catch (error) {
          if (!(error instanceof SchoolOsError && error.code === "unavailable")) throw error;
          if (attempt >= REVOKE_ATTEMPTS) {
            result.pending.push(workspaceId);
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, REVOKE_RETRY_MS * attempt));
        }
      }
    }
    return result;
  }

  // Baselines

  /**
   * Checks every version reachable from a baseline version for teacher-only files: paths matching
   * the assignment's patterns, or marked teacher-only in any version of the baseline. With Git
   * storage this walks the repository's own commits, by every parent, rather than the records.
   */
  async checkBaseline(caller: Caller, rawBaseline: BaselineRef, rawRules: TeacherOnlyRules): Promise<BaselineReport> {
    const baseline = parse(BaselineRef, rawBaseline);
    const rules = parse(TeacherOnlyRules, rawRules);
    const { chosen, manifests } = await this.#ownedBaseline(caller, baseline);
    const marked = new Set(manifests.flatMap(({ manifest }) => manifest.files.filter((f) => f.teacherOnly === true).map((f) => f.path)));
    const classify = teacherOnlyClassifier(rules, marked);

    let scanned: { versionNumber?: number; paths: string[]; chosen: boolean }[];
    if (chosen.manifest.storage.kind === "artifacts-git") {
      const byCommit = new Map<GitOid, number>();
      for (const { revision, manifest } of manifests) {
        if (manifest.storage.kind === "artifacts-git") byCommit.set(manifest.storage.commit, revision.number);
      }
      const head = chosen.manifest.storage.commit;
      const commits = await this.#git.scanHistory(chosen.manifest.storage.repository, head);
      scanned = commits.map((c) => ({
        ...(byCommit.has(c.commit) ? { versionNumber: byCommit.get(c.commit)! } : {}),
        paths: c.paths,
        chosen: c.commit === head,
      }));
    } else {
      const byId = new Map(manifests.map((m) => [m.revision.id, m]));
      scanned = [];
      for (let at: typeof chosen | undefined = chosen; at !== undefined; at = at.revision.parentRevisionId === undefined ? undefined : byId.get(at.revision.parentRevisionId)) {
        scanned.push({ versionNumber: at.revision.number, paths: at.manifest.files.map((f) => f.path), chosen: at === chosen });
      }
    }

    const findings: BaselineFinding[] = [];
    for (const version of scanned) {
      for (const path of version.paths) {
        const reason = classify(path);
        if (reason === undefined) continue;
        findings.push({
          path,
          ...(version.versionNumber === undefined ? {} : { versionNumber: version.versionNumber }),
          inChosenVersion: version.chosen,
          reason,
        });
      }
    }
    return { clean: findings.length === 0, versionsChecked: scanned.length, findings };
  }

  /**
   * Forks a baseline version into one of the caller's own workspaces as a new project, in a new
   * repository whose one commit has no parent and only the chosen version's files. It is refused,
   * with the report, if any version reachable from the chosen one holds a teacher-only file, even
   * one later deleted: Git history keeps what a later commit removed (roadmap §6.2, §14). Re-create
   * such a baseline as a fresh snapshot first.
   */
  async forkFromBaseline(caller: Caller, rawBaseline: BaselineRef, toWorkspaceId: WorkspaceId, rawRules: TeacherOnlyRules, rawTitle: string): Promise<ForkResult> {
    const report = await this.checkBaseline(caller, rawBaseline, rawRules);
    if (!report.clean) return { status: "blocked", report };
    return { status: "forked", project: await this.#copyVersion(caller, parse(BaselineRef, rawBaseline), toWorkspaceId, rawTitle) };
  }

  /**
   * Re-creates a baseline as a fresh snapshot: a new project in the baseline's own workspace whose
   * one version has only the chosen version's files and no history, so it can then be forked. It
   * is refused, with the report, if the chosen version itself holds a teacher-only file.
   */
  async recreateBaseline(caller: Caller, rawBaseline: BaselineRef, rawRules: TeacherOnlyRules, rawTitle: string): Promise<ForkResult> {
    const baseline = parse(BaselineRef, rawBaseline);
    const report = await this.checkBaseline(caller, baseline, rawRules);
    const inChosen = report.findings.filter((f) => f.inChosenVersion);
    if (inChosen.length > 0) return { status: "blocked", report: { ...report, clean: false, findings: inChosen } };
    const { artifact } = await this.#artifacts.getArtifact(caller, baseline.artifactId);
    return { status: "forked", project: await this.#copyVersion(caller, baseline, artifact.workspaceId, rawTitle) };
  }

  // Internals

  async #copyVersion(caller: Caller, baseline: BaselineRef, toWorkspaceId: WorkspaceId, rawTitle: string): Promise<ProjectView> {
    const { artifact } = await this.#artifacts.getArtifact(caller, baseline.artifactId);
    const { manifest } = await this.#readManifest(caller, baseline.artifactId, baseline.revisionId);
    const files = await this.#filesOf(manifest);
    return this.createProject(caller, {
      workspaceId: toWorkspaceId,
      type: parse(ProjectArtifactType, artifact.type),
      title: rawTitle,
      files: files.map((f) => ({ path: f.path, bytes: f.bytes })),
      message: "Starting point",
      aiAssistance: { level: "none" },
    });
  }

  /** The caller's own baseline artifact, the chosen version, and every version's manifest. */
  async #ownedBaseline(caller: Caller, baseline: BaselineRef) {
    const { artifact } = await this.#artifacts.getArtifact(caller, baseline.artifactId);
    if (artifact.ownerPrincipalId !== caller.principal.principalId) {
      throw new SchoolOsError("forbidden", "Only the owner of this work can publish a baseline from it.");
    }
    const manifests: { revision: ArtifactRevision; manifest: ProjectManifest }[] = [];
    for (const revision of await this.#artifacts.history(caller, artifact.id)) {
      manifests.push({ revision, manifest: await this.#manifestOf(caller, artifact.id, revision) });
    }
    const chosen = manifests.find((m) => m.revision.id === baseline.revisionId);
    if (chosen === undefined) throw notFound("revision", baseline.revisionId);
    return { artifact, chosen, manifests };
  }

  /** Writes a project's first version, whose content describes `manifest`, through learning-artifacts. */
  async #record(caller: Caller, input: z.output<typeof NewProject>, manifest: ProjectManifest, content: RevisionContentInput): Promise<ProjectView> {
    const view = await this.#artifacts.createArtifact(caller, {
      workspaceId: input.workspaceId,
      type: input.type,
      title: input.title,
      content,
      aiAssistance: input.aiAssistance,
    });
    return { artifact: view.artifact, latest: versionOf(view.head, manifest) };
  }

  /** Builds and pushes a version to Git: the project commit, its manifest, and the protected version ref. */
  async #pushVersion(
    caller: Caller,
    input: { repository: string; workspaceId: WorkspaceId; built: BuiltTree; parent: GitOid | undefined; message: string },
  ): Promise<{ manifest: ProjectManifest; pushed: PushedVersion }> {
    const at = this.#now();
    const principalId = caller.principal.principalId;
    const commit = await this.#git.projectCommit({ built: input.built, parent: input.parent, principalId, message: input.message, at });
    const manifest: ProjectManifest = {
      ...manifestBase(input.built, input.message),
      storage: { kind: "artifacts-git", repository: input.repository, commit: commit.oid },
    };
    const pushed = await this.#git.pushVersion({
      repository: input.repository,
      workspaceId: input.workspaceId,
      principalId,
      built: input.built,
      commit,
      manifest: encoder.encode(JSON.stringify(manifest)),
      at,
    });
    return { manifest, pushed };
  }

  /**
   * The content learning-artifacts records for a pushed version: the manifest in its version
   * commit, registered as `artifacts-git` content, where learning-artifacts has that provider; the
   * same manifest as inline text where it does not.
   */
  async #versionContent(manifest: ProjectManifest, pushed: PushedVersion): Promise<RevisionContentInput> {
    if (manifest.storage.kind !== "artifacts-git" || !this.#artifacts.hasContentProvider(ARTIFACTS_GIT_PROVIDER)) return manifestText(manifest);
    return {
      kind: "registered",
      provider: ARTIFACTS_GIT_PROVIDER,
      key: ArtifactsGitBackend.versionKey(manifest.storage.repository, pushed.version),
      mediaType: PROJECT_MANIFEST_MEDIA_TYPE,
      digest: await sha256Digest(encoder.encode(JSON.stringify(manifest))),
    };
  }

  async #readManifest(caller: Caller, artifactId: ArtifactId, revisionId?: RevisionId) {
    const { revision, content } = await this.#artifacts.readRevision(caller, artifactId, revisionId);
    return { revision, manifest: parseManifest(revision, content.kind === "text" ? content.text : undefined) };
  }

  async #manifestOf(caller: Caller, artifactId: ArtifactId, revision: ArtifactRevision): Promise<ProjectManifest> {
    if (revision.mediaType !== PROJECT_MANIFEST_MEDIA_TYPE) throw notAProject();
    return (await this.#readManifest(caller, artifactId, revision.id)).manifest;
  }

  async #filesOf(manifest: ProjectManifest): Promise<VersionFile[]> {
    const bytesByPath = manifest.storage.kind === "bundle"
      ? new Map(manifest.files.map((f) => [f.path, fromBase64(bundleBlob(manifest, f.blob))]))
      : await this.#git.readFiles(manifest.storage.repository, manifest.tree);
    const files: VersionFile[] = [];
    for (const file of manifest.files) {
      const bytes = bytesByPath.get(file.path);
      if (bytes === undefined || (await gitObject("blob", bytes)).oid !== file.blob) {
        throw new SchoolOsError("unavailable", "This project's files are missing from storage or failed their integrity check.");
      }
      files.push({ path: file.path, bytes, teacherOnly: file.teacherOnly === true });
    }
    if (bytesByPath.size !== manifest.files.length) {
      throw new SchoolOsError("unavailable", "This project's files do not match the saved version.");
    }
    return files;
  }

  /** Runs `use` with a diff source holding every object the manifests' trees need. */
  async #withSource<T>(manifests: ProjectManifest[], use: (source: TreeDiffSource) => Promise<T>): Promise<T> {
    const local = new Map<GitOid, Uint8Array<ArrayBuffer>>();
    const trees = new Map<GitOid, Uint8Array<ArrayBuffer>>();
    for (const manifest of manifests) {
      if (manifest.storage.kind !== "bundle") continue;
      const built = await rebuildBundle(manifest);
      for (const object of built.objects) (object.type === "tree" ? trees : local).set(object.oid, object.payload);
    }
    const localSource: TreeDiffSource = {
      getTree: async (oid) => (trees.has(oid) ? parseGitTreePayload(trees.get(oid)!, oid) : null),
      getBlob: async (oid) => local.get(oid) ?? "unavailable",
    };
    const repository = manifests.find((m) => m.storage.kind === "artifacts-git")?.storage;
    if (repository?.kind !== "artifacts-git") return use(localSource);
    return this.#git.withTreeSource(repository.repository, (remote) => use({
      getTree: async (oid) => (await localSource.getTree(oid)) ?? remote.getTree(oid),
      getBlob: async (oid) => (local.has(oid) ? local.get(oid)! : remote.getBlob(oid)),
    }));
  }

  /**
   * The same `update` decision learning-artifacts makes when it records a version, asked first so
   * nothing is pushed for a save that would be refused (a closed term, or someone else's work).
   */
  async #assertMayChange(caller: Caller, artifact: Artifact): Promise<void> {
    if (artifact.ownerPrincipalId !== caller.principal.principalId) throw new SchoolOsError("forbidden", "Only a project's owner can change it.");
    const request: AuthorizationRequest = {
      subject: caller.principal,
      action: "update",
      resource: {
        kind: "artifact",
        id: artifact.id,
        scope: artifact.scope,
        classification: artifact.classification,
        ownerPrincipalId: artifact.ownerPrincipalId,
      },
      context: { channel: caller.channel, ...(await this.#termOf(artifact)) },
    };
    const { decision } = await this.#policy.decide(request);
    if (decision.effect !== "allow") throw new SchoolOsError("forbidden", "This work can no longer be changed.");
  }

  async #termOf(artifact: Artifact): Promise<{ termState?: TermState }> {
    const [{ state }, { snapshot }] = await Promise.all([this.#workspaces.load(), this.#directory.load()]);
    const workspace = state.workspaces.find((w) => w.id === artifact.workspaceId);
    if (workspace === undefined) throw notFound("artifact", artifact.id);
    if (workspace.kind === "personal") return {};
    const term = snapshot.terms.find((t) => t.id === workspace.termId);
    if (term === undefined) throw new Error(`term ${workspace.termId} is missing from the directory`);
    return { termState: term.state };
  }
}

const encoder = new TextEncoder();

/** A manifest as inline text content. Its JSON has no raw line breaks, so canonicalization leaves it unchanged. */
function manifestText(manifest: ProjectManifest): RevisionContentInput {
  return { kind: "text", mediaType: PROJECT_MANIFEST_MEDIA_TYPE, text: JSON.stringify(manifest) };
}

/** Course workspaces whose course grants have all been revoked: a closed term's, or a dropped student's. */
function endedCourseWorkspaces(state: WorkspaceState): WorkspaceId[] {
  const live = new Set(state.grants.filter((g) => g.state === "live").map((g) => g.workspaceId));
  return [...new Set(state.grants.filter((g) => g.state === "revoked" && !live.has(g.workspaceId)).map((g) => g.workspaceId))];
}

function manifestBase(built: BuiltTree, message: string): Omit<ProjectManifest, "storage"> {
  return { format: "schoolos.project.v1", message, contentDigest: built.contentDigest, tree: built.tree, files: built.files };
}

function bundleManifest(built: BuiltTree, message: string): ProjectManifest {
  const blobs: Record<string, string> = {};
  for (const [oid, bytes] of built.blobs) blobs[oid] = toBase64(bytes);
  return { ...manifestBase(built, message), storage: { kind: "bundle", blobs } };
}

function bundleBlob(manifest: ProjectManifest, oid: GitOid): string {
  const blob = manifest.storage.kind === "bundle" ? manifest.storage.blobs[oid] : undefined;
  if (blob === undefined) throw new SchoolOsError("unavailable", "This project's files are missing from storage.");
  return blob;
}

/** A bundle's Git objects, rebuilt from its files and checked against the tree it recorded. */
async function rebuildBundle(manifest: ProjectManifest): Promise<BuiltTree> {
  const built = await buildTree(manifest.files.map((f) => ({ path: f.path, bytes: fromBase64(bundleBlob(manifest, f.blob)) })));
  if (built.tree !== manifest.tree) throw new SchoolOsError("unavailable", "This project's files failed their integrity check.");
  return built;
}

/** Whether a path is teacher-only, and why. */
function teacherOnlyClassifier(rules: TeacherOnlyRules, marked: ReadonlySet<string>): (path: string) => BaselineFinding["reason"] | undefined {
  const matchers = rules.answerKeyGlobs.map((pattern) => ({ pattern, matches: globMatcher(pattern) }));
  return (path) => {
    const match = matchers.find((m) => m.matches(path));
    if (match !== undefined) return { kind: "pattern", pattern: match.pattern };
    return marked.has(path) ? { kind: "marked-teacher-only" } : undefined;
  };
}

function versionOf(revision: ArtifactRevision, manifest: ProjectManifest): ProjectVersion {
  return {
    revisionId: revision.id,
    number: revision.number,
    message: manifest.message,
    savedAt: revision.createdAt,
    savedBy: revision.authorPrincipalId,
    contentDigest: manifest.contentDigest,
    revisionDigest: revision.content.digest,
    fileCount: manifest.files.length,
  };
}

function parseManifest(revision: ArtifactRevision, text: string | undefined): ProjectManifest {
  if (revision.mediaType !== PROJECT_MANIFEST_MEDIA_TYPE || text === undefined) throw notAProject();
  const parsed = ProjectManifest.safeParse(JSON.parse(text));
  if (!parsed.success) throw new SchoolOsError("unavailable", "This project version could not be read.");
  return parsed.data;
}

function notAProject(): SchoolOsError {
  return new SchoolOsError("validation-failed", "This artifact is not a project.");
}

function notFound(kind: string, id: string): SchoolOsError {
  return new SchoolOsError("not-found", `${kind} ${id} was not found.`);
}

/** Parses caller input, answering `validation-failed` rather than a raw Zod error. */
function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new SchoolOsError("validation-failed", z.prettifyError(parsed.error).slice(0, 1000));
  return parsed.data;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
