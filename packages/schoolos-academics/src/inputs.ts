import { z } from "zod";
import {
  AcademicTerm,
  CatalogCourse,
  CourseOffering,
  Enrollment,
  PrincipalId,
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
