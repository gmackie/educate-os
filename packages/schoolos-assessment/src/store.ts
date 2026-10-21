import { SchoolOsError } from "@schoolos/contracts";
import { AssessmentState, type OfficialGradeVersion } from "./model.ts";

/** The assessment records as stored, with the version optimistic concurrency checks against. */
export interface StoredAssessment {
  /** Increases by one on every commit. */
  version: number;
  /** The state. Callers own this copy and may not assume edits to it are stored. */
  state: AssessmentState;
}

/**
 * Where one district's assessment records are kept. A write replaces the state as a whole, only if
 * nothing else committed since it was loaded, and only if it keeps the invariants
 * {@link assertAssessmentInvariants} checks.
 */
export interface AssessmentRecordStore {
  /** Reads the current state. */
  load(): Promise<StoredAssessment>;
  /** Stores `next` if the stored version is still `expectedVersion`, and throws `conflict` if not. */
  commit(next: AssessmentState, expectedVersion: number): Promise<void>;
}

const FEEDBACK_ORDER = ["draft", "shared-with-student", "final"] as const;

/**
 * Refuses a change that would rewrite the assessment record. Every store implementation calls it
 * before writing:
 * - a submission is never removed, and nothing about it changes except being marked withdrawn;
 * - an assignment's rubric never changes once it has a submission;
 * - starter material is never changed or removed;
 * - feedback only moves forward, and a final result never changes;
 * - an official grade version is never changed or removed, and each new one is the next number
 *   for its assignment and student.
 */
export function assertAssessmentInvariants(previous: AssessmentState, next: AssessmentState): void {
  const submissions = new Map(next.submissions.map((s) => [s.id, s]));
  for (const before of previous.submissions) {
    const after = submissions.get(before.id);
    if (after === undefined) throw violation(`Submission ${before.id} cannot be removed.`);
    const { withdrawnAt: wasWithdrawn, ...rest } = before;
    const { withdrawnAt: isWithdrawn, ...restAfter } = after;
    if (canonicalJson(rest) !== canonicalJson(restAfter) || (wasWithdrawn !== undefined && wasWithdrawn !== isWithdrawn)) {
      throw violation(`Submission ${before.id} is immutable.`);
    }
  }

  const assignments = new Map(next.assignments.map((a) => [a.id, a]));
  for (const before of previous.assignments) {
    const after = assignments.get(before.id);
    if (after === undefined) throw violation(`Assignment ${before.id} cannot be removed.`);
    const submitted = previous.submissions.some((s) => s.assignmentId === before.id);
    if (submitted && canonicalJson(before.rubric ?? null) !== canonicalJson(after.rubric ?? null)) {
      throw violation(`Assignment ${before.id} has submissions, so its rubric is locked.`);
    }
  }

  const starters = new Map(next.starterMaterials.map((m) => [m.id, m]));
  for (const before of previous.starterMaterials) {
    const after = starters.get(before.id);
    if (after === undefined || canonicalJson(after) !== canonicalJson(before)) throw violation(`Starter material ${before.id} is immutable.`);
  }

  const feedback = new Map(next.feedback.map((f) => [f.submissionId, f]));
  for (const before of previous.feedback) {
    const after = feedback.get(before.submissionId);
    if (after === undefined) throw violation(`Feedback on ${before.submissionId} cannot be removed.`);
    if (FEEDBACK_ORDER.indexOf(after.state) < FEEDBACK_ORDER.indexOf(before.state)) {
      throw violation(`Feedback on ${before.submissionId} cannot move back to ${after.state}.`);
    }
    if (before.state === "final" && canonicalJson(after) !== canonicalJson(before)) {
      throw violation(`Feedback on ${before.submissionId} is final.`);
    }
  }

  const versions = new Map(next.gradeVersions.map((v) => [versionKey(v), v]));
  for (const before of previous.gradeVersions) {
    const after = versions.get(versionKey(before));
    if (after === undefined || canonicalJson(after) !== canonicalJson(before)) {
      throw violation(`Official grade version ${before.version} is immutable.`);
    }
  }
  const latest = new Map<string, number>();
  for (const version of next.gradeVersions) {
    const key = gradeKey(version);
    const expected = (latest.get(key) ?? 0) + 1;
    if (version.version !== expected) throw violation("Official grade versions must increase by one at a time.");
    latest.set(key, version.version);
  }
}

function violation(message: string): SchoolOsError {
  return new SchoolOsError("policy-violation", message);
}

function gradeKey(v: OfficialGradeVersion): string {
  return JSON.stringify([v.assignmentId, v.studentPrincipalId]);
}

function versionKey(v: OfficialGradeVersion): string {
  return JSON.stringify([v.assignmentId, v.studentPrincipalId, v.version]);
}

/** JSON with object keys sorted, so two equal records compare equal whatever order their keys are in. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/** An {@link AssessmentRecordStore} held in memory, for tests and the local harness. */
export class InMemoryAssessmentRecordStore implements AssessmentRecordStore {
  #state: AssessmentState = { assignments: [], starterMaterials: [], submissions: [], feedback: [], gradeProposals: [], gradeVersions: [] };
  #version = 0;

  async load(): Promise<StoredAssessment> {
    return { version: this.#version, state: structuredClone(this.#state) };
  }

  async commit(next: AssessmentState, expectedVersion: number): Promise<void> {
    if (expectedVersion !== this.#version) {
      throw new SchoolOsError("conflict", "The assessment records changed while this request was in progress; retry it.");
    }
    const parsed = AssessmentState.parse(next);
    assertAssessmentInvariants(this.#state, parsed);
    this.#state = structuredClone(parsed);
    this.#version += 1;
  }
}
