// How SchoolOS records relate to OneRoster records. PlayTrek kept this relation in its
// `external_identities` table (packages/edtech/src/oneroster/sync.ts at commit 7258e4347); SchoolOS
// keeps it as a plain map returned beside each snapshot, so this package needs no database.
import { CourseId, EnrollmentId, ID_PREFIXES, OfferingId, PrincipalId, SchoolId, TermId } from "@schoolos/contracts";
import type { DistrictId } from "@schoolos/contracts";
import { z } from "zod";
import { SourcedId } from "./spec.ts";

/**
 * The OneRoster `sourcedId` behind each SchoolOS record a roster import created or linked, by
 * entity type. Records absent from it were not made by an import, and an import leaves them alone.
 *
 * A principal also records whether the roster still lists it. A principal the roster stops listing
 * stays in the directory (see `import.ts`), so the snapshot alone cannot say it was deactivated.
 */
export const OneRosterSourceMap = z.strictObject({
  schools: z.record(SchoolId, SourcedId),
  terms: z.record(TermId, SourcedId),
  courses: z.record(CourseId, SourcedId),
  offerings: z.record(OfferingId, SourcedId),
  principals: z.record(PrincipalId, z.strictObject({ sourcedId: SourcedId, active: z.boolean() })),
  enrollments: z.record(EnrollmentId, SourcedId),
});
/** A OneRoster source map. */
export type OneRosterSourceMap = z.infer<typeof OneRosterSourceMap>;

/** The source map of a directory no roster import has touched. */
export const EMPTY_SOURCE_MAP: OneRosterSourceMap = {
  schools: {},
  terms: {},
  courses: {},
  offerings: {},
  principals: {},
  enrollments: {},
};

/** The SchoolOS entity types a OneRoster import creates. */
export type ImportedKind = keyof OneRosterSourceMap;

const KIND_PREFIX = {
  schools: ID_PREFIXES.school,
  terms: ID_PREFIXES.term,
  courses: ID_PREFIXES.course,
  offerings: ID_PREFIXES.offering,
  principals: ID_PREFIXES.principal,
  enrollments: ID_PREFIXES.enrollment,
} as const satisfies Record<ImportedKind, string>;

/**
 * The SchoolOS ID a OneRoster record receives when it first appears, such as `prn_or-3f9a…`: a
 * SHA-256 digest of the district, entity type and `sourcedId`, cut to 128 bits. Re-importing the
 * same feed therefore yields the same IDs, while the ID reveals nothing about the `sourcedId`, which
 * is often a student number.
 */
export async function derivedId(districtId: DistrictId, kind: ImportedKind, sourcedId: string): Promise<string> {
  const input = new TextEncoder().encode(JSON.stringify([districtId, kind, sourcedId]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  const hex = Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${KIND_PREFIX[kind]}_or-${hex}`;
}
