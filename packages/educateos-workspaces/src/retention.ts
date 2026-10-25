import { PrincipalId, EducateOsError, type DistrictDirectorySnapshot, type WorkspaceId } from "@educateos/contracts";
import type { AcademicStore } from "@educateos/academics";
import { eligibleFrom, workspaceLifecycle } from "./lifecycle.ts";
import { RetentionPolicy, type CourseWorkspace, type Workspace, type WorkspaceDeletionRecord, type WorkspaceState } from "./model.ts";
import type { WorkspaceStore } from "./store.ts";

/**
 * Deletes what a course workspace stores: its Workshop storage, its artifacts, its project
 * repositories. Each storage owner provides one. It must be idempotent: the retention job calls it
 * again for a workspace whose deletion was interrupted, including one whose storage is already gone.
 */
export interface WorkspaceStorageEraser {
  /** Deletes everything stored for `workspace`. Resolves once nothing is left. */
  eraseWorkspace(workspace: CourseWorkspace): Promise<void>;
}

/** What a {@link WorkspaceRetentionJob} is built from. */
export interface WorkspaceRetentionJobOptions {
  /** The district's workspace records. */
  workspaces: WorkspaceStore;
  /** The district's academic directory, read for term states. Never written. */
  directory: AcademicStore;
  /** How long course workspaces are kept after their term closes. */
  retention: RetentionPolicy;
  /** Deletes a workspace's storage. */
  eraser: WorkspaceStorageEraser;
  /** The service principal the job runs as, named as the actor of every deletion record. */
  runAs: PrincipalId;
  /** The clock. Defaults to the system clock. */
  now?: () => Date;
}

/** What one {@link WorkspaceRetentionJob.run} did. */
export interface RetentionRunResult {
  /** Workspaces deleted by this run, including interrupted deletions it resumed. */
  deleted: WorkspaceId[];
  /** Workspaces whose storage could not be erased. They stay pending, and the next run retries them. */
  failed: WorkspaceId[];
}

/** Commit attempts before one step gives up on concurrent changes and leaves the workspace for the next run. */
const COMMIT_ATTEMPTS = 3;

/**
 * The scheduled retention job (roadmap §6.1): deletes the storage of every course workspace that is
 * `eligible-for-deletion` and writes one {@link WorkspaceDeletionRecord} per deletion. It is a
 * trusted platform job, run on a schedule as a service principal, never reachable by a caller.
 *
 * Each workspace is deleted in three steps, each safe to interrupt:
 *
 * 1. **Decide.** Reload the workspace and its term, check it is still eligible (so a legal hold
 *    placed since the last run keeps it) and commit `deletion: pending`, all against one version of
 *    the state. A hold placed concurrently makes this commit fail, and from this commit on
 *    `setLegalHold` refuses: this is the moment of deletion.
 * 2. **Erase** the storage, through the idempotent {@link WorkspaceStorageEraser}.
 * 3. **Record.** Commit `deletion: deleted`, drop the storage handle and append the audit record,
 *    together, so there is exactly one record however often the job stopped between steps.
 *
 * A run resumes pending deletions first. Running it again when nothing is eligible changes nothing.
 * The workspace record itself is kept as a tombstone with lifecycle `deleted`, so the course key
 * stays taken and the owner can see the work was deleted under the retention policy.
 */
export class WorkspaceRetentionJob {
  readonly #workspaces: WorkspaceStore;
  readonly #directory: AcademicStore;
  readonly #retention: RetentionPolicy;
  readonly #eraser: WorkspaceStorageEraser;
  readonly #runAs: PrincipalId;
  readonly #now: () => Date;

  constructor(options: WorkspaceRetentionJobOptions) {
    this.#workspaces = options.workspaces;
    this.#directory = options.directory;
    this.#retention = RetentionPolicy.parse(options.retention);
    this.#eraser = options.eraser;
    this.#runAs = PrincipalId.parse(options.runAs);
    this.#now = options.now ?? (() => new Date());
  }

