import { SchoolOsError, type AssessmentRunId, type SubmissionId } from "@schoolos/contracts";
import type { RunState } from "@schoolos/assessment-ci";
import { AiRelease, OptionalRun, TeacherOverride } from "./model.ts";

/**
 * Where optional runs, overrides and releases are kept: teacher-side storage, never a student's
 * workspace. A run is inserted once and then changed only through {@link replaceRun}.
 */
export interface OptionalRunStore {
  getRun(id: AssessmentRunId): Promise<OptionalRun | undefined>;
  /** Stores `run` unless one with its ID exists, and returns whichever is stored. */
  insertRun(run: OptionalRun): Promise<OptionalRun>;
  /** Stores `next` if the stored run is still at `expectedRevision`; throws `conflict` if not. */
  replaceRun(next: OptionalRun, expectedRevision: number): Promise<void>;
  /** A submission's runs, oldest first. */
  runsFor(submissionId: SubmissionId): Promise<OptionalRun[]>;
  /** Appends an override. Overrides are never changed or removed. */
  addOverride(override: TeacherOverride): Promise<void>;
  overridesFor(submissionId: SubmissionId): Promise<TeacherOverride[]>;
  /** Records a release; releasing the same run again keeps the first. */
  addRelease(release: AiRelease): Promise<void>;
  releasesFor(submissionId: SubmissionId): Promise<AiRelease[]>;
}

const TRANSITIONS: Record<RunState, readonly RunState[]> = {
  queued: ["running"],
  running: ["queued", "running", "completed", "failed"],
  completed: [],
  failed: [],
};

/** What a run is, which never changes. */
function identity(r: OptionalRun): string {
  return JSON.stringify([r.id, r.key, r.spec, r.submissionId, r.districtId, r.offeringId, r.activityId, r.requestedBy, r.queuedAt]);
}

function fail(message: string): SchoolOsError {
  return new SchoolOsError("policy-violation", message);
}

/**
 * Refuses a change that would rewrite a run's history: what it is never changes, its state moves
 * only forward (with a retry back to `queued`), a finished run never changes, and each change is
 * the next revision.
 */
export function assertOptionalRunTransition(previous: OptionalRun, next: OptionalRun): void {
  if (identity(previous) !== identity(next)) throw fail(`Run ${previous.id} cannot change what it is.`);
  if (!TRANSITIONS[previous.state].includes(next.state)) throw fail(`Run ${previous.id} cannot go from ${previous.state} to ${next.state}.`);
  if (next.revision !== previous.revision + 1) throw fail(`Run ${previous.id} must change one revision at a time.`);
  if (next.attempts < previous.attempts) throw fail(`Run ${previous.id} cannot forget an attempt.`);
}

/** An {@link OptionalRunStore} in memory, for tests and local development. Values are copied in and out. */
export class InMemoryOptionalRunStore implements OptionalRunStore {
  readonly #runs = new Map<AssessmentRunId, string>();
  readonly #overrides: string[] = [];
  readonly #releases: string[] = [];

  async getRun(id: AssessmentRunId): Promise<OptionalRun | undefined> {
    const stored = this.#runs.get(id);
    return stored === undefined ? undefined : OptionalRun.parse(JSON.parse(stored));
  }

  async insertRun(run: OptionalRun): Promise<OptionalRun> {
    const existing = await this.getRun(run.id);
    if (existing !== undefined) return existing;
    this.#runs.set(run.id, JSON.stringify(OptionalRun.parse(run)));
    return OptionalRun.parse(run);
  }

  async replaceRun(next: OptionalRun, expectedRevision: number): Promise<void> {
    const current = await this.getRun(next.id);
    if (current === undefined) throw new SchoolOsError("not-found", `Run ${next.id} was not found.`);
    if (current.revision !== expectedRevision) throw new SchoolOsError("conflict", `Run ${next.id} changed since it was read.`);
    assertOptionalRunTransition(current, next);
    this.#runs.set(next.id, JSON.stringify(OptionalRun.parse(next)));
  }

  async runsFor(submissionId: SubmissionId): Promise<OptionalRun[]> {
    return [...this.#runs.values()].map((s) => OptionalRun.parse(JSON.parse(s))).filter((r) => r.submissionId === submissionId).toSorted((a, b) => a.queuedAt.localeCompare(b.queuedAt));
  }

  async addOverride(override: TeacherOverride): Promise<void> {
    this.#overrides.push(JSON.stringify(TeacherOverride.parse(override)));
  }

  async overridesFor(submissionId: SubmissionId): Promise<TeacherOverride[]> {
    return this.#overrides.map((s) => TeacherOverride.parse(JSON.parse(s))).filter((o) => o.submissionId === submissionId);
  }

  async addRelease(release: AiRelease): Promise<void> {
    if ((await this.releasesFor(release.submissionId)).some((r) => r.runId === release.runId)) return;
    this.#releases.push(JSON.stringify(AiRelease.parse(release)));
  }

  async releasesFor(submissionId: SubmissionId): Promise<AiRelease[]> {
    return this.#releases.map((s) => AiRelease.parse(JSON.parse(s))).filter((r) => r.submissionId === submissionId);
  }
}
