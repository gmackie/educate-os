// Clever LMS Connect, the Data API's gradebook endpoints, built only from Clever's published API
// v3.1 OpenAPI file (github.com/Clever/swagger-api, full-v3.yml, version 3.1.0: the operations
// createAssignmentForSection, get/update/deleteAssignmentForSection, getSubmissionsForAssignment and
// get/updateSubmissionForAssignment, with the Assignment, AssignmentRequest, Submission and
// SubmissionRequest schemas) and the LMS Connect quickstart (https://dev.clever.com/docs/clever-lms-connect),
// which says the endpoints exist only on v3.1. Not tested against Clever: LMS Connect needs a Clever
// Complete agreement. Where the spec is silent the choice made here is listed in the README.
import { hexId } from "../ids.ts";
import type { CleverRecord } from "./model.ts";

/** How a Clever assignment is graded (`GradingType`). */
export const CLEVER_GRADING_TYPES = ["points", "percent", "pass_fail", "letter_grade"] as const;
/** A Clever assignment's lifecycle state (`AssignmentState`). */
export const CLEVER_ASSIGNMENT_STATES = ["draft", "scheduled", "open", "locked"] as const;
/** A Clever submission's state (`SubmissionState`). */
export const CLEVER_SUBMISSION_STATES = ["created", "submitted", "returned", "reclaimed"] as const;
const ASSIGNEE_MODES = ["all", "individuals"] as const;
const SUBMISSION_TYPES = ["link", "file", "text", "discussion"] as const;
const SUBMISSION_FLAGS = ["excused", "late", "missing"] as const;

/** The largest `limit` the submissions list takes (the spec's `maximum: 100`). */
export const CLEVER_SUBMISSIONS_MAX_LIMIT = 100;

/** An assignment as LMS Connect serves it (`Assignment`). Absent `x-omitempty` fields are left out. */
export interface CleverAssignment {
  readonly id: string;
  readonly created: string;
  readonly last_modified: string;
  readonly title: string;
  readonly description: string;
  readonly description_plaintext: string | null;
  readonly due_date: string | null;
  readonly display_date: string | null;
  readonly start_date: string | null;
  readonly end_date: string | null;
  readonly grading_type: (typeof CLEVER_GRADING_TYPES)[number];
  readonly state: (typeof CLEVER_ASSIGNMENT_STATES)[number];
  readonly points_possible: number | null;
  readonly assignee_mode: (typeof ASSIGNEE_MODES)[number];
  readonly assignee_ids?: readonly string[];
  readonly attachments?: readonly Record<string, unknown>[];
  readonly submission_types?: readonly string[];
  readonly max_attempts?: number;
  readonly category_id: string | null;
  readonly term_id: string | null;
}

/** A student's submission as LMS Connect serves it (`Submission`). */
export interface CleverSubmission {
  /** Deprecated by Clever (empty when the LMS is Google Classroom); the fake fills it. */
  readonly id: string;
  readonly created: string;
  readonly last_modified: string;
  readonly assignment_id: string;
  readonly user_id: string;
  readonly state: (typeof CLEVER_SUBMISSION_STATES)[number];
  readonly grade: string | null;
  readonly grade_points?: number;
  readonly grade_comment: string | null;
  readonly grader_id: string | null;
  readonly override_due_date: string | null;
  readonly flags?: readonly string[];
  readonly extra_attempts?: number;
  readonly attachments?: readonly Record<string, unknown>[];
}

type Rule = (value: unknown) => boolean;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const string: Rule = (v) => typeof v === "string";
const number: Rule = (v) => typeof v === "number" && Number.isFinite(v);
const integer: Rule = (v) => Number.isInteger(v);
const datetime: Rule = (v) => typeof v === "string" && DATETIME.test(v) && !Number.isNaN(Date.parse(v));
const oneOf = (values: readonly string[]): Rule => (v) => typeof v === "string" && values.includes(v);
const nullable = (rule: Rule): Rule => (v) => v === null || rule(v);
const arrayOf = (rule: Rule): Rule => (v) => Array.isArray(v) && v.every(rule);
/** `AttachmentRequest`: the spec's only `type` is `file`. */
const attachment: Rule = (v) =>
  isObject(v) &&
  oneOf(["file"])(v["type"]) &&
  ["title", "description", "url"].every((key) => v[key] === undefined || nullable(string)(v[key]));

