// A district-wide client for the Google Classroom REST API v1, acting through a service account's
// domain-wide delegation. New for SCHO-77; docs/educateos/integrations/google-classroom.md is the
// design record. Followed: the Classroom REST reference
// (https://developers.google.com/workspace/classroom/reference/rest) and its usage limits
// (https://developers.google.com/workspace/classroom/limits).
import type { SyncErrorCode } from "@educateos/contracts";
import { z } from "zod";
import { RosterSyncError } from "../sync-run.ts";
import { DEFAULT_RETRY_POLICY, fetchWithRetry, realSleep } from "../oneroster/rest/retry.ts";
import type { RetryPolicy, Sleep } from "../oneroster/rest/retry.ts";
import { discard, readBoundedJson, readGoogleError } from "./http.ts";
import type { DelegatedTokens } from "./service-account.ts";

/** The Classroom API's base URL. */
export const CLASSROOM_API = "https://classroom.googleapis.com/v1";

const NumericId = z.string().regex(/^\d{1,32}$/, "is not a Classroom numeric ID");
const Text = (max: number) => z.string().max(max);

/** A course, as `courses.list` serves it. Fields EducateOS does not read are dropped. */
export const ClassroomCourse = z.object({
  id: NumericId,
  name: Text(750).min(1),
  section: Text(2800).optional(),
  ownerId: NumericId,
  // A string, not an enum: a state Google adds later must not make a course unreadable.
  courseState: z.string().min(1).max(64),
  /** The course's page in Classroom. */
  alternateLink: z.url({ protocol: /^https$/ }).optional(),
});
/** A Classroom course. */
export type ClassroomCourse = z.infer<typeof ClassroomCourse>;

/** A teacher or student on a course roster, with the profile fields the granted scopes reveal. */
export const ClassroomMember = z.object({
  userId: NumericId,
  profile: z.object({
    name: z.object({ givenName: Text(500).optional(), familyName: Text(500).optional(), fullName: Text(1000).optional() }).optional(),
    emailAddress: Text(320).optional(),
  }).optional(),
});
/** A Classroom roster member. */
export type ClassroomMember = z.infer<typeof ClassroomMember>;

// `p:` aliases are visible only to the Cloud project that made them, so only `d:` ones are read.
const ClassroomAlias = z.object({ alias: z.string().max(260) });

/** Coursework, as `courses.courseWork` serves it. */
export const ClassroomCourseWorkRecord = z.object({
  id: NumericId,
  title: Text(3000).min(1),
  description: Text(30_000).optional(),
  state: z.string().min(1).max(64),
  maxPoints: z.number().nonnegative().finite().optional(),
  // Google omits a boolean at its default, so absent means false.
  associatedWithDeveloper: z.boolean().default(false),
});
/** A Classroom coursework record. */
export type ClassroomCourseWorkRecord = z.infer<typeof ClassroomCourseWorkRecord>;

/** A student's submission to coursework. */
export const ClassroomSubmissionRecord = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  userId: NumericId,
  state: z.string().max(64),
  assignedGrade: z.number().optional(),
  draftGrade: z.number().optional(),
});
/** A Classroom submission. */
export type ClassroomSubmissionRecord = z.infer<typeof ClassroomSubmissionRecord>;

/**
 * A request Google refused, or one that could not be completed. `code` is what a sync records;
 * `status` and `reasons` are Google's codes, for callers that act on a particular refusal (such as
 * `ProjectPermissionDenied`).
 */
export class ClassroomRequestError extends RosterSyncError {
  /** The HTTP status, when Google answered. */
  readonly status: number | undefined;
  /** Google's `ErrorInfo` reasons and Classroom's `@` tag. */
  readonly reasons: readonly string[];

  constructor(code: SyncErrorCode, message: string, status?: number, reasons: readonly string[] = []) {
    super(code, message);
    this.name = "ClassroomRequestError";
    this.status = status;
    this.reasons = reasons;
  }
}

