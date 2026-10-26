// A OneRoster 1.2 rostering server in the ClassLink OAuth 2.0 profile, as a fetch handler over a
// district seed. Followed:
// - 1EdTech OneRoster 1.2 Rostering Service REST/JSON Binding: the endpoints under
//   `/ims/oneroster/rostering/v1p2`, the collection and single-record JSON wrappers, `limit`
//   (default 100) / `offset`, `X-Total-Count`, the `Link` header with first/prev/next/last, `sort`
//   and `orderBy`, `filter`, `fields`, and the imsx_StatusInfo error payload with the HTTP codes of
//   Table 2.4 (400 invalid_filter_field/invalid_selection_field, 401 unauthorisedrequest, 403
//   forbidden, 404 unknownobject, 429 server_busy, 500 internal_server_error).
// - The binding's security section: OAuth 2.0 client credentials with the scopes
//   `.../scope/roster-core.readonly`, `.../scope/roster.readonly` and
//   `.../scope/roster-demographics.readonly`.
// - RFC 6749 sections 2.3.1, 4.4 and 5 for the token endpoint: HTTP Basic or form-post client
//   authentication, `invalid_client` (401), `invalid_scope` and `unsupported_grant_type` (400).
// - ClassLink's Roster Server: the token endpoint is the server URL plus `/token` (per districts'
//   setup guides; ClassLink's own 1.2 path is not publicly documented, so it is configurable).
import { Fake, basicCredentials, bearer, decodeSegments, formOf, TokenIssuer } from "../fake.ts";
import type { FakeOptions } from "../fake.ts";
import { validateSeed } from "../seed.ts";
import type { DistrictSeed, HeadersSource } from "../types.ts";
import { QueryError, parseFilter, passes, selectFields, sortRecords } from "./query.ts";
import { COLLECTION_FIELDS, ONEROSTER_COLLECTIONS, ROSTERING_PATH, SINGULAR, malform, projectSeed } from "./records.ts";
import type { OneRosterCollection, OneRosterRecord } from "./records.ts";

/** Read access to the core rostering collections (everything but demographics). */
export const ROSTER_CORE_READONLY = "https://purl.imsglobal.org/spec/or/v1p2/scope/roster-core.readonly";
/** Read access to every rostering collection. */
export const ROSTER_READONLY = "https://purl.imsglobal.org/spec/or/v1p2/scope/roster.readonly";
/** Read access to demographics. */
export const ROSTER_DEMOGRAPHICS_READONLY = "https://purl.imsglobal.org/spec/or/v1p2/scope/roster-demographics.readonly";

/** An OAuth client the district registered, and the scopes it may be granted. */
export interface OneRosterClient {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Defaults to {@link ROSTER_CORE_READONLY}. */
  readonly scopes?: readonly string[];
}

/** Options of a {@link OneRosterFake}. */
export interface OneRosterFakeOptions extends FakeOptions {
  readonly seed: DistrictSeed;
  /** The server's base URL. Defaults to `https://<seed id>-vn-v2.rosterserver.example`. */
  readonly baseUrl?: string;
  /** The token endpoint's path. Defaults to `/token`, as ClassLink's Roster Server serves it. */
  readonly tokenPath?: string;
  /** The registered clients. Defaults to {@link DEFAULT_ONEROSTER_CLIENT}. */
  readonly clients?: readonly OneRosterClient[];
  /** Access token lifetime. Defaults to 3600 seconds. */
  readonly tokenLifetimeSeconds?: number;
  /** The largest page served, whatever `limit` asks. Defaults to 1000. */
  readonly maxPageSize?: number;
}

/** The client a fake registers when given none. Synthetic credentials. */
export const DEFAULT_ONEROSTER_CLIENT: OneRosterClient = {
  clientId: "educateos-oneroster-client",
  clientSecret: "SYNTHETIC-ONEROSTER-SECRET-0f3a",
  scopes: [ROSTER_CORE_READONLY],
};

interface Grant {
  readonly clientId: string;
  readonly scopes: readonly string[];
}

