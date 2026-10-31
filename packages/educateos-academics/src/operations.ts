import { z } from "zod";
import {
  AcademicTerm,
  assertOperationDescriptor,
  CatalogCourse,
  CourseId,
  CourseOffering,
  Enrollment,
  EnrollmentId,
  OfferingId,
  operationChannelFor,
  Principal,
  PrincipalId,
  School,
  SchoolId,
  EducateOsError,
  TermId,
  TermState,
  type Action,
  type Caller,
  type EducateOsErrorBody,
  type OperationChannel,
  type OperationDescriptorFields,
} from "@educateos/contracts";
import { assertOperationRoutable, type DirectoryEntityKind } from "./authority.ts";
import type { AcademicDirectory } from "./directory.ts";
import {
  CoursePatch,
  DepartedStatus,
  NewCourse,
  NewEnrollment,
  NewOffering,
  NewPrincipal,
  NewSchool,
  NewTerm,
  OfferingFilter,
  OfferingPatch,
  PrincipalPatch,
  SchoolPatch,
  TermPatch,
} from "./inputs.ts";
import { DirectoryValidationError, zodIssues } from "./validation.ts";

/**
 * One {@link AcademicDirectory} operation as a named, schema-checked function: the operation
 * descriptor (RFC 0002 §2). The HTTP routes and the MCP tools are both built from
 * {@link ACADEMIC_OPERATIONS} and both run through {@link invokeOperation}, so they cannot disagree
 * about validation, authorization, rules or which channels may reach an operation at all.
 */
export interface AcademicOperation extends OperationDescriptorFields {
  /** A stable snake_case name, used as the tool name. */
  name: string;
  /** What the operation does, for tool listings. */
  description: string;
  /** The action the operation is, in the authorization vocabulary, for surfaces that classify it. */
  action: Action;
  /** The record type whose source of record the operation reads or writes. */
  authority: DirectoryEntityKind;
  /** The operation's whole input. Unknown fields are rejected. */
  input: z.ZodType;
  /** What a successful call returns. */
  output: z.ZodType;
  /** Runs the operation with input that `input` has already parsed. */
  run(directory: AcademicDirectory, caller: Caller, input: unknown): Promise<unknown>;
}

function defineOperation<S extends z.ZodType, O extends z.ZodType>(
  definition: Omit<AcademicOperation, "input" | "output" | "run"> & {
    input: S;
    output: O;
    run: (directory: AcademicDirectory, caller: Caller, input: z.output<S>) => Promise<z.output<O>>;
  },
): AcademicOperation {
  assertOperationDescriptor(definition.name, definition);
  return definition as AcademicOperation;
}

