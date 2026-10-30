// Clever LMS Connect grade passback (SCHO-278): approved grades written into the district LMS
// (Google Classroom, Canvas, Schoology) behind a Clever section, through Clever's API v3.1. Built
// only to Clever's published OpenAPI file (github.com/Clever/swagger-api, full-v3.yml, version
// 3.1.0: createAssignmentForSection, getAssignmentForSection and updateSubmissionForAssignment) and
// the LMS Connect quickstart (https://dev.clever.com/docs/clever-lms-connect). It has not been
// tested against Clever, which offers LMS Connect only under a Clever Complete agreement; its tests
// run against `CleverDataFake` in @educateos/provider-fakes, built to the same spec.
import { z } from "zod";
import { EducateOsError, type ErrorCode, type OfferingId, type Principal } from "@educateos/contracts";
import { CLEVER_ISSUER } from "@educateos/identity";
import { routeOfKind, type CleverLmsConnectGradeRoute, type GradeDelivery, type GradeRouteStore, type GradeSink, type LmsGradeRoute } from "./passback.ts";
import { readJson } from "./service-client.ts";

/** Where LMS Connect lives: the Data API, v3.1 only. */
export const CLEVER_LMS_CONNECT_BASE = "https://api.clever.com/v3.1";

const ID = z.string().min(1).max(255);
/**
 * What an assignment or user ID may be in a request path. Clever's are ObjectIds; anything outside
 * this set (a `/`, or `..`) could name another resource, so it is never sent.
 */
const PATH_ID = /^[A-Za-z0-9_-]{1,255}$/;

/** A Clever section's roster, from `GET /sections/{id}`: who LMS Connect will grade in it. */
const CleverSection = z.object({
  id: ID,
  district: ID,
  students: z.array(ID),
  teachers: z.array(ID),
});

/**
 * A Clever LMS Connect assignment (`Assignment`), as far as grading needs it: a gradebook column.
 * A stripping `z.object`, since Clever adds fields.
 */
export const CleverLmsConnectAssignment = z.object({
  id: ID,
  title: z.string().max(3000),
  grading_type: z.enum(["points", "percent", "pass_fail", "letter_grade"]),
  points_possible: z.number().finite().nullable().optional(),
});
/** A Clever LMS Connect assignment. */
export type CleverLmsConnectAssignment = z.infer<typeof CleverLmsConnectAssignment>;

/** An assignment to create (part of `AssignmentRequest`): a new points column, out of `pointsPossible`. */
export const CleverLmsConnectAssignmentDraft = z.strictObject({
  title: z.string().trim().min(1).max(3000),
  description: z.string().max(30_000).optional(),
  pointsPossible: z.number().positive().finite(),
  /** ISO 8601 with an offset. */
  dueDate: z.iso.datetime({ offset: true }).optional(),
});
/** A Clever LMS Connect assignment draft. */
export type CleverLmsConnectAssignmentDraft = z.infer<typeof CleverLmsConnectAssignmentDraft>;

/** What {@link CleverLmsConnectClient} is built from. */
export interface CleverLmsConnectClientOptions {
  readonly fetch: typeof globalThis.fetch;
  /** The district-app bearer token for a Clever district ID. A secret: it never appears in an error. */
  readonly token: (cleverDistrictId: string) => Promise<string>;
  /** Where the API is. Defaults to {@link CLEVER_LMS_CONNECT_BASE}; a fake serves it elsewhere. */
  readonly baseUrl?: string;
}

/**
 * The LMS Connect calls grade passback makes, authorized by the district-app token of the route's
 * district. No redirects are followed, error bodies are not read, and every error names only the
 * operation and the status.
 */
export class CleverLmsConnectClient {
  readonly #fetch: typeof globalThis.fetch;
  readonly #token: (cleverDistrictId: string) => Promise<string>;
  readonly #base: string;

  constructor(options: CleverLmsConnectClientOptions) {
    this.#fetch = options.fetch;
    this.#token = options.token;
    this.#base = (options.baseUrl ?? CLEVER_LMS_CONNECT_BASE).replace(/\/+$/, "");
  }

  /** The section's roster. */
  async section(route: CleverLmsConnectGradeRoute): Promise<z.infer<typeof CleverSection>> {
    return this.#call(route, "GET", `/sections/${encodeURIComponent(route.sectionId)}`, undefined, CleverSection, "section");
  }

  /** One assignment in the route's section, or `undefined` if the section has no such assignment. */
  async assignment(route: CleverLmsConnectGradeRoute, assignmentId: string): Promise<CleverLmsConnectAssignment | undefined> {
    if (!PATH_ID.test(assignmentId)) return undefined;
    try {
      return await this.#call(route, "GET", this.#assignmentPath(route, assignmentId), undefined, CleverLmsConnectAssignment, "assignment");
    } catch (err) {
      if (err instanceof CleverLmsConnectNotFound) return undefined;
      throw err;
    }
  }

