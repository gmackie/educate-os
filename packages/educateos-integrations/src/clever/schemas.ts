// The Clever Data API v3.1 records EducateOS reads, from Clever's reference
// (https://dev.clever.com/docs/districts, /schools, /terms, /courses, /sections, /users and
// /events-api). Only the fields EducateOS maps are named. Every schema is loose, because Clever adds
// fields without a new API version, and only what Clever marks "guaranteed" is required: anything
// else may be absent in a real district's data and is handled where it is mapped. New for EducateOS.
import { z } from "zod";

/** A Clever ID: a 24-hex-digit ObjectId in every district seen, but treated as opaque. */
export const CleverId = z.string().min(1).max(255);

/** The collections EducateOS reads, in the order a complete sync reads them. */
export const CLEVER_COLLECTIONS = ["districts", "schools", "terms", "courses", "sections", "users"] as const;
/** One of {@link CLEVER_COLLECTIONS}. */
export type CleverCollection = (typeof CLEVER_COLLECTIONS)[number];

const Text = z.string().max(1000);

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
  low_grade: Text.optional(),
  high_grade: Text.optional(),
});

/** A term. Clever documents its dates as `YYYY-MM-DD`; some districts' data carries a full timestamp. */
export const CleverTerm = z.looseObject({
  id: CleverId,
  district: CleverId,
  name: Text.optional(),
  start_date: Text.optional(),
  end_date: Text.optional(),
});

/** A course. Clever districts often have none, and the shape varies between SIS integrations. */
export const CleverCourse = z.looseObject({
  id: CleverId,
  district: CleverId,
  name: Text.optional(),
  number: Text.optional(),
});

/** A section. `teachers` and `students` are guaranteed; `course` and `term_id` are not. */
export const CleverSection = z.looseObject({
  id: CleverId,
  district: CleverId,
  school: CleverId,
  course: CleverId.optional(),
  term_id: CleverId.optional(),
  name: Text.optional(),
  course_name: Text.optional(),
  subject: Text.optional(),
  grade: Text.optional(),
  teacher: CleverId.optional(),
  teachers: z.array(CleverId).max(10_000),
  students: z.array(CleverId).max(10_000),
});

const Credentials = z.looseObject({ district_username: Text.optional() }).optional();

/** The body of one of a user's roles. Each role has its own fields; these are the ones read. */
const RoleBody = z.looseObject({
  school: CleverId.optional(),
  schools: z.array(CleverId).max(1000).optional(),
  sis_id: Text.optional(),
  grade: Text.optional(),
  credentials: Credentials,
});

const ContactRole = z.looseObject({
  sis_id: Text.optional(),
  student_relationships: z.array(z.looseObject({ student: CleverId, relationship: Text.optional() })).max(100).optional(),
});

/**
 * A v3.x user: one record per person, holding each of their roles under `roles`. A student or a
 * contact holds only that role; teachers, staff and district admins may hold several.
 */
export const CleverUser = z.looseObject({
  id: CleverId,
  district: CleverId,
  email: Text.optional(),
  name: z.looseObject({ first: Text.min(1), last: Text.min(1), middle: Text.optional() }),
  roles: z.looseObject({
    student: RoleBody.optional(),
    teacher: RoleBody.optional(),
    staff: RoleBody.optional(),
    district_admin: z.looseObject({}).optional(),
    contact: ContactRole.optional(),
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
