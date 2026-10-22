import {
  ID_PREFIXES,
  precheckAuthorization,
  SchoolOsError,
  type AcademicTerm,
  type Action,
  type AuthorityMap,
  type AuthorizationRequest,
  type Authorizer,
  type Caller,
  type CatalogCourse,
  type CourseId,
  type CourseOffering,
  type Decision,
  type DistrictDirectorySnapshot,
  type Enrollment,
  type EnrollmentId,
  type IdKind,
  type OfferingId,
  type Principal,
  type PrincipalId,
  type ResourceRef,
  type School,
  type SchoolId,
  type TermId,
  type TermState,
} from "@schoolos/contracts";
import { assertLocallyWritable } from "./authority.ts";
import {
  CoursePatch,
  DepartedStatus,
  NewCourse,
  NewEnrollment,
  NewOffering,
  NewSchool,
  NewTerm,
  OfferingPatch,
  SchoolPatch,
  TermPatch,
  type OfferingFilter,
} from "./inputs.ts";
import type { AcademicStore } from "./store.ts";
import type { z } from "zod";
import { assertTermTransition, DirectoryValidationError, validateDirectory, zodIssues } from "./validation.ts";

/** What {@link AcademicDirectory} is built from. */
export interface AcademicDirectoryOptions {
  /** Where the district's directory is kept. */
  store: AcademicStore;
  /** The source of record for each record type. */
  authority: AuthorityMap;
  /**
   * Decides every request. It receives the request exactly as built, so an auditing authorizer
   * records cross-district and malformed requests too; the directory still denies whatever
   * `precheckAuthorization` refuses, whatever the authorizer answers.
   */
  authorizer: Authorizer;
}

/** A resource to authorize against, with the state of the term it belongs to, if any. */
interface Target {
  resource: ResourceRef;
  termState?: TermState;
}

function notFound(kind: string, id: string): SchoolOsError {
  return new SchoolOsError("not-found", `${kind} ${id} was not found.`);
}

/**
 * Re-parses typed input at the service boundary. Types do not survive a cast or a JavaScript
 * caller, and a stray `state` or `districtId` spread into a record would bypass the rules that
 * govern those fields.
 */
function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new DirectoryValidationError("the request is invalid", zodIssues(parsed.error));
  return parsed.data;
}

function newId<K extends IdKind>(kind: K): `${(typeof ID_PREFIXES)[K]}_${string}` {
  return `${ID_PREFIXES[kind]}_${crypto.randomUUID()}`;
}

/** Builds resource references from stored records only, so nothing a caller sends can shape them. */
class Targets {
  readonly #snapshot: DistrictDirectorySnapshot;

  constructor(snapshot: DistrictDirectorySnapshot) {
    this.#snapshot = snapshot;
  }

