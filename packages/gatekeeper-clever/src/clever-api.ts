// A small client for the Clever Data API v3.1 and its LMS Connect gradebook endpoints, authorized
// by one district's district-app token. Built to Clever's published v3.1 OpenAPI file
// (github.com/Clever/swagger-api, full-v3.yml): the records of /districts, /schools, /terms,
// /courses, /sections and /users, `links`-based paging, and the LMS Connect operations
// createAssignmentForSection, getAssignmentForSection, getSubmissionsForAssignment and
// get/updateSubmissionForAssignment. LMS Connect needs a Clever Complete agreement and has not been
// run against Clever; its tests run against `CleverDataFake` in @educateos/provider-fakes.
//
// `@educateos/integrations`' CleverDataClient reads whole collections for a roster sync from a
// fixed host, and `@educateos/lti`'s CleverLmsConnectClient covers only what grade passback needs,
// so neither fits a gatekeeper that reads single records from a configurable base. The rules are
// theirs: no redirects followed, a size cap on every response, error bodies never read, and
// messages that name the record and status only.
//
// Records are parsed field by field into the shapes below. A field this file does not name (email,
// contacts, demographics, credentials) never leaves this module.

import { readTextCapped } from "@gadgets/gatekeeper-kit/response-body";
import { CLEVER_ID } from "./clever-env";
import { invalid, notFound, unavailable } from "./clever-errors";

/** The largest response body read. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/** Records per page asked for. */
const PAGE_SIZE = 1000;
/** The most pages one listing follows, so a looping server cannot stall a call. */
const MAX_PAGES = 50;
/** LMS Connect's page cap for submissions (the spec's `maximum: 100`). */
const SUBMISSIONS_PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 30_000;

/** A Clever user, as far as the gatekeeper reads one. */
export type CleverUserRecord = {
  id: string;
  district: string;
  first: string;
  last: string;
  /** The roles the user holds, each with the schools it lists. */
  roles: {
    student?: { grade?: string; schools: string[] };
    teacher?: { schools: string[] };
    staff?: { schools: string[] };
    district_admin?: Record<string, never>;
  };
};

export type CleverSectionRecord = {
  id: string;
  district: string;
  school: string;
  name: string;
  course?: string;
  termId?: string;
  subject?: string;
  grade?: string;
  period?: string;
  teachers: string[];
  students: string[];
};

export type CleverSchoolRecord = { id: string; district: string; name: string };
export type CleverTermRecord = { id: string; name?: string; startDate?: string; endDate?: string };
export type CleverCourseRecord = { id: string; name?: string };
export type CleverDistrictRecord = { id: string; name: string };

/** An LMS Connect assignment, as far as the gatekeeper reads one. */
export type LmsAssignmentRecord = {
  id: string;
  title: string;
  description?: string;
  gradingType: string;
  pointsPossible?: number;
  dueDate?: string;
};

export type LmsSubmissionState = "created" | "submitted" | "returned" | "reclaimed";

/** An LMS Connect submission, as far as the gatekeeper reads one. */
export type LmsSubmissionRecord = {
  userId: string;
  state: LmsSubmissionState;
  gradePoints?: number;
  gradeComment?: string;
};

type Raw = Record<string, unknown>;

function record(value: unknown, what: string): Raw {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw unavailable(`Clever's ${what} is malformed.`);
  }
  return value as Raw;
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string") throw unavailable(`Clever's ${what} is malformed.`);
  return value;
}

/** A string field that may be absent, null or empty; all three read as absent. */
function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

function schoolsOf(role: Raw | undefined): string[] {
  if (role === undefined) return [];
  const listed = ids(role.schools);
  const single = optionalText(role.school);
  return single !== undefined && !listed.includes(single) ? [...listed, single] : listed;
}

function roleBody(roles: Raw, name: string): Raw | undefined {
  const body = roles[name];
  return typeof body === "object" && body !== null && !Array.isArray(body) ? body as Raw : undefined;
}

export function parseUser(value: unknown): CleverUserRecord {
  const raw = record(value, "user");
  const name = record(raw.name ?? {}, "user");
  const roles = record(raw.roles ?? {}, "user");
  const student = roleBody(roles, "student");
  const teacher = roleBody(roles, "teacher");
  const staff = roleBody(roles, "staff");
  const admin = roleBody(roles, "district_admin");
  const grade = optionalText(student?.grade);
  return {
    id: text(raw.id, "user"),
    district: text(raw.district, "user"),
    first: optionalText(name.first) ?? "",
    last: optionalText(name.last) ?? "",
    roles: {
      ...(student ? { student: { ...(grade === undefined ? {} : { grade }), schools: schoolsOf(student) } } : {}),
      ...(teacher ? { teacher: { schools: schoolsOf(teacher) } } : {}),
      ...(staff ? { staff: { schools: schoolsOf(staff) } } : {}),
      ...(admin ? { district_admin: {} } : {}),
    },
  };
}