  /** Deletes every eligible workspace's storage, resuming interrupted deletions first. */
  async run(): Promise<RetentionRunResult> {
    const [{ state }, { snapshot }] = await Promise.all([this.#workspaces.load(), this.#directory.load()]);
    const pending = state.workspaces.filter((w): w is CourseWorkspace => w.kind === "course" && w.deletion?.state === "pending");
    const eligible = state.workspaces.filter(
      (w): w is CourseWorkspace => w.kind === "course" && w.deletion === undefined && this.#eligible(w, state, snapshot),
    );
    const result: RetentionRunResult = { deleted: [], failed: [] };
    for (const candidate of [...pending, ...eligible]) {
      const claimed = await this.#claim(candidate.id);
      if (claimed === undefined) continue;
      try {
        await this.#eraser.eraseWorkspace(claimed);
      } catch {
        result.failed.push(claimed.id);
        continue;
      }
      if (await this.#record(claimed.id)) result.deleted.push(claimed.id);
    }
    return result;
  }

  /** Whether a workspace with no deletion begun is eligible now, its legal hold included. */
  #eligible(workspace: CourseWorkspace, state: WorkspaceState, snapshot: DistrictDirectorySnapshot): boolean {
    const term = snapshot.terms.find((t) => t.id === workspace.termId);
    if (term === undefined) return false;
    const closure = state.closures.find((c) => c.termId === workspace.termId);
    const lifecycle = workspaceLifecycle(workspace, {
      termState: term.state,
      ...(closure === undefined ? {} : { closure }),
      retention: this.#retention,
      now: this.#now(),
    });
    return lifecycle === "eligible-for-deletion";
  }

  /**
   * Step 1: the workspace, marked `pending`, if it is still eligible or already pending. Returns
   * undefined if it is no longer eligible (a hold was placed) or was finished by another run.
   */
  async #claim(workspaceId: WorkspaceId): Promise<CourseWorkspace | undefined> {
    return this.#change(workspaceId, (workspace, state, snapshot) => {
      if (workspace.deletion?.state === "pending") return { result: workspace };
      if (workspace.deletion !== undefined || !this.#eligible(workspace, state, snapshot)) return { result: undefined };
      const claimed: CourseWorkspace = { ...workspace, deletion: { state: "pending", startedAt: this.#now().toISOString() } };
      return { replace: claimed, result: claimed };
    });
  }

  /** Step 3: marks the workspace deleted and appends its audit record. False if another run already did. */
  async #record(workspaceId: WorkspaceId): Promise<boolean> {
    return this.#change(workspaceId, (workspace, state) => {
      if (workspace.deletion?.state !== "pending") return { result: false };
      const closure = state.closures.find((c) => c.termId === workspace.termId);
      if (closure === undefined) throw new Error(`course workspace ${workspace.id} is pending deletion but its term was never closed`);
      const deletedAt = this.#now().toISOString();
      const { storageHandle: _erased, ...rest } = workspace;
      const deleted: CourseWorkspace = { ...rest, deletion: { state: "deleted", startedAt: workspace.deletion.startedAt, deletedAt } };
      const record: WorkspaceDeletionRecord = {
        districtId: workspace.districtId,
        actor: { principalId: this.#runAs },
        at: deletedAt,
        action: "workspace.storage-deleted",
        target: { workspaceId: workspace.id, ownerPrincipalId: workspace.ownerPrincipalId, offeringId: workspace.offeringId, termId: workspace.termId },
        retention: { closedAt: closure.closedAt, eligibleFrom: eligibleFrom(closure, this.#retention).toISOString() },
      };
      return { replace: deleted, append: record, result: true };
    });
  }

  /** Applies one step to fresh state, committing it against the version it read. */
  async #change<T>(
    workspaceId: WorkspaceId,
    step: (workspace: CourseWorkspace, state: WorkspaceState, snapshot: DistrictDirectorySnapshot) => {
      replace?: CourseWorkspace;
      append?: WorkspaceDeletionRecord;
      result: T;
    },
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const [{ state, version }, { snapshot }] = await Promise.all([this.#workspaces.load(), this.#directory.load()]);
      const workspace = state.workspaces.find((w): w is CourseWorkspace => w.id === workspaceId && w.kind === "course");
      if (workspace === undefined) throw new Error(`course workspace ${workspaceId} disappeared from the directory`);
      const { replace, append, result } = step(workspace, state, snapshot);
      if (replace === undefined) return result;
      const next: WorkspaceState = {
        ...state,
        workspaces: state.workspaces.map((w): Workspace => (w.id === workspaceId ? replace : w)),
        deletions: append === undefined ? state.deletions : [...state.deletions, append],
      };
      try {
        await this.#workspaces.commit(next, version);
        return result;
      } catch (error) {
        if (!(error instanceof EducateOsError && error.code === "conflict") || attempt >= COMMIT_ATTEMPTS) throw error;
      }
    }
  }
}
