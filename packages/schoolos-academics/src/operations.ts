import { z } from "zod";
import {
  CourseId,
  EnrollmentId,
  OfferingId,
  PrincipalId,
  SchoolId,
  SchoolOsError,
  TermId,
  TermState,
  type Caller,
  type SchoolOsErrorBody,
} from "@schoolos/contracts";
import type { AcademicDirectory } from "./directory.ts";
import {
  CoursePatch,
  DepartedStatus,
  NewCourse,
  NewEnrollment,
  NewOffering,
  NewSchool,
  NewTerm,
  OfferingFilter,
  OfferingPatch,
  SchoolPatch,
  TermPatch,
} from "./inputs.ts";
import { DirectoryValidationError, zodIssues } from "./validation.ts";

/**
 * One {@link AcademicDirectory} operation as a named, schema-checked function. The HTTP routes and
 * the MCP tools are both built from {@link ACADEMIC_OPERATIONS} and both run through
 * {@link invokeOperation}, so they cannot disagree about validation, authorization or rules.
 */
export interface AcademicOperation {
  /** A stable snake_case name, used as the tool name. */
  name: string;
  /** What the operation does, for tool listings. */
  description: string;
  /** The operation's whole input. Unknown fields are rejected. */
  input: z.ZodType;
  /** Runs the operation with input that `input` has already parsed. */
  run(directory: AcademicDirectory, caller: Caller, input: unknown): Promise<unknown>;
}

function defineOperation<S extends z.ZodType>(definition: {
  name: string;
  description: string;
  input: S;
  run: (directory: AcademicDirectory, caller: Caller, input: z.output<S>) => Promise<unknown>;
}): AcademicOperation {
  return definition as AcademicOperation;
}

const none = z.strictObject({});
const withSchool = z.strictObject({ schoolId: SchoolId });
const withTerm = z.strictObject({ termId: TermId });
const withCourse = z.strictObject({ courseId: CourseId });
const withOffering = z.strictObject({ offeringId: OfferingId });
const withEnrollment = z.strictObject({ enrollmentId: EnrollmentId });

