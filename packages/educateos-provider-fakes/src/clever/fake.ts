// A fake of the Clever Data API v3.1 (https://api.clever.com/v3.1), built from Clever's developer
// docs: paging (https://dev.clever.com/docs/paging-and-limits), events
// (https://dev.clever.com/docs/events-api), errors and rate limits
// (https://dev.clever.com/docs/error-messages), and the record schemas of /districts, /schools,
// /terms, /sections and /users. District-app bearer tokens authorise every request. v3.1 also
// serves LMS Connect's assignments and submissions (`lms-connect.ts`), built to Clever's published
// spec and not tested against Clever.
import { Fake, bearer, type FakeOptions } from "../fake.ts";
import { tokenId } from "../ids.ts";
import { studentsToRemove, validateSeed, withoutPeople } from "../seed.ts";
import type { DistrictSeed, PersonSeed, SectionSeed } from "../types.ts";
import { cleverDistrictId, cleverId, cleverUserId, type CleverCollection, type CleverRole } from "./ids.ts";
import { LmsConnectGradebook, type CleverAssignment, type CleverSubmission } from "./lms-connect.ts";
import { projectClever, type CleverExtraRoles, type CleverRecord, type CleverRecords } from "./model.ts";

/** The Data API's origin. */
export const CLEVER_API_ORIGIN = "https://api.clever.com";

/** Clever's default and maximum page sizes (paging-and-limits). */
export const CLEVER_DEFAULT_LIMIT = 100;
export const CLEVER_MAX_LIMIT = 10000;

/** The rate limit Clever documents per bearer token per minute (error-messages). */
export const CLEVER_RATE_LIMIT_PER_MINUTE = 1200;

/** A Clever event type, such as `users.updated`. */
export type CleverEventType = `${CleverCollection}.${"created" | "updated" | "deleted"}`;

/** An event, as `/events` serves it. */
export interface CleverEvent {
  readonly id: string;
  readonly type: CleverEventType;
  /** ISO 8601. */
  readonly created: string;
  readonly data: { readonly object: CleverRecord; readonly previous_attributes?: Record<string, unknown> };
}

/** Options of {@link CleverDataFake}. */
export interface CleverDataFakeOptions extends FakeOptions {
  readonly seed: DistrictSeed;
  /** District-app tokens accepted as bearers. Defaults to one, derived from the seed: {@link CleverDataFake.districtToken}. */
  readonly districtTokens?: readonly string[];
  /** Extra Clever roles for multi-role teachers, staff and administrators, by person ID. */
  readonly extraRoles?: CleverExtraRoles;
  /**
   * Renders the fields Clever's v3.1 spec marks nullable as `null` when the seed has nothing for
   * them, and each role a user does not hold as `null`, as some real districts' data does. Defaults
   * to leaving them out.
   */
  readonly nulls?: boolean;
  /** Requests per token per minute before a real 429. Defaults to {@link CLEVER_RATE_LIMIT_PER_MINUTE}. */
  readonly rateLimitPerMinute?: number;
  /**
   * Where the API is served. Defaults to {@link CLEVER_API_ORIGIN}. A base with a path (one host
   * serving several fakes) serves `/v3.1/…` below that path, and its `links` and `uri`s carry the
   * path, so they resolve against the origin as Clever's do.
   */
  readonly baseUrl?: string;
  /**
   * Who is calling, for the rate limit: each distinct key gets its own budget per token. Defaults to
   * one budget per token, as Clever counts. A fake whose token is shared by callers who do not trust
   * each other (a public demo) keys by caller, so one caller cannot spend another's budget.
   */
  readonly clientKey?: (request: Request) => string;
}

/** Collections in dependency order: creates and updates go this way, deletes the reverse. */
const ORDER: readonly CleverCollection[] = ["districts", "schools", "terms", "courses", "users", "sections"];

