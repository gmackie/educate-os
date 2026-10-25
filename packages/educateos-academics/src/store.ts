import { EducateOsError, type DistrictDirectorySnapshot } from "@educateos/contracts";
import { validateDirectory } from "./validation.ts";

/** A district directory as stored, with the version optimistic concurrency checks against. */
export interface StoredDirectory {
  /** Increases by one on every commit. */
  version: number;
  /** The directory. Callers own this copy and may not assume edits to it are stored. */
  snapshot: DistrictDirectorySnapshot;
}

/**
 * Where one district's directory is kept. A write replaces the directory as a whole, and only if
 * nothing else committed since it was loaded, so the integrity check that ran on the candidate is
 * still true of what is stored. The in-memory store keeps the whole snapshot; a D1 store can diff
 * `next` against what it holds and write the changed rows in one batch.
 *
 * Stores hold one district. The district itself never changes through a commit.
 */
export interface AcademicStore {
  /** Reads the current directory. */
  load(): Promise<StoredDirectory>;
  /**
   * Stores `next` if the stored version is still `expectedVersion`, and throws `conflict` if not.
   * `next` has already been validated; stores do not re-check business rules.
   */
  commit(next: DistrictDirectorySnapshot, expectedVersion: number): Promise<void>;
}

/** An {@link AcademicStore} held in memory, for tests, the local harness and the fallback service. */
export class InMemoryAcademicStore implements AcademicStore {
  #snapshot: DistrictDirectorySnapshot;
  #version = 0;

  private constructor(snapshot: DistrictDirectorySnapshot) {
    this.#snapshot = snapshot;
  }

  /**
   * A store seeded from a directory snapshot, such as a synthetic district. The snapshot is parsed
   * and integrity-checked first, and refused with `validation-failed` listing every issue.
   */
  static seeded(snapshot: DistrictDirectorySnapshot): InMemoryAcademicStore {
    return new InMemoryAcademicStore(structuredClone(validateDirectory(snapshot)));
  }

  async load(): Promise<StoredDirectory> {
    return { version: this.#version, snapshot: structuredClone(this.#snapshot) };
  }

  async commit(next: DistrictDirectorySnapshot, expectedVersion: number): Promise<void> {
    if (expectedVersion !== this.#version) {
      throw new EducateOsError("conflict", "The directory changed while this request was in progress; retry it.");
    }
    if (next.district.id !== this.#snapshot.district.id) {
      throw new EducateOsError("conflict", "A directory store holds one district, which a commit cannot change.");
    }
    this.#snapshot = structuredClone(next);
    this.#version += 1;
  }
}
