// Google Classroom REST v1 client, called with the connected teacher's own OAuth token.
//
// Classroom binds coursework to the Cloud project of the OAuth client that created it: only that
// project may change it or grade its submissions, and Google refuses anyone else with
// `@ProjectPermissionDenied`. So the client lists only coursework Classroom reports as
// `associatedWithDeveloper`, and refuses locally what Google would refuse remotely.
// docs/educateos/integrations/google-classroom.md is the design record.

import { AccessTokenProvider, fetchWithAuthRetry } from "./auth-retry";
import type {
  ClassroomRubricUpdate, ClassroomGradingPeriodUpdate, ClassroomRubric, ClassroomRubricDraft, ClassroomGradingPeriodSettings,
  ClassroomCourse, ClassroomCourseWork, ClassroomCourseWorkDraft, ClassroomRoster,
  ClassroomRosterMember, ClassroomSubmission,
} from "./classroom-types";
import { GoogleApiError, readGoogleJson } from "./google-response";

import { classroomRubricUpdate, classroomGradingPeriodUpdate, classroomRubricDraft, classroomRubricFromRaw, classroomGradingPeriodsFromRaw } from "./classroom-plus";

const CLASSROOM_API_BASE = "https://classroom.googleapis.com/v1";
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 100;
// Classroom caps a class at 1,000 students; well past that, a listing is refused, not truncated.
const MAX_LIST_ITEMS = 5_000;

const NUMERIC_ID_RE = /^\d{1,32}$/;
const SUBMISSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function validated(value: string, pattern: RegExp, what: string): string {
  if (!pattern.test(value)) throw new Error(`Invalid Google Classroom ${what}.`);
  return value;
}

/**
 * Validate a Classroom course ID. Only the numeric form is accepted: Classroom also resolves
 * aliases (`d:` and `p:`), which can be repointed at another course.
 */
export function validateClassroomCourseId(courseId: string): string {
  return validated(courseId, NUMERIC_ID_RE, "course ID");
}

/** Validate a coursework ID before it is interpolated into a request path. */
export function validateClassroomCourseWorkId(courseWorkId: string): string {
  return validated(courseWorkId, NUMERIC_ID_RE, "coursework ID");
}

/** Validate a submission ID before it is interpolated into a request path. */
export function validateClassroomSubmissionId(submissionId: string): string {
  return validated(submissionId, SUBMISSION_ID_RE, "submission ID");
}

/** Validate a Classroom user ID, as a roster entry names a student. */
export function validateClassroomUserId(userId: string): string {
  return validated(userId, NUMERIC_ID_RE, "user ID");
}

/**
 * Refuse a grade Classroom would change: it must be non-negative, and Classroom rounds to two
 * decimal places, which would publish a grade the teacher never approved.
 */
export function validateClassroomGrade(grade: number): number {
  if (!Number.isFinite(grade) || grade < 0) {
    throw new Error("A Google Classroom grade must be a non-negative number.");
  }
  if (Number(grade.toFixed(2)) !== grade) {
    throw new Error(
      `Google Classroom keeps grades to two decimal places, so ${grade} would be rounded. Give ` +
      "the grade with at most two decimal places.");
  }
  return grade;
}

/** Coursework or a submission this connection's Google Cloud project did not create. */
export class ClassroomNotOwnedError extends Error {
  constructor() {
    super(
      "Google Classroom lets an app change only the coursework it created, and this coursework " +
      "was not created through this Google connection. Create the coursework with " +
      "createCourseWork() to grade it here.");
  }
}

/** The student must turn work in before the teacher can return its grade. */
export class ClassroomSubmissionNotReadyError extends Error {
  constructor() {
    super("This submission has not been turned in. Ask the student to turn it in before grading and returning it.");
  }
}

/** Refuse return-ineligible work before changing a grade. Returned work may be regraded. */
export function assertClassroomSubmissionReady(submission: ClassroomSubmission): void {
  if (submission.state !== "TURNED_IN" && submission.state !== "RETURNED") throw new ClassroomSubmissionNotReadyError();
}

const API_DISABLED_MESSAGE =
  "Google Classroom data access is turned off for this account. A Google Workspace admin must " +
  "turn it on: Admin console > Apps > Google Workspace > Classroom > Data access, then allow " +
  "users to authorize apps to access their Google Classroom data.";

const QUOTA_MESSAGE =
  "Google Classroom's request quota is exhausted (1,200 requests a minute per user). Wait a " +
  "minute and try again.";

/**
 * Translates Classroom's documented errors into ones a teacher can act on. Anything else is
 * rethrown unchanged: `GoogleApiError` already carries no response prose.
 */