const RESOURCES = new Set<string>(ORDER);

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The old values of whatever changed between `before` and `after`, nesting into objects. */
function previousAttributes(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const old = before[key];
    const now = after[key];
    if (equal(old, now)) continue;
    out[key] = isObject(old) && isObject(now) ? previousAttributes(old, now) : (old ?? null);
  }
  return out;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/**
 * A Clever Data API v3.1 fake over a seed. Tests and demos change the roster through
 * {@link mutate} (or {@link addPerson}, {@link updatePerson}, {@link removePerson},
 * {@link updateSection}, {@link moveStudent} …), and `/events` reports each change as Clever would.
 */
export class CleverDataFake extends Fake {
  /** The default district-app token, derived from the seed. */
  readonly districtToken: string;
  /** The Clever ID of the district. */
  readonly districtId: string;
  /** Every event so far, oldest first. */
  readonly events: CleverEvent[] = [];
  readonly #tokens: Set<string>;
  readonly #extraRoles: CleverExtraRoles;
  readonly #nulls: boolean;
  readonly #limit: number;
  readonly #usage = new Map<string, { window: number; count: number }>();
  readonly #clientKey: ((request: Request) => string) | undefined;
  /** The path the API is served below: empty at Clever's own origin. */
  readonly #prefix: string;
  readonly #origin: string;
  /** Each event's position in {@link events}, so a cursor is found without a scan. */
  readonly #eventIndex = new Map<string, number>();
  readonly #gradebook: LmsConnectGradebook;
  #seed: DistrictSeed;
  #records: CleverRecords;
  #eventCount = 0;

