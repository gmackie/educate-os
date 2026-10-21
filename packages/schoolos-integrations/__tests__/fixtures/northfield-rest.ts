// The synthetic Northfield district as OneRoster 1.2 REST JSON, and a fake rostering server that
// serves it. The records are converted from the CSV export in `northfield-export.ts`, so the CSV and
// REST sources describe exactly the same district. Every domain is a reserved `.example` one.
import { parseCsv } from "../../src/oneroster/csv.ts";
import type { oneroster } from "../../src/index.ts";
import { PASSWORD_SENTINEL, buildExport } from "./northfield-export.ts";
import type { Variant } from "./northfield-export.ts";

/** The server's origin. */
export const ORIGIN = "https://sis.northfield.example";
/** Its token endpoint. */
export const TOKEN_URL = `${ORIGIN}/oauth/token`;
/** The `dateLastModified` of every record as first served. */
export const MODIFIED = "2026-10-01T12:00:00.000Z";
/** The OAuth client. */
export const CREDENTIALS = { clientId: "schoolos-northfield", clientSecret: "SENTINEL-CLIENT-SECRET-5d1e" };

type Json = Record<string, unknown>;
/** Records by collection. */
export type Collections = Record<oneroster.RosterCollection | "demographics", Json[]>;

function rowsOf(text: string): Record<string, string>[] {
  const parsed = parseCsv(text, { maxRows: 1000 });
  if (!parsed.ok) throw new Error(parsed.error.message);
  const [header, ...records] = parsed.records;
  return records.map((r) => Object.fromEntries(header!.fields.map((name, i) => [name, r.fields[i]!])));
}

const TYPE_PATH: Record<string, string> = { org: "orgs", academicSession: "academicSessions", course: "courses", class: "classes", user: "users" };
const ref = (type: string, sourcedId: string) => ({
  href: `${ORIGIN}/ims/oneroster/rostering/v1p2/${TYPE_PATH[type]}/${sourcedId}`,
  sourcedId,
  type,
});
const list = (value: string) => (value === "" ? [] : value.split(","));
const optional = (key: string, value: string) => (value === "" ? {} : { [key]: value });
const base = (r: Record<string, string>) => ({ sourcedId: r.sourcedId!, status: r.status || "active", dateLastModified: MODIFIED });

/** One variant of the district as REST collections, plus a demographics record that must never be read. */
export function northfieldRest(variant: Variant = "northfield"): Collections {
  const files = buildExport(variant);
  const roles = rowsOf(files["roles.csv"]!);
  return {
    orgs: rowsOf(files["orgs.csv"]!).map((r) => ({
      ...base(r),
      name: r.name,
      type: r.type,
      identifier: r.identifier,
      ...(r.parentSourcedId ? { parent: ref("org", r.parentSourcedId) } : {}),
    })),
    academicSessions: rowsOf(files["academicSessions.csv"]!).map((r) => ({
      ...base(r),
      title: r.title,
      startDate: r.startDate,
      endDate: r.endDate,
      type: r.type,
      schoolYear: r.schoolYear,
      ...(r.parentSourcedId ? { parent: ref("academicSession", r.parentSourcedId) } : {}),
    })),
    courses: rowsOf(files["courses.csv"]!).map((r) => ({
      ...base(r),
      title: r.title,
      courseCode: r.courseCode,
      grades: list(r.grades!),
      subjects: list(r.subjects!),
      subjectCodes: list(r.subjectCodes!),
      org: ref("org", r.orgSourcedId!),
    })),
    classes: rowsOf(files["classes.csv"]!).map((r) => ({
      ...base(r),
      title: r.title,
      classCode: r.classCode,
      classType: r.classType,
      location: r.location,
      grades: list(r.grades!),
      subjects: list(r.subjects!),
      subjectCodes: list(r.subjectCodes!),
      periods: list(r.periods!),
      course: ref("course", r.courseSourcedId!),
      school: ref("org", r.schoolSourcedId!),
      terms: list(r.termSourcedIds!).map((t) => ref("academicSession", t)),
    })),
    users: rowsOf(files["users.csv"]!).map((r) => ({
      ...base(r),
      username: r.username,
      userIds: [...r.userIds!.matchAll(/\{([^:]+):([^}]*)\}/g)].map(([, type, identifier]) => ({ type, identifier })),
      enabledUser: true,
      givenName: r.givenName,
      familyName: r.familyName,
      identifier: r.identifier,
      ...optional("email", r.email!),
      grades: list(r.grades!),
      password: PASSWORD_SENTINEL,
      phone: "+1-555-0100",
      roles: roles.filter((role) => role.userSourcedId === r.sourcedId).map((role) => ({
        roleType: role.roleType,
        role: role.role,
        org: ref("org", role.orgSourcedId!),
      })),
      primaryOrg: ref("org", r.primaryOrgSourcedId!),
      ...(r.agentSourcedIds ? { agents: list(r.agentSourcedIds).map((a) => ref("user", a)) } : {}),
    })),
    enrollments: rowsOf(files["enrollments.csv"]!).map((r) => ({
      ...base(r),
      user: ref("user", r.userSourcedId!),
      class: ref("class", r.classSourcedId!),
      school: ref("org", r.schoolSourcedId!),
      role: r.role,
      ...(r.primary ? { primary: r.primary === "true" } : {}),
    })),
    demographics: [{ sourcedId: "u-amara", status: "active", dateLastModified: MODIFIED, birthDate: "2011-04-02" }],
  };
}