  district(kind: ResourceRef["kind"]): Target {
    return {
      resource: {
        kind,
        scope: { level: "district", districtId: this.#snapshot.district.id },
        classification: "district-internal",
      },
    };
  }

  school(school: School): Target {
    return {
      resource: {
        kind: "school",
        id: school.id,
        scope: { level: "school", districtId: school.districtId, schoolId: school.id },
        classification: "district-internal",
      },
    };
  }

  /** Creating something within a school, such as an offering. */
  inSchool(kind: ResourceRef["kind"], school: School, termId: TermId): Target {
    return {
      resource: {
        kind,
        scope: { level: "school", districtId: school.districtId, schoolId: school.id },
        classification: "district-internal",
      },
      ...this.#termState(termId),
    };
  }

  term(term: AcademicTerm): Target {
    return {
      resource: {
        kind: "term",
        id: term.id,
        scope: { level: "district", districtId: term.districtId },
        classification: "district-internal",
      },
      termState: term.state,
    };
  }

  course(course: CatalogCourse): Target {
    return {
      resource: {
        kind: "course",
        id: course.id,
        scope: { level: "district", districtId: course.districtId },
        classification: "district-internal",
      },
    };
  }

  offering(offering: CourseOffering): Target {
    return {
      resource: { kind: "offering", id: offering.id, scope: this.#offeringScope(offering), classification: "district-internal" },
      ...this.#termState(offering.termId),
    };
  }

  /** The enrollments of an offering as a collection: its roster, and where new enrollments go. */
  roster(offering: CourseOffering, ownerPrincipalId?: PrincipalId): Target {
    return {
      resource: {
        kind: "enrollment",
        scope: this.#offeringScope(offering),
        classification: "course",
        ...(ownerPrincipalId === undefined ? {} : { ownerPrincipalId }),
      },
      ...this.#termState(offering.termId),
    };
  }

  principal(principal: Principal): Target {
    return {
      resource: {
        kind: "principal",
        id: principal.id,
        scope: { level: "district", districtId: principal.districtId },
        classification: "district-internal",
        ownerPrincipalId: principal.id,
      },
    };
  }

  enrollment(enrollment: Enrollment): Target | undefined {
    const offering = this.#snapshot.offerings.find((o) => o.id === enrollment.offeringId);
    if (offering === undefined) return undefined;
    return {
      resource: {
        kind: "enrollment",
        id: enrollment.id,
        scope: this.#offeringScope(offering),
        classification: "course",
        ownerPrincipalId: enrollment.principalId,
      },
      ...this.#termState(offering.termId),
    };
  }

  #offeringScope(offering: CourseOffering): ResourceRef["scope"] {
    return { level: "offering", districtId: offering.districtId, schoolId: offering.schoolId, offeringId: offering.id };
  }

  #termState(termId: TermId): { termState?: TermState } {
    const term = this.#snapshot.terms.find((t) => t.id === termId);
    return term === undefined ? {} : { termState: term.state };
  }
}

/**
 * The AcademicDirectory domain service (roadmap §2.2): schools, academic terms, catalog courses,
 * course offerings and enrollments for one district. The HTTP handler and the MCP tools are thin
 * layers over these methods, so both get the same rules.
 *
 * Every method authorizes the caller before it returns or changes anything, building the request
 * only from stored records. Reads the caller may not make answer `not-found`, exactly as if the
 * record did not exist; so do writes to records the caller cannot read. Writes are refused with
 * `conflict` when another system owns the record type, and with `validation-failed` when the
 * resulting directory would fail `checkDirectoryIntegrity`. Nothing is ever hard-deleted.
 */
export class AcademicDirectory {
  readonly #store: AcademicStore;
  readonly #authority: AuthorityMap;
  readonly #authorizer: Authorizer;

  constructor(options: AcademicDirectoryOptions) {
    this.#store = options.store;
    this.#authority = options.authority;
    this.#authorizer = options.authorizer;
  }

  // Schools

  /** The schools the caller may read. */
  async listSchools(caller: Caller): Promise<School[]> {
    const { snapshot } = await this.#store.load();
    const targets = new Targets(snapshot);
    return this.#readable(caller, snapshot.schools, (school) => targets.school(school));
  }

  /** One school. */
  async getSchool(caller: Caller, schoolId: SchoolId): Promise<School> {
    const { snapshot } = await this.#store.load();
    const school = snapshot.schools.find((s) => s.id === schoolId);
    if (school === undefined) throw notFound("school", schoolId);
    await this.#requireRead(caller, new Targets(snapshot).school(school), "school", schoolId);
    return school;
  }