/** Every directory operation is exposed to the district's screens, its API and agents. */
const EVERYWHERE = ["ui", "rest", "mcp-agent"] as const satisfies readonly OperationChannel[];
/** A read: changes nothing, so it repeats harmlessly and no call waits for anyone. */
const READ = { version: 1, effect: "read", idempotency: "inherent", approval: "none", channels: EVERYWHERE } as const;
/** A direct write to a directory record: an agent's call waits for the requester to confirm it. */
const WRITE = { version: 1, effect: "write", approval: "confirm-agent", channels: EVERYWHERE } as const;

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
    ...READ,
    action: "list",
    authority: "school",
    input: none,
    output: z.array(School),
    run: (d, c) => d.listSchools(c),
  }),
  get_school: defineOperation({
    name: "get_school",
    description: "Get one school.",
    ...READ,
    action: "read",
    authority: "school",
    input: withSchool,
    output: School,
    run: (d, c, i) => d.getSchool(c, i.schoolId),
  }),
  create_school: defineOperation({
    name: "create_school",
    description: "Create a school.",
    ...WRITE,
    action: "create",
    idempotency: "none",
    authority: "school",
    input: NewSchool,
    output: School,
    run: (d, c, i) => d.createSchool(c, i),
  }),
  update_school: defineOperation({
    name: "update_school",
    description: "Change a school's name or grade bands.",
    ...WRITE,
    action: "update",
    idempotency: "inherent",
    authority: "school",
    input: withSchool.extend(SchoolPatch.shape),
    output: School,
    run: (d, c, { schoolId, ...patch }) => d.updateSchool(c, schoolId, patch),
  }),
  list_terms: defineOperation({
    name: "list_terms",
    description: "List academic terms, optionally only those in one state.",
    ...READ,
    action: "list",
    authority: "term",
    input: z.strictObject({ state: TermState.optional() }),
    output: z.array(AcademicTerm),
    run: (d, c, i) => d.listTerms(c, i),
  }),
  get_term: defineOperation({
    name: "get_term",
    description: "Get one academic term.",
    ...READ,
    action: "read",
    authority: "term",
    input: withTerm,
    output: AcademicTerm,
    run: (d, c, i) => d.getTerm(c, i.termId),
  }),
  create_term: defineOperation({
    name: "create_term",
    description: "Create an academic term. It starts planned.",
    ...WRITE,
    action: "create",
    idempotency: "none",
    authority: "term",
    input: NewTerm,
    output: AcademicTerm,
    run: (d, c, i) => d.createTerm(c, i),
  }),
  update_term: defineOperation({
    name: "update_term",
    description: "Change an academic term's name or dates.",
    ...WRITE,
    action: "update",
    idempotency: "inherent",
    authority: "term",
    input: withTerm.extend(TermPatch.shape),
    output: AcademicTerm,
    run: (d, c, { termId, ...patch }) => d.updateTerm(c, termId, patch),
  }),
  transition_term: defineOperation({
    name: "transition_term",
    description: "Move an academic term to its next state: planned, active, grading, completed.",
    ...WRITE,
    action: "update",
    idempotency: "inherent",
    authority: "term",
    input: withTerm.extend({ to: TermState }),
    output: AcademicTerm,
    run: (d, c, i) => d.transitionTerm(c, i.termId, i.to),
  }),
  list_courses: defineOperation({
    name: "list_courses",
    description: "List catalog courses.",
    ...READ,
    action: "list",
    authority: "course",
    input: none,
    output: z.array(CatalogCourse),
    run: (d, c) => d.listCourses(c),
  }),
  get_course: defineOperation({
    name: "get_course",
    description: "Get one catalog course.",
    ...READ,
    action: "read",
    authority: "course",
    input: withCourse,
    output: CatalogCourse,
    run: (d, c, i) => d.getCourse(c, i.courseId),
  }),
  create_course: defineOperation({
    name: "create_course",
    description: "Create a catalog course.",
    ...WRITE,
    action: "create",
    idempotency: "none",
    authority: "course",
    input: NewCourse,
    output: CatalogCourse,
    run: (d, c, i) => d.createCourse(c, i),
  }),
  update_course: defineOperation({
    name: "update_course",
    description: "Change a catalog course's title, subject or grade band.",
    ...WRITE,
    action: "update",
    idempotency: "inherent",
    authority: "course",
    input: withCourse.extend(CoursePatch.shape),
    output: CatalogCourse,
    run: (d, c, { courseId, ...patch }) => d.updateCourse(c, courseId, patch),
  }),
  set_course_archived: defineOperation({
    name: "set_course_archived",
    description: "Archive a catalog course, or restore an archived one. Archived courses accept no new offerings.",
    ...WRITE,
    action: "update",
    idempotency: "inherent",
    authority: "course",
    input: withCourse.extend({ archived: z.boolean() }),
    output: CatalogCourse,
    run: (d, c, i) => d.setCourseArchived(c, i.courseId, i.archived),
  }),
  list_offerings: defineOperation({
    name: "list_offerings",
    description: "List course offerings, by school, term or a principal's active enrollments.",
    ...READ,
    action: "list",
    authority: "offering",
    input: OfferingFilter,
    output: z.array(CourseOffering),
    run: (d, c, i) => d.listOfferings(c, i),
  }),
  get_offering: defineOperation({
    name: "get_offering",
    description: "Get one course offering.",
    ...READ,
    action: "read",
    authority: "offering",
    input: withOffering,
    output: CourseOffering,
    run: (d, c, i) => d.getOffering(c, i.offeringId),
  }),
  create_offering: defineOperation({
    name: "create_offering",
    description: "Create a course offering: a section of a catalog course in one school and term.",
    ...WRITE,
    action: "create",
    idempotency: "none",
    authority: "offering",
    input: NewOffering,
    output: CourseOffering,
    run: (d, c, i) => d.createOffering(c, i),
  }),
  update_offering: defineOperation({
    name: "update_offering",
    description: "Rename a course offering's section.",
    ...WRITE,
    action: "update",
    idempotency: "inherent",
    authority: "offering",
    input: withOffering.extend(OfferingPatch.shape),
    output: CourseOffering,
    run: (d, c, { offeringId, ...patch }) => d.updateOffering(c, offeringId, patch),
  }),
  set_offering_archived: defineOperation({
    name: "set_offering_archived",
    description: "Archive a course offering, or restore an archived one. Archived offerings accept no new enrollments.",
    ...WRITE,
    action: "update",
    idempotency: "inherent",
    authority: "offering",
    input: withOffering.extend({ archived: z.boolean() }),
    output: CourseOffering,
    run: (d, c, i) => d.setOfferingArchived(c, i.offeringId, i.archived),
  }),
  get_roster: defineOperation({
    name: "get_roster",
    description: "List the active enrollments of a course offering.",
    ...READ,
    action: "list",
    authority: "enrollment",
    input: withOffering,
    output: z.array(Enrollment),
    run: (d, c, i) => d.roster(c, i.offeringId),
  }),
  list_enrollments: defineOperation({
    name: "list_enrollments",
    description: "List a principal's enrollments.",
    ...READ,
    action: "list",
    authority: "enrollment",
    input: z.strictObject({ principalId: PrincipalId }),
    output: z.array(Enrollment),
    run: (d, c, i) => d.listEnrollments(c, i.principalId),
  }),
  my_enrollments: defineOperation({
    name: "my_enrollments",
    description: "List your own enrollments.",
    ...READ,
    action: "list",
    authority: "enrollment",
    input: none,
    output: z.array(Enrollment),
    run: (d, c) => d.listEnrollments(c, c.principal.principalId),
  }),
  get_enrollment: defineOperation({
    name: "get_enrollment",
    description: "Get one enrollment.",
    ...READ,
    action: "read",
    authority: "enrollment",
    input: withEnrollment,
    output: Enrollment,
    run: (d, c, i) => d.getEnrollment(c, i.enrollmentId),
  }),
  create_enrollment: defineOperation({
    name: "create_enrollment",
    description: "Enroll a principal in a course offering.",
    ...WRITE,
    action: "create",
    idempotency: "none",
    authority: "enrollment",
    input: NewEnrollment,
    output: Enrollment,
    run: (d, c, i) => d.createEnrollment(c, i),
  }),
  deactivate_enrollment: defineOperation({
    name: "deactivate_enrollment",
    description: "Remove a principal from a course offering. The enrollment is kept, marked inactive.",
    ...WRITE,
    action: "update",
    idempotency: "inherent",
    authority: "enrollment",
    input: withEnrollment,
    output: Enrollment,
    run: (d, c, i) => d.deactivateEnrollment(c, i.enrollmentId),
  }),
  create_principal: defineOperation({
    name: "create_principal",
    description: "Create a student or staff principal with the sign-in identity that resolves to them, where EducateOS owns principals.",
    ...WRITE,
    // It links a sign-in identity to the principal, and identity links are never agent tools
    // (RFC 0002 §2).
    channels: ["ui", "rest"],
    action: "create",
    idempotency: "none",
    authority: "principal",
    input: NewPrincipal,
    output: Principal,
    run: (d, c, i) => d.createPrincipal(c, i),
  }),
  set_principal_status: defineOperation({
    name: "set_principal_status",
    description: "Mark a principal graduated or inactive. Their records and work are kept; their class access ends.",
    ...WRITE,
    action: "update",
    idempotency: "inherent",
    authority: "principal",
    input: z.strictObject({ principalId: PrincipalId, status: DepartedStatus }),
    output: Principal,
    run: (d, c, i) => d.setPrincipalStatus(c, i.principalId, i.status),
  }),
  // Granting or taking away district administration is deliberately not an operation: an agent
  // tool must never be able to widen anyone's authority. It is an admin console route only.
  update_principal: defineOperation({
    name: "update_principal",
    description: "Correct a principal's name, email or kind (student or staff), where EducateOS owns principals. Their sign-in is unchanged.",
    ...WRITE,
    action: "update",
    idempotency: "inherent",
    authority: "principal",
    input: z.strictObject({ principalId: PrincipalId }).extend(PrincipalPatch.shape),
    output: Principal,
    run: (d, c, { principalId, ...patch }) => d.updatePrincipal(c, principalId, patch),
  }),
  reactivate_principal: defineOperation({
    name: "reactivate_principal",
    description: "Make a graduated or inactive principal active again, where EducateOS owns principals.",
    ...WRITE,
    action: "update",
    idempotency: "inherent",
    authority: "principal",
    input: z.strictObject({ principalId: PrincipalId }),
    output: Principal,
    run: (d, c, i) => d.reactivatePrincipal(c, i.principalId),
  }),
} satisfies Record<string, AcademicOperation>;