function classroomError(error: unknown): unknown {
  if (!(error instanceof GoogleApiError)) return error;
  if (error.providerReasons.includes("ProjectPermissionDenied")) return new ClassroomNotOwnedError();
  if (error.providerReasons.includes("ClassroomApiDisabled")) {
    return new Error(API_DISABLED_MESSAGE, { cause: error });
  }
  if (error.providerStatus === "RESOURCE_EXHAUSTED") return new Error(QUOTA_MESSAGE, { cause: error });
  return error;
}

/** Whether Classroom refused for want of access rather than failing transiently. */
export function isClassroomNoAccessError(error: unknown): boolean {
  // Classroom data access being off for the account is also a refusal, wrapped in a clearer error.
  let cause = error instanceof GoogleApiError ? error : error instanceof Error ? error.cause : undefined;
  return cause instanceof GoogleApiError &&
    (cause.providerStatus === "PERMISSION_DENIED" || cause.providerStatus === "NOT_FOUND");
}

// ── Response parsing ────────────────────────────────────────────────
//
// Every response is read field by field into the agent-facing types, so a field Google adds is
// dropped rather than passed through, and one of the wrong type is treated as absent.

type Raw = Record<string, unknown>;

function record(value: unknown): Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Raw : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback;
}

/** The fields `extra` names whose values are present, for spreading into a result. */
function present<T extends object>(extra: T): Partial<T> {
  return Object.fromEntries(Object.entries(extra).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function requiredId(raw: Raw, key: string, what: string): string {
  let id = text(raw[key]);
  if (id === undefined) throw new Error(`Google Classroom returned a ${what} without an ID.`);
  return id;
}

const COURSE_STATES = [
  "ACTIVE", "ARCHIVED", "PROVISIONED", "DECLINED", "SUSPENDED", "COURSE_STATE_UNSPECIFIED",
] as const;
const COURSE_WORK_STATES = ["PUBLISHED", "DRAFT", "DELETED", "COURSE_WORK_STATE_UNSPECIFIED"] as const;
const SUBMISSION_STATES = [
  "NEW", "CREATED", "TURNED_IN", "RETURNED", "RECLAIMED_BY_STUDENT", "SUBMISSION_STATE_UNSPECIFIED",
] as const;

/** A course as the agent sees it. */
export function classroomCourseFromRaw(value: unknown): ClassroomCourse {
  let raw = record(value);
  let id = requiredId(raw, "id", "course");
  return {
    id,
    name: text(raw.name) ?? id,
    courseState: oneOf(raw.courseState, COURSE_STATES, "COURSE_STATE_UNSPECIFIED"),
    ...present({
      section: text(raw.section), description: text(raw.description), room: text(raw.room),
      alternateLink: text(raw.alternateLink),
    }),
  };
}

/** A teacher or student roster entry. Classroom nests the name under `profile`. */
export function classroomRosterMemberFromRaw(value: unknown): ClassroomRosterMember {
  let raw = record(value);
  let userId = requiredId(raw, "userId", "roster entry");
  return { userId, ...present({ name: text(record(record(raw.profile).name).fullName) }) };
}

/** Coursework, with whether this connection's project created it. */
export type OwnedCourseWork = { courseWork: ClassroomCourseWork; owned: boolean };

/** Coursework as the agent sees it, and whether this connection's project owns it. */
export function classroomCourseWorkFromRaw(value: unknown): OwnedCourseWork {
  let raw = record(value);
  let updateTime = text(raw.updateTime);
  return {
    courseWork: {
      id: requiredId(raw, "id", "coursework item"),
      title: text(raw.title) ?? "(untitled)",
      state: oneOf(raw.state, COURSE_WORK_STATES, "COURSE_WORK_STATE_UNSPECIFIED"),
      ...present({
        description: text(raw.description), maxPoints: finite(raw.maxPoints),
        alternateLink: text(raw.alternateLink),
        updateTime: updateTime === undefined ? undefined : new Date(updateTime),
      }),
    },
    owned: raw.associatedWithDeveloper === true,
  };
}

/** A student submission as the agent sees it. */
export function classroomSubmissionFromRaw(value: unknown): ClassroomSubmission {
  let raw = record(value);
  return {
    id: requiredId(raw, "id", "submission"),
    courseWorkId: requiredId(raw, "courseWorkId", "submission"),
    userId: requiredId(raw, "userId", "submission"),
    state: oneOf(raw.state, SUBMISSION_STATES, "SUBMISSION_STATE_UNSPECIFIED"),
    ...present({
      late: raw.late === true ? true : undefined,
      assignedGrade: finite(raw.assignedGrade), draftGrade: finite(raw.draftGrade),
      alternateLink: text(raw.alternateLink),
    }),
  };
}

/** A Classroom REST client for one connected account. */
export class ClassroomApi {
  constructor(private getAccessToken: AccessTokenProvider) {}

  /**
   * One Classroom request. `idempotent` lets a write that is safe to send twice be retried on 429
   * and 5xx, as a GET always is.
   */
  async #request(path: string, operation: string, init: RequestInit = {}, idempotent = false)
      : Promise<Raw> {
    try {
      let headers = new Headers(init.headers);
      if (init.body !== undefined) headers.set("Content-Type", "application/json");
      let response = await fetchWithAuthRetry(
        `${CLASSROOM_API_BASE}${path}`, { ...init, headers }, this.getAccessToken,
        { timeoutMs: REQUEST_TIMEOUT_MS, idempotent });
      if (init.method === "DELETE" && response.status === 204) return {};
      return record(await readGoogleJson<unknown>(response, {
        provider: "Google Classroom", operation, maxBytes: MAX_RESPONSE_BYTES,
      }));
    } catch (error) {
      throw classroomError(error);
    }
  }

  /** Every item of a paged listing, following `nextPageToken`. */
  async #listAll(path: string, params: URLSearchParams, key: string, operation: string)
      : Promise<unknown[]> {
    let items: unknown[] = [];
    let pageToken: string | undefined;
    do {
      let query = new URLSearchParams(params);
      query.set("pageSize", String(PAGE_SIZE));
      if (pageToken) query.set("pageToken", pageToken);
      let page = await this.#request(`${path}?${query}`, operation);
      let pageItems = page[key];
      if (Array.isArray(pageItems)) items.push(...pageItems);
      if (items.length > MAX_LIST_ITEMS) {
        throw new Error(`Google Classroom returned more than ${MAX_LIST_ITEMS} items.`);
      }
      pageToken = text(page.nextPageToken);
    } while (pageToken);
    return items;
  }

  #course(courseId: string): string {
    return `/courses/${validateClassroomCourseId(courseId)}`;
  }

  #courseWork(courseId: string, courseWorkId: string): string {
    return `${this.#course(courseId)}/courseWork/${validateClassroomCourseWorkId(courseWorkId)}`;
  }

  #submission(courseId: string, courseWorkId: string, submissionId: string): string {
    return `${this.#courseWork(courseId, courseWorkId)}/studentSubmissions/` +
      validateClassroomSubmissionId(submissionId);
  }

  /** The active courses the connected account teaches, for the course picker. */
  async listTaughtCourses(): Promise<ClassroomCourse[]> {
    let params = new URLSearchParams({ teacherId: "me", courseStates: "ACTIVE" });
    return (await this.#listAll("/courses", params, "courses", "list courses"))
      .map(classroomCourseFromRaw);
  }

  async getCourse(courseId: string): Promise<ClassroomCourse> {
    return classroomCourseFromRaw(await this.#request(this.#course(courseId), "get course"));
  }

  /** Whether the connected account teaches the course. */
  async isTeacher(courseId: string): Promise<boolean> {
    try {
      await this.#request(`${this.#course(courseId)}/teachers/me`, "get teacher");
      return true;
    } catch (error) {
      if (isClassroomNoAccessError(error)) return false;
      throw error;
    }
  }

  async getRoster(courseId: string): Promise<ClassroomRoster> {
    let [teachers, students] = await Promise.all(["teachers", "students"].map(async key =>
      (await this.#listAll(`${this.#course(courseId)}/${key}`, new URLSearchParams(), key,
        `list ${key}`)).map(classroomRosterMemberFromRaw)));
    return { teachers, students };
  }

  /** Grading periods of the bound course, without inventing missing settings. */
  async getGradingPeriodSettings(courseId: string): Promise<ClassroomGradingPeriodSettings> {
    return classroomGradingPeriodsFromRaw(await this.#request(`${this.#course(courseId)}/gradingPeriodSettings`, "read grading periods"));
  }

  /** Rubrics are visible only through coursework this project owns. */
  async listRubrics(courseId: string, courseWorkId: string): Promise<ClassroomRubric[]> {
    await this.getOwnedCourseWork(courseId, courseWorkId);
    return (await this.#listAll(`${this.#courseWork(courseId, courseWorkId)}/rubrics`, new URLSearchParams(), "rubrics", "list rubrics"))
      .map(classroomRubricFromRaw);
  }

  /** Create once; the action journal handles an unknown outcome rather than retrying a POST. */
  async createRubric(courseId: string, courseWorkId: string, draft: ClassroomRubricDraft): Promise<ClassroomRubric> {
    const body = classroomRubricDraft(draft);
    await this.getOwnedCourseWork(courseId, courseWorkId);
    return classroomRubricFromRaw(await this.#request(`${this.#courseWork(courseId, courseWorkId)}/rubrics`, "create rubric", {
      method: "POST", body: JSON.stringify(body),
    }));
  }

  /** Replace only criteria on coursework owned by this OAuth project. */
  async updateRubric(courseId: string, courseWorkId: string, rubricId: string, update: ClassroomRubricUpdate): Promise<ClassroomRubric> {
    const body = classroomRubricUpdate(update);
    const id = validated(rubricId, NUMERIC_ID_RE, "rubric ID");
    await this.getOwnedCourseWork(courseId, courseWorkId);
    return classroomRubricFromRaw(await this.#request(`${this.#courseWork(courseId, courseWorkId)}/rubrics/${id}?updateMask=criteria`, "update rubric", { method: "PATCH", body: JSON.stringify(body) }));
  }

  /** Delete a rubric only after rechecking coursework ownership at apply time. */
  async deleteRubric(courseId: string, courseWorkId: string, rubricId: string): Promise<void> {
    const id = validated(rubricId, NUMERIC_ID_RE, "rubric ID");
    await this.getOwnedCourseWork(courseId, courseWorkId);
    await this.#request(`${this.#courseWork(courseId, courseWorkId)}/rubrics/${id}`, "delete rubric", { method: "DELETE" });
  }

  /** Replace the bound course's periods; new periods can be minted, so never retry an uncertain PATCH. */
  async updateGradingPeriodSettings(courseId: string, settings: ClassroomGradingPeriodUpdate): Promise<ClassroomGradingPeriodSettings> {
    const body = classroomGradingPeriodUpdate(settings);
    return classroomGradingPeriodsFromRaw(await this.#request(`${this.#course(courseId)}/gradingPeriodSettings?updateMask=grading_periods,apply_to_existing_coursework`, "update grading periods", { method: "PATCH", body: JSON.stringify(body) }));
  }

  /** The course's published and draft coursework that this connection's project created. */
  async listOwnedCourseWork(courseId: string): Promise<ClassroomCourseWork[]> {
    let params = new URLSearchParams([
      ["courseWorkStates", "PUBLISHED"], ["courseWorkStates", "DRAFT"],
    ]);
    return (await this.#listAll(
      `${this.#course(courseId)}/courseWork`, params, "courseWork", "list coursework"))
      .map(classroomCourseWorkFromRaw)
      .filter(({ owned }) => owned)
      .map(({ courseWork }) => courseWork);
  }

  /** One coursework item, refused locally unless this connection's project created it. */
  async getOwnedCourseWork(courseId: string, courseWorkId: string): Promise<ClassroomCourseWork> {
    let { courseWork, owned } = classroomCourseWorkFromRaw(
      await this.#request(this.#courseWork(courseId, courseWorkId), "get coursework"));
    if (!owned) throw new ClassroomNotOwnedError();
    return courseWork;
  }

  /** Create an assignment, which this connection's project then owns. */
  async createCourseWork(courseId: string, draft: ClassroomCourseWorkDraft)
      : Promise<ClassroomCourseWork> {
    let body = {
      title: draft.title,
      workType: "ASSIGNMENT",
      state: draft.state ?? "DRAFT",
      ...present({ description: draft.description, maxPoints: draft.maxPoints }),
    };
    return classroomCourseWorkFromRaw(await this.#request(
      `${this.#course(courseId)}/courseWork`, "create coursework",
      { method: "POST", body: JSON.stringify(body) })).courseWork;
  }

  async listSubmissions(courseId: string, courseWorkId: string, userId?: string)
      : Promise<ClassroomSubmission[]> {
    let params = new URLSearchParams(
      userId === undefined ? {} : { userId: validateClassroomUserId(userId) });
    return (await this.#listAll(
      `${this.#courseWork(courseId, courseWorkId)}/studentSubmissions`, params,
      "studentSubmissions", "list submissions"))
      .map(classroomSubmissionFromRaw);
  }

  async getSubmission(courseId: string, courseWorkId: string, submissionId: string)
      : Promise<ClassroomSubmission> {
    return classroomSubmissionFromRaw(await this.#request(
      this.#submission(courseId, courseWorkId, submissionId), "get submission"));
  }

  /**
   * Set a submission's `assignedGrade`, then return it so the student sees the grade: `return`
   * alone does not copy the draft grade, as the Classroom UI does. Both are safe to repeat, so
   * both are retried on a 429.
   */
  async gradeAndReturn(
    courseId: string, courseWorkId: string, submissionId: string, assignedGrade: number,
  ): Promise<void> {
    validateClassroomGrade(assignedGrade);
    const submission = await this.getSubmission(courseId, courseWorkId, submissionId);
    assertClassroomSubmissionReady(submission);
    let path = this.#submission(courseId, courseWorkId, submissionId);
    await this.#request(
      `${path}?updateMask=assignedGrade`, "patch submission",
      { method: "PATCH", body: JSON.stringify({ assignedGrade: validateClassroomGrade(assignedGrade) }) },
      true);
    if (submission.state !== "RETURNED") {
      await this.#request(`${path}:return`, "return submission", { method: "POST", body: "{}" }, true);
    }
  }
}
