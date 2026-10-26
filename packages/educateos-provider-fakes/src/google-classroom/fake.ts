// The Google Classroom API v1 as a fetch handler over a district seed, at
// https://classroom.googleapis.com/v1. Followed: the Classroom REST reference
// (https://developers.google.com/workspace/classroom/reference/rest): `courses.list` (`teacherId`,
// `studentId`, `courseStates`, each user named by numeric ID, email or `me`) and `courses.get`;
// `courses.teachers` and `courses.students` list/get; `courses.courseWork` list
// (`courseWorkStates`, PUBLISHED by default; students see only PUBLISHED), get and create (state
// DRAFT by default; the creating project's coursework is `associatedWithDeveloper`);
// `courses.courseWork.studentSubmissions` list (`-` for every coursework, `userId`, `states`,
// `late`), get, patch (a mandatory `updateMask` of `draftGrade`/`assignedGrade`), `return` and
// `turnIn`, each refused with `@ProjectPermissionDenied` when the calling project did not create
// the coursework; `pageSize`/`pageToken`/`nextPageToken` paging where the server may return fewer
// items than asked; the OAuth scopes each method lists; `UserProfile.emailAddress` only with
// `classroom.profile.emails` and `photoUrl` only with `classroom.profile.photos`. Google's JSON
// omits fields at their default value, so `associatedWithDeveloper` and `late` appear only when true.
import { Fake, bearer, decodeSegments, TokenIssuer } from "../fake.ts";
import type { FakeOptions } from "../fake.ts";
import { numericId, tokenId } from "../ids.ts";
import { modifiedOf, studentsToRemove, validateSeed } from "../seed.ts";
import type { AssignmentSeed, DistrictSeed, PersonSeed, SectionSeed, SubmissionSeed } from "../types.ts";
import { googleSubjectId } from "../oidc/presets.ts";
import { GoogleError, googleErrorResponse } from "./errors.ts";

/** The API's base URL. */
export const CLASSROOM_API_BASE = "https://classroom.googleapis.com/v1";

const AUTH = "https://www.googleapis.com/auth/";

/** The Classroom OAuth scopes. */
export const CLASSROOM_SCOPES = {
  courses: `${AUTH}classroom.courses`,
  coursesReadonly: `${AUTH}classroom.courses.readonly`,
  rosters: `${AUTH}classroom.rosters`,
  rostersReadonly: `${AUTH}classroom.rosters.readonly`,
  profileEmails: `${AUTH}classroom.profile.emails`,
  profilePhotos: `${AUTH}classroom.profile.photos`,
  courseworkStudents: `${AUTH}classroom.coursework.students`,
  courseworkStudentsReadonly: `${AUTH}classroom.coursework.students.readonly`,
  courseworkMe: `${AUTH}classroom.coursework.me`,
  courseworkMeReadonly: `${AUTH}classroom.coursework.me.readonly`,
} as const;

const S = CLASSROOM_SCOPES;
const COURSE_READ = [S.courses, S.coursesReadonly];
const ROSTER_READ = [S.rosters, S.rostersReadonly, S.profileEmails, S.profilePhotos];
const COURSEWORK_READ = [S.courseworkStudents, S.courseworkStudentsReadonly, S.courseworkMe, S.courseworkMeReadonly];

/** What a bearer token grants: who it acts as (a seed person ID) and its scopes. */
export interface ClassroomGrant {
  /** The seed person the token acts for. */
  readonly userId: string;
  readonly scopes: readonly string[];
}

/** Options of a {@link GoogleClassroomFake}. */
export interface GoogleClassroomFakeOptions extends FakeOptions {
  readonly seed: DistrictSeed;
  /** Bearer tokens the fake accepts, and what each grants. More can be added with {@link GoogleClassroomFake.authorize}. */
  readonly tokens?: Readonly<Record<string, ClassroomGrant>>;
  /** The most items one page holds, whatever `pageSize` asks. Defaults to 20. */
  readonly maxPageSize?: number;
  /** Whether the domain's admin has turned Classroom data access off (`@ClassroomApiDisabled`). */
  readonly apiDisabled?: boolean;
}

type Json = Record<string, unknown>;

interface Course {
  readonly section: SectionSeed;
  readonly id: string;
  state: "ACTIVE" | "ARCHIVED" | "PROVISIONED" | "DECLINED" | "SUSPENDED";
  teachers: string[];
  students: string[];
  readonly created: string;
}

interface CourseWork {
  readonly courseId: string;
  readonly id: string;
  title: string;
  description?: string;
  state: "PUBLISHED" | "DRAFT" | "DELETED";
  maxPoints?: number;
  workType: string;
  dueAt?: string;
  readonly ownedByDeveloper: boolean;
  readonly creatorPersonId: string;
  readonly created: string;
  updated: string;
}