  /** Creates a points assignment for every student of the route's section. */
  async createAssignment(route: CleverLmsConnectGradeRoute, draft: CleverLmsConnectAssignmentDraft): Promise<CleverLmsConnectAssignment> {
    const body = {
      title: draft.title,
      ...(draft.description === undefined ? {} : { description: draft.description }),
      grading_type: "points",
      points_possible: draft.pointsPossible,
      assignee_mode: "all",
      ...(draft.dueDate === undefined ? {} : { due_date: draft.dueDate }),
    };
    return this.#call(route, "POST", `/sections/${encodeURIComponent(route.sectionId)}/assignments`, body, CleverLmsConnectAssignment, "assignment");
  }

  /** Sets a student's grade on an assignment (`updateSubmissionForAssignment`). */
  async gradeSubmission(
    route: CleverLmsConnectGradeRoute,
    input: { assignmentId: string; userId: string; gradePoints: number; comment: string | undefined },
  ): Promise<void> {
    if (!PATH_ID.test(input.assignmentId) || !PATH_ID.test(input.userId)) throw new EducateOsError("validation-failed", "The Clever submission is not addressable.");
    const body = { grade_points: input.gradePoints, ...(input.comment === undefined ? {} : { grade_comment: input.comment }) };
    const path = `${this.#assignmentPath(route, input.assignmentId)}/submissions/${encodeURIComponent(input.userId)}`;
    await this.#call(route, "PATCH", path, body, z.object({ user_id: ID }), "submission");
  }

  #assignmentPath(route: CleverLmsConnectGradeRoute, assignmentId: string): string {
    return `/sections/${encodeURIComponent(route.sectionId)}/assignments/${encodeURIComponent(assignmentId)}`;
  }

  async #call<T>(route: CleverLmsConnectGradeRoute, method: string, path: string, body: unknown, schema: z.ZodType<T>, what: string): Promise<T> {
    const token = await this.#token(route.districtId);
    // A local const, so the injected fetch is never called as a method of this object (workerd
    // refuses that with "Illegal invocation").
    const fetch = this.#fetch;
    let response: Response;
    try {
      response = await fetch(`${this.#base}${path}`, {
        method,
        redirect: "manual",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new EducateOsError("unavailable", `Clever could not be reached for the ${what}.`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404) throw new CleverLmsConnectNotFound(`Clever has no such ${what}.`);
      throw new EducateOsError(codeOf(response.status), `Clever refused the ${what} request (${response.status}).`);
    }
    let parsed: unknown;
    try {
      parsed = await readJson(response);
    } catch {
      throw new EducateOsError("unavailable", `Clever's ${what} is not readable JSON.`);
    }
    const data = z.object({ data: schema }).safeParse(parsed);
    if (!data.success) throw new EducateOsError("unavailable", `Clever's ${what} is malformed.`);
    return data.data.data;
  }
}

/** A Clever 404: `not-found`, which the client turns into `undefined` where absence is an answer. */
class CleverLmsConnectNotFound extends EducateOsError {
  constructor(message: string) {
    super("not-found", message);
  }
}

function codeOf(status: number): ErrorCode {
  if (status === 400) return "validation-failed";
  if (status === 401 || status === 403) return "forbidden";
  return "unavailable";
}

/** What {@link CleverLmsConnectGradeSink} is built from. */
export interface CleverLmsConnectGradeSinkOptions {
  readonly client: CleverLmsConnectClient;
  /**
   * The issuer of the identity links that carry each student's Clever user ID: the issuer the
   * district's Clever roster import and Clever SSO use (`clever.CLEVER_SUBJECT_FIELD` in
   * @educateos/integrations keys people by that ID). Defaults to {@link CLEVER_ISSUER}.
   */
  readonly issuer?: string;
}

/**
 * Publishes approved grades to Clever LMS Connect assignments. A {@link GradeSink} for the passback
 * gate. Built to Clever's published v3.1 spec and not tested against Clever.
 *
 * A column is a Clever assignment in the route's section: the one the route's `assignments` maps it
 * to, or the assignment with the column as its ID. The student is found by the Clever user ID their
 * identity link carries, and must be a student on the section's Clever roster. The grade is set as
 * `grade_points`, with the comment as `grade_comment`. The submission's `state` is left alone:
 * returning work to the student stays the teacher's action, as with Classroom. Setting the same
 * points again leaves the same grade, so a retried delivery is harmless; the passback ledger keeps
 * retries from being sent at all.
 */
