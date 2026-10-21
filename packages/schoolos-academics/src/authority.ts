import { SchoolOsError, type AuthorityMap } from "@schoolos/contracts";

/** The record types an `AuthorityMap` assigns a source of record to. */
export const DIRECTORY_ENTITY_KINDS = ["school", "term", "course", "offering", "enrollment", "principal"] as const;

/** One of {@link DIRECTORY_ENTITY_KINDS}. */
export type DirectoryEntityKind = (typeof DIRECTORY_ENTITY_KINDS)[number];

const PLURALS: Record<DirectoryEntityKind, string> = {
  school: "Schools",
  term: "Academic terms",
  course: "Catalog courses",
  offering: "Course offerings",
  enrollment: "Enrollments",
  principal: "Principals",
};

/**
 * Refuses a user-initiated write to a record type an external system owns, naming that system so
 * the caller knows where to make the change instead.
 */
export function assertLocallyWritable(authority: AuthorityMap, kind: DirectoryEntityKind): void {
  const owner = authority[kind];
  if (owner === "local") return;
  throw new SchoolOsError(
    "conflict",
    `${PLURALS[kind]} are owned by ${owner}; change them there and let its sync update SchoolOS.`,
  );
}

/** Refuses a sync write from a provider that does not own the record type. */
export function assertSyncWritable(authority: AuthorityMap, kind: DirectoryEntityKind, provider: string): void {
  const owner = authority[kind];
  if (owner === `external:${provider}`) return;
  throw new SchoolOsError("conflict", `${PLURALS[kind]} are owned by ${owner}, not external:${provider}.`);
}
