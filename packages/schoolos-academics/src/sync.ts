import { z } from "zod";
import {
  AcademicTerm,
  CatalogCourse,
  CourseOffering,
  Enrollment,
  Principal,
  School,
  type DistrictDirectorySnapshot,
} from "@schoolos/contracts";
import { assertSyncWritable, type AuthorityMap, type DirectoryEntityKind } from "./authority.ts";
import { replace } from "./directory.ts";
import type { AcademicStore } from "./store.ts";
import { assertTermTransition, DirectoryValidationError, validateDirectory, zodIssues } from "./validation.ts";

/**
 * Records an external system reports, keyed by their stable IDs. A batch only adds or updates
 * records; it never removes one. A student a roster no longer lists arrives as an inactive
 * enrollment, so their work is retained.
 */
export const SyncBatch = z.strictObject({
  schools: z.array(School).optional(),
  terms: z.array(AcademicTerm).optional(),
  courses: z.array(CatalogCourse).optional(),
  offerings: z.array(CourseOffering).optional(),
  principals: z.array(Principal).optional(),
  enrollments: z.array(Enrollment).optional(),
});
/** A sync batch. */
export type SyncBatch = z.infer<typeof SyncBatch>;

const BATCH_KINDS = {
  schools: "school",
  terms: "term",
  courses: "course",
  offerings: "offering",
  principals: "principal",
  enrollments: "enrollment",
} as const satisfies Record<keyof SyncBatch, DirectoryEntityKind>;

/** What {@link AcademicSync} is built from. */
export interface AcademicSyncOptions {
  /** The store the district's {@link AcademicDirectory} uses. */
  store: AcademicStore;
  /** The same source-of-record map the directory uses. */
  authority: AuthorityMap;
  /** The provider this adapter speaks for, as in `external:<provider>`. */
  provider: string;
}

/**
 * The only write path for record types an external system owns. It is a capability: holding one
 * is the authority to write as that provider, so it is handed to the provider's sync adapter and
 * never exposed through the HTTP handler or the tools. It writes only the record types the
 * {@link AuthorityMap} assigns to its provider, refusing the whole batch with `conflict` otherwise.
 *
 * Synced data meets the same rules as local writes: the whole batch is validated with
 * `checkDirectoryIntegrity` before anything is committed, and terms still only move forward.
 */
export class AcademicSync {
  readonly #store: AcademicStore;
  readonly #authority: AuthorityMap;
  readonly #provider: string;

  constructor(options: AcademicSyncOptions) {
    this.#store = options.store;
    this.#authority = options.authority;
    this.#provider = options.provider;
  }

  /** Applies a batch atomically: every record is written, or none is. */
  async apply(input: unknown): Promise<void> {
    const parsed = SyncBatch.safeParse(input);
    if (!parsed.success) throw new DirectoryValidationError("the sync batch is invalid", zodIssues(parsed.error));
    const batch = parsed.data;
    for (const key of Object.keys(batch) as (keyof SyncBatch)[]) {
      assertSyncWritable(this.#authority, BATCH_KINDS[key], this.#provider);
    }

    const { snapshot, version } = await this.#store.load();
    for (const term of batch.terms ?? []) {
      const current = snapshot.terms.find((t) => t.id === term.id);
      if (current !== undefined && current.state !== term.state) assertTermTransition(current.state, term.state);
    }
    const next: DistrictDirectorySnapshot = {
      ...snapshot,
      schools: upsert(snapshot.schools, batch.schools),
      terms: upsert(snapshot.terms, batch.terms),
      courses: upsert(snapshot.courses, batch.courses),
      offerings: upsert(snapshot.offerings, batch.offerings),
      principals: upsert(snapshot.principals, batch.principals),
      enrollments: upsert(snapshot.enrollments, batch.enrollments),
    };
    await this.#store.commit(validateDirectory(next), version);
  }
}

function upsert<T extends { id: string }>(records: T[], incoming: T[] | undefined): T[] {
  let result = records;
  for (const record of incoming ?? []) {
    result = result.some((r) => r.id === record.id) ? replace(result, record) : [...result, record];
  }
  return result;
}
