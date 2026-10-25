import { EducateOsError } from "@educateos/contracts";
import { ArtifactState } from "./model.ts";

/** The artifact records as stored, with the version optimistic concurrency checks against. */
export interface StoredArtifacts {
  /** Increases by one on every commit. */
  version: number;
  /** The state. Callers own this copy and may not assume edits to it are stored. */
  state: ArtifactState;
}

/**
 * Where one district's artifact records (not their content) are kept. A write replaces the state
 * as a whole, only if nothing else committed since it was loaded, and only if it keeps the
 * invariants {@link assertRevisionInvariants} checks.
 */
export interface ArtifactRecordStore {
  /** Reads the current state. */
  load(): Promise<StoredArtifacts>;
  /** Stores `next` if the stored version is still `expectedVersion`, and throws `conflict` if not. */
  commit(next: ArtifactState, expectedVersion: number): Promise<void>;
}

/**
 * Refuses a change that would rewrite history. Every store implementation calls it before writing:
 * a stored revision is never modified, and a revision pinned before or after the change is never
 * removed. Unpinned revisions may be removed, which is how a deleted artifact's history is
 * collected; releasing a pin and collecting its revision are therefore two commits.
 */
export function assertRevisionInvariants(previous: ArtifactState, next: ArtifactState): void {
  const after = new Map(next.revisions.map((r) => [r.id, r]));
  for (const revision of previous.revisions) {
    const kept = after.get(revision.id);
    if (kept !== undefined && canonicalJson(kept) !== canonicalJson(revision)) {
      throw new EducateOsError("policy-violation", `Revision ${revision.id} is immutable.`);
    }
  }
  for (const pin of [...previous.pins, ...next.pins]) {
    if (!after.has(pin.revisionId)) throw new EducateOsError("policy-violation", `Revision ${pin.revisionId} is pinned and cannot be removed.`);
  }
}

/** JSON with object keys sorted, so two equal records compare equal whatever order their keys are in. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/** An {@link ArtifactRecordStore} held in memory, for tests and the local harness. */
export class InMemoryArtifactRecordStore implements ArtifactRecordStore {
  #state: ArtifactState = { artifacts: [], revisions: [], pins: [], shares: [] };
  #version = 0;

  async load(): Promise<StoredArtifacts> {
    return { version: this.#version, state: structuredClone(this.#state) };
  }

  async commit(next: ArtifactState, expectedVersion: number): Promise<void> {
    if (expectedVersion !== this.#version) {
      throw new EducateOsError("conflict", "The artifacts changed while this request was in progress; retry it.");
    }
    const parsed = ArtifactState.parse(next);
    assertRevisionInvariants(this.#state, parsed);
    this.#state = structuredClone(parsed);
    this.#version += 1;
  }
}