  constructor(options: CleverDataFakeOptions) {
    super(options);
    this.#seed = validateSeed(options.seed);
    this.districtId = cleverDistrictId(this.#seed);
    this.districtToken = tokenId("clever:district-token", this.#seed.id, 40);
    this.#tokens = new Set(options.districtTokens ?? [this.districtToken]);
    this.#extraRoles = options.extraRoles ?? {};
    this.#nulls = options.nulls ?? false;
    this.#limit = options.rateLimitPerMinute ?? CLEVER_RATE_LIMIT_PER_MINUTE;
    this.#clientKey = options.clientKey;
    const base = new URL(options.baseUrl ?? CLEVER_API_ORIGIN);
    this.#origin = base.origin;
    this.#prefix = base.pathname.replace(/\/+$/, "");
    this.#records = projectClever(this.#seed, this.#extraRoles, this.#nulls);
    this.#gradebook = new LmsConnectGradebook(this.#seed.id, () => this.now(), (id) => this.#records.sections.get(id));
  }

  /** The seed as it stands after every mutation. */
  get seed(): DistrictSeed {
    return this.#seed;
  }

  /** The Clever ID of a seed record. */
  idOf(collection: Exclude<CleverCollection, "districts">, seedId: string): string {
    return cleverId(this.#seed, collection, seedId);
  }

  /** The Clever user ID of a seed person. */
  userId(personId: string): string {
    return cleverUserId(this.#seed, personId);
  }

  /** The record the API currently serves, or undefined. */
  record(collection: CleverCollection, id: string): CleverRecord | undefined {
    return this.#records[collection].get(id);
  }

  /** A section's LMS Connect assignments, oldest first, by the section's Clever ID. */
  assignmentsFor(sectionId: string): CleverAssignment[] {
    return this.#gradebook.assignmentsFor(sectionId);
  }

  /**
   * A student's LMS Connect submission, as the API would serve it now, or undefined if the
   * assignment is not in the section or the student is not one of its assignees. Clever IDs.
   */
  submissionFor(sectionId: string, assignmentId: string, userId: string): CleverSubmission | undefined {
    return this.#gradebook.submissionFor(sectionId, assignmentId, userId);
  }

  // ── Mutations ───────────────────────────────────────────────────

  /**
   * Replaces the seed with `change(seed)` and records the difference as events: creates, then
   * updates (with `previous_attributes`), then deletes in reverse dependency order, as Clever
   * batches them. Changed records get `last_modified` now. Returns the new events.
   */
  mutate(change: (seed: DistrictSeed) => DistrictSeed): CleverEvent[] {
    const next = validateSeed(change(this.#seed));
    const projected = projectClever(next, this.#extraRoles, this.#nulls);
    const stamp = new Date(this.now()).toISOString();
    const created: CleverEvent[] = [];
    const updated: CleverEvent[] = [];
    const deleted: CleverEvent[] = [];
    for (const collection of ORDER) {
      const before = this.#records[collection];
      const after = projected[collection];
      for (const [id, fresh] of after) {
        const old = before.get(id);
        if (old === undefined) {
          const record = "last_modified" in fresh ? { ...fresh, created: stamp, last_modified: stamp } : fresh;
          after.set(id, record);
          created.push(this.#event(`${collection}.created`, stamp, record));
          continue;
        }
        const strip = ({ created: _c, last_modified: _m, ...rest }: CleverRecord) => rest;
        if (equal(strip(old), strip(fresh))) {
          after.set(id, old);
          continue;
        }
        const record = "last_modified" in fresh ? { ...fresh, created: old["created"], last_modified: stamp } : fresh;
        after.set(id, record);
        updated.push(this.#event(`${collection}.updated`, stamp, record, previousAttributes(old, record)));
      }
    }
    for (const collection of ORDER.toReversed()) {
      for (const [id, old] of this.#records[collection]) {
        if (!projected[collection].has(id)) deleted.push(this.#event(`${collection}.deleted`, stamp, old));
      }
    }
    this.#seed = next;
    this.#records = projected;
    const batch = [...created, ...updated, ...deleted].map((event) => {
      this.#eventCount += 1;
      const seconds = Math.floor(this.now() / 1000).toString(16).padStart(8, "0");
      const final = { ...event, id: `${seconds}${this.#eventCount.toString(16).padStart(6, "0")}${tokenIdHex(this.#seed.id, this.#eventCount)}` };
      return final;
    });
    for (const event of batch) {
      this.#eventIndex.set(event.id, this.events.length);
      this.events.push(event);
    }
    return batch;
  }

  #event(type: CleverEventType, created: string, object: CleverRecord, previous?: Record<string, unknown>): CleverEvent {
    return { id: "", type, created, data: previous === undefined ? { object } : { object, previous_attributes: previous } };
  }

  /** Adds a person (a `users.created` event, and `sections.updated` for any roster they join). */
  addPerson(person: PersonSeed, sectionIds: readonly string[] = []): CleverEvent[] {
    return this.mutate((seed) => ({
      ...seed,
      people: [...seed.people, person],
      sections: seed.sections.map((s) => {
        if (!sectionIds.includes(s.id)) return s;
        return person.role === "student" ? { ...s, studentIds: [...s.studentIds, person.id] } : { ...s, teacherIds: [...s.teacherIds, person.id] };
      }),
    }));
  }

  /** Changes a person's fields (a `users.updated` event). */
  updatePerson(personId: string, patch: Partial<Omit<PersonSeed, "id">>): CleverEvent[] {
    return this.mutate((seed) => ({ ...seed, people: seed.people.map((p) => (p.id === personId ? { ...p, ...patch } : p)) }));
  }

  /** Removes a person and their roster places (`users.deleted`, and `sections.updated`). */
  removePerson(personId: string): CleverEvent[] {
    return this.mutate((seed) => withoutPeople(seed, new Set([personId])));
  }

  /** Adds a section (`sections.created`). */
  addSection(section: SectionSeed): CleverEvent[] {
    return this.mutate((seed) => ({ ...seed, sections: [...seed.sections, section] }));
  }

  /** Changes a section, its roster included (`sections.updated`). */
  updateSection(sectionId: string, patch: Partial<Omit<SectionSeed, "id">>): CleverEvent[] {
    return this.mutate((seed) => ({ ...seed, sections: seed.sections.map((s) => (s.id === sectionId ? { ...s, ...patch } : s)) }));
  }

  /**
   * Moves a student from one section's roster to another's, as a schedule change in the SIS does
   * (`sections.updated` for each). The student's own record is untouched.
   */
  moveStudent(studentId: string, fromSectionId: string, toSectionId: string): CleverEvent[] {
    const from = this.#seed.sections.find((s) => s.id === fromSectionId);
    const to = this.#seed.sections.find((s) => s.id === toSectionId);
    if (from === undefined || to === undefined) throw new RangeError("a move is between two sections the district has");
    if (!from.studentIds.includes(studentId)) throw new RangeError(`${studentId} is not in ${fromSectionId}`);
    if (to.studentIds.includes(studentId)) throw new RangeError(`${studentId} is already in ${toSectionId}`);
    return this.mutate((seed) => ({
      ...seed,
      sections: seed.sections.map((s) => {
        if (s.id === fromSectionId) return { ...s, studentIds: s.studentIds.filter((id) => id !== studentId) };
        if (s.id === toSectionId) return { ...s, studentIds: [...s.studentIds, studentId] };
        return s;
      }),
    }));
  }

  /** Removes a section (`sections.deleted`). */
  removeSection(sectionId: string): CleverEvent[] {
    return this.mutate((seed) => ({
      ...seed,
      sections: seed.sections.filter((s) => s.id !== sectionId),
      ...(seed.assignments === undefined ? {} : { assignments: seed.assignments.filter((a) => a.sectionId !== sectionId) }),
    }));
  }

  protected removeLargeShare(fraction: number): void {
    this.mutate((seed) => withoutPeople(seed, studentsToRemove(seed, fraction)));
  }

  // ── Serving ─────────────────────────────────────────────────────

  #rateHeaders(token: string, remaining: number): Headers {
    const window = Math.floor(this.now() / 60000);
    return new Headers({
      "x-ratelimit-limit": String(this.#limit),
      "x-ratelimit-remaining": String(Math.max(0, remaining)),
      "x-ratelimit-reset": String((window + 1) * 60),
      "x-ratelimit-bucket": tokenId("clever:bucket", token, 12),
    });
  }

  protected errorResponse(status: number, reason: "outage" | "rate-limit", request: Request): Response {
    if (reason === "rate-limit") {
      // Clever's 429 has an empty body and the X-RateLimit-* headers (error-messages).
      return new Response(null, { status: 429, headers: this.#rateHeaders(bearer(request) ?? "", 0) });
    }
    return json({ error: status === 503 ? "Service Unavailable" : "Internal Server Error" }, status);
  }

  protected async serve(request: Request, body: string): Promise<Response> {
    const url = new URL(request.url);
    const token = bearer(request);
    if (url.origin !== this.#origin || (this.#prefix !== "" && !url.pathname.startsWith(`${this.#prefix}/`))) return json({ error: "Resource not found" }, 404);
    if (token === undefined || !this.#tokens.has(token)) return json({ error: "Unauthorized" }, 401);
    const window = Math.floor(this.now() / 60000);
    const budget = this.#clientKey === undefined ? token : `${token}\u0000${this.#clientKey(request)}`;
    const usage = this.#usage.get(budget);
    const count = usage !== undefined && usage.window === window ? usage.count + 1 : 1;
    if (usage === undefined || usage.window !== window) {
      // Budgets of past minutes are spent; forgetting them bounds a long-running fake's memory.
      for (const [key, old] of this.#usage) if (old.window !== window) this.#usage.delete(key);
    }
    this.#usage.set(budget, { window, count });
    const headers = this.#rateHeaders(token, this.#limit - count);
    if (count > this.#limit) return new Response(null, { status: 429, headers });
    const response = this.#route(request, url, body);
    for (const [key, value] of headers) response.headers.set(key, value);
    return response;
  }

  #route(request: Request, url: URL, body: string): Response {
    const path = url.pathname.slice(this.#prefix.length);
    const lms = /^\/(v3\.[01])\/sections\/([^/]+)\/assignments(?:\/([^/]+)(?:\/(submissions)(?:\/([^/]+))?)?)?\/?$/.exec(path);
    if (lms !== null) {
      const [, version, sectionId, assignmentId, submissions, userId] = lms as unknown as [string, string, string, string | undefined, string | undefined, string | undefined];
      // LMS Connect is v3.1 only (clever-lms-connect): v3.0 has no such resource.
      if (version !== "v3.1") return json({ error: "Resource not found" }, 404);
      return this.#gradebook.serve(request.method, { sectionId, assignmentId, submissions: submissions !== undefined, userId }, body, url, `${this.#prefix}/${version}`);
    }
    const match = /^\/(v3\.[01])\/([a-z_]+)(?:\/([0-9a-f]{24}|[^/]+))?(?:\/([a-z_]+))?\/?$/.exec(path);
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
    if (match === null) return json({ error: "Resource not found" }, 404);
    const [, version, resource, id, nested] = match as unknown as [string, string, string, string | undefined, string | undefined];
    const base = `${this.#prefix}/${version}`;
    if (resource === "events") {
      if (nested !== undefined) return json({ error: "Resource not found" }, 404);
      return id === undefined ? this.#eventList(request, url, base) : this.#eventOne(id, base);
    }
    if (!RESOURCES.has(resource)) return json({ error: "Resource not found" }, 404);
    const collection = resource as CleverCollection;
    if (id === undefined) return this.#list(request, url, base, collection, [...this.#records[collection].values()]);
    const record = this.#records[collection].get(id);
    if (record === undefined) return json({ error: "Resource not found" }, 404);
    if (nested === undefined) return json({ data: record, links: [{ rel: "self", uri: `${base}/${collection}/${id}` }] });
    return this.#related(request, url, base, collection, record, nested);
  }

  #related(request: Request, url: URL, base: string, collection: CleverCollection, record: CleverRecord, nested: string): Response {
    const all = <C extends CleverCollection>(c: C) => [...this.#records[c].values()];
    const one = (c: CleverCollection, id: unknown) => {
      const found = typeof id === "string" ? this.#records[c].get(id) : undefined;
      if (found === undefined) return json({ error: "Resource not found" }, 404);
      return json({ data: found, links: [{ rel: "self", uri: `${base}/${c}/${found.id}` }] });
    };
    const list = (c: CleverCollection, records: CleverRecord[]) => this.#list(request, url, base, c, records);
    const usersById = (ids: Iterable<string>) => {
      const set = new Set(ids);
      return all("users").filter((u) => set.has(u.id));
    };
    const sectionsOf = (userId: string) => all("sections").filter((s) => (s["students"] as string[]).includes(userId) || (s["teachers"] as string[]).includes(userId));
    const schoolsOfUser = (user: CleverRecord) =>
      new Set(Object.values(user["roles"] as Record<string, Record<string, unknown> | null>).flatMap((r) => (r?.["schools"] as string[] | undefined) ?? []));
    if (nested === "district") return one("districts", collection === "districts" ? record.id : record["district"]);
    switch (`${collection}/${nested}`) {
      case "districts/schools":
        return list("schools", all("schools"));
      case "districts/users":
        return list("users", all("users"));
      case "districts/sections":
        return list("sections", all("sections"));
      case "districts/terms":
        return list("terms", all("terms"));
      case "districts/courses":
        return list("courses", all("courses"));
      case "schools/sections":
        return list("sections", all("sections").filter((s) => s["school"] === record.id));
      case "schools/users":
        return list("users", all("users").filter((u) => schoolsOfUser(u).has(record.id)));
      case "schools/courses": {
        const ids = new Set(all("sections").filter((s) => s["school"] === record.id).map((s) => s["course"]));
        return list("courses", all("courses").filter((c) => ids.has(c.id)));
      }
      case "schools/terms": {
        const ids = new Set(all("sections").filter((s) => s["school"] === record.id).map((s) => s["term_id"]));
        return list("terms", all("terms").filter((t) => ids.has(t.id)));
      }
      case "sections/users": {
        const role = url.searchParams.get("role");
        const students = record["students"] as string[];
        const teachers = record["teachers"] as string[];
        const ids = role === "student" ? students : role === "teacher" ? teachers : [...teachers, ...students];
        return this.#list(request, url, base, "users", usersById(ids), false);
      }
      case "sections/school":
        return one("schools", record["school"]);
      case "sections/term":
        return one("terms", record["term_id"]);
      case "sections/course":
        return one("courses", record["course"]);
      case "terms/sections":
        return list("sections", all("sections").filter((s) => s["term_id"] === record.id));
      case "courses/sections":
        return list("sections", all("sections").filter((s) => s["course"] === record.id));
      case "users/sections":
        return list("sections", sectionsOf(record.id));
      case "users/schools": {
        const ids = schoolsOfUser(record);
        return list("schools", all("schools").filter((s) => ids.has(s.id)));
      }
      case "users/mystudents": {
        const roles = record["roles"] as Record<string, Record<string, unknown> | null>;
        const ids = new Set<string>();
        if (roles["teacher"] != null) for (const s of all("sections")) if ((s["teachers"] as string[]).includes(record.id)) for (const st of s["students"] as string[]) ids.add(st);
        for (const rel of (roles["contact"]?.["student_relationships"] as { student: string }[] | undefined) ?? []) ids.add(rel.student);
        return list("users", usersById(ids));
      }
      case "users/myteachers": {
        const ids = new Set<string>();
        for (const s of all("sections")) if ((s["students"] as string[]).includes(record.id)) for (const t of s["teachers"] as string[]) ids.add(t);
        return list("users", usersById(ids));
      }
      case "users/mycontacts":
        return list(
          "users",
          all("users").filter((u) => {
            const contact = (u["roles"] as Record<string, Record<string, unknown> | null>)["contact"];
            return ((contact?.["student_relationships"] as { student: string }[] | undefined) ?? []).some((r) => r.student === record.id);
          }),
        );
      default:
        return json({ error: "Resource not found" }, 404);
    }
  }

  /** Parses `limit`, or returns Clever's error response for a bad one. */
  #limitOf(url: URL): number | Response {
    const raw = url.searchParams.get("limit");
    if (raw === null) return CLEVER_DEFAULT_LIMIT;
    const limit = Number(raw);
    if (!Number.isInteger(limit) || limit < 1) return json({ error: "limit must be a positive integer" }, 400);
    // A limit over 10000 is a 413 Request Entity Too Large (error-messages).
    if (limit > CLEVER_MAX_LIMIT) return json({ error: "Request entity too large" }, 413);
    return limit;
  }

  #list(request: Request, url: URL, base: string, collection: CleverCollection, records: CleverRecord[], roleFilter = true): Response {
    const limit = this.#limitOf(url);
    if (limit instanceof Response) return limit;
    let rows = records.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const role = url.searchParams.get("role");
    if (collection === "users" && roleFilter && role !== null) {
      const roles: readonly CleverRole[] = ["student", "teacher", "staff", "district_admin", "contact"];
      if (!roles.includes(role as CleverRole)) return json({ error: `invalid role: ${role}` }, 400);
      rows = rows.filter((u) => (u["roles"] as Record<string, unknown>)[role] != null);
    }
    const after = url.searchParams.get("starting_after");
    const before = url.searchParams.get("ending_before");
    const ids = rows.map((r) => r.id);
    const start = after === null ? 0 : ids.filter((id) => id <= after).length;
    const end = before === null || before === "last" ? ids.length : ids.filter((id) => id < before).length;
    const page = this.#page(start, end, limit, before !== null);
    const items = rows.slice(page.from, page.to).map((data) => ({ data, uri: `${base}/${collection}/${data.id}` }));
    if (items.length > 0 && this.takeMalformed(request)) {
      const victim = items[Math.floor(items.length / 2)]!;
      victim.data = malformed(collection, victim.data);
    }
    return json({ data: items, links: this.#links(url, ids, page) });
  }

  #page(start: number, end: number, limit: number, fromEnd: boolean): { from: number; to: number } {
    if (fromEnd) return { from: Math.max(start, end - limit), to: end };
    return { from: start, to: Math.min(end, start + limit) };
  }

  #links(url: URL, ids: readonly string[], page: { from: number; to: number }): { rel: string; uri: string }[] {
    const link = (rel: string, cursor?: [string, string]) => {
      const params = new URLSearchParams(url.searchParams);
      params.delete("starting_after");
      params.delete("ending_before");
      if (cursor !== undefined) params.set(cursor[0], cursor[1]);
      const query = params.toString();
      return { rel, uri: `${url.pathname}${query === "" ? "" : `?${query}`}` };
    };
    const self = { rel: "self", uri: `${url.pathname}${url.search}` };
    const links = [self];
    if (page.to > page.from && page.to < ids.length) links.push(link("next", ["starting_after", ids[page.to - 1]!]));
    if (page.to > page.from && page.from > 0) links.push(link("prev", ["ending_before", ids[page.from]!]));
    return links;
  }

  #eventList(request: Request, url: URL, base: string): Response {
    const limit = this.#limitOf(url);
    if (limit instanceof Response) return limit;
    const types = url.searchParams.getAll("record_type").flatMap((t) => t.split(","));
    const rows = types.length === 0 ? this.events : this.events.filter((e) => types.includes(e.type.split(".")[0]!));
    const ids = rows.map((e) => e.id);
    const after = url.searchParams.get("starting_after");
    const before = url.searchParams.get("ending_before");
    // An events cursor must name a real event (events-api: starting_after "requires a valid event_id").
    for (const cursor of [after, before === "last" ? null : before]) {
      if (cursor !== null && !this.#eventIndex.has(cursor)) return json({ error: `invalid event id: ${cursor}` }, 400);
    }
    // `rows` keeps the events' order, so the rows before a cursor are found by binary search on
    // their positions: one pass to filter, then O(log n) per cursor, rather than a scan per row.
    const positions = rows.map((e) => this.#eventIndex.get(e.id)!);
    const countBefore = (cursor: string, inclusive: boolean) => {
      const at = this.#eventIndex.get(cursor)!;
      let low = 0;
      let high = positions.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (inclusive ? positions[mid]! <= at : positions[mid]! < at) low = mid + 1;
        else high = mid;
      }
      return low;
    };
    const start = after === null ? 0 : countBefore(after, true);
    const end = before === null || before === "last" ? rows.length : countBefore(before, false);
    const page = this.#page(start, end, limit, before !== null);
    const items: { data: unknown; uri: string }[] = rows.slice(page.from, page.to).map((event) => ({ data: event, uri: `${base}/events/${event.id}` }));
    if (items.length > 0 && this.takeMalformed(request)) {
      const victim = items[Math.floor(items.length / 2)]!;
      const event = victim.data as CleverEvent;
      const { id: _id, ...object } = event.data.object;
      victim.data = { ...event, data: { ...event.data, object } };
    }
    return json({ data: items, links: this.#links(url, ids, page) });
  }

  #eventOne(id: string, base: string): Response {
    const at = this.#eventIndex.get(id);
    const event = at === undefined ? undefined : this.events[at];
    if (event === undefined) return json({ error: "Resource not found" }, 404);
    return json({ data: event, links: [{ rel: "self", uri: `${base}/events/${id}` }] });
  }
}

function tokenIdHex(seedId: string, n: number): string {
  // Ten hex digits of noise so event IDs look like ObjectIds while staying deterministic.
  return [...tokenId("clever:event", `${seedId}\u0000${n}`, 10)].map((c) => (c.charCodeAt(0) % 16).toString(16)).join("");
}

/**
 * One record broken the way Clever data goes wrong: a guaranteed field missing or null. Users lose
 * `name.last`, sections get a null `students`, and anything else loses its `district`.
 */
function malformed(collection: CleverCollection, record: CleverRecord): CleverRecord {
  if (collection === "users") {
    const { last: _last, ...name } = record["name"] as Record<string, unknown>;
    return { ...record, name };
  }
  if (collection === "sections") return { ...record, students: null };
  const { district: _district, ...rest } = record;
  return rest;
}