export class CleverLmsConnectGradeSink implements GradeSink {
  readonly via = "clever-lms-connect";
  readonly #client: CleverLmsConnectClient;
  readonly #issuer: string;

  constructor(options: CleverLmsConnectGradeSinkOptions) {
    this.#client = options.client;
    this.#issuer = options.issuer ?? CLEVER_ISSUER;
  }

  async check(route: LmsGradeRoute, column: string, student: Principal): Promise<void> {
    await this.#target(routeOfKind(route, "clever-lms-connect"), column, student);
  }

  async deliver(input: LmsGradeRoute, delivery: GradeDelivery, student: Principal): Promise<void> {
    const route = routeOfKind(input, "clever-lms-connect");
    const { assignment, userId } = await this.#target(route, delivery.column, student);
    // Points against the assignment's own maximum. Rescaling would publish a number the teacher
    // never approved, so a differing maximum, or another grading type, is refused instead.
    if (assignment.grading_type !== "points" || assignment.points_possible !== delivery.scoreMaximum) {
      throw new EducateOsError("conflict", "The Clever assignment is not out of the same number of points as the approved grade.");
    }
    try {
      await this.#client.gradeSubmission(route, { assignmentId: assignment.id, userId, gradePoints: delivery.scoreGiven, comment: delivery.comment });
    } catch (err) {
      if (err instanceof CleverLmsConnectNotFound) throw new EducateOsError("not-found", "Clever has no submission for this student on the assignment.");
      throw err;
    }
  }

  async #target(route: CleverLmsConnectGradeRoute, column: string, student: Principal) {
    const identity = student.externalIdentities.find((link) => link.issuer === this.#issuer && link.districtId === student.districtId);
    if (identity === undefined) throw new EducateOsError("not-found", "The student has no Clever account linked.");
    let section: z.infer<typeof CleverSection>;
    try {
      section = await this.#client.section(route);
    } catch (err) {
      if (err instanceof CleverLmsConnectNotFound) throw new EducateOsError("not-found", "Clever does not share the route's section.");
      throw err;
    }
    if (section.id !== route.sectionId || section.district !== route.districtId) {
      throw new EducateOsError("conflict", "The Clever section is not in the route's district.");
    }
    if (!section.students.includes(identity.subject)) {
      throw new EducateOsError("not-found", "The student is not on the Clever section's roster.");
    }
    const assignmentId = route.assignments?.[column] ?? column;
    const assignment = await this.#client.assignment(route, assignmentId);
    if (assignment === undefined || assignment.id !== assignmentId) {
      throw new EducateOsError("forbidden", "The assignment is not in this section's gradebook.");
    }
    return { assignment, userId: identity.subject };
  }
}

/** What {@link CleverLmsConnectAdapter} is built from. */
export interface CleverLmsConnectAdapterOptions {
  readonly client: CleverLmsConnectClient;
  /** The grade routes: an offering is reached in Clever only through a Clever LMS Connect route. */
  readonly routes: GradeRouteStore;
}

/**
 * Creates gradebook columns in an offering's Clever section. An offering routed anywhere else is
 * refused. Grades go through {@link CleverLmsConnectGradeSink}, which only the passback gate drives.
 */
export class CleverLmsConnectAdapter {
  readonly #options: CleverLmsConnectAdapterOptions;

  constructor(options: CleverLmsConnectAdapterOptions) {
    this.#options = options;
  }

  /**
   * Creates a points assignment for the whole section. Its ID is a `column` a teacher's grade
   * approval can name, unless the route maps that column elsewhere.
   */
  async createAssignment(offeringId: OfferingId, draft: CleverLmsConnectAssignmentDraft): Promise<CleverLmsConnectAssignment> {
    const parsed = CleverLmsConnectAssignmentDraft.safeParse(draft);
    if (!parsed.success) throw new EducateOsError("validation-failed", "The assignment is malformed.");
    return this.#options.client.createAssignment(await this.#route(offeringId), parsed.data);
  }

  /** The Clever assignment a column publishes to, or `undefined` if the section has none. */
  async assignment(offeringId: OfferingId, column: string): Promise<CleverLmsConnectAssignment | undefined> {
    const route = await this.#route(offeringId);
    return this.#options.client.assignment(route, route.assignments?.[column] ?? column);
  }

  async #route(offeringId: OfferingId): Promise<CleverLmsConnectGradeRoute> {
    const route = await this.#options.routes.routeFor(offeringId);
    if (route === undefined || route.authority === "local" || route.via !== "clever-lms-connect") {
      throw new EducateOsError("conflict", "This offering is not connected to Clever LMS Connect.");
    }
    return route;
  }
}
