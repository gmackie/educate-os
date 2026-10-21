import { SchoolOsError, type AssessmentRunId } from "@schoolos/contracts";
import { canonicalJson } from "./canonical.ts";
import { AssessmentRun, type RunState } from "./model.ts";

/**
 * Where assessment runs are kept. A run is inserted once and then changed only through
 * {@link replace}, which checks the revision it was read at and the transition it makes.
 */
export interface AssessmentRunStore {
  /** The run, if stored. */
  get(id: AssessmentRunId): Promise<AssessmentRun | undefined>;
  /** Stores `run` unless a run with its ID exists, and returns whichever is stored: the first insert wins. */
  insert(run: AssessmentRun): Promise<AssessmentRun>;
  /** Stores `next` if the stored run is still at `expectedRevision`, and throws `conflict` if not. */
  replace(next: AssessmentRun, expectedRevision: number): Promise<void>;
}

/** What a run is, which never changes. */
function identity(run: AssessmentRun): string {
  return canonicalJson([run.id, run.key, run.evaluators, run.queuedAt]);
}

const TRANSITIONS: Record<RunState, readonly RunState[]> = {
  queued: ["running"],
  // Back to `queued` after a transient failure; `running` again when an expired lease is reclaimed.
  running: ["queued", "running", "completed", "failed"],
  completed: [],
  failed: [],
};

/**
 * Refuses a change that would rewrite a run's history. Every store implementation calls it before
 * replacing a run: its identity, key, resolved evaluators and queue time never change, its state
 * only moves along `queued → running → completed | failed` (with a retry back to `queued`), a
 * finished run never changes, and each change is the next revision.
 */
export function assertRunTransition(previous: AssessmentRun, next: AssessmentRun): void {
  if (identity(previous) !== identity(next)) throw violation(`Run ${previous.id} cannot change what it is.`);
  if (!TRANSITIONS[previous.state].includes(next.state)) throw violation(`Run ${previous.id} cannot go from ${previous.state} to ${next.state}.`);
  if (next.revision !== previous.revision + 1) throw violation(`Run ${previous.id} must change one revision at a time.`);
  if (next.attempts < previous.attempts) throw violation(`Run ${previous.id} cannot forget an attempt.`);
}

function violation(message: string): SchoolOsError {
  return new SchoolOsError("policy-violation", message);
}

/** An {@link AssessmentRunStore} in memory, for tests and local development. Values are copied in and out. */
export class InMemoryAssessmentRunStore implements AssessmentRunStore {
  readonly #runs = new Map<AssessmentRunId, string>();

  async get(id: AssessmentRunId): Promise<AssessmentRun | undefined> {
    const stored = this.#runs.get(id);
    return stored === undefined ? undefined : AssessmentRun.parse(JSON.parse(stored));
  }

  async insert(run: AssessmentRun): Promise<AssessmentRun> {
    const existing = await this.get(run.id);
    if (existing !== undefined) return existing;
    this.#runs.set(run.id, JSON.stringify(AssessmentRun.parse(run)));
    return AssessmentRun.parse(run);
  }

  async replace(next: AssessmentRun, expectedRevision: number): Promise<void> {
    const current = await this.get(next.id);
    if (current === undefined) throw new SchoolOsError("not-found", `Run ${next.id} was not found.`);
    if (current.revision !== expectedRevision) throw new SchoolOsError("conflict", `Run ${next.id} changed since it was read.`);
    assertRunTransition(current, next);
    this.#runs.set(next.id, JSON.stringify(AssessmentRun.parse(next)));
  }
}