/** A list read: the records that validated, and a description of each that did not. */
export interface ListRead<T> {
  records: T[];
  /** One entry per invalid record: its position in the list and what was wrong. */
  invalid: { index: number; message: string }[];
}

/** Limits on what the client reads. */
export interface ClassroomLimits {
  /** The largest response body accepted, in bytes. */
  maxResponseBytes: number;
  /** The most items one list may hold. */
  maxListItems: number;
  /** How long one request may take. */
  requestTimeoutMs: number;
}

/** Limits generous enough for a large district: Classroom caps a course at 1,000 students. */
export const DEFAULT_CLASSROOM_LIMITS: ClassroomLimits = {
  maxResponseBytes: 8 * 1024 * 1024,
  maxListItems: 100_000,
  requestTimeoutMs: 30_000,
};

/** Everything a {@link GoogleClassroomClient} needs. */
export interface GoogleClassroomClientOptions {
  /** Delegated tokens, holding the scopes the calls made need. */
  tokens: DelegatedTokens;
  /** The Workspace administrator reads act as, by primary email. */
  admin: string;
  /** The fetch every request goes through. */
  fetch: typeof fetch;
  /** Items asked for per page. The server may return fewer. Defaults to 100. */
  pageSize?: number;
  /** The retry policy, when not {@link DEFAULT_RETRY_POLICY}. */
  retry?: RetryPolicy;
  /** The limits, when not {@link DEFAULT_CLASSROOM_LIMITS}. */
  limits?: ClassroomLimits;
  /** How to wait between attempts. */
  sleep?: Sleep;
  /** The time in milliseconds, for `Retry-After` dates. */
  clock?: () => number;
}

/**
 * The Classroom calls district sync and grade sync make. Reads act as the configured administrator;
 * a call that changes coursework acts as the Workspace user it names, since Classroom lets only a
 * course's teachers create or grade its coursework.
 *
 * Every request refuses redirects and is retried through 429s (honouring `Retry-After`), 5xxs
 * and network failures; a 401 refreshes the token once. Failures are {@link ClassroomRequestError}s
 * whose messages name the operation, HTTP status and Google's error codes only.
 */
export class GoogleClassroomClient {
  readonly #tokens: DelegatedTokens;
  readonly #admin: string;
  readonly #fetch: typeof fetch;
  readonly #pageSize: number;
  readonly #retry: RetryPolicy;
  readonly #limits: ClassroomLimits;
  readonly #sleep: Sleep;
  readonly #clock: () => number;