/** The name of an operation in {@link ACADEMIC_OPERATIONS}. */
export type AcademicOperationName = keyof typeof ACADEMIC_OPERATIONS;

/** An operation's outcome, in the shape both surfaces return. */
export type OperationOutcome = { ok: true; value: unknown } | { ok: false; error: EducateOsErrorBody };

/**
 * Parses `input` and runs the operation, converting failures to error bodies. An operation not
 * exposed on the caller's channel is refused with `forbidden` before anything else happens. One
 * whose effect writes is then routed by its domain's authority binding, so a write to a domain
 * another system owns is refused with a `conflict` naming that system before it runs. Every decision the
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
  const channel = operationChannelFor(caller.channel);
  if (!operation.channels.includes(channel)) {
    // Refused by design, whoever is calling and whatever they send: nothing is parsed or decided.
    return {
      ok: false,
      error: { code: "forbidden", message: `${operation.name} is not available through ${channel}.`, correlationId },
    };
  }
  try {
    const parsed = operation.input.safeParse(input);
    if (!parsed.success) throw new DirectoryValidationError("the request is invalid", zodIssues(parsed.error));
    assertOperationRoutable(directory.authorityBindings, operation.authority, { name: operation.name, writes: operation.effect !== "read" });
    return { ok: true, value: await operation.run(directory, { ...caller, correlationId }, parsed.data) };
  } catch (error) {
    if (error instanceof EducateOsError) return { ok: false, error: { ...error.toBody(), correlationId } };
    // The caller gets nothing internal, so this log line is the only record of what went wrong.
    console.error("academics operation failed", { operation: operation.name, correlationId, error });
    return {
      ok: false,
      error: { code: "unavailable", message: "The academic directory could not complete the request.", correlationId },
    };
  }
}