export function parseSection(value: unknown): CleverSectionRecord {
  const raw = record(value, "section");
  const teachers = ids(raw.teachers);
  const primary = optionalText(raw.teacher);
  if (primary !== undefined && !teachers.includes(primary)) teachers.push(primary);
  const course = optionalText(raw.course);
  const termId = optionalText(raw.term_id);
  const subject = optionalText(raw.subject);
  const grade = optionalText(raw.grade);
  const period = optionalText(raw.period);
  return {
    id: text(raw.id, "section"),
    district: text(raw.district, "section"),
    school: text(raw.school, "section"),
    name: optionalText(raw.name) ?? "Untitled section",
    ...(course === undefined ? {} : { course }),
    ...(termId === undefined ? {} : { termId }),
    ...(subject === undefined ? {} : { subject }),
    ...(grade === undefined ? {} : { grade }),
    ...(period === undefined ? {} : { period }),
    teachers,
    students: ids(raw.students),
  };
}

export function parseSchool(value: unknown): CleverSchoolRecord {
  const raw = record(value, "school");
  return { id: text(raw.id, "school"), district: text(raw.district, "school"), name: optionalText(raw.name) ?? "Unnamed school" };
}

export function parseTerm(value: unknown): CleverTermRecord {
  const raw = record(value, "term");
  const name = optionalText(raw.name);
  const startDate = optionalText(raw.start_date);
  const endDate = optionalText(raw.end_date);
  return {
    id: text(raw.id, "term"),
    ...(name === undefined ? {} : { name }),
    ...(startDate === undefined ? {} : { startDate }),
    ...(endDate === undefined ? {} : { endDate }),
  };
}

export function parseCourse(value: unknown): CleverCourseRecord {
  const raw = record(value, "course");
  const name = optionalText(raw.name);
  return { id: text(raw.id, "course"), ...(name === undefined ? {} : { name }) };
}

export function parseDistrict(value: unknown): CleverDistrictRecord {
  const raw = record(value, "district");
  return { id: text(raw.id, "district"), name: optionalText(raw.name) ?? "Unnamed district" };
}

export function parseAssignment(value: unknown): LmsAssignmentRecord {
  const raw = record(value, "assignment");
  const description = optionalText(raw.description);
  const dueDate = optionalText(raw.due_date);
  const points = raw.points_possible;
  return {
    id: text(raw.id, "assignment"),
    title: optionalText(raw.title) ?? "Untitled assignment",
    ...(description === undefined ? {} : { description }),
    gradingType: optionalText(raw.grading_type) ?? "points",
    ...(typeof points === "number" && Number.isFinite(points) ? { pointsPossible: points } : {}),
    ...(dueDate === undefined ? {} : { dueDate }),
  };
}

const SUBMISSION_STATES: readonly LmsSubmissionState[] = ["created", "submitted", "returned", "reclaimed"];

export function parseSubmission(value: unknown): LmsSubmissionRecord {
  const raw = record(value, "submission");
  const state = SUBMISSION_STATES.find(candidate => candidate === raw.state) ?? "created";
  const comment = optionalText(raw.grade_comment);
  const points = raw.grade_points;
  return {
    userId: text(raw.user_id, "submission"),
    state,
    ...(typeof points === "number" && Number.isFinite(points) ? { gradePoints: points } : {}),
    ...(comment === undefined ? {} : { gradeComment: comment }),
  };
}

/** What an assignment is created with: a points column for the whole section. */
export type LmsAssignmentDraft = {
  title: string;
  description?: string;
  pointsPossible: number;
  /** ISO 8601 with an offset. */
  dueDate?: string;
};

/** What a submission is updated with. */
export type LmsSubmissionUpdate = {
  gradePoints?: number;
  gradeComment?: string;
  state?: LmsSubmissionState;
};

/** Thrown for a 404: the caller decides what is missing. */
export class CleverMissingError extends Error {}

/** Thrown for a 4xx other than 404, 401, 403 and 429: Clever refused the request as sent. */
export class CleverRefusedError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Thrown when a write's outcome cannot be known: a transport failure or a 5xx after sending it. */
export class CleverOutcomeUnknownError extends Error {}

function assertId(id: string, what: string): string {
  if (!CLEVER_ID.test(id)) throw notFound(what);
  return id;
}

/** One district's Clever data, through its district-app token. */
export class CleverApi {
  readonly #base: URL;
  readonly #token: string;

  /** `base` is the Data API's base (`https://api.clever.com`, or a fake's). */
  constructor(base: string, token: string) {
    this.#base = new URL(`${base.replace(/\/+$/, "")}/v3.1`);
    this.#token = token;
  }

