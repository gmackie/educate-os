import { z } from "zod";
import {
  CourseId,
  DistrictId,
  EnrollmentId,
  OfferingId,
  PrincipalId,
  SchoolId,
  TermId,
} from "./ids";
import { Principal, RoleAssignment } from "./identity";

/** A district: the tenant, and the owner of every record beneath it. */
export const District = z.strictObject({
  id: DistrictId,
  name: z.string().min(1).max(200),
  /** IANA time zone used for term dates and deadlines. */
  timeZone: z.string().min(1),
  /** The issuers whose identities this district trusts. An identity from any other is rejected. */
  trustedIssuers: z.array(z.url({ protocol: /^https$/ })).min(1),
});
/** A district. */
export type District = z.infer<typeof District>;

/**
 * A grade band as published: a single grade (`K`, `7`) or an inclusive range (`9-12`). Bands are
 * kept as written and never flattened to one numeric grade.
 */
export const GradeBand = z.string().regex(/^(K|\d{1,2})(-\d{1,2})?$/, "expected a grade band such as K, 7 or 9-12");
/** A grade band. */
export type GradeBand = z.infer<typeof GradeBand>;

/** A school within a district. */
export const School = z.strictObject({
  id: SchoolId,
  districtId: DistrictId,
  name: z.string().min(1).max(200),
  gradeBands: z.array(GradeBand).min(1),
});
/** A school. */
export type School = z.infer<typeof School>;

/**
 * Where an academic term is in its life. A term's state changes permissions and funding, not
 * whether its work exists: closing a term never deletes anything (roadmap §6.1).
 */
export const TermState = z.enum(["planned", "active", "grading", "completed"]);
/** A term state. */
export type TermState = z.infer<typeof TermState>;

/** An academic term. */
export const AcademicTerm = z.strictObject({
  id: TermId,
  districtId: DistrictId,
  name: z.string().min(1).max(200),
  startsOn: z.iso.date(),
  endsOn: z.iso.date(),
  state: TermState,
});
/** An academic term. */
export type AcademicTerm = z.infer<typeof AcademicTerm>;

/**
 * The broad subject of a course. Subjects are deliberately not limited to STEM; every SchoolOS
 * milestone must work for writing, science, history and at least one of mathematics or the arts.
 */
export const Subject = z.enum([
  "english-language-arts",
  "science",
  "history-social-studies",
  "mathematics",
  "arts",
  "world-languages",
  "computer-science",
  "health-physical-education",
  "social-emotional-learning",
  "other",
]);
/** A subject. */
export type Subject = z.infer<typeof Subject>;

/** A catalog course: the reusable definition (Biology I), not any one class of it. */
export const CatalogCourse = z.strictObject({
  id: CourseId,
  districtId: DistrictId,
  title: z.string().min(1).max(200),
  subject: Subject,
  gradeBand: GradeBand,
});
/** A catalog course. */
export type CatalogCourse = z.infer<typeof CatalogCourse>;

/** One section of a catalog course, taught in one school and term. */
export const CourseOffering = z.strictObject({
  id: OfferingId,
  districtId: DistrictId,
  schoolId: SchoolId,
  termId: TermId,
  courseId: CourseId,
  sectionName: z.string().min(1).max(100),
});
/** A course offering. */
export type CourseOffering = z.infer<typeof CourseOffering>;

/** A principal's participation in an offering, as a learner or as instructional staff. */
export const Enrollment = z.strictObject({
  id: EnrollmentId,
  districtId: DistrictId,
  offeringId: OfferingId,
  principalId: PrincipalId,
  role: z.enum(["student", "teacher", "co-teacher"]),
  /**
   * Inactive enrollments stay on record. A student dropped from a roster loses live course access,
   * but their workspace and work are retained (roadmap §14).
   */
  status: z.enum(["active", "inactive"]),
});
/** An enrollment. */
export type Enrollment = z.infer<typeof Enrollment>;

/**
 * Everything a district directory holds at a point in time: the shape a roster import produces
 * and the shape synthetic fixtures are written in. It carries no workspaces or work.
 */
export const DistrictDirectorySnapshot = z.strictObject({
  district: District,
  schools: z.array(School),
  terms: z.array(AcademicTerm),
  courses: z.array(CatalogCourse),
  offerings: z.array(CourseOffering),
  principals: z.array(Principal),
  enrollments: z.array(Enrollment),
  roleAssignments: z.array(RoleAssignment),
});
/** A district directory snapshot. */
export type DistrictDirectorySnapshot = z.infer<typeof DistrictDirectorySnapshot>;
