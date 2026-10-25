import { z } from "zod";
import { ProviderName } from "./primitives.ts";

/**
 * Which system owns a directory record type. `local` means EducateOS is authoritative and accepts
 * user writes. `external:<provider>` means a roster or LMS is, and only that provider's sync adapter
 * may write: EducateOS keeps a projection, never a competing copy (roadmap §6.3).
 */
export const Authority = z.union([z.literal("local"), z.templateLiteral(["external:", ProviderName])]);
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

/**
 * Which system holds an offering's official grades. `local` means EducateOS does, and nothing is
 * sent to an LMS. `lms:<provider>` means the named LMS does, and EducateOS only publishes
 * teacher-approved grades to it. The form follows {@link Authority}, with `lms:` because only an LMS
 * can hold a gradebook.
 */
export const GradeAuthority = z.union([z.literal("local"), z.templateLiteral(["lms:", ProviderName])]);
/** A grade authority. */
export type GradeAuthority = z.infer<typeof GradeAuthority>;