interface Submission {
  readonly courseId: string;
  readonly courseWorkId: string;
  readonly id: string;
  readonly personId: string;
  state: NonNullable<SubmissionSeed["state"]>;
  draftGrade?: number;
  assignedGrade?: number;
  late: boolean;
  readonly created: string;
  updated: string;
  history: Json[];
}

const COURSE_STATES = ["ACTIVE", "ARCHIVED", "PROVISIONED", "DECLINED", "SUSPENDED"];
const SUBMISSION_STATES = ["NEW", "CREATED", "TURNED_IN", "RETURNED", "RECLAIMED_BY_STUDENT"];
const WORK_TYPES = ["ASSIGNMENT", "SHORT_ANSWER_QUESTION", "MULTIPLE_CHOICE_QUESTION"];
const CREATE_FIELDS = new Set([
  "title", "description", "materials", "state", "dueDate", "dueTime", "scheduledTime", "maxPoints", "workType", "assigneeMode",
  "individualStudentsOptions", "submissionModificationMode", "topicId", "gradeCategory", "assignment", "multipleChoiceQuestion", "gradingPeriodId",
]);

const notFound = () => new GoogleError(404, "NOT_FOUND", "Requested entity was not found.");
const denied = () => new GoogleError(403, "PERMISSION_DENIED", "The caller does not have permission");
const invalid = (message: string) => new GoogleError(400, "INVALID_ARGUMENT", message);
const projectDenied = () => new GoogleError(403, "PERMISSION_DENIED", "@ProjectPermissionDenied The Developer Console project is not permitted to make this request.");

