import { z } from "zod";
import { SchoolOsError } from "@schoolos/contracts";

/** The record types an {@link AuthorityMap} assigns a source of record to. */
export const DIRECTORY_ENTITY_KINDS = ["school", "term", "course", "offering", "enrollment", "principal"] as const;

/** One of {@link DIRECTORY_ENTITY_KINDS}. */
export type DirectoryEntityKind = (typeof DIRECTORY_ENTITY_KINDS)[number];

/**
 * Which system owns a record type. `local` means SchoolOS is authoritative and the fallback service
 * accepts user writes. `external:<provider>` means a roster or LMS is, and only that provider's sync
 * adapter may write: SchoolOS keeps a projection, never a competing copy (roadmap §6.3).
 */
export const Authority = z.union([
  z.literal("local"),
  z.templateLiteral(["external:", z.string().regex(/^[a-z][a-z0-9-]{0,62}$/)]),
]);
/** A source of record. */
export type Authority = z.infer<typeof Authority>;

/** The source of record for every directory record type. Every type must be stated; none defaults. */
export const AuthorityMap = z.strictObject({
  school: Authority,
  term: Authority,
  course: Authority,
  offering: Authority,
  enrollment: Authority,
  principal: Authority,
});
/** The source of record for each directory record type. */
export type AuthorityMap = z.infer<typeof AuthorityMap>;

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