  // --- Data API -------------------------------------------------------------------------------

  async user(id: string): Promise<CleverUserRecord> {
    return parseUser(await this.#getRecord(`/users/${assertId(id, "user")}`, "user"));
  }

  async section(id: string): Promise<CleverSectionRecord> {
    return parseSection(await this.#getRecord(`/sections/${assertId(id, "section")}`, "section"));
  }

  async school(id: string): Promise<CleverSchoolRecord> {
    return parseSchool(await this.#getRecord(`/schools/${assertId(id, "school")}`, "school"));
  }

  async term(id: string): Promise<CleverTermRecord> {
    return parseTerm(await this.#getRecord(`/terms/${assertId(id, "term")}`, "term"));
  }

  async course(id: string): Promise<CleverCourseRecord> {
    return parseCourse(await this.#getRecord(`/courses/${assertId(id, "course")}`, "course"));
  }

  async district(id: string): Promise<CleverDistrictRecord> {
    return parseDistrict(await this.#getRecord(`/districts/${assertId(id, "district")}`, "district"));
  }

  /** The sections a user teaches or is enrolled in. */
  async userSections(userId: string): Promise<CleverSectionRecord[]> {
    return (await this.#list(`/users/${assertId(userId, "user")}/sections`, "sections")).map(parseSection);
  }

  /** A section's users in one role. */
  async sectionUsers(sectionId: string, role: "teacher" | "student"): Promise<CleverUserRecord[]> {
    return (await this.#list(`/sections/${assertId(sectionId, "section")}/users`, "roster", { role })).map(parseUser);
  }

  async sections(): Promise<CleverSectionRecord[]> {
    return (await this.#list("/sections", "sections")).map(parseSection);
  }

  async schoolSections(schoolId: string): Promise<CleverSectionRecord[]> {
    return (await this.#list(`/schools/${assertId(schoolId, "school")}/sections`, "sections")).map(parseSection);
  }

  async schools(): Promise<CleverSchoolRecord[]> {
    return (await this.#list("/schools", "schools")).map(parseSchool);
  }

  async terms(): Promise<CleverTermRecord[]> {
    return (await this.#list("/terms", "terms")).map(parseTerm);
  }

  async courses(): Promise<CleverCourseRecord[]> {
    return (await this.#list("/courses", "courses")).map(parseCourse);
  }

  // --- LMS Connect ----------------------------------------------------------------------------

  /** Creates a points assignment for every student of the section. */
  async createAssignment(sectionId: string, draft: LmsAssignmentDraft): Promise<LmsAssignmentRecord> {
    const body = {
      title: draft.title,
      ...(draft.description === undefined ? {} : { description: draft.description }),
      grading_type: "points",
      points_possible: draft.pointsPossible,
      assignee_mode: "all",
      ...(draft.dueDate === undefined ? {} : { due_date: draft.dueDate }),
    };
    return parseAssignment(await this.#write("POST", `/sections/${assertId(sectionId, "section")}/assignments`, body, "assignment"));
  }

  /** One assignment of the section, or undefined if the section has no such assignment. */
  async assignment(sectionId: string, assignmentId: string): Promise<LmsAssignmentRecord | undefined> {
    try {
      return parseAssignment(await this.#getOne(this.#assignmentPath(sectionId, assignmentId), "assignment"));
    } catch (error) {
      if (error instanceof CleverMissingError) return undefined;
      throw error;
    }
  }

  /** Every submission of the assignment. */
  async submissions(sectionId: string, assignmentId: string): Promise<LmsSubmissionRecord[]> {
    const path = `${this.#assignmentPath(sectionId, assignmentId)}/submissions`;
    const items = await this.#list(path, "submissions", {}, SUBMISSIONS_PAGE_SIZE);
    return items.map(parseSubmission);
  }

  /** One student's submission, or undefined when the student has none. */
  async submission(sectionId: string, assignmentId: string, userId: string): Promise<LmsSubmissionRecord | undefined> {
    try {
      const path = `${this.#assignmentPath(sectionId, assignmentId)}/submissions/${assertId(userId, "student")}`;
      return parseSubmission(await this.#getOne(path, "submission"));
    } catch (error) {
      if (error instanceof CleverMissingError) return undefined;
      throw error;
    }
  }

  /** Updates one student's submission (`updateSubmissionForAssignment`). */
  async updateSubmission(sectionId: string, assignmentId: string, userId: string, update: LmsSubmissionUpdate): Promise<void> {
    const body = {
      ...(update.gradePoints === undefined ? {} : { grade_points: update.gradePoints }),
      ...(update.gradeComment === undefined ? {} : { grade_comment: update.gradeComment }),
      ...(update.state === undefined ? {} : { state: update.state }),
    };
    const path = `${this.#assignmentPath(sectionId, assignmentId)}/submissions/${assertId(userId, "student")}`;
    await this.#write("PATCH", path, body, "submission");
  }

  #assignmentPath(sectionId: string, assignmentId: string): string {
    return `/sections/${assertId(sectionId, "section")}/assignments/${assertId(assignmentId, "assignment")}`;
  }

  // --- transport ------------------------------------------------------------------------------

  #url(path: string, query: Record<string, string> = {}): URL {
    const url = new URL(`${this.#base.pathname}${path}`, this.#base);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url;
  }

  /** A Data API record; a 404 reads as not-found, like a record the user may not reach. */
  async #getRecord(path: string, what: string): Promise<unknown> {
    try {
      return await this.#getOne(path, what);
    } catch (error) {
      if (error instanceof CleverMissingError) throw notFound(what);
      throw error;
    }
  }

  async #getOne(path: string, what: string): Promise<unknown> {
    const body = record(await this.#request("GET", this.#url(path), undefined, what), what);
    return body.data;
  }

  /** Every item of a listing, following `links` `next` while it stays on the same resource. */
  async #list(path: string, what: string, query: Record<string, string> = {}, limit = PAGE_SIZE): Promise<unknown[]> {
    const first = this.#url(path, { ...query, limit: String(limit) });
    const items: unknown[] = [];
    let url: URL | undefined = first;
    for (let page = 0; url !== undefined; page++) {
      if (page >= MAX_PAGES) throw unavailable(`Clever's ${what} has more pages than this connection reads.`);
      let raw: unknown;
      try {
        raw = await this.#request("GET", url, undefined, what);
      } catch (error) {
        if (error instanceof CleverMissingError) throw notFound(what);
        throw error;
      }
      const body = record(raw, what);
      const data = Array.isArray(body.data) ? body.data : [];
      for (const item of data) {
        // A Data API list wraps each record as `{ data, uri }`; LMS Connect's submissions do not.
        const wrapped = typeof item === "object" && item !== null && "data" in item && "uri" in item;
        items.push(wrapped ? (item as { data: unknown }).data : item);
      }
      const links = Array.isArray(body.links) ? body.links as unknown[] : [];
      const next = links.map(link => record(link, what)).find(link => link.rel === "next")?.uri;
      url = typeof next === "string" && data.length > 0 ? this.#sameResource(first, next, what) : undefined;
    }
    return items;
  }

  #sameResource(first: URL, target: string, what: string): URL {
    let url: URL;
    try {
      url = new URL(target, first);
    } catch {
      throw unavailable(`Clever sent a malformed next link for the ${what}.`);
    }
    if (url.origin !== first.origin || url.pathname !== first.pathname) {
      throw unavailable(`Clever sent a next link for the ${what} to another resource.`);
    }
    return url;
  }

  async #write(method: "POST" | "PATCH", path: string, body: unknown, what: string): Promise<unknown> {
    const response = record(await this.#request(method, this.#url(path), body, what), what);
    return response.data;
  }

  async #request(method: string, url: URL, body: unknown, what: string): Promise<unknown> {
    // Read at call time, so a test's stubbed fetch is the one used; called as a plain function,
    // never as a method, which workerd refuses ("Illegal invocation").
    const fetch = globalThis.fetch;
    const write = method !== "GET";
    let response: Response;
    try {
      response = await fetch(url.href, {
        method,
        // workerd refuses `redirect: "error"`; a redirect is answered as a failure like any non-2xx.
        redirect: "manual",
        headers: {
          authorization: `Bearer ${this.#token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      if (write) throw new CleverOutcomeUnknownError(`Clever could not be reached for the ${what}.`);
      throw unavailable(`Clever could not be reached for the ${what}.`);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const status = response.status;
      if (status === 404) throw new CleverMissingError(`Clever has no such ${what}.`);
      if (status === 401 || status === 403) {
        throw unavailable(`Clever refused this district's connection for the ${what} (${status}).`);
      }
      if (status === 429) throw unavailable(`Clever is rate limiting this district. Try again shortly.`);
      if (status >= 400 && status < 500) {
        if (write) throw new CleverRefusedError(`Clever refused the ${what} (${status}).`, status);
        throw invalid(`Clever refused the ${what} request (${status}).`);
      }
      if (write) throw new CleverOutcomeUnknownError(`Clever failed while writing the ${what} (${status}).`);
      throw unavailable(`Clever failed to read the ${what} (${status}).`);
    }
    let payload: string;
    try {
      payload = await readTextCapped(response, MAX_RESPONSE_BYTES);
    } catch {
      throw unavailable(`Clever's ${what} is too large to read.`);
    }
    if (payload === "") return {};
    try {
      return JSON.parse(payload);
    } catch {
      throw unavailable(`Clever's ${what} is not readable JSON.`);
    }
  }
}