/** A request the fake server received. */
export interface Received {
  method: string;
  url: URL;
  authorization: string | null;
  body?: string;
}

/** Overrides the server's answer to one request; returning undefined lets the server answer. */
export type Fault = (request: Received) => Response | undefined;

/**
 * A OneRoster 1.2 rostering server as a fetch handler: client-credentials tokens, `limit`/`offset`
 * paging sorted by `sourcedId`, `X-Total-Count` and `Link` headers, and the `dateLastModified>=`
 * filter. Tests reach in to change records, expire tokens and inject faults.
 */
export class FakeOneRosterServer {
  collections: Collections;
  /** Every request, in order. */
  readonly received: Received[] = [];
  /** One-shot faults, tried in order before the server answers. */
  readonly faults: Fault[] = [];
  /** Faults that apply to every request. */
  readonly persistentFaults: Fault[] = [];
  /** The largest page the server returns, whatever the client asks for. */
  maxPageSize = 1000;
  /** Whether pages carry `Link` and `X-Total-Count` headers. */
  headers = { link: true, total: true };
  tokenLifetimeSeconds = 3600;
  tokensIssued = 0;
  readonly #valid = new Set<string>();

  constructor(collections: Collections = northfieldRest()) {
    this.collections = collections;
  }

  /** Invalidates every token issued so far, as a server-side revocation would. */
  revokeTokens(): void {
    this.#valid.clear();
  }

  /** Replaces a record, or adds it, with a new `dateLastModified`. */
  upsert(collection: oneroster.RosterCollection, record: Json): void {
    const records = this.collections[collection];
    const index = records.findIndex((r) => r.sourcedId === record.sourcedId);
    if (index === -1) records.push(record);
    else records[index] = record;
  }

  /** A record, for editing. */
  record(collection: oneroster.RosterCollection, sourcedId: string): Json {
    const found = this.collections[collection].find((r) => r.sourcedId === sourcedId);
    if (found === undefined) throw new Error(`no ${collection} ${sourcedId}`);
    return found;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    const request: Received = {
      method: init?.method ?? "GET",
      url,
      authorization: headers.get("authorization"),
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    };
    this.received.push(request);
    for (const fault of this.persistentFaults) {
      const response = fault(request);
      if (response !== undefined) return response;
    }
    for (const [index, fault] of this.faults.entries()) {
      const response = fault(request);
      if (response !== undefined) {
        this.faults.splice(index, 1);
        return response;
      }
    }
    if (url.origin !== ORIGIN) throw new TypeError("fetch failed");
    if (url.href === TOKEN_URL) return this.#token(request);
    return this.#list(request);
  };

  #token(request: Received): Response {
    const expected = `Basic ${btoa(`${CREDENTIALS.clientId}:${CREDENTIALS.clientSecret}`)}`;
    const form = new URLSearchParams(request.body);
    if (request.method !== "POST" || request.authorization !== expected || form.get("grant_type") !== "client_credentials") {
      return Response.json({ error: "invalid_client" }, { status: 401 });
    }
    const token = `token-${++this.tokensIssued}`;
    this.#valid.add(token);
    return Response.json({ access_token: token, token_type: "Bearer", expires_in: this.tokenLifetimeSeconds, scope: form.get("scope") });
  }

  #list(request: Received): Response {
    const { url } = request;
    const token = request.authorization?.replace(/^Bearer /, "");
    if (token === undefined || !this.#valid.has(token)) return Response.json({ imsx_codeMajor: "failure" }, { status: 401 });
    const match = /^\/ims\/oneroster\/rostering\/v1p2\/(\w+)$/.exec(url.pathname);
    const collection = match?.[1] as keyof Collections | undefined;
    if (collection === undefined || !Object.hasOwn(this.collections, collection)) return new Response(null, { status: 404 });

    let records = this.collections[collection].toSorted((a, b) => String(a.sourcedId) < String(b.sourcedId) ? -1 : 1);
    const filter = url.searchParams.get("filter");
    if (filter !== null) {
      const since = /^dateLastModified>='([^']+)'$/.exec(filter);
      if (since === null) return new Response(null, { status: 400 });
      records = records.filter((r) => Date.parse(String(r.dateLastModified)) >= Date.parse(since[1]!));
    }
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), this.maxPageSize);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const page = records.slice(offset, offset + limit);
    const headers = new Headers();
    if (this.headers.total) headers.set("x-total-count", String(records.length));
    if (this.headers.link && offset + limit < records.length) {
      const next = new URL(url);
      next.searchParams.set("offset", String(offset + limit));
      headers.set("link", `<${next.pathname}${next.search}>; rel="next"`);
    }
    return Response.json({ [collection]: page }, { headers });
  }
}
