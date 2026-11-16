import { z } from "zod";
import { EducateOsError, PrincipalId } from "@educateos/contracts";

/** Counts of erased records, never their text or learning observations. */
export const StudentLearningCounts = z.strictObject({ plans: z.int().nonnegative(), guidance: z.int().nonnegative(), guardianGrants: z.int().nonnegative(), aiRuntimeCounters: z.int().nonnegative().default(0) });
/** A district's explicit disposition decision for this subject and this record scope only. */
export const StudentLearningDisposition = z.strictObject({
  legalHold: z.boolean(),
  retainUntil: z.iso.datetime().optional(),
  deletionAuthorized: z.boolean(),
  archiveSatisfied: z.boolean(),
});
/** A content-free deletion receipt, committed atomically with the erasure and write fence. */
export const StudentLearningReceipt = z.strictObject({
  id: z.string().uuid(), studentId: PrincipalId, actorId: PrincipalId, at: z.iso.datetime(), counts: StudentLearningCounts,
});
/** A subject's durable retention decision and terminal optional-learning write fence. */
export const StudentLearningState = StudentLearningDisposition.extend({
  revision: z.int().nonnegative(), receipt: StudentLearningReceipt.optional(),
});
/** A subject's lifecycle state. */
export type StudentLearningState = z.infer<typeof StudentLearningState>;
/** The preview contract used by the admin API and future lifecycle integrations. */
export const StudentLearningPreview = z.strictObject({
  studentId: PrincipalId, state: StudentLearningState, counts: StudentLearningCounts,
  blockers: z.array(z.enum(["legal-hold", "retention", "disposition-unreviewed", "archive-required"])),
});
/** Subject-only operational counters; shares the lifecycle's synchronous transaction domain. */
export interface StudentLearningRuntimePersistence {
  count(studentId: PrincipalId): number;
  erase(studentId: PrincipalId): void;
}
/** Internal storage contract. All callbacks must be synchronous and use the same transaction domain. */
export interface StudentLearningPersistence {
  runtime?: StudentLearningRuntimePersistence;
  atomic<T>(run: () => T): T;
  get(studentId: PrincipalId): StudentLearningState | undefined;
  put(studentId: PrincipalId, state: StudentLearningState): void;
  counts(studentId: PrincipalId): z.input<typeof StudentLearningCounts>;
  erase(studentId: PrincipalId, actorId: PrincipalId, at: string): void;
}
/** Trusted storage adapter: callers must first authorize through district policy. No timers or inferred deletion obligation. */
export class StudentLearningLifecycle {
  readonly persistence: StudentLearningPersistence;
  constructor(persistence: StudentLearningPersistence) { this.persistence = persistence; }
  state(studentId: PrincipalId): StudentLearningState {
    return this.persistence.get(studentId) ?? { revision: 0, legalHold: false, deletionAuthorized: false, archiveSatisfied: false };
  }
  /** Terminal revocation overrides deployment grants, including receipts from older versions. */
  aiRevoked(studentId: PrincipalId): boolean { return this.state(studentId).receipt !== undefined; }
  private counts(studentId: PrincipalId): z.infer<typeof StudentLearningCounts> {
    return StudentLearningCounts.parse({ ...this.persistence.counts(studentId), aiRuntimeCounters: this.persistence.runtime?.count(studentId) ?? 0 });
  }
  /** Called inside each participating store's write transaction, including new-record writes. */
  assertWritable(studentId: PrincipalId): void {
    if (this.state(studentId).receipt !== undefined) throw new EducateOsError("conflict", "This student's optional planner and guidance records were erased. Return to the class page.");
  }
  /** Counts across all classes, including records from removed enrollments. Changes nothing. */
  preview(studentId: PrincipalId, at: string): z.infer<typeof StudentLearningPreview> {
    z.iso.datetime().parse(at);
    return this.persistence.atomic(() => {
      const state = this.state(studentId);
      const blockers: z.infer<typeof StudentLearningPreview>["blockers"] = [];
      if (state.legalHold) blockers.push("legal-hold");
      if (state.retainUntil !== undefined && Date.parse(at) < Date.parse(state.retainUntil)) blockers.push("retention");
      if (!state.deletionAuthorized) blockers.push("disposition-unreviewed");
      if (!state.archiveSatisfied) blockers.push("archive-required");
      return { studentId, state, counts: this.counts(studentId), blockers };
    });
  }
  /** Optimistic revision checks serialize a hold change against deletion. Erasure is terminal. */
  configure(studentId: PrincipalId, disposition: z.infer<typeof StudentLearningDisposition>, revision: number): StudentLearningState {
    return this.persistence.atomic(() => {
      const state = this.state(studentId);
      if (state.revision !== revision || state.receipt !== undefined) throw changed();
      const next = StudentLearningState.parse({ ...StudentLearningDisposition.parse(disposition), revision: revision + 1 });
      this.persistence.put(studentId, next);
      return next;
    });
  }
  /** Atomic, idempotent subject erasure. Retries return the original receipt, including actor and counts. */
  purge(studentId: PrincipalId, actorId: PrincipalId, at: string, revision: number): z.infer<typeof StudentLearningReceipt> {
    z.iso.datetime().parse(at);
    return this.persistence.atomic(() => {
      const state = this.state(studentId);
      if (state.receipt !== undefined) {
        // Upgrade repair: old receipts already revoke AI, but pre-integration quotas may remain.
        this.persistence.runtime?.erase(studentId);
        return state.receipt;
      }
      if (state.revision !== revision) throw changed();
      // Do not call preview here: storage transactions cannot nest.
      if (state.legalHold || !state.deletionAuthorized || !state.archiveSatisfied || (state.retainUntil !== undefined && Date.parse(at) < Date.parse(state.retainUntil))) {
        throw new EducateOsError("conflict", "Deletion is blocked by the student's hold, retention or unreviewed disposition. Preview the inventory first.");
      }
      const receipt = StudentLearningReceipt.parse({ id: crypto.randomUUID(), studentId, actorId, at, counts: this.counts(studentId) });
      this.persistence.erase(studentId, actorId, at);
      this.persistence.runtime?.erase(studentId);
      this.persistence.put(studentId, { ...state, revision: revision + 1, receipt });
      return receipt;
    });
  }
}
const changed = () => new EducateOsError("conflict", "The student's retention decision changed. Preview again.");