/** An opaque page token: the offset, bound to the request it continues. */
function pageToken(offset: number, fingerprint: string): string {
  return btoa(JSON.stringify({ o: offset, f: fingerprint })).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function readPageToken(token: string, fingerprint: string): number {
  try {
    const parsed = JSON.parse(atob(token.replaceAll("-", "+").replaceAll("_", "/"))) as { o?: unknown; f?: unknown };
    if (typeof parsed.o === "number" && Number.isInteger(parsed.o) && parsed.o >= 0 && parsed.f === fingerprint) return parsed.o;
  } catch {
    // Falls through to the refusal.
  }
  throw invalid("Invalid page token: it does not belong to this request.");
}

const iso = (time: string | number) => new Date(time).toISOString();

/**
 * Google Classroom over a district seed. Each section is a course; its teachers and students are
 * the roster; `assignments` are coursework, `createdByIntegration` ones owned by the calling
 * project. Every assigned student of published coursework has a submission. IDs are derived with
 * `numericId` and `tokenId`, so they are stable: use {@link courseId}, {@link userId},
 * {@link courseWorkId} and {@link submissionId} to find them.
 */
export class GoogleClassroomFake extends Fake {
  readonly #seed: DistrictSeed;
  readonly #grants: TokenIssuer<ClassroomGrant>;
  readonly #maxPageSize: number;
  readonly #apiDisabled: boolean;
  readonly #people: Map<string, PersonSeed>;
  readonly #courses = new Map<string, Course>();
  readonly #courseWork = new Map<string, CourseWork>();
  readonly #submissions = new Map<string, Submission>();
  #createdWork = 0;
  // The request being served, so a list page can consume a malformed-record fault matching it.
  #current: Request | undefined;

  constructor(options: GoogleClassroomFakeOptions) {
    super(options);
    this.#seed = validateSeed(options.seed);
    this.#grants = new TokenIssuer<ClassroomGrant>("ya29.fake-", this.now);
    this.#maxPageSize = options.maxPageSize ?? 20;
    this.#apiDisabled = options.apiDisabled ?? false;
    this.#people = new Map(this.#seed.people.map((p) => [p.id, p]));
    for (const [token, grant] of Object.entries(options.tokens ?? {})) this.authorize(token, grant);
    for (const section of this.#seed.sections) {
      this.#courses.set(this.courseId(section.id), {
        section,
        id: this.courseId(section.id),
        state: (section.status ?? "active") === "tobedeleted" ? "ARCHIVED" : "ACTIVE",
        teachers: [...section.teacherIds],
        students: [...section.studentIds],
        created: iso(modifiedOf(this.#seed, section)),
      });
    }
    for (const assignment of this.#seed.assignments ?? []) this.#seedAssignment(assignment);
  }

  /** Accepts `token` as a bearer token granting `grant`, until `expiresAt` (ms; default never). */
  authorize(token: string, grant: ClassroomGrant, expiresAt?: number): void {
    if (!this.#people.has(grant.userId)) throw new RangeError(`no seed person ${grant.userId}`);
    this.#grants.register(token, grant, expiresAt);
  }

  /** Mints a fresh token for a seed person, valid for `lifetimeSeconds` (default 3599, as Google's). */
  issueToken(grant: ClassroomGrant, lifetimeSeconds = 3599): string {
    if (!this.#people.has(grant.userId)) throw new RangeError(`no seed person ${grant.userId}`);
    return this.#grants.issue(grant, lifetimeSeconds);
  }

  /** Invalidates every token, as a revocation would. */
  revokeTokens(): void {
    this.#grants.revokeAll();
  }

  /** The Classroom course ID of a seed section. */
  courseId(sectionId: string): string {
    return numericId("google-classroom-course", sectionId, 12);
  }

  /** The Google user ID of a seed person: the same 21 digits as their Google sign-in `sub`. */
  userId(personId: string): string {
    return googleSubjectId(this.#seed, personId);
  }

  /** The coursework ID of a seed assignment. */
  courseWorkId(assignmentId: string): string {
    return numericId("google-classroom-coursework", assignmentId, 12);
  }

  /** The submission ID of a student's work on a seed assignment, or on created coursework by its ID. */
  submissionId(assignmentOrCourseWorkId: string, personId: string): string {
    const workId = this.#courseWork.has(assignmentOrCourseWorkId) ? assignmentOrCourseWorkId : this.courseWorkId(assignmentOrCourseWorkId);
    return `Cg${tokenId("google-classroom-submission", `${workId}:${personId}`, 14)}`;
  }

  /** A course's coursework as the API serves it to the calling project, for assertions. */
  courseWorkOf(courseId: string): Json[] {
    return [...this.#courseWork.values()].filter((w) => w.courseId === courseId).map((w) => this.#courseWorkJson(w));
  }

  /** A submission as the API serves it, for assertions. */
  submission(submissionId: string): Json | undefined {
    const found = this.#submissions.get(submissionId);
    return found === undefined ? undefined : this.#submissionJson(found);
  }

  /** Takes a student off a course's roster, with their submissions. */
  removeStudent(sectionId: string, personId: string): void {
    const course = this.#courses.get(this.courseId(sectionId));
    if (course === undefined) throw new RangeError(`no section ${sectionId}`);
    course.students = course.students.filter((id) => id !== personId);
    for (const [id, s] of this.#submissions) if (s.courseId === course.id && s.personId === personId) this.#submissions.delete(id);
  }

  /** Sets a course's state, such as `ARCHIVED`. */
  setCourseState(sectionId: string, state: Course["state"]): void {
    const course = this.#courses.get(this.courseId(sectionId));
    if (course === undefined) throw new RangeError(`no section ${sectionId}`);
    course.state = state;
  }

  #seedAssignment(a: AssignmentSeed): void {
    const course = this.#courses.get(this.courseId(a.sectionId))!;
    const at = iso(modifiedOf(this.#seed, a));
    const work: CourseWork = {
      courseId: course.id,
      id: this.courseWorkId(a.id),
      title: a.title,
      ...(a.description === undefined ? {} : { description: a.description }),
      state: a.state ?? "PUBLISHED",
      ...(a.maxPoints === undefined ? {} : { maxPoints: a.maxPoints }),
      workType: "ASSIGNMENT",
      ...(a.dueAt === undefined ? {} : { dueAt: a.dueAt }),
      ownedByDeveloper: a.createdByIntegration ?? false,
      creatorPersonId: course.teachers[0] ?? course.section.teacherIds[0]!,
      created: at,
      updated: at,
    };
    this.#courseWork.set(work.id, work);
    if (work.state !== "PUBLISHED") return;
    const given = new Map((a.submissions ?? []).map((s) => [s.studentId, s]));
    for (const personId of course.students) {
      const s = given.get(personId);
      this.#addSubmission(work, personId, s === undefined ? { state: "NEW", late: false } : { state: s.state ?? "CREATED", draftGrade: s.draftGrade, assignedGrade: s.assignedGrade, late: s.late ?? false }, at);
    }
  }

  #addSubmission(work: CourseWork, personId: string, values: { state: Submission["state"]; draftGrade?: number | undefined; assignedGrade?: number | undefined; late: boolean }, at: string): void {
    const id = this.submissionId(work.id, personId);
    this.#submissions.set(id, {
      courseId: work.courseId,
      courseWorkId: work.id,
      id,
      personId,
      state: values.state,
      ...(values.draftGrade === undefined ? {} : { draftGrade: values.draftGrade }),
      ...(values.assignedGrade === undefined ? {} : { assignedGrade: values.assignedGrade }),
      late: values.late,
      created: at,
      updated: at,
      history: [{ stateHistory: { state: "CREATED", stateTimestamp: at, actorUserId: this.userId(personId) } }],
    });
  }

  protected override removeLargeShare(fraction: number): void {
    const present = new Set([...this.#courses.values()].flatMap((c) => c.students));
    const seed = { ...this.#seed, people: this.#seed.people.filter((p) => p.role !== "student" || present.has(p.id)) };
    const removed = studentsToRemove(seed, fraction);
    for (const course of this.#courses.values()) {
      for (const personId of course.students.filter((id) => removed.has(id))) this.removeStudent(course.section.id, personId);
    }
  }

  protected override errorResponse(status: number, reason: "outage" | "rate-limit"): Response {
    if (reason === "rate-limit") {
      return googleErrorResponse(429, "RESOURCE_EXHAUSTED",
        "Quota exceeded for quota metric 'Requests' and limit 'Requests per minute per user' of service 'classroom.googleapis.com' for consumer 'project_number:100000000001'.",
        { info: { reason: "RATE_LIMIT_EXCEEDED", metadata: { service: "classroom.googleapis.com", quota_metric: "classroom.googleapis.com/default_requests", quota_limit: "DefaultRequestsPerMinutePerUser", consumer: "projects/100000000001" } } });
    }
    if (status === 504) return googleErrorResponse(504, "DEADLINE_EXCEEDED", "The request was aborted because it took too long.");
    if (status === 500) return googleErrorResponse(500, "INTERNAL", "Internal error encountered.");
    return googleErrorResponse(status, "UNAVAILABLE", "The service is currently unavailable.");
  }

  protected override async serve(request: Request, body: string): Promise<Response> {
    this.#current = request;
    try {
      return this.#route(request, body);
    } catch (error) {
      if (error instanceof GoogleError) return error.response();
      throw error;
    } finally {
      this.#current = undefined;
    }
  }

  #route(request: Request, body: string): Response {
    const url = new URL(request.url);
    if (url.origin !== new URL(CLASSROOM_API_BASE).origin || !url.pathname.startsWith("/v1/")) throw notFound();
    const caller = this.#authenticate(request);
    if (this.#apiDisabled) throw new GoogleError(403, "PERMISSION_DENIED", "@ClassroomApiDisabled The user is not permitted to access the Classroom API.");
    const segments = decodeSegments(url.pathname.slice("/v1/".length));
    if (segments === undefined) throw notFound();
    const [verbless, verb] = splitVerb(segments.at(-1)!);
    segments[segments.length - 1] = verbless;
    const method = request.method.toUpperCase();
    const q = url.searchParams;
    if (segments[0] !== "courses") throw notFound();
    // Only a submission takes a custom verb (`:return`, `:turnIn`); on anything else it names nothing.
    if (verb !== undefined && segments.length !== 6) throw notFound();

    if (segments.length === 1) {
      if (method !== "GET") throw notFound();
      this.#need(caller, COURSE_READ, "google.classroom.v1.Courses.ListCourses");
      return this.#listCourses(caller, url);
    }
    const course = this.#visibleCourse(caller, segments[1]!);
    if (segments.length === 2) {
      if (method !== "GET") throw notFound();
      this.#need(caller, COURSE_READ, "google.classroom.v1.Courses.GetCourse");
      return Response.json(this.#courseJson(course, caller));
    }
    const resource = segments[2];
    if ((resource === "teachers" || resource === "students") && method === "GET") {
      const service = resource === "teachers" ? "Teachers" : "Students";
      if (segments.length === 3) {
        this.#need(caller, ROSTER_READ, `google.classroom.v1.Courses.${service}.List${service}`);
        const items = course[resource].map((id) => this.#memberJson(course, id, caller));
        return this.#page(url, items, resource);
      }
      if (segments.length === 4) {
        this.#need(caller, ROSTER_READ, `google.classroom.v1.Courses.${service}.Get${service.slice(0, -1)}`);
        const personId = this.#resolveUser(segments[3]!, caller, false);
        if (personId === undefined || !course[resource].includes(personId)) throw notFound();
        return Response.json(this.#memberJson(course, personId, caller));
      }
    }
    if (resource !== "courseWork") throw notFound();
    if (segments.length === 3) {
      if (method === "GET") {
        this.#need(caller, COURSEWORK_READ, "google.classroom.v1.Courses.CourseWork.ListCourseWork");
        const states = q.getAll("courseWorkStates");
        const wanted = states.length === 0 ? ["PUBLISHED"] : states;
        const items = this.#workOf(course, caller)
          .filter((w) => wanted.includes(w.state))
          .toSorted((a, b) => Date.parse(b.updated) - Date.parse(a.updated))
          .map((w) => this.#courseWorkJson(w));
        return this.#page(url, items, "courseWork");
      }
      if (method === "POST") {
        this.#need(caller, [S.courseworkStudents], "google.classroom.v1.Courses.CourseWork.CreateCourseWork");
        return this.#createCourseWork(course, caller, body);
      }
      throw notFound();
    }
    const workId = segments[3]!;
    if (segments.length === 4) {
      if (method !== "GET") throw notFound();
      this.#need(caller, COURSEWORK_READ, "google.classroom.v1.Courses.CourseWork.GetCourseWork");
      return Response.json(this.#courseWorkJson(this.#visibleWork(course, caller, workId)));
    }
    if (segments[4] !== "studentSubmissions") throw notFound();
    if (segments.length === 5) {
      if (method !== "GET") throw notFound();
      this.#need(caller, COURSEWORK_READ, "google.classroom.v1.Courses.CourseWork.StudentSubmissions.ListStudentSubmissions");
      return this.#listSubmissions(url, course, caller, workId);
    }
    if (segments.length !== 6) throw notFound();
    const work = this.#visibleWork(course, caller, workId);
    const submission = this.#submissions.get(segments[5]!);
    if (submission === undefined || submission.courseWorkId !== work.id) throw notFound();
    const teaches = course.teachers.includes(caller.userId);
    if (!teaches && submission.personId !== caller.userId && !this.#isAdmin(caller)) throw denied();

    if (verb === undefined && method === "GET") {
      this.#need(caller, COURSEWORK_READ, "google.classroom.v1.Courses.CourseWork.StudentSubmissions.GetStudentSubmission");
      return Response.json(this.#submissionJson(submission));
    }
    if (verb === undefined && method === "PATCH") {
      this.#need(caller, [S.courseworkStudents, S.courseworkMe], "google.classroom.v1.Courses.CourseWork.StudentSubmissions.PatchStudentSubmission");
      if (!work.ownedByDeveloper) throw projectDenied();
      if (!teaches) throw denied();
      return this.#patchSubmission(submission, q.get("updateMask"), body);
    }
    if (verb === "return" && method === "POST") {
      this.#need(caller, [S.courseworkStudents], "google.classroom.v1.Courses.CourseWork.StudentSubmissions.ReturnStudentSubmission");
      if (!work.ownedByDeveloper) throw projectDenied();
      if (!teaches) throw denied();
      this.#transition(submission, "RETURNED", caller);
      return Response.json({});
    }
    if (verb === "turnIn" && method === "POST") {
      this.#need(caller, [S.courseworkMe], "google.classroom.v1.Courses.CourseWork.StudentSubmissions.TurnInStudentSubmission");
      if (!work.ownedByDeveloper) throw projectDenied();
      if (submission.personId !== caller.userId) throw denied();
      // A returned submission may be turned in again (resubmitted); one already turned in may not.
      if (submission.state === "TURNED_IN") {
        throw new GoogleError(400, "FAILED_PRECONDITION", "@CourseWorkStateTransitionInvalid The submission cannot be turned in from its current state.");
      }
      submission.late = work.dueAt !== undefined && this.now() > Date.parse(work.dueAt);
      this.#transition(submission, "TURNED_IN", caller);
      return Response.json({});
    }
    throw notFound();
  }

  #authenticate(request: Request): ClassroomGrant {
    const token = bearer(request);
    const grant = this.#grants.lookup(token);
    if (grant !== undefined) return grant;
    const headers = { "www-authenticate": 'Bearer realm="https://accounts.google.com/"' };
    if (token === undefined) {
      throw new GoogleError(401, "UNAUTHENTICATED",
        "Request is missing required authentication credential. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.",
        { reason: "CREDENTIALS_MISSING", metadata: { service: "classroom.googleapis.com" } }, headers);
    }
    throw new GoogleError(401, "UNAUTHENTICATED",
      "Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.",
      { reason: "ACCESS_TOKEN_TYPE_UNSUPPORTED", metadata: { service: "classroom.googleapis.com" } }, headers);
  }

  #need(caller: ClassroomGrant, scopes: readonly string[], method: string): void {
    if (caller.scopes.some((s) => scopes.includes(s))) return;
    throw new GoogleError(403, "PERMISSION_DENIED", "Request had insufficient authentication scopes.",
      { reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT", metadata: { service: "classroom.googleapis.com", method } },
      { "www-authenticate": `Bearer realm="https://accounts.google.com/", error="insufficient_scope", scope="${scopes.join(" ")}"` });
  }

  #isAdmin(caller: ClassroomGrant): boolean {
    return this.#people.get(caller.userId)?.role === "administrator";
  }

  #member(course: Course, personId: string): boolean {
    return course.teachers.includes(personId) || course.students.includes(personId);
  }

  /** A user named as a numeric ID, an email address or `me`, as a seed person ID. */
  #resolveUser(name: string, caller: ClassroomGrant, strict = true): string | undefined {
    if (name === "me") return caller.userId;
    const person = this.#seed.people.find((p) => (name.includes("@") ? p.email.toLowerCase() === name.toLowerCase() : this.userId(p.id) === name));
    if (person === undefined && strict) throw notFound();
    return person?.id;
  }

  #visibleCourse(caller: ClassroomGrant, id: string): Course {
    const course = this.#courses.get(id);
    if (course === undefined) throw notFound();
    if (!this.#member(course, caller.userId) && !this.#isAdmin(caller)) throw denied();
    return course;
  }

  /** The coursework the caller may see: students see only published work. */
  #workOf(course: Course, caller: ClassroomGrant): CourseWork[] {
    const staff = course.teachers.includes(caller.userId) || this.#isAdmin(caller);
    return [...this.#courseWork.values()].filter((w) => w.courseId === course.id && w.state !== "DELETED" && (staff || w.state === "PUBLISHED"));
  }

  #visibleWork(course: Course, caller: ClassroomGrant, id: string): CourseWork {
    const work = this.#workOf(course, caller).find((w) => w.id === id);
    if (work === undefined) throw notFound();
    return work;
  }

  #listCourses(caller: ClassroomGrant, url: URL): Response {
    const q = url.searchParams;
    const teacher = q.get("teacherId");
    const student = q.get("studentId");
    const teacherId = teacher === null ? undefined : this.#resolveUser(teacher, caller);
    const studentId = student === null ? undefined : this.#resolveUser(student, caller);
    const states = q.getAll("courseStates");
    for (const state of states) if (!COURSE_STATES.includes(state)) throw invalid(`Invalid value at 'course_states' (TYPE_ENUM), "${state}"`);
    const items = [...this.#courses.values()]
      .filter((c) => this.#isAdmin(caller) || this.#member(c, caller.userId))
      .filter((c) => teacherId === undefined || c.teachers.includes(teacherId))
      .filter((c) => studentId === undefined || c.students.includes(studentId))
      .filter((c) => states.length === 0 || states.includes(c.state))
      .map((c) => this.#courseJson(c, caller));
    return this.#page(url, items, "courses");
  }

  #courseJson(course: Course, caller: ClassroomGrant): Json {
    const s = course.section;
    return {
      id: course.id,
      name: s.title,
      ...(s.period === undefined ? {} : { section: `Period ${s.period}` }),
      ...(s.room === undefined ? {} : { room: s.room }),
      ownerId: this.userId(course.teachers[0] ?? s.teacherIds[0]!),
      creationTime: course.created,
      updateTime: course.created,
      // Only teachers see the enrollment code.
      ...(course.teachers.includes(caller.userId) ? { enrollmentCode: tokenId("google-classroom-code", s.id, 7).toLowerCase().replace(/[-_]/g, "x") } : {}),
      courseState: course.state,
      alternateLink: `https://classroom.google.com/c/${btoa(course.id).replaceAll("=", "")}`,
      teacherGroupEmail: `${slug(s.title)}_teachers_${course.id.slice(-6)}@${this.#seed.domain}`,
      courseGroupEmail: `${slug(s.title)}_${course.id.slice(-6)}@${this.#seed.domain}`,
      guardiansEnabled: false,
      calendarId: `classroom${course.id}@group.calendar.google.example`,
      gradebookSettings: { calculationType: "TOTAL_POINTS", displaySetting: "HIDE_OVERALL_GRADE" },
    };
  }

  #memberJson(course: Course, personId: string, caller: ClassroomGrant): Json {
    const person = this.#people.get(personId)!;
    const profile: Json = {
      id: this.userId(personId),
      name: { givenName: person.givenName, familyName: person.familyName, fullName: `${person.givenName} ${person.familyName}` },
      ...(caller.scopes.includes(S.profileEmails) ? { emailAddress: person.email } : {}),
      ...(caller.scopes.includes(S.profilePhotos) ? { photoUrl: `//lh3.googleusercontent.example/a/${tokenId("google-photo", personId, 20)}` } : {}),
      ...(person.role === "teacher" ? { verifiedTeacher: true } : {}),
    };
    return { courseId: course.id, userId: this.userId(personId), profile };
  }

  #courseWorkJson(w: CourseWork): Json {
    const due = w.dueAt === undefined ? undefined : new Date(w.dueAt);
    return {
      courseId: w.courseId,
      id: w.id,
      title: w.title,
      ...(w.description === undefined ? {} : { description: w.description }),
      state: w.state,
      alternateLink: `https://classroom.google.com/c/${btoa(w.courseId).replaceAll("=", "")}/a/${btoa(w.id).replaceAll("=", "")}/details`,
      creationTime: w.created,
      updateTime: w.updated,
      ...(due === undefined
        ? {}
        : { dueDate: { year: due.getUTCFullYear(), month: due.getUTCMonth() + 1, day: due.getUTCDate() }, dueTime: { hours: due.getUTCHours(), minutes: due.getUTCMinutes() } }),
      ...(w.maxPoints === undefined ? {} : { maxPoints: w.maxPoints }),
      workType: w.workType,
      ...(w.ownedByDeveloper ? { associatedWithDeveloper: true } : {}),
      assigneeMode: "ALL_STUDENTS",
      submissionModificationMode: "MODIFIABLE_UNTIL_TURNED_IN",
      creatorUserId: this.userId(w.creatorPersonId),
      ...(w.workType === "ASSIGNMENT" ? { assignment: {} } : {}),
    };
  }

  #submissionJson(s: Submission): Json {
    const work = this.#courseWork.get(s.courseWorkId)!;
    return {
      courseId: s.courseId,
      courseWorkId: s.courseWorkId,
      id: s.id,
      userId: this.userId(s.personId),
      creationTime: s.created,
      updateTime: s.updated,
      state: s.state,
      ...(s.late ? { late: true } : {}),
      ...(s.draftGrade === undefined ? {} : { draftGrade: s.draftGrade }),
      ...(s.assignedGrade === undefined ? {} : { assignedGrade: s.assignedGrade }),
      alternateLink: `https://classroom.google.com/c/${btoa(s.courseId).replaceAll("=", "")}/a/${btoa(s.courseWorkId).replaceAll("=", "")}/submissions/by-status/and-sort-last-name/student/${btoa(this.userId(s.personId)).replaceAll("=", "")}`,
      courseWorkType: work.workType,
      ...(work.ownedByDeveloper ? { associatedWithDeveloper: true } : {}),
      ...(work.workType === "ASSIGNMENT" ? { assignmentSubmission: {} } : {}),
      submissionHistory: s.history,
    };
  }

  #createCourseWork(course: Course, caller: ClassroomGrant, body: string): Response {
    let draft: Json;
    try {
      const parsed: unknown = JSON.parse(body);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new TypeError();
      draft = parsed as Json;
    } catch {
      throw invalid("Invalid JSON payload received.");
    }
    for (const key of Object.keys(draft)) {
      if (!CREATE_FIELDS.has(key)) throw invalid(`Invalid JSON payload received. Unknown name "${key}" at 'course_work': Cannot find field.`);
    }
    if (!course.teachers.includes(caller.userId)) throw denied();
    if (typeof draft.title !== "string" || draft.title.trim() === "") throw invalid("title: Title is required.");
    if (typeof draft.workType !== "string" || !WORK_TYPES.includes(draft.workType)) throw invalid("workType: A supported work type is required.");
    const state = draft.state ?? "DRAFT";
    if (state !== "DRAFT" && state !== "PUBLISHED") throw invalid(`state: ${String(state)} is not a state coursework can be created in.`);
    if (draft.maxPoints !== undefined && !(typeof draft.maxPoints === "number" && draft.maxPoints >= 0)) throw invalid("maxPoints: must be a non-negative number.");
    if (course.state !== "ACTIVE") throw new GoogleError(400, "FAILED_PRECONDITION", "@InactiveCourseOwner The course is not active.");

    const at = iso(this.now());
    this.#createdWork += 1;
    const work: CourseWork = {
      courseId: course.id,
      id: numericId("google-classroom-created-coursework", `${course.id}:${this.#createdWork}`, 12),
      title: draft.title,
      ...(typeof draft.description === "string" ? { description: draft.description } : {}),
      state,
      ...(typeof draft.maxPoints === "number" ? { maxPoints: draft.maxPoints } : {}),
      workType: draft.workType,
      ownedByDeveloper: true,
      creatorPersonId: caller.userId,
      created: at,
      updated: at,
    };
    this.#courseWork.set(work.id, work);
    if (state === "PUBLISHED") for (const personId of course.students) this.#addSubmission(work, personId, { state: "NEW", late: false }, at);
    return Response.json(this.#courseWorkJson(work));
  }

  #listSubmissions(url: URL, course: Course, caller: ClassroomGrant, workId: string): Response {
    const q = url.searchParams;
    const works = workId === "-" ? this.#workOf(course, caller) : [this.#visibleWork(course, caller, workId)];
    const ids = new Set(works.map((w) => w.id));
    const user = q.get("userId");
    const userId = user === null ? undefined : this.#resolveUser(user, caller);
    const states = q.getAll("states");
    for (const state of states) if (!SUBMISSION_STATES.includes(state)) throw invalid(`Invalid value at 'states' (TYPE_ENUM), "${state}"`);
    const late = q.get("late") ?? "LATE_VALUES_UNSPECIFIED";
    if (!["LATE_VALUES_UNSPECIFIED", "LATE_ONLY", "NOT_LATE_ONLY"].includes(late)) throw invalid(`Invalid value at 'late' (TYPE_ENUM), "${late}"`);
    const staff = course.teachers.includes(caller.userId) || this.#isAdmin(caller);
    const items = [...this.#submissions.values()]
      .filter((s) => ids.has(s.courseWorkId))
      .filter((s) => staff || s.personId === caller.userId)
      .filter((s) => userId === undefined || s.personId === userId)
      .filter((s) => states.length === 0 || states.includes(s.state))
      .filter((s) => late === "LATE_VALUES_UNSPECIFIED" || (late === "LATE_ONLY") === s.late)
      .map((s) => this.#submissionJson(s));
    return this.#page(url, items, "studentSubmissions");
  }

  #patchSubmission(submission: Submission, updateMask: string | null, body: string): Response {
    if (updateMask === null || updateMask.trim() === "") throw invalid("updateMask: Update mask is required.");
    const fields = updateMask.split(",").map((f) => f.trim());
    for (const field of fields) if (field !== "draftGrade" && field !== "assignedGrade") throw invalid(`updateMask: ${field} is not a field a teacher may update.`);
    let patch: Json;
    try {
      patch = JSON.parse(body) as Json;
    } catch {
      throw invalid("Invalid JSON payload received.");
    }
    // `null`, an array or a scalar is no StudentSubmission; Google refuses it rather than clearing grades.
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) throw invalid("Invalid JSON payload received.");
    for (const field of fields) {
      const value = patch[field];
      if (value === undefined || value === null) {
        delete submission[field as "draftGrade" | "assignedGrade"];
        continue;
      }
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw invalid(`${field}: A grade must be a non-negative number.`);
      // Classroom keeps grades to two decimal places.
      submission[field as "draftGrade" | "assignedGrade"] = Math.round(value * 100) / 100;
    }
    submission.updated = iso(this.now());
    return Response.json(this.#submissionJson(submission));
  }

  #transition(submission: Submission, state: Submission["state"], caller: ClassroomGrant): void {
    const at = iso(this.now());
    submission.state = state;
    submission.updated = at;
    submission.history.push({ stateHistory: { state, stateTimestamp: at, actorUserId: this.userId(caller.userId) } });
  }

  /** One page of `items`, with a `nextPageToken` bound to this request when more remain. */
  #page(url: URL, items: Json[], key: string): Response {
    const q = url.searchParams;
    const sizeText = q.get("pageSize") ?? "0";
    if (!/^\d+$/.test(sizeText)) throw invalid(`Invalid value at 'page_size' (TYPE_INT32), "${sizeText}"`);
    const size = Number(sizeText) === 0 ? this.#maxPageSize : Math.min(Number(sizeText), this.#maxPageSize);
    const rest = new URLSearchParams(q);
    rest.delete("pageToken");
    rest.delete("pageSize");
    rest.sort();
    const fingerprint = `${url.pathname}?${rest}`;
    const token = q.get("pageToken");
    const offset = token === null || token === "" ? 0 : readPageToken(token, fingerprint);
    let page = items.slice(offset, offset + size);
    if (page.length > 0 && this.#current !== undefined && this.takeMalformed(this.#current)) page = [malformed(key, page[0]!), ...page.slice(1)];
    const next = offset + size < items.length ? pageToken(offset + size, fingerprint) : undefined;
    // An empty list is served as `{}`: Google omits empty repeated fields.
    return Response.json({ ...(page.length === 0 ? {} : { [key]: page }), ...(next === undefined ? {} : { nextPageToken: next }) });
  }
}

/** Splits a custom method off a path segment, as `abc:return` → [`abc`, `return`]. */
function splitVerb(segment: string): [string, string | undefined] {
  const colon = segment.indexOf(":");
  return colon === -1 ? [segment, undefined] : [segment.slice(0, colon), segment.slice(colon + 1)];
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

/** One list item broken as a malformed-record fault: the identifying field it cannot be used without is gone. */
function malformed(key: string, item: Json): Json {
  const copy = structuredClone(item);
  if (key === "teachers" || key === "students" || key === "studentSubmissions") delete copy.userId;
  else delete copy.id;
  return copy;
}
