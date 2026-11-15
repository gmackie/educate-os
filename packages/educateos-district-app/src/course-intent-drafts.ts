// District-owned, teacher-scoped pedagogical draft event history.
// Every revision is append-only; no course, student assignment or rubric is changed.
import { EducateOsError } from "@educateos/contracts";
import { CourseIntentDraftRecord, type CourseIntentDraftRecord as Draft, type CourseIntentDraftStatus } from "./routes.ts";

export interface CourseIntentDraftStore {
  /** Atomically reserve a unique teacher/offering request before calling any model. */
  claim(pending: Draft): Promise<{ created: boolean; draft: Draft }>;
  /** Compare-and-swap appends a new immutable revision; no overwrite or deletion. */
  transition(next: Draft, expectedRevision: number): Promise<Draft>;
  get(offeringId: string, ownerPrincipalId: string, draftId: string): Promise<Draft | undefined>;
  list(offeringId: string, ownerPrincipalId: string, limit?: number): Promise<Draft[]>;
  history(offeringId: string, ownerPrincipalId: string, draftId: string): Promise<Draft[]>;
}

function sameSource(a: Draft["source"], b: Draft["source"]): boolean {
  return a.packageId === b.packageId && a.version === b.version
    && a.digest === b.digest && a.unitKey === b.unitKey;
}

export function validateDraftClaim(pending: Draft): Draft {
  const parsed = CourseIntentDraftRecord.parse(pending);
  if (parsed.revision !== 1 || parsed.status !== "pending" || parsed.result !== undefined
    || parsed.selection !== undefined || parsed.reviewedBy !== undefined) {
    throw new EducateOsError("validation-failed", "A new course intent request must start pending.");
  }
  return parsed;
}

export function compareDraftRequest(existing: Draft, incoming: Draft): Draft {
  if (existing.offeringId !== incoming.offeringId
    || existing.ownerPrincipalId !== incoming.ownerPrincipalId
    || existing.requestKey !== incoming.requestKey
    || existing.goal !== incoming.goal || !sameSource(existing.source, incoming.source)) {
    throw new EducateOsError("conflict", "A curriculum request key was already used for different source metadata.");
  }
  return existing;
}

function ensureSelected(ids: readonly string[], available: readonly string[], what: string): void {
  const set = new Set(available);
  if (ids.some((id) => !set.has(id))) {
    throw new EducateOsError("validation-failed", "A selected " + what + " does not belong to this proposal.");
  }
}

/** Validate state transition and content identity, independent of caller-side checks. */
export function validateDraftTransition(current: Draft, input: Draft, expectedRevision: number): Draft {
  const next = CourseIntentDraftRecord.parse(input);
  if (next.id !== current.id || next.offeringId !== current.offeringId
    || next.ownerPrincipalId !== current.ownerPrincipalId
    || next.requestKey !== current.requestKey
    || next.goal !== current.goal || next.createdAt !== current.createdAt
    || !sameSource(next.source, current.source)) {
    throw new EducateOsError("conflict", "A draft revision cannot change its owner or source identity.");
  }
  if (current.revision !== expectedRevision || next.revision !== expectedRevision + 1) {
    throw new EducateOsError("conflict", "The draft changed since it was reviewed; reload before continuing.");
  }
  const allowed: Record<CourseIntentDraftStatus, readonly CourseIntentDraftStatus[]> = {
    pending: ["proposed", "failed"],
    proposed: ["reviewed", "discarded"],
    reviewed: [], discarded: [], failed: [],
  };
  if (!allowed[current.status].includes(next.status)) {
    throw new EducateOsError("conflict", "The draft cannot move to that status.");
  }
  if (Date.parse(next.updatedAt) < Date.parse(current.updatedAt)) {
    throw new EducateOsError("conflict", "Draft revision time cannot move backwards.");
  }
  if (next.status === "proposed") {
    const result = next.result!;
    if (result.goal !== next.goal || !sameSource(result.source, next.source)
      || result.intent.origin !== "machine-suggestion"
      || !sameSource(result.intent.source as Draft["source"], next.source)) {
      throw new EducateOsError("validation-failed", "The model suggestion cannot change its original source.");
    }
  }
  if (next.status === "reviewed") {
    if (current.result === undefined || next.result === undefined
      || JSON.stringify(current.result) !== JSON.stringify(next.result)
      || next.reviewedBy !== current.ownerPrincipalId) {
      throw new EducateOsError("validation-failed", "Review may only select from the owner's original private proposal.");
    }
    const original = next.result.intent;
    ensureSelected(next.selection!.goalIds, original.learningGoals.map((x) => x.id), "learning goal");
    ensureSelected(next.selection!.strategyIds, original.strategies.map((x) => x.id), "strategy");
  }
  if (next.status === "discarded" && next.selection !== undefined) {
    throw new EducateOsError("validation-failed", "Discarded drafts cannot carry selections.");
  }
  return next;
}

export class InMemoryCourseIntentDraftStore implements CourseIntentDraftStore {
  readonly #revisions = new Map<string, Draft[]>();

  async claim(input: Draft): Promise<{ created: boolean; draft: Draft }> {
    const pending = validateDraftClaim(input);
    for (const versions of this.#revisions.values()) {
      const current = versions.at(-1)!;
      if (current.offeringId === pending.offeringId
        && current.ownerPrincipalId === pending.ownerPrincipalId
        && current.requestKey === pending.requestKey) {
        return { created: false, draft: structuredClone(compareDraftRequest(current, pending)) };
      }
    }
    if (this.#revisions.has(pending.id)) {
      throw new EducateOsError("conflict", "That draft identifier already exists.");
    }
    this.#revisions.set(pending.id, [structuredClone(pending)]);
    return { created: true, draft: structuredClone(pending) };
  }

  async transition(input: Draft, expectedRevision: number): Promise<Draft> {
    const previous = this.#revisions.get(input.id);
    if (previous === undefined) throw new EducateOsError("not-found", "The draft was not found.");
    const current = previous.at(-1)!;
    const next = validateDraftTransition(current, input, expectedRevision);
    previous.push(structuredClone(next));
    return structuredClone(next);
  }

  async get(offeringId: string, ownerPrincipalId: string, draftId: string): Promise<Draft | undefined> {
    const current = this.#revisions.get(draftId)?.at(-1);
    return current?.offeringId === offeringId && current?.ownerPrincipalId === ownerPrincipalId
      ? structuredClone(current) : undefined;
  }

  async history(offeringId: string, ownerPrincipalId: string, draftId: string): Promise<Draft[]> {
    const all = this.#revisions.get(draftId);
    if (all === undefined || all[0]!.offeringId !== offeringId || all[0]!.ownerPrincipalId !== ownerPrincipalId) return [];
    return structuredClone(all);
  }

  async list(offeringId: string, ownerPrincipalId: string, limit = 25): Promise<Draft[]> {
    const found = [...this.#revisions.values()].map((v) => v.at(-1)!).filter(
      (d) => d.offeringId === offeringId && d.ownerPrincipalId === ownerPrincipalId,
    );
    return structuredClone(found.toReversed().slice(0, Math.max(1, Math.min(25, limit))));
  }
}