/** An endpoint: which stored collection it reads, the wrapper key, and which records it admits. */
interface View {
  readonly collection: OneRosterCollection;
  readonly key: string;
  readonly admits?: (record: OneRosterRecord) => boolean;
}

const hasRole = (role: string) => (r: OneRosterRecord) => ((r.roles as { role: string }[] | undefined) ?? []).some((x) => x.role === role);
const VIEWS: Readonly<Record<string, View>> = {
  orgs: { collection: "orgs", key: "orgs" },
  schools: { collection: "orgs", key: "orgs", admits: (r) => r.type === "school" },
  academicSessions: { collection: "academicSessions", key: "academicSessions" },
  terms: { collection: "academicSessions", key: "academicSessions", admits: (r) => r.type === "term" },
  gradingPeriods: { collection: "academicSessions", key: "academicSessions", admits: (r) => r.type === "gradingPeriod" },
  courses: { collection: "courses", key: "courses" },
  classes: { collection: "classes", key: "classes" },
  users: { collection: "users", key: "users" },
  students: { collection: "users", key: "users", admits: hasRole("student") },
  teachers: { collection: "users", key: "users", admits: hasRole("teacher") },
  enrollments: { collection: "enrollments", key: "enrollments" },
};

/** A status-info code minor value of the binding. */
export type OneRosterCodeMinor =
  | "fullsuccess" | "invalid_filter_field" | "invalid_selection_field" | "invalid_sort_field" | "forbidden" | "unauthorisedrequest"
  | "internal_server_error" | "server_busy" | "unknownobject" | "invaliddata" | "unsupported";

/** An imsx_StatusInfo error response. */
export function oneRosterStatusInfo(status: number, codeMinor: OneRosterCodeMinor, description: string, headers?: HeadersSource): Response {
  return Response.json({
    imsx_codeMajor: "failure",
    imsx_severity: "error",
    imsx_description: description,
    imsx_CodeMinor: { imsx_codeMinorField: [{ imsx_codeMinorFieldName: "TargetEndSystem", imsx_codeMinorFieldValue: codeMinor }] },
  }, { status, ...(headers === undefined ? {} : { headers }) });
}

const oauthError = (status: number, error: string, description: string, headers?: HeadersSource) =>
  Response.json({ error, error_description: description }, { status, headers: { "cache-control": "no-store", pragma: "no-cache", ...headers } });

const ASSOCIATIONS: Readonly<Record<string, Readonly<Record<string, (id: string) => (r: OneRosterRecord) => boolean>>>> = {
  classes: {
    // A `tobedeleted` enrollment no longer puts its user on the class roster.
    students: (id) => (r) => r.role === "student" && r.status === "active" && (r.class as { sourcedId: string }).sourcedId === id,
    teachers: (id) => (r) => r.role === "teacher" && r.status === "active" && (r.class as { sourcedId: string }).sourcedId === id,
  },
};

/**
 * A OneRoster 1.2 rostering server over a district seed. Records are the seed's, projected by
 * {@link projectSeed}; tests and demos change them with {@link upsert} and {@link remove}, which
 * stamp a fresh `dateLastModified` so a delta finds them.
 */
export class OneRosterFake extends Fake {
  /** The server's base URL. The rostering service is at {@link ROSTERING_PATH} below it. */
  readonly baseUrl: string;
  /** The token endpoint. */
  readonly tokenUrl: string;
  /** The token issuer, for revoking tokens or counting how many were issued. */
  readonly tokens: TokenIssuer<Grant>;
  readonly #clients: readonly OneRosterClient[];
  readonly #lifetime: number;
  readonly #maxPageSize: number;
  readonly #store: Record<OneRosterCollection, Map<string, OneRosterRecord>>;