  constructor(options: GoogleClassroomClientOptions) {
    this.#tokens = options.tokens;
    this.#admin = options.admin;
    this.#fetch = options.fetch;
    this.#pageSize = options.pageSize ?? 100;
    if (!Number.isInteger(this.#pageSize) || this.#pageSize < 1 || this.#pageSize > 1000) {
      throw new RosterSyncError("internal-error", "the Classroom page size must be 1 to 1,000");
    }
    this.#retry = options.retry ?? DEFAULT_RETRY_POLICY;
    this.#limits = options.limits ?? DEFAULT_CLASSROOM_LIMITS;
    this.#sleep = options.sleep ?? realSleep;
    this.#clock = options.clock ?? Date.now;
  }

  /** Every course in the domain the administrator can see in one of `states` (all states when none). */
  listCourses(states: readonly string[] = []): Promise<ListRead<ClassroomCourse>> {
    return this.#list("courses", "courses", ClassroomCourse, this.#admin, { courseStates: states });
  }

  /** A course's domain-scoped aliases, such as `d:<SIS section ID>`. */
  async listAliases(courseId: string): Promise<string[]> {
    const read = await this.#list(`courses/${id(courseId)}/aliases`, "aliases", ClassroomAlias);
    return read.records.map((r) => r.alias).filter((alias) => alias.startsWith("d:"));
  }

  /** A course's teachers. */
  listTeachers(courseId: string): Promise<ListRead<ClassroomMember>> {
    return this.#list(`courses/${id(courseId)}/teachers`, "teachers", ClassroomMember);
  }

  /** A course's students. */
  listStudents(courseId: string): Promise<ListRead<ClassroomMember>> {
    return this.#list(`courses/${id(courseId)}/students`, "students", ClassroomMember);
  }

  /** One course. */
  async getCourse(courseId: string): Promise<ClassroomCourse> {
    return this.#parse("course", ClassroomCourse, await this.#call("GET", `courses/${id(courseId)}`, "get course", this.#admin));
  }

  /** One teacher of a course, with their email when the token has `classroom.profile.emails`. */
  async getTeacher(courseId: string, userId: string): Promise<ClassroomMember> {
    return this.#parse("teacher", ClassroomMember, await this.#call("GET", `courses/${id(courseId)}/teachers/${id(userId)}`, "get teacher", this.#admin));
  }

  /** A course's published coursework, as `actAs` sees it. */
  listCourseWork(courseId: string, actAs: string): Promise<ListRead<ClassroomCourseWorkRecord>> {
    return this.#list(`courses/${id(courseId)}/courseWork`, "courseWork", ClassroomCourseWorkRecord, actAs);
  }

  /** One piece of coursework, as `actAs` sees it. */
  async getCourseWork(courseId: string, courseWorkId: string, actAs: string): Promise<ClassroomCourseWorkRecord> {
    const body = await this.#call("GET", `courses/${id(courseId)}/courseWork/${id(courseWorkId)}`, "get coursework", actAs);
    return this.#parse("coursework", ClassroomCourseWorkRecord, body);
  }

  /** Creates coursework as `actAs`, a teacher of the course. The calling project owns it. */
  async createCourseWork(courseId: string, body: Record<string, unknown>, actAs: string): Promise<ClassroomCourseWorkRecord> {
    const created = await this.#call("POST", `courses/${id(courseId)}/courseWork`, "create coursework", actAs, undefined, body);
    return this.#parse("coursework", ClassroomCourseWorkRecord, created);
  }

  /** The submissions of one student to one piece of coursework. */
  listSubmissions(courseId: string, courseWorkId: string, userId: string, actAs: string): Promise<ListRead<ClassroomSubmissionRecord>> {
    return this.#list(
      `courses/${id(courseId)}/courseWork/${id(courseWorkId)}/studentSubmissions`,
      "studentSubmissions",
      ClassroomSubmissionRecord,
      actAs,
      { userId: id(userId) },
    );
  }

