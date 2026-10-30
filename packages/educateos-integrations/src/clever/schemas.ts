// The Clever Data API v3.1 records EducateOS reads, from Clever's reference
// (https://dev.clever.com/docs/districts, /schools, /terms, /courses, /sections, /users and
// /events-api). Only the fields EducateOS maps are named. Every schema is loose, because Clever adds
// fields without a new API version, and only what Clever marks "guaranteed" is required: anything
// else may be absent in a real district's data and is handled where it is mapped. A field Clever's
// v3.1 OpenAPI spec (github.com/Clever/swagger-api, full-v3.yml) marks `x-nullable` reads a null as
// absent. New for EducateOS.
import { z } from "zod";

/** A Clever ID: a 24-hex-digit ObjectId in every district seen, but treated as opaque. */
export const CleverId = z.string().min(1).max(255);

/** The collections EducateOS reads, in the order a complete sync reads them. */
export const CLEVER_COLLECTIONS = ["districts", "schools", "terms", "courses", "sections", "users"] as const;
/** One of {@link CLEVER_COLLECTIONS}. */
export type CleverCollection = (typeof CLEVER_COLLECTIONS)[number];

const Text = z.string().max(1000);

/** `schema` or absent, where Clever may also send `null` for absent: the parsed record has no null. */
function nullable<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === null ? undefined : value), schema.optional());
}

/**
 * A person's first or last name. Clever allows null, but a person with no name cannot be imported,
 * so a null one is the record's own error, said plainly.
 */
const PersonName = z
  .string({ error: (issue) => (issue.input === null || issue.input === undefined ? "Clever has no name here, so the person cannot be imported" : undefined) })
  .min(1)
  .max(1000);

/** A district. A district token reads exactly one. */
export const CleverDistrict = z.looseObject({
  id: CleverId,
  name: Text.min(1),
});

/** A school. */
export const CleverSchool = z.looseObject({
  id: CleverId,
  district: CleverId,
  name: Text.min(1),
  sis_id: Text.optional(),
  low_grade: nullable(Text),
  high_grade: nullable(Text),
});

/** A term. Clever documents its dates as `YYYY-MM-DD`; some districts' data carries a full timestamp. */
export const CleverTerm = z.looseObject({
  id: CleverId,
  district: CleverId,
  name: nullable(Text),
  start_date: nullable(Text),
  end_date: nullable(Text),
});

/** A course. Clever districts often have none. */
export const CleverCourse = z.looseObject({
  id: CleverId,
  district: CleverId,
  name: nullable(Text),
  number: nullable(Text),
});

/** A section. `teachers` and `students` are guaranteed; `course` and `term_id` are not. */
export const CleverSection = z.looseObject({
  id: CleverId,
  district: CleverId,
  school: CleverId,
  course: nullable(CleverId),
  term_id: nullable(CleverId),
  name: Text.optional(),
  course_name: Text.optional(),
  subject: nullable(Text),
  grade: nullable(Text),
  teacher: nullable(CleverId),
  teachers: z.array(CleverId).max(10_000),
  students: z.array(CleverId).max(10_000),
});

const Credentials = nullable(z.looseObject({ district_username: Text.optional() }));

/** The body of one of a user's roles. Each role has its own fields; these are the ones read. */
const RoleBody = z.looseObject({
  school: CleverId.optional(),
  schools: z.array(CleverId).max(1000).optional(),
  sis_id: Text.optional(),
  grade: nullable(Text),
  credentials: Credentials,
});

const ContactRole = z.looseObject({
  sis_id: nullable(Text),
  student_relationships: z.array(z.looseObject({ student: CleverId, relationship: nullable(Text) })).max(100).optional(),
});

/**
 * A v3.x user: one record per person, holding each of their roles under `roles`. A student or a
 * contact holds only that role; teachers, staff and district admins may hold several. A role the
 * user does not hold is absent or null.
 */
export const CleverUser = z.looseObject({
  id: CleverId,
  district: CleverId,
  email: nullable(Text),
  name: z.looseObject({ first: PersonName, last: PersonName, middle: nullable(Text) }),
  roles: z.looseObject({
    student: nullable(RoleBody),
    teacher: nullable(RoleBody),
    staff: nullable(RoleBody),
    district_admin: nullable(z.looseObject({})),
    contact: nullable(ContactRole),
  }),
});

/** The schema of each collection's records. */
export const CLEVER_RECORD_SCHEMAS = {
  districts: CleverDistrict,
  schools: CleverSchool,
  terms: CleverTerm,
  courses: CleverCourse,
  sections: CleverSection,
  users: CleverUser,
} as const satisfies Record<CleverCollection, z.ZodType>;

/** A validated record of one collection. */
export type CleverRecord<C extends CleverCollection> = z.infer<(typeof CLEVER_RECORD_SCHEMAS)[C]>;

/** A list response: each record wrapped with its URI, and the paging links. */
export const CleverPage = z.looseObject({
  data: z.array(z.looseObject({ data: z.unknown() })),
  links: z.array(z.looseObject({ rel: z.string(), uri: z.string() })).optional(),
});

/**
 * An event. `data.object` is the record as it is after the change (as it was, for a deletion);
 * it is validated against its collection's schema where the event is read.
 */
export const CleverEvent = z.looseObject({
  id: CleverId,
  /** Such as `users.updated`. A type EducateOS does not read is skipped, whatever its shape. */
  type: z.string().min(1).max(200),
  created: z.string().optional(),
  data: z.looseObject({ object: z.unknown() }),
});
/** A Clever event. */
export type CleverEvent = z.infer<typeof CleverEvent>;