  /** Creates a school. District-level. */
  async createSchool(caller: Caller, rawInput: NewSchool): Promise<School> {
    const input = parseInput(NewSchool, rawInput);
    const { snapshot, version } = await this.#store.load();
    await this.#require(caller, "create", new Targets(snapshot).district("school"));
    assertLocallyWritable(this.#authority, "school");
    const school: School = { id: newId("school") as SchoolId, districtId: snapshot.district.id, ...input };
    await this.#commit({ ...snapshot, schools: [...snapshot.schools, school] }, version);
    return school;
  }

  /** Changes a school's name or grade bands. */
  async updateSchool(caller: Caller, schoolId: SchoolId, rawPatch: SchoolPatch): Promise<School> {
    const patch = parseInput(SchoolPatch, rawPatch);
    const { snapshot, version } = await this.#store.load();
    const school = snapshot.schools.find((s) => s.id === schoolId);
    if (school === undefined) throw notFound("school", schoolId);
    await this.#requireWrite(caller, "update", new Targets(snapshot).school(school), "school", schoolId);
    assertLocallyWritable(this.#authority, "school");
    const updated: School = { ...school, ...patch };
    await this.#commit({ ...snapshot, schools: replace(snapshot.schools, updated) }, version);
    return updated;
  }

  // Terms

  /** The terms the caller may read, optionally only those in one state. */
  async listTerms(caller: Caller, filter: { state?: TermState } = {}): Promise<AcademicTerm[]> {
    const { snapshot } = await this.#store.load();
    const targets = new Targets(snapshot);
    const terms = snapshot.terms.filter((t) => filter.state === undefined || t.state === filter.state);
    return this.#readable(caller, terms, (term) => targets.term(term));
  }

  /** One term. */
  async getTerm(caller: Caller, termId: TermId): Promise<AcademicTerm> {
    const { snapshot } = await this.#store.load();
    const term = snapshot.terms.find((t) => t.id === termId);
    if (term === undefined) throw notFound("term", termId);
    await this.#requireRead(caller, new Targets(snapshot).term(term), "term", termId);
    return term;
  }

  /** Creates a term. It starts `planned`. */
  async createTerm(caller: Caller, rawInput: NewTerm): Promise<AcademicTerm> {
    const input = parseInput(NewTerm, rawInput);
    const { snapshot, version } = await this.#store.load();
    await this.#require(caller, "create", new Targets(snapshot).district("term"));
    assertLocallyWritable(this.#authority, "term");
    const term: AcademicTerm = { id: newId("term") as TermId, districtId: snapshot.district.id, ...input, state: "planned" };
    await this.#commit({ ...snapshot, terms: [...snapshot.terms, term] }, version);
    return term;
  }

  /** Changes a term's name or dates. Its state changes only through {@link transitionTerm}. */
  async updateTerm(caller: Caller, termId: TermId, rawPatch: TermPatch): Promise<AcademicTerm> {
    const patch = parseInput(TermPatch, rawPatch);
    const { snapshot, version } = await this.#store.load();
    const term = snapshot.terms.find((t) => t.id === termId);
    if (term === undefined) throw notFound("term", termId);
    await this.#requireWrite(caller, "update", new Targets(snapshot).term(term), "term", termId);
    assertLocallyWritable(this.#authority, "term");
    const updated: AcademicTerm = { ...term, ...patch };
    await this.#commit({ ...snapshot, terms: replace(snapshot.terms, updated) }, version);
    return updated;
  }

  /**
   * Moves a term one step along planned → active → grading → completed. Any other change,
   * including moving backwards or skipping a state, is refused with `conflict`.
   */
  async transitionTerm(caller: Caller, termId: TermId, to: TermState): Promise<AcademicTerm> {
    const { snapshot, version } = await this.#store.load();
    const term = snapshot.terms.find((t) => t.id === termId);
    if (term === undefined) throw notFound("term", termId);
    await this.#requireWrite(caller, "update", new Targets(snapshot).term(term), "term", termId);
    assertLocallyWritable(this.#authority, "term");
    assertTermTransition(term.state, to);
    const updated: AcademicTerm = { ...term, state: to };
    await this.#commit({ ...snapshot, terms: replace(snapshot.terms, updated) }, version);
    return updated;
  }

  // Catalog courses

  /** The catalog courses the caller may read. */
  async listCourses(caller: Caller): Promise<CatalogCourse[]> {
    const { snapshot } = await this.#store.load();
    const targets = new Targets(snapshot);
    return this.#readable(caller, snapshot.courses, (course) => targets.course(course));
  }

  /** One catalog course. */
  async getCourse(caller: Caller, courseId: CourseId): Promise<CatalogCourse> {
    const { snapshot } = await this.#store.load();
    const course = snapshot.courses.find((c) => c.id === courseId);
    if (course === undefined) throw notFound("course", courseId);
    await this.#requireRead(caller, new Targets(snapshot).course(course), "course", courseId);
    return course;
  }

  /** Creates a catalog course. District-level. */
  async createCourse(caller: Caller, rawInput: NewCourse): Promise<CatalogCourse> {
    const input = parseInput(NewCourse, rawInput);
    const { snapshot, version } = await this.#store.load();
    await this.#require(caller, "create", new Targets(snapshot).district("course"));
    assertLocallyWritable(this.#authority, "course");
    const course: CatalogCourse = { id: newId("course") as CourseId, districtId: snapshot.district.id, ...input };
    await this.#commit({ ...snapshot, courses: [...snapshot.courses, course] }, version);
    return course;
  }

  /** Changes a catalog course's title, subject or grade band. */
  async updateCourse(caller: Caller, courseId: CourseId, rawPatch: CoursePatch): Promise<CatalogCourse> {
    const patch = parseInput(CoursePatch, rawPatch);
    const { snapshot, version } = await this.#store.load();
    const course = snapshot.courses.find((c) => c.id === courseId);
    if (course === undefined) throw notFound("course", courseId);
    await this.#requireWrite(caller, "update", new Targets(snapshot).course(course), "course", courseId);
    assertLocallyWritable(this.#authority, "course");
    const updated: CatalogCourse = { ...course, ...patch };
    await this.#commit({ ...snapshot, courses: replace(snapshot.courses, updated) }, version);
    return updated;
  }

  // Offerings

  /**
   * The offerings the caller may read, filtered by school and term. With `principalId`, only the
   * offerings that principal is actively enrolled in, and only where the caller may read both the
   * enrollment and the offering, so the list reveals no enrollment the caller could not read.
   */
  async listOfferings(caller: Caller, filter: OfferingFilter = {}): Promise<CourseOffering[]> {
    const { snapshot } = await this.#store.load();
    const targets = new Targets(snapshot);
    let offerings = snapshot.offerings.filter(
      (o) => (filter.schoolId === undefined || o.schoolId === filter.schoolId)
        && (filter.termId === undefined || o.termId === filter.termId),
    );
    if (filter.principalId !== undefined) {
      const enrollments = snapshot.enrollments.filter(
        (e) => e.principalId === filter.principalId && e.status === "active",
      );
      const visible = await this.#readable(caller, enrollments, (e) => targets.enrollment(e));
      const enrolledIn = new Set(visible.map((e) => e.offeringId));
      offerings = offerings.filter((o) => enrolledIn.has(o.id));
    }
    return this.#readable(caller, offerings, (offering) => targets.offering(offering));
  }

  /** One course offering. */
  async getOffering(caller: Caller, offeringId: OfferingId): Promise<CourseOffering> {
    const { snapshot } = await this.#store.load();
    const offering = snapshot.offerings.find((o) => o.id === offeringId);
    if (offering === undefined) throw notFound("offering", offeringId);
    await this.#requireRead(caller, new Targets(snapshot).offering(offering), "offering", offeringId);
    return offering;
  }

  /** Creates a course offering in a school. */
  async createOffering(caller: Caller, rawInput: NewOffering): Promise<CourseOffering> {
    const input = parseInput(NewOffering, rawInput);
    const { snapshot, version } = await this.#store.load();
    const school = snapshot.schools.find((s) => s.id === input.schoolId);
    if (school === undefined) throw notFound("school", input.schoolId);
    const targets = new Targets(snapshot);
    await this.#requireWrite(caller, "create", targets.inSchool("offering", school, input.termId), "school", school.id, targets.school(school));
    assertLocallyWritable(this.#authority, "offering");
    const offering: CourseOffering = { id: newId("offering") as OfferingId, districtId: snapshot.district.id, ...input };
    await this.#commit({ ...snapshot, offerings: [...snapshot.offerings, offering] }, version);
    return offering;
  }

  /** Renames a course offering's section. */
  async updateOffering(caller: Caller, offeringId: OfferingId, rawPatch: OfferingPatch): Promise<CourseOffering> {
    const patch = parseInput(OfferingPatch, rawPatch);
    const { snapshot, version } = await this.#store.load();
    const offering = snapshot.offerings.find((o) => o.id === offeringId);
    if (offering === undefined) throw notFound("offering", offeringId);
    await this.#requireWrite(caller, "update", new Targets(snapshot).offering(offering), "offering", offeringId);
    assertLocallyWritable(this.#authority, "offering");
    const updated: CourseOffering = { ...offering, ...patch };
    await this.#commit({ ...snapshot, offerings: replace(snapshot.offerings, updated) }, version);
    return updated;
  }

  /** The active enrollments of an offering: its live roster. */
  async roster(caller: Caller, offeringId: OfferingId): Promise<Enrollment[]> {
    const { snapshot } = await this.#store.load();
    const offering = snapshot.offerings.find((o) => o.id === offeringId);
    if (offering === undefined) throw notFound("offering", offeringId);
    const targets = new Targets(snapshot);
    await this.#requireWrite(caller, "list", targets.roster(offering), "offering", offeringId, targets.offering(offering));
    return snapshot.enrollments.filter((e) => e.offeringId === offeringId && e.status === "active");
  }

  // Enrollments

  /** A principal's enrollments, active and inactive, that the caller may read. */
  async listEnrollments(caller: Caller, principalId: PrincipalId): Promise<Enrollment[]> {
    const { snapshot } = await this.#store.load();
    const targets = new Targets(snapshot);
    const enrollments = snapshot.enrollments.filter((e) => e.principalId === principalId);
    return this.#readable(caller, enrollments, (e) => targets.enrollment(e));
  }

  /** One enrollment. */
  async getEnrollment(caller: Caller, enrollmentId: EnrollmentId): Promise<Enrollment> {
    const { snapshot } = await this.#store.load();
    const enrollment = snapshot.enrollments.find((e) => e.id === enrollmentId);
    const target = enrollment && new Targets(snapshot).enrollment(enrollment);
    if (enrollment === undefined || target === undefined) throw notFound("enrollment", enrollmentId);
    await this.#requireRead(caller, target, "enrollment", enrollmentId);
    return enrollment;
  }

  /**
   * Enrolls a principal in an offering. It is a `conflict` if they already have an active
   * enrollment there.
   */
  async createEnrollment(caller: Caller, rawInput: NewEnrollment): Promise<Enrollment> {
    const input = parseInput(NewEnrollment, rawInput);
    const { snapshot, version } = await this.#store.load();
    const offering = snapshot.offerings.find((o) => o.id === input.offeringId);
    if (offering === undefined) throw notFound("offering", input.offeringId);
    const targets = new Targets(snapshot);
    await this.#requireWrite(
      caller,
      "create",
      targets.roster(offering, input.principalId),
      "offering",
      offering.id,
      targets.offering(offering),
    );
    assertLocallyWritable(this.#authority, "enrollment");
    const existing = snapshot.enrollments.find(
      (e) => e.offeringId === input.offeringId && e.principalId === input.principalId && e.status === "active",
    );
    if (existing !== undefined) {
      throw new SchoolOsError("conflict", `${input.principalId} is already enrolled in ${input.offeringId} (${existing.id}).`);
    }
    const enrollment: Enrollment = {
      id: newId("enrollment") as EnrollmentId,
      districtId: snapshot.district.id,
      ...input,
      status: "active",
    };
    await this.#commit({ ...snapshot, enrollments: [...snapshot.enrollments, enrollment] }, version);
    return enrollment;
  }

  /**
   * Removes a principal from an offering by marking the enrollment inactive. The record stays: a
   * dropped student loses live course access but keeps their workspace and work (roadmap §14).
   * Deactivating an inactive enrollment changes nothing.
   */
  async deactivateEnrollment(caller: Caller, enrollmentId: EnrollmentId): Promise<Enrollment> {
    const { snapshot, version } = await this.#store.load();
    const enrollment = snapshot.enrollments.find((e) => e.id === enrollmentId);
    const target = enrollment && new Targets(snapshot).enrollment(enrollment);
    if (enrollment === undefined || target === undefined) throw notFound("enrollment", enrollmentId);
    await this.#requireWrite(caller, "update", target, "enrollment", enrollmentId);
    assertLocallyWritable(this.#authority, "enrollment");
    if (enrollment.status === "inactive") return enrollment;
    const updated: Enrollment = { ...enrollment, status: "inactive" };
    await this.#commit({ ...snapshot, enrollments: replace(snapshot.enrollments, updated) }, version);
    return updated;
  }

  // Principals

  /**
   * Moves a principal to `graduated` or `inactive` (roadmap §14, "Semester end / graduation").
   * Nothing is deleted: the principal, their enrollments and their role assignments stay on record,
   * but a principal that is not active holds no roles, so every class decision about them is denied
   * from the next one on. Their course grants are revoked by the workspace directory's
   * `reconcileCourseGrants`, which `transitionPrincipal` in `@schoolos/workspaces` runs after this.
   * Refused with `conflict` when another system owns principals: there the change belongs in that
   * system, whose next sync would otherwise undo it. Moving to the current status changes nothing.
   */
  async setPrincipalStatus(caller: Caller, principalId: PrincipalId, rawStatus: DepartedStatus): Promise<Principal> {
    const status = parseInput(DepartedStatus, rawStatus);
    const { snapshot, version } = await this.#store.load();
    const principal = snapshot.principals.find((p) => p.id === principalId);
    if (principal === undefined) throw notFound("principal", principalId);
    await this.#requireWrite(caller, "update", new Targets(snapshot).principal(principal), "principal", principalId);
    assertLocallyWritable(this.#authority, "principal");
    if (principal.status === status) return principal;
    const updated: Principal = { ...principal, status };
    await this.#commit({ ...snapshot, principals: replace(snapshot.principals, updated) }, version);
    return updated;
  }

  // Authorization and commit

  async #decide(caller: Caller, action: Action, target: Target): Promise<Decision> {
    const request: AuthorizationRequest = {
      subject: caller.principal,
      action,
      resource: target.resource,
      context: {
        channel: caller.channel,
        ...(target.termState === undefined ? {} : { termState: target.termState }),
      },
    };
    const decision = caller.correlationId === undefined
      ? await this.#authorizer.authorize(request)
      : await this.#authorizer.authorize(request, { correlationId: caller.correlationId });
    // The authorizer sees, and can audit, every request; it still cannot allow one the shared
    // precheck refuses, such as a caller from another district.
    const precheck = precheckAuthorization(request);
    return precheck.ok ? decision : precheck.decision;
  }

  /** Requires an allow, answering `forbidden` otherwise. For actions on the district itself. */
  async #require(caller: Caller, action: Action, target: Target): Promise<void> {
    if ((await this.#decide(caller, action, target)).effect === "allow") return;
    throw new SchoolOsError("forbidden", `You may not ${action} a ${target.resource.kind} here.`);
  }

  /** Requires a read, answering `not-found` exactly as for a record that does not exist. */
  async #requireRead(caller: Caller, target: Target, kind: string, id: string): Promise<void> {
    if ((await this.#decide(caller, "read", target)).effect === "allow") return;
    throw notFound(kind, id);
  }

  /**
   * Requires `action` on `target`. If refused, answers `not-found` for `kind id` unless the caller
   * may read `visible` (by default the target itself), so a refusal reveals nothing the caller
   * could not already see.
   */
  async #requireWrite(
    caller: Caller,
    action: Action,
    target: Target,
    kind: string,
    id: string,
    visible: Target = target,
  ): Promise<void> {
    if ((await this.#decide(caller, action, target)).effect === "allow") return;
    await this.#requireRead(caller, visible, kind, id);
    throw new SchoolOsError("forbidden", `You may not ${action} this ${target.resource.kind}.`);
  }

  /** The records the caller may read, in order. A record with no resolvable target is skipped. */
  async #readable<T>(caller: Caller, records: T[], targetOf: (record: T) => Target | undefined): Promise<T[]> {
    const allowed: T[] = [];
    for (const record of records) {
      const target = targetOf(record);
      if (target !== undefined && (await this.#decide(caller, "read", target)).effect === "allow") allowed.push(record);
    }
    return allowed;
  }

  async #commit(next: DistrictDirectorySnapshot, version: number): Promise<void> {
    await this.#store.commit(validateDirectory(next), version);
  }
}

/** The records with the one sharing `updated`'s ID replaced by it. */
export function replace<T extends { id: string }>(records: T[], updated: T): T[] {
  return records.map((record) => (record.id === updated.id ? updated : record));
}
