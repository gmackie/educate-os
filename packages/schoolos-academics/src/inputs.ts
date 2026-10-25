import { z } from "zod";
import {
  AcademicTerm,
  CatalogCourse,
  CourseOffering,
  Enrollment,
  ExternalIdentity,
  Principal,
  PrincipalId,
  PrincipalStatus,
  School,
  SchoolId,
  TermId,
} from "@schoolos/contracts";

// The writable fields of each record, taken from the contract schemas so the two cannot drift.
// IDs, districts, term states and enrollment statuses are never caller-supplied: the service
// assigns IDs and the district, terms start `planned`, and enrollments start `active`.

/** The fields a caller supplies to create a school. */
export const NewSchool = School.pick({ name: true, gradeBands: true });
/** Input for creating a school. */
export type NewSchool = z.infer<typeof NewSchool>;

/** The school fields a caller may change. Omitted fields are unchanged. */
export const SchoolPatch = NewSchool.partial();
/** A change to a school. */
export type SchoolPatch = z.infer<typeof SchoolPatch>;

/** The fields a caller supplies to create an academic term, which starts `planned`. */
export const NewTerm = AcademicTerm.pick({ name: true, startsOn: true, endsOn: true });
/** Input for creating a term. */
export type NewTerm = z.infer<typeof NewTerm>;

/** The term fields a caller may change. State changes only through `transitionTerm`. */
export const TermPatch = NewTerm.partial();
/** A change to a term. */
export type TermPatch = z.infer<typeof TermPatch>;

/** The fields a caller supplies to create a catalog course. */
export const NewCourse = CatalogCourse.pick({ title: true, subject: true, gradeBand: true });
/** Input for creating a catalog course. */
export type NewCourse = z.infer<typeof NewCourse>;

/** The catalog course fields a caller may change. */
export const CoursePatch = NewCourse.partial();
/** A change to a catalog course. */
export type CoursePatch = z.infer<typeof CoursePatch>;

/** The fields a caller supplies to create a course offering. */
export const NewOffering = CourseOffering.pick({ schoolId: true, termId: true, courseId: true, sectionName: true });
/** Input for creating a course offering. */
export type NewOffering = z.infer<typeof NewOffering>;

/**
 * The offering fields a caller may change. Its school, term and course are fixed: moving a section
 * between them would silently move its enrolled students' work too.
 */
export const OfferingPatch = CourseOffering.pick({ sectionName: true }).partial();
/** A change to a course offering. */
export type OfferingPatch = z.infer<typeof OfferingPatch>;

/** Filters for listing offerings. `principalId` lists the offerings that principal is actively enrolled in. */
export const OfferingFilter = z.strictObject({
  schoolId: SchoolId.optional(),
  termId: TermId.optional(),
  principalId: PrincipalId.optional(),
});
/** Offering list filters. */
export type OfferingFilter = z.infer<typeof OfferingFilter>;

/** The fields a caller supplies to enroll a principal, which starts `active`. */
export const NewEnrollment = Enrollment.pick({ offeringId: true, principalId: true, role: true });
/** Input for creating an enrollment. */
export type NewEnrollment = z.infer<typeof NewEnrollment>;

/**
 * The statuses an administrator may move a principal to: graduation and departure. Neither deletes
 * anything. Making a principal active again is the source of record's job (an enrollment or roster
 * sync), not an administrator's override.
 */
export const DepartedStatus = PrincipalStatus.exclude(["active"]);
/** A departed status. */
export type DepartedStatus = z.infer<typeof DepartedStatus>;

/**
 * The fields a caller supplies to create a principal locally (SCHO-186), for a district whose
 * authority map makes SchoolOS the source of record for principals, such as a homeschool co-op
 * with no roster. The principal starts `active`. `identity` is the sign-in that resolves to them:
 * the issuer (one the district trusts) and that issuer's stable subject, never an email address
 * (ADR-0003). Guardians and services are not created here: guardians come through guardian
 * relationships, services through deployment configuration.
 */
export const NewPrincipal = z.strictObject({
  kind: z.enum(["student", "staff"]),
  displayName: Principal.shape.displayName,
  email: Principal.shape.email,
  identity: ExternalIdentity.pick({ issuer: true, subject: true }),
});
/** Input for creating a principal. */
export type NewPrincipal = z.infer<typeof NewPrincipal>;

/**
 * The principal fields an administrator may change where SchoolOS owns principals (SCHO-212).
 * Omitted fields are unchanged, and `email: null` clears the address. Their sign-in identity is
 * fixed: it is how they are found, and moving it would hand their record to someone else. A change
 * of `kind` is refused while the principal holds an enrollment or a role (see
 * `AcademicDirectory.updatePrincipal`).
 */
export const PrincipalPatch = z.strictObject({
  kind: NewPrincipal.shape.kind.optional(),
  displayName: Principal.shape.displayName.optional(),
  email: z.union([z.email(), z.null()]).optional(),
});
/** A change to a principal. */
export type PrincipalPatch = z.infer<typeof PrincipalPatch>;