/** `AssignmentRequest`. Every field is optional in the spec; `x-nullable` fields take `null`. */
const ASSIGNMENT_REQUEST: Readonly<Record<string, Rule>> = {
  title: nullable(string),
  description: nullable(string),
  description_plaintext: nullable(string),
  due_date: nullable(datetime),
  display_date: nullable(datetime),
  start_date: nullable(datetime),
  end_date: nullable(datetime),
  grading_type: nullable(oneOf(CLEVER_GRADING_TYPES)),
  points_possible: nullable(number),
  assignee_ids: arrayOf(string),
  assignee_mode: nullable(oneOf(ASSIGNEE_MODES)),
  attachments: arrayOf(attachment),
  max_attempts: integer,
  submission_types: arrayOf(oneOf(SUBMISSION_TYPES)),
  term_id: nullable(string),
};

/** `SubmissionRequest`. */
const SUBMISSION_REQUEST: Readonly<Record<string, Rule>> = {
  grade: nullable(string),
  grade_points: number,
  grade_comment: nullable(string),
  grader_id: nullable(string),
  state: nullable(oneOf(CLEVER_SUBMISSION_STATES)),
  flags: arrayOf(oneOf(SUBMISSION_FLAGS)),
  extra_attempts: integer,
  override_due_date: nullable(datetime),
  attachments: arrayOf(attachment),
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The spec's error body for every LMS Connect error (`BadRequest`, `NotFound`, `InternalError`). */
function error(status: number, message: string): Response {
  return Response.json({ message }, { status });
}

/**
 * Parses a request body against one of the request schemas: the known fields, each checked. Fields
 * the schema does not name are dropped, as a generated Go server drops them (Clever's own quickstart
 * sends `state` with a new assignment, which `AssignmentRequest` does not have).
 */
function parseBody(body: string, rules: Readonly<Record<string, Rule>>): Record<string, unknown> | Response {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return error(400, "request body is not valid JSON");
  }
  if (!isObject(value)) return error(400, "request body must be a JSON object");
  const out: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(rules)) {
    if (value[key] === undefined) continue;
    if (!rule(value[key])) return error(400, `invalid value for ${key}`);
    out[key] = value[key];
  }
  return out;
}

/** Where one LMS Connect request is going, as the fake's router matched it. */
export interface LmsConnectPath {
  readonly sectionId: string;
  readonly assignmentId: string | undefined;
  /** Whether the path continues with `/submissions`. */
  readonly submissions: boolean;
  readonly userId: string | undefined;
}

/**
 * The in-memory gradebook behind the LMS Connect endpoints: assignments by section, and the
 * submissions of each assignment's assignees. A submission exists for every current assignee, in
 * state `created`, from the moment the assignment does (an LMS makes one per assignee); grading one
 * stores it.
 */
export class LmsConnectGradebook {
  readonly #namespace: string;
  readonly #now: () => number;
  readonly #section: (id: string) => CleverRecord | undefined;
  /** Assignments by section ID, then by assignment ID, in creation order. */
  readonly #assignments = new Map<string, Map<string, CleverAssignment>>();
  /** Submissions that have been written, by assignment ID, then user ID. */
  readonly #submissions = new Map<string, Map<string, CleverSubmission>>();
  #created = 0;

  /** `namespace` keeps assignment IDs distinct between districts; `section` reads the roster now. */
  constructor(namespace: string, now: () => number, section: (id: string) => CleverRecord | undefined) {
    this.#namespace = namespace;
    this.#now = now;
    this.#section = section;
  }