  /** Sets a submission's grade fields, named in `updateMask`, as `actAs`, a teacher of the course. */
  async patchSubmission(
    courseId: string, courseWorkId: string, submissionId: string,
    grades: { assignedGrade?: number; draftGrade?: number }, actAs: string,
  ): Promise<ClassroomSubmissionRecord> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(submissionId)) throw new ClassroomRequestError("internal-error", "invalid Classroom submission ID");
    const updateMask = Object.keys(grades).toSorted().join(",");
    const body = await this.#call(
      "PATCH",
      `courses/${id(courseId)}/courseWork/${id(courseWorkId)}/studentSubmissions/${submissionId}`,
      "grade submission",
      actAs,
      { updateMask },
      grades,
    );
    return this.#parse("submission", ClassroomSubmissionRecord, body);
  }

  /** Reads every page of a list. Invalid items are reported, not thrown, so one bad record is an issue. */
  async #list<T>(path: string, key: string, schema: z.ZodType<T>, actAs = this.#admin, params: Query = {}): Promise<ListRead<T>> {
    const records: T[] = [];
    const invalid: ListRead<T>["invalid"] = [];
    const seenTokens = new Set<string>();
    let index = 0;
    let pageToken: string | undefined;
    do {
      const query = { ...params, pageSize: String(this.#pageSize), ...(pageToken === undefined ? {} : { pageToken }) };
      const body = await this.#call("GET", path, `list ${key}`, actAs, query);
      const page = z.object({ nextPageToken: z.string().max(4096).optional() }).loose().safeParse(body);
      const items = page.success ? (page.data as Record<string, unknown>)[key] ?? [] : undefined;
      if (!page.success || !Array.isArray(items)) throw new ClassroomRequestError("invalid-response", `list ${key} returned no ${key} list`);
      for (const item of items) {
        const parsed = schema.safeParse(item);
        if (parsed.success) records.push(parsed.data);
        else invalid.push({ index, message: describe(parsed.error) });
        index++;
      }
      if (index > this.#limits.maxListItems) {
        throw new ClassroomRequestError("response-too-large", `list ${key} has more than ${this.#limits.maxListItems} items`);
      }
      // An empty token, like an absent one, ends the list.
      pageToken = page.data.nextPageToken || undefined;
      if (pageToken !== undefined) {
        if (seenTokens.has(pageToken)) throw new ClassroomRequestError("inconsistent-paging", `list ${key} repeated a page token`);
        seenTokens.add(pageToken);
      }
    } while (pageToken !== undefined);
    return { records, invalid };
  }

  async #call(
    method: string, path: string, operation: string, actAs: string,
    query: Query = {}, body?: unknown,
  ): Promise<unknown> {
    const url = new URL(`${CLASSROOM_API}/${path}`);
    for (const [name, value] of Object.entries(query)) {
      for (const one of typeof value === "string" ? [value] : value) url.searchParams.append(name, one);
    }
    const send = async (token: string) => {
      try {
        return await fetchWithRetry(
          () => this.#fetch(url, {
            method,
            headers: {
              authorization: `Bearer ${token}`,
              accept: "application/json",
              ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            // workerd refuses `redirect: "error"`; a 3xx is refused below instead.
            redirect: "manual",
            signal: AbortSignal.timeout(this.#limits.requestTimeoutMs),
          }),
          // Reads and grade patches are idempotent. A create is not: a failure after Google acted
          // would create the coursework twice, so it is sent once and the caller decides.
          method === "POST" ? { ...this.#retry, maxAttempts: 1 } : this.#retry,
          this.#sleep,
          this.#clock,
        );
      } catch {
        throw new ClassroomRequestError("source-unavailable", `${operation} did not complete`);
      }
    };
    let token = await this.#tokens.token(actAs);
    let response = await send(token);
    if (response.status === 401) {
      await discard(response);
      this.#tokens.invalidate(actAs, token);
      token = await this.#tokens.token(actAs);
      response = await send(token);
    }
    if (response.status >= 300 && response.status < 400) {
      await discard(response);
      throw new ClassroomRequestError("invalid-response", `${operation} was redirected (HTTP ${response.status}); Classroom never redirects`, response.status);
    }
    if (!response.ok) {
      const { status, reasons } = await readGoogleError(response);
      const codes = [status, ...reasons].filter((c) => c !== undefined).join(", ");
      throw new ClassroomRequestError(
        failureCode(response.status),
        `${operation} failed with HTTP ${response.status}${codes === "" ? "" : ` (${codes})`}`,
        response.status,
        reasons,
      );
    }
    return readBoundedJson(operation, response, this.#limits.maxResponseBytes);
  }

  #parse<T>(what: string, schema: z.ZodType<T>, body: unknown): T {
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ClassroomRequestError("invalid-response", `Classroom returned a malformed ${what}: ${describe(parsed.error)}`);
    return parsed.data;
  }
}

/** Query parameters; a list is sent as the parameter repeated, as Google reads a repeated field. */
type Query = Readonly<Record<string, string | readonly string[]>>;

/** A numeric Classroom ID, checked before it is put in a path. Aliases are not accepted. */
function id(value: string): string {
  if (!NumericId.safeParse(value).success) throw new ClassroomRequestError("internal-error", "invalid Classroom ID");
  return value;
}

function failureCode(status: number): SyncErrorCode {
  if (status === 401 || status === 403) return "auth-failed";
  if (status === 429) return "rate-limited";
  if (status >= 500 || status === 404 || status === 408) return "source-unavailable";
  return "invalid-response";
}

/** A Zod error as `field: problem`, naming fields only, never values. */
function describe(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "record"}: ${issue.message}`).join("; ");
}