/** Every operation the fallback service exposes, by name. */
export const ACADEMIC_OPERATIONS = {
  list_schools: defineOperation({
    name: "list_schools",
    description: "List the schools you may see.",
    input: none,
    run: (d, c) => d.listSchools(c),
  }),
  get_school: defineOperation({
    name: "get_school",
    description: "Get one school.",
    input: withSchool,
    run: (d, c, i) => d.getSchool(c, i.schoolId),
  }),
  create_school: defineOperation({
    name: "create_school",
    description: "Create a school.",
    input: NewSchool,
    run: (d, c, i) => d.createSchool(c, i),
  }),
  update_school: defineOperation({
    name: "update_school",
    description: "Change a school's name or grade bands.",
    input: withSchool.extend(SchoolPatch.shape),
    run: (d, c, { schoolId, ...patch }) => d.updateSchool(c, schoolId, patch),
  }),
  list_terms: defineOperation({
    name: "list_terms",
    description: "List academic terms, optionally only those in one state.",
    input: z.strictObject({ state: TermState.optional() }),
    run: (d, c, i) => d.listTerms(c, i),
  }),
  get_term: defineOperation({
    name: "get_term",
    description: "Get one academic term.",
    input: withTerm,
    run: (d, c, i) => d.getTerm(c, i.termId),
  }),
  create_term: defineOperation({
    name: "create_term",
    description: "Create an academic term. It starts planned.",
    input: NewTerm,
    run: (d, c, i) => d.createTerm(c, i),
  }),
  update_term: defineOperation({
    name: "update_term",
    description: "Change an academic term's name or dates.",
    input: withTerm.extend(TermPatch.shape),
    run: (d, c, { termId, ...patch }) => d.updateTerm(c, termId, patch),
  }),
  transition_term: defineOperation({
    name: "transition_term",
    description: "Move an academic term to its next state: planned, active, grading, completed.",
    input: withTerm.extend({ to: TermState }),
    run: (d, c, i) => d.transitionTerm(c, i.termId, i.to),
  }),
  list_courses: defineOperation({
    name: "list_courses",
    description: "List catalog courses.",
    input: none,
    run: (d, c) => d.listCourses(c),
  }),
  get_course: defineOperation({
    name: "get_course",
    description: "Get one catalog course.",
    input: withCourse,
    run: (d, c, i) => d.getCourse(c, i.courseId),
  }),
  create_course: defineOperation({
    name: "create_course",
    description: "Create a catalog course.",
    input: NewCourse,
    run: (d, c, i) => d.createCourse(c, i),
  }),
  update_course: defineOperation({
    name: "update_course",
    description: "Change a catalog course's title, subject or grade band.",
    input: withCourse.extend(CoursePatch.shape),
    run: (d, c, { courseId, ...patch }) => d.updateCourse(c, courseId, patch),
  }),
  list_offerings: defineOperation({
    name: "list_offerings",
    description: "List course offerings, by school, term or a principal's active enrollments.",
    input: OfferingFilter,
    run: (d, c, i) => d.listOfferings(c, i),
  }),
  get_offering: defineOperation({
    name: "get_offering",
    description: "Get one course offering.",
    input: withOffering,
    run: (d, c, i) => d.getOffering(c, i.offeringId),
  }),
  create_offering: defineOperation({
    name: "create_offering",
    description: "Create a course offering: a section of a catalog course in one school and term.",
    input: NewOffering,
    run: (d, c, i) => d.createOffering(c, i),
  }),
  update_offering: defineOperation({
    name: "update_offering",
    description: "Rename a course offering's section.",
    input: withOffering.extend(OfferingPatch.shape),
    run: (d, c, { offeringId, ...patch }) => d.updateOffering(c, offeringId, patch),
  }),
  get_roster: defineOperation({
    name: "get_roster",
    description: "List the active enrollments of a course offering.",
    input: withOffering,
    run: (d, c, i) => d.roster(c, i.offeringId),
  }),
  list_enrollments: defineOperation({
    name: "list_enrollments",
    description: "List a principal's enrollments.",
    input: z.strictObject({ principalId: PrincipalId }),
    run: (d, c, i) => d.listEnrollments(c, i.principalId),
  }),
  my_enrollments: defineOperation({
    name: "my_enrollments",
    description: "List your own enrollments.",
    input: none,
    run: (d, c) => d.listEnrollments(c, c.principal.principalId),
  }),
  get_enrollment: defineOperation({
    name: "get_enrollment",
    description: "Get one enrollment.",
    input: withEnrollment,
    run: (d, c, i) => d.getEnrollment(c, i.enrollmentId),
  }),
  create_enrollment: defineOperation({
    name: "create_enrollment",
    description: "Enroll a principal in a course offering.",
    input: NewEnrollment,
    run: (d, c, i) => d.createEnrollment(c, i),
  }),
  deactivate_enrollment: defineOperation({
    name: "deactivate_enrollment",
    description: "Remove a principal from a course offering. The enrollment is kept, marked inactive.",
    input: withEnrollment,
    run: (d, c, i) => d.deactivateEnrollment(c, i.enrollmentId),
  }),
  set_principal_status: defineOperation({
    name: "set_principal_status",
    description: "Mark a principal graduated or inactive. Their records and work are kept; their class access ends.",
    input: z.strictObject({ principalId: PrincipalId, status: DepartedStatus }),
    run: (d, c, i) => d.setPrincipalStatus(c, i.principalId, i.status),
  }),
} satisfies Record<string, AcademicOperation>;

/** The name of an operation in {@link ACADEMIC_OPERATIONS}. */
export type AcademicOperationName = keyof typeof ACADEMIC_OPERATIONS;

/** An operation's outcome, in the shape both surfaces return. */
export type OperationOutcome = { ok: true; value: unknown } | { ok: false; error: SchoolOsErrorBody };

/**
 * Parses `input` and runs the operation, converting failures to error bodies. Every decision the
 * operation makes is audited under one correlation ID, the caller's if it brings one, and every
 * error body names it, so a refusal a user reports leads straight to the audit entries behind it.
 * Unexpected errors become `unavailable` with a generic message, so internal detail never reaches
 * the caller; they are logged under the same ID instead.
 */
export async function invokeOperation(
  operation: AcademicOperation,
  directory: AcademicDirectory,
  caller: Caller,
  input: unknown,
): Promise<OperationOutcome> {
  const correlationId = caller.correlationId ?? crypto.randomUUID();
  try {
    const parsed = operation.input.safeParse(input);
    if (!parsed.success) throw new DirectoryValidationError("the request is invalid", zodIssues(parsed.error));
    return { ok: true, value: await operation.run(directory, { ...caller, correlationId }, parsed.data) };
  } catch (error) {
    if (error instanceof SchoolOsError) return { ok: false, error: { ...error.toBody(), correlationId } };
    // The caller gets nothing internal, so this log line is the only record of what went wrong.
    console.error("academics operation failed", { operation: operation.name, correlationId, error });
    return {
      ok: false,
      error: { code: "unavailable", message: "The academic directory could not complete the request.", correlationId },
    };
  }
}