  /** The section's assignments, oldest first. */
  assignmentsFor(sectionId: string): CleverAssignment[] {
    return [...(this.#assignments.get(sectionId)?.values() ?? [])];
  }

  /** One student's submission, as `GET …/submissions/{user_id}` would serve it, or undefined. */
  submissionFor(sectionId: string, assignmentId: string, userId: string): CleverSubmission | undefined {
    const section = this.#section(sectionId);
    const assignment = this.#assignments.get(sectionId)?.get(assignmentId);
    if (section === undefined || assignment === undefined) return undefined;
    return this.#submission(section, assignment, userId);
  }

  /** Serves one LMS Connect request. `base` is the path of the API version, such as `/v3.1`. */
  serve(method: string, path: LmsConnectPath, body: string, url: URL, base: string): Response {
    const section = this.#section(path.sectionId);
    if (section === undefined) return error(404, "section not found");
    if (path.assignmentId === undefined) {
      // The spec defines only POST on a section's assignments; there is no list.
      return method === "POST" ? this.#create(section, body) : error(405, "method not allowed");
    }
    const assignments = this.#assignments.get(section.id);
    const assignment = assignments?.get(path.assignmentId);
    if (!path.submissions) {
      if (!["GET", "PATCH", "DELETE"].includes(method)) return error(405, "method not allowed");
      if (assignment === undefined) return error(404, "assignment not found");
      if (method === "GET") return Response.json({ data: assignment });
      if (method === "DELETE") {
        assignments!.delete(assignment.id);
        this.#submissions.delete(assignment.id);
        return new Response(null, { status: 200 });
      }
      return this.#update(section, assignment, body);
    }
    if (path.userId === undefined) {
      if (method !== "GET") return error(405, "method not allowed");
      if (assignment === undefined) return error(404, "assignment not found");
      return this.#list(section, assignment, url, base);
    }
    if (!["GET", "PATCH"].includes(method)) return error(405, "method not allowed");
    if (assignment === undefined) return error(404, "assignment not found");
    const submission = this.#submission(section, assignment, path.userId);
    if (submission === undefined) return error(404, "submission not found");
    if (method === "GET") return Response.json({ data: submission });
    return this.#grade(section, submission, body);
  }

  #stamp(): string {
    return new Date(this.#now()).toISOString();
  }

  /** Checks the assignee fields against the section: `individuals` needs students of it. */
  #assignees(section: CleverRecord, mode: unknown, ids: unknown): Response | undefined {
    const students = section["students"] as readonly string[];
    if (mode === "individuals") {
      const list = (ids as readonly string[] | undefined) ?? [];
      if (list.length === 0) return error(400, "assignee_ids is required when assignee_mode is individuals");
      if (!list.every((id) => students.includes(id))) return error(400, "assignee_ids must be students of the section");
    } else if (ids !== undefined && (ids as readonly string[]).length > 0) {
      return error(400, "assignee_ids is only allowed when assignee_mode is individuals");
    }
    return undefined;
  }

  #create(section: CleverRecord, body: string): Response {
    const fields = parseBody(body, ASSIGNMENT_REQUEST);
    if (fields instanceof Response) return fields;
    if (typeof fields["title"] !== "string" || fields["title"].trim() === "") return error(400, "title is required");
    const invalid = this.#assignees(section, fields["assignee_mode"], fields["assignee_ids"]);
    if (invalid !== undefined) return invalid;
    this.#created += 1;
    const stamp = this.#stamp();
    const assignment = this.#project(
      {
        id: hexId("clever:assignment", `${this.#namespace}\u0000${this.#created}`),
        created: stamp,
        last_modified: stamp,
        title: "",
        description: "",
        description_plaintext: null,
        due_date: null,
        display_date: null,
        start_date: null,
        end_date: null,
        grading_type: "points",
        state: "open",
        points_possible: null,
        assignee_mode: "all",
        category_id: null,
        term_id: typeof section["term_id"] === "string" ? section["term_id"] : null,
      },
      fields,
    );
    const assignments = this.#assignments.get(section.id) ?? new Map<string, CleverAssignment>();
    assignments.set(assignment.id, assignment);
    this.#assignments.set(section.id, assignments);
    return Response.json({ data: assignment });
  }

  #update(section: CleverRecord, assignment: CleverAssignment, body: string): Response {
    const fields = parseBody(body, ASSIGNMENT_REQUEST);
    if (fields instanceof Response) return fields;
    if ("title" in fields && (typeof fields["title"] !== "string" || fields["title"].trim() === "")) return error(400, "title cannot be empty");
    const mode = "assignee_mode" in fields ? fields["assignee_mode"] : assignment.assignee_mode;
    const ids = "assignee_ids" in fields ? fields["assignee_ids"] : mode === "individuals" ? assignment.assignee_ids : undefined;
    const invalid = this.#assignees(section, mode, ids);
    if (invalid !== undefined) return invalid;
    const next = this.#project({ ...assignment, last_modified: this.#stamp() }, fields);
    this.#assignments.get(section.id)!.set(next.id, next);
    return Response.json({ data: next });
  }

  /** Applies request fields to an assignment. A `null` for a field the record never nulls keeps it. */
  #project(base: CleverAssignment, fields: Record<string, unknown>): CleverAssignment {
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(fields)) {
      if (value === null && ["title", "grading_type", "assignee_mode"].includes(key)) continue;
      out[key] = key === "description" && value === null ? "" : value;
    }
    if (out["assignee_mode"] !== "individuals") delete out["assignee_ids"];
    // A display date in the future holds the assignment back from students until then.
    const display = out["display_date"];
    out["state"] = typeof display === "string" && Date.parse(display) > this.#now() ? "scheduled" : "open";
    return out as unknown as CleverAssignment;
  }

  #assignee(section: CleverRecord, assignment: CleverAssignment, userId: string): boolean {
    if (!(section["students"] as readonly string[]).includes(userId)) return false;
    return assignment.assignee_mode === "all" || (assignment.assignee_ids ?? []).includes(userId);
  }

  #submission(section: CleverRecord, assignment: CleverAssignment, userId: string): CleverSubmission | undefined {
    if (!this.#assignee(section, assignment, userId)) return undefined;
    return (
      this.#submissions.get(assignment.id)?.get(userId) ?? {
        id: hexId("clever:submission", `${assignment.id}\u0000${userId}`),
        created: assignment.created,
        last_modified: assignment.created,
        assignment_id: assignment.id,
        user_id: userId,
        state: "created",
        grade: null,
        grade_comment: null,
        grader_id: null,
        override_due_date: null,
      }
    );
  }

  #grade(section: CleverRecord, submission: CleverSubmission, body: string): Response {
    const fields = parseBody(body, SUBMISSION_REQUEST);
    if (fields instanceof Response) return fields;
    const grader = fields["grader_id"];
    if (typeof grader === "string" && !(section["teachers"] as readonly string[]).includes(grader)) {
      return error(400, "grader_id must be a teacher of the section");
    }
    const out: Record<string, unknown> = { ...submission, last_modified: this.#stamp() };
    for (const [key, value] of Object.entries(fields)) {
      // `state` is x-nullable, but a submission always has one: a null leaves it as it is.
      if (key === "state" && value === null) continue;
      out[key] = value;
    }
    const next = out as unknown as CleverSubmission;
    const stored = this.#submissions.get(submission.assignment_id) ?? new Map<string, CleverSubmission>();
    stored.set(next.user_id, next);
    this.#submissions.set(submission.assignment_id, stored);
    return Response.json({ data: next });
  }

  #list(section: CleverRecord, assignment: CleverAssignment, url: URL, base: string): Response {
    const raw = url.searchParams.get("limit");
    const limit = raw === null ? CLEVER_SUBMISSIONS_MAX_LIMIT : Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > CLEVER_SUBMISSIONS_MAX_LIMIT) {
      return error(400, `limit must be an integer from 1 to ${CLEVER_SUBMISSIONS_MAX_LIMIT}`);
    }
    // The cursor is opaque in the spec; here it is the last user ID of the previous page.
    const cursor = url.searchParams.get("cursor");
    const all = (section["students"] as readonly string[])
      .toSorted()
      .filter((id) => cursor === null || id > cursor)
      .map((id) => this.#submission(section, assignment, id))
      .filter((s) => s !== undefined);
    const page = all.slice(0, limit);
    if (all.length <= limit) return Response.json({ data: page });
    // `links` is x-omitempty, and its only rel is `next`.
    const next = `${base}/sections/${section.id}/assignments/${assignment.id}/submissions?limit=${limit}&cursor=${page.at(-1)!.user_id}`;
    return Response.json({ data: page, links: [{ rel: "next", uri: next }] });
  }
}