  constructor(options: OneRosterFakeOptions) {
    super(options);
    const seed = validateSeed(options.seed);
    this.baseUrl = (options.baseUrl ?? `https://${seed.id}-vn-v2.rosterserver.example`).replace(/\/+$/, "");
    this.tokenUrl = `${this.baseUrl}${options.tokenPath ?? "/token"}`;
    this.tokens = new TokenIssuer<Grant>("or2_", this.now);
    this.#clients = options.clients ?? [DEFAULT_ONEROSTER_CLIENT];
    this.#lifetime = options.tokenLifetimeSeconds ?? 3600;
    this.#maxPageSize = options.maxPageSize ?? 1000;
    const projected = projectSeed(seed, this.baseUrl);
    this.#store = Object.fromEntries(ONEROSTER_COLLECTIONS.map((c) => [c, new Map(projected[c].map((r) => [r.sourcedId, r]))])) as Record<OneRosterCollection, Map<string, OneRosterRecord>>;
  }

  /** The URL of the rostering service. */
  get rosteringUrl(): string {
    return `${this.baseUrl}${ROSTERING_PATH}`;
  }

  /** Every record of a collection, tobedeleted ones included, in storage order. */
  records(collection: OneRosterCollection): OneRosterRecord[] {
    return [...this.#store[collection].values()].map((r) => structuredClone(r));
  }

  /** One record, for editing and passing back to {@link upsert}. Throws for an unknown one. */
  record(collection: OneRosterCollection, sourcedId: string): OneRosterRecord {
    const found = this.#store[collection].get(sourcedId);
    if (found === undefined) throw new RangeError(`no ${collection} record ${sourcedId}`);
    return structuredClone(found);
  }

  /**
   * Adds or replaces a record. Its `dateLastModified` becomes the clock's time unless `options.keepDate`
   * is set; its `status` defaults to `active`. Returns the stored record.
   */
  upsert(collection: OneRosterCollection, record: Partial<OneRosterRecord> & { sourcedId: string }, options: { keepDate?: boolean } = {}): OneRosterRecord {
    const stored = {
      ...record,
      status: record.status ?? "active",
      dateLastModified: options.keepDate === true && record.dateLastModified !== undefined ? record.dateLastModified : this.#stamp(),
    } as OneRosterRecord;
    this.#store[collection].set(record.sourcedId, stored);
    return structuredClone(stored);
  }

  /**
   * Marks a record `tobedeleted` with a fresh `dateLastModified`, as servers report deletions to a
   * delta. With `cascade` (the default for users and classes), the enrollments naming it go too.
   */
  remove(collection: OneRosterCollection, sourcedId: string, options: { cascade?: boolean } = {}): void {
    const at = this.#stamp();
    const mark = (c: OneRosterCollection, id: string) => {
      const found = this.#store[c].get(id);
      if (found !== undefined) this.#store[c].set(id, { ...found, status: "tobedeleted", dateLastModified: at });
    };
    if (!this.#store[collection].has(sourcedId)) throw new RangeError(`no ${collection} record ${sourcedId}`);
    mark(collection, sourcedId);
    if ((options.cascade ?? true) && (collection === "users" || collection === "classes")) {
      const field = collection === "users" ? "user" : "class";
      for (const e of this.#store.enrollments.values()) {
        if ((e[field] as { sourcedId: string }).sourcedId === sourcedId && e.status === "active") mark("enrollments", e.sourcedId);
      }
    }
  }

  /** Deletes a record outright, as a server that drops records rather than flagging them would. */
  purge(collection: OneRosterCollection, sourcedId: string): void {
    this.#store[collection].delete(sourcedId);
  }

  #stamp(): string {
    return new Date(this.now()).toISOString();
  }

  protected override removeLargeShare(fraction: number): void {
    if (!(fraction >= 0 && fraction <= 1)) throw new RangeError("a large-removal fraction is between 0 and 1");
    // As `studentsToRemove`: the first ceil(fraction × n) active students in ID order.
    const students = [...this.#store.users.values()]
      .filter((u) => u.status === "active" && hasRole("student")(u))
      .map((u) => u.sourcedId)
      .toSorted();
    for (const id of students.slice(0, Math.ceil(students.length * fraction))) this.remove("users", id);
  }

  protected override errorResponse(status: number, reason: "outage" | "rate-limit"): Response {
    return reason === "rate-limit"
      ? oneRosterStatusInfo(429, "server_busy", "Too many requests. Retry at a later time.")
      : oneRosterStatusInfo(status, "internal_server_error", "The service is temporarily unavailable.");
  }

  protected override async serve(request: Request, body: string): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== new URL(this.baseUrl).origin) return new Response("Not Found", { status: 404 });
    if (url.pathname === new URL(this.tokenUrl).pathname) return this.#token(request, body);
    const root = new URL(this.rosteringUrl).pathname;
    if (!url.pathname.startsWith(`${root}/`)) return oneRosterStatusInfo(404, "unknownobject", "Unknown Object");
    if (request.method !== "GET") return oneRosterStatusInfo(405, "unsupported", `${request.method} is not supported by the rostering service`, { allow: "GET" });

    const grant = this.tokens.lookup(bearer(request));
    if (grant === undefined) {
      return oneRosterStatusInfo(401, "unauthorisedrequest", "The request was not correctly authorised.", { "www-authenticate": 'Bearer error="invalid_token"' });
    }
    const parts = decodeSegments(url.pathname.slice(root.length + 1));
    if (parts === undefined) return oneRosterStatusInfo(404, "unknownobject", "Unknown Object");
    const view = VIEWS[parts[0]!];
    if (view === undefined) {
      // The seed holds no demographics: the collection is served empty, behind its own scope.
      if (parts[0] !== "demographics") return oneRosterStatusInfo(404, "unknownobject", "Unknown Object");
      return this.#forbidUnless(grant, [ROSTER_DEMOGRAPHICS_READONLY, ROSTER_READONLY]) ??
        (parts.length === 1 ? Response.json({ demographics: [] }, { headers: { "x-total-count": "0" } }) : oneRosterStatusInfo(404, "unknownobject", "Unknown Object"));
    }
    const forbidden = this.#forbidUnless(grant, [ROSTER_CORE_READONLY, ROSTER_READONLY]);
    if (forbidden !== undefined) return forbidden;

    try {
      if (parts.length === 1) return this.#list(request, url, view);
      if (parts.length === 2) return this.#single(url, view, parts[1]!);
      const association = parts.length === 3 ? ASSOCIATIONS[parts[0]!]?.[parts[2]!] : undefined;
      if (association !== undefined) {
        if (!this.#store[view.collection].has(parts[1]!)) return oneRosterStatusInfo(404, "unknownobject", "Unknown Object");
        const userIds = new Set([...this.#store.enrollments.values()].filter(association(parts[1]!)).map((e) => (e.user as { sourcedId: string }).sourcedId));
        return this.#list(request, url, { collection: "users", key: "users", admits: (u) => userIds.has(u.sourcedId) });
      }
      return oneRosterStatusInfo(404, "unknownobject", "Unknown Object");
    } catch (error) {
      if (error instanceof QueryError) return oneRosterStatusInfo(400, error.codeMinor, error.message);
      throw error;
    }
  }

  #forbidUnless(grant: Grant, scopes: readonly string[]): Response | undefined {
    return grant.scopes.some((s) => scopes.includes(s)) ? undefined : oneRosterStatusInfo(403, "forbidden", "The access token's scopes do not grant this request.");
  }

  #single(url: URL, view: View, sourcedId: string): Response {
    const found = this.#store[view.collection].get(sourcedId);
    if (found === undefined || (view.admits !== undefined && !view.admits(found))) return oneRosterStatusInfo(404, "unknownobject", "Unknown Object");
    const select = selectFields(url.searchParams.getAll("fields"), COLLECTION_FIELDS[view.collection]);
    return Response.json({ [SINGULAR[view.collection]]: select === undefined ? found : select(found) });
  }

  #list(request: Request, url: URL, view: View): Response {
    const fields = COLLECTION_FIELDS[view.collection];
    const params = url.searchParams;
    const limitText = params.get("limit") ?? "100";
    const offsetText = params.get("offset") ?? "0";
    if (!/^\d+$/.test(limitText) || Number(limitText) < 1) throw new QueryError("invaliddata", "limit is a positive integer");
    if (!/^\d+$/.test(offsetText)) throw new QueryError("invaliddata", "offset is a non-negative integer");
    const orderBy = params.get("orderBy") ?? "asc";
    if (orderBy !== "asc" && orderBy !== "desc") throw new QueryError("invaliddata", "orderBy is asc or desc");
    const filterText = params.get("filter");
    const filter = filterText === null ? undefined : parseFilter(filterText, fields);
    const select = selectFields(params.getAll("fields"), fields);

    let records = [...this.#store[view.collection].values()].filter((r) => view.admits?.(r) ?? true);
    if (filter !== undefined) records = records.filter((r) => passes(r, filter));
    const sort = params.get("sort");
    if (sort !== null) records = sortRecords(records, sort, orderBy, fields);

    const total = records.length;
    const limit = Math.min(Number(limitText), this.#maxPageSize);
    const offset = Number(offsetText);
    let page: Record<string, unknown>[] = records.slice(offset, offset + limit);
    if (page.length > 0 && this.takeMalformed(request)) page = [malform(view.collection, page[0] as OneRosterRecord), ...page.slice(1)];
    if (select !== undefined) page = page.map(select);

    const headers = new Headers({ "x-total-count": String(total) });
    const link = (rel: string, at: number, size = limit) => {
      const target = new URL(url);
      target.searchParams.set("limit", String(size));
      target.searchParams.set("offset", String(at));
      return `<${target.href}>; rel="${rel}"`;
    };
    const links = [link("first", 0)];
    if (offset > 0) links.push(link("prev", Math.max(0, offset - limit)));
    if (offset + limit < total) links.push(link("next", offset + limit));
    if (total > offset) {
      const last = offset + Math.floor((total - 1 - offset) / limit) * limit;
      links.push(link("last", last, total - last));
    }
    headers.set("link", links.join(", "));
    return Response.json({ [view.key]: page }, { headers });
  }

  #token(request: Request, body: string): Response {
    if (request.method !== "POST") return oauthError(405, "invalid_request", "the token endpoint takes POST", { allow: "POST" });
    if (!/^application\/x-www-form-urlencoded\b/i.test(request.headers.get("content-type") ?? "")) {
      return oauthError(400, "invalid_request", "the token request is form-encoded");
    }
    const form = formOf(body);
    const basic = basicCredentials(request);
    const posted = form.get("client_id") === null ? undefined : { clientId: form.get("client_id")!, clientSecret: form.get("client_secret") ?? "" };
    // RFC 6749 section 2.3: a client uses one authentication method per request.
    if (basic !== undefined && posted !== undefined) return oauthError(400, "invalid_request", "use one client authentication method");
    const given = basic ?? posted;
    const client = this.#clients.find((c) => c.clientId === given?.clientId && c.clientSecret === given.clientSecret);
    if (client === undefined) {
      return oauthError(401, "invalid_client", "client authentication failed", basic === undefined ? undefined : { "www-authenticate": 'Basic realm="oneroster"' });
    }
    if (form.get("grant_type") !== "client_credentials") return oauthError(400, "unsupported_grant_type", "only client_credentials is supported");
    const allowed = client.scopes ?? [ROSTER_CORE_READONLY];
    const asked = (form.get("scope") ?? "").split(" ").filter((s) => s !== "");
    const refused = asked.filter((s) => !allowed.includes(s));
    if (refused.length > 0) return oauthError(400, "invalid_scope", `the client may not be granted ${refused.join(" ")}`);
    const scopes = asked.length === 0 ? allowed : asked;
    const token = this.tokens.issue({ clientId: client.clientId, scopes }, this.#lifetime);
    return Response.json(
      { access_token: token, token_type: "bearer", expires_in: this.#lifetime, scope: scopes.join(" ") },
      { headers: { "cache-control": "no-store", pragma: "no-cache" } },
    );
  }
}
