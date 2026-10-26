// Contract tests of the OneRoster 1.2 rostering fake against the 1EdTech REST/JSON binding: the
// token endpoint, bearer and scope checks, paging to the last page, filter/sort/fields, the
// single-record and status-info shapes, delta stamps, and each fault kind.
import { describe, expect, it } from "vitest";
import { DEFAULT_ONEROSTER_CLIENT, OneRosterFake, ROSTER_CORE_READONLY, ROSTER_DEMOGRAPHICS_READONLY } from "../src/oneroster/index.ts";
import { SAMPLE_DISTRICT } from "../src/sample.ts";

const START = Date.parse("2026-10-20T15:00:00.000Z");

function setup(options: Partial<ConstructorParameters<typeof OneRosterFake>[0]> = {}) {
  const clock = { ms: START };
  const fake = new OneRosterFake({ seed: SAMPLE_DISTRICT, now: () => clock.ms, ...options });
  const basic = `Basic ${btoa(`${DEFAULT_ONEROSTER_CLIENT.clientId}:${DEFAULT_ONEROSTER_CLIENT.clientSecret}`)}`;
  const tokenRequest = (body: Record<string, string>, headers: Record<string, string> = { authorization: basic }) =>
    fake.fetch(fake.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(body).toString(),
    });
  const token = async (scope = ROSTER_CORE_READONLY) => {
    const response = await tokenRequest({ grant_type: "client_credentials", scope });
    expect(response.status).toBe(200);
    return ((await response.json()) as { access_token: string }).access_token;
  };
  const get = async (path: string, accessToken?: string) =>
    fake.fetch(`${fake.rosteringUrl}/${path}`, { headers: { authorization: `Bearer ${accessToken ?? (await token())}` } });
  const json = async (path: string, accessToken?: string) => {
    const response = await get(path, accessToken);
    return { response, body: (await response.json()) as Record<string, Record<string, unknown>[]> };
  };
  return { fake, clock, basic, tokenRequest, token, get, json };
}

const ids = (records: Record<string, unknown>[] | undefined) => (records ?? []).map((r) => r.sourcedId);

describe("the token endpoint", () => {
  it("issues a bearer token to a client authenticating with HTTP Basic", async () => {
    const { tokenRequest } = setup();
    const response = await tokenRequest({ grant_type: "client_credentials", scope: ROSTER_CORE_READONLY });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ token_type: "bearer", expires_in: 3600, scope: ROSTER_CORE_READONLY });
  });

  it("accepts client credentials posted in the form", async () => {
    const { tokenRequest } = setup();
    const response = await tokenRequest(
      { grant_type: "client_credentials", client_id: DEFAULT_ONEROSTER_CLIENT.clientId, client_secret: DEFAULT_ONEROSTER_CLIENT.clientSecret },
      {},
    );
    expect(response.status).toBe(200);
  });

  it("refuses a bad client with 401 invalid_client", async () => {
    const { tokenRequest } = setup();
    const response = await tokenRequest({ grant_type: "client_credentials" }, { authorization: `Basic ${btoa("educateos-oneroster-client:wrong")}` });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Basic/);
    expect(await response.json()).toMatchObject({ error: "invalid_client" });
  });

  it("refuses a scope the client may not have with 400 invalid_scope", async () => {
    const { tokenRequest } = setup();
    const response = await tokenRequest({ grant_type: "client_credentials", scope: ROSTER_DEMOGRAPHICS_READONLY });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_scope" });
  });

  it("refuses another grant type", async () => {
    const { tokenRequest } = setup();
    expect(await (await tokenRequest({ grant_type: "password" })).json()).toMatchObject({ error: "unsupported_grant_type" });
  });

  it("expires tokens on the injected clock", async () => {
    const { token, get, clock } = setup({ tokenLifetimeSeconds: 60 });
    const t = await token();
    expect((await get("orgs", t)).status).toBe(200);
    clock.ms += 61_000;
    const expired = await get("orgs", t);
    expect(expired.status).toBe(401);
    expect(await expired.json()).toMatchObject({
      imsx_codeMajor: "failure",
      imsx_severity: "error",
      imsx_CodeMinor: { imsx_codeMinorField: [{ imsx_codeMinorFieldValue: "unauthorisedrequest" }] },
    });
  });
});

describe("authorization", () => {
  it("refuses a request without a valid bearer token", async () => {
    const { get } = setup();
    expect((await get("users", "nope")).status).toBe(401);
  });

  it("refuses demographics to a roster-core token with 403 forbidden", async () => {
    const { get, fake } = setup({ clients: [{ ...DEFAULT_ONEROSTER_CLIENT, scopes: [ROSTER_CORE_READONLY, ROSTER_DEMOGRAPHICS_READONLY] }] });
    const response = await get("demographics");
    expect(response.status).toBe(403);
    expect(fake.requestsTo("/demographics")).toHaveLength(1);
  });

  it("refuses the core collections to a demographics-only token", async () => {
    const { get, token } = setup({ clients: [{ ...DEFAULT_ONEROSTER_CLIENT, scopes: [ROSTER_DEMOGRAPHICS_READONLY] }] });
    const t = await token(ROSTER_DEMOGRAPHICS_READONLY);
    expect((await get("users", t)).status).toBe(403);
    expect((await get("demographics", t)).status).toBe(200);
  });
});

describe("collections", () => {
  it("serves the seed as 1.2 records", async () => {
    const { json } = setup();
    const { body } = await json("users/mw-s-01");
    expect(body.user).toEqual({
      sourcedId: "mw-s-01",
      status: "active",
      dateLastModified: "2026-10-01T12:00:00.000Z",
      username: "ada.brightwater",
      userIds: [{ type: "LocalId", identifier: "S1001" }],
      enabledUser: true,
      givenName: "Ada",
      familyName: "Brightwater",
      roles: [{ roleType: "primary", role: "student", org: expect.objectContaining({ sourcedId: "mw-hs", type: "org" }) }],
      primaryOrg: expect.objectContaining({ sourcedId: "mw-hs" }),
      identifier: "S1001",
      email: "ada.brightwater@maplewood.example",
      agents: [expect.objectContaining({ sourcedId: "mw-g-brightwater", type: "user" })],
      grades: ["09"],
    });
    const org = ((body.user as unknown as { primaryOrg: { href: string } }).primaryOrg).href;
    expect(org).toBe("https://maplewood-vn-v2.rosterserver.example/ims/oneroster/rostering/v1p2/orgs/mw-hs");
  });

  it("serves classes with course, school and terms references", async () => {
    const { json } = setup();
    const { body } = await json("classes/mw-eng9-p1");
    expect(body.class).toMatchObject({ title: "English 9, period 1", classType: "scheduled", classCode: "ENG-109-1", periods: ["1"], location: "R101" });
    expect((await json("enrollments/mw-eng9-p1:mw-t-quill")).body.enrollment).toMatchObject({ role: "teacher", primary: true });
    expect((await json("enrollments/mw-eng9-p1:mw-t-reyes")).body.enrollment).toMatchObject({ role: "teacher", primary: false });
  });

  it("answers an unknown record with 404 and Unknown Object", async () => {
    const { get } = setup();
    const response = await get("users/nobody");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      imsx_codeMajor: "failure",
      imsx_severity: "error",
      imsx_description: "Unknown Object",
      imsx_CodeMinor: { imsx_codeMinorField: [{ imsx_codeMinorFieldName: "TargetEndSystem", imsx_codeMinorFieldValue: "unknownobject" }] },
    });
  });

  it("serves the schools, terms, students and teachers views", async () => {
    const { json } = setup();
    expect(ids((await json("schools")).body.orgs)).toEqual(["mw-hs", "mw-ms"]);
    expect(ids((await json("orgs")).body.orgs)).toEqual(["maplewood", "mw-hs", "mw-ms"]);
    expect((await json("terms")).body.academicSessions).toEqual([]);
    expect((await json("students")).body.users).toHaveLength(10);
    expect(ids((await json("teachers")).body.users)).toEqual(["mw-t-okafor", "mw-t-quill", "mw-t-reyes"]);
    expect(ids((await json("classes/mw-eng9-p1/teachers")).body.users)).toEqual(["mw-t-quill", "mw-t-reyes"]);
    expect((await json("classes/mw-eng9-p1/students")).body.users).toHaveLength(5);
    expect((await (await setup().get("students/mw-t-quill")).status)).toBe(404);
  });
});

describe("class rosters", () => {
  it("drop a user whose enrollment is tobedeleted, and a malformed path is a 404", async () => {
    const { fake, json, get } = setup();
    expect(ids((await json("classes/mw-bio-p2/students")).body.users)).toContain("mw-s-01");
    fake.remove("users", "mw-s-01");
    expect(ids((await json("classes/mw-bio-p2/students")).body.users)).not.toContain("mw-s-01");
    expect((await get("users/%E0")).status).toBe(404);
  });
});

describe("paging", () => {
  it("defaults to 100 a page and pages to the last page by Link next", async () => {
    const { json, token } = setup();
    const t = await token();
    const first = await json("enrollments", t);
    expect(first.body.enrollments).toHaveLength(25);
    expect(first.response.headers.get("x-total-count")).toBe("25");

    const seen: unknown[] = [];
    let path: string | undefined = "enrollments?limit=10&offset=0&sort=sourcedId&orderBy=asc";
    const pages: string[] = [];
    while (path !== undefined) {
      const { response, body } = await json(path, t);
      seen.push(...ids(body.enrollments));
      pages.push(response.headers.get("link")!);
      const next = /<([^>]+)>; rel="next"/.exec(response.headers.get("link")!)?.[1];
      path = next === undefined ? undefined : next.slice(next.indexOf("/enrollments") + 1);
    }
    expect(seen).toEqual(ids(first.body.enrollments).toSorted());
    expect(pages).toHaveLength(3);
    expect(pages[1]).toContain('limit=10&offset=0&sort=sourcedId&orderBy=asc>; rel="first"');
    expect(pages[1]).toContain('offset=0&sort=sourcedId&orderBy=asc>; rel="prev"');
    expect(pages[1]).toContain('limit=5&offset=20&sort=sourcedId&orderBy=asc>; rel="last"');
    expect(pages[2]).not.toContain('rel="next"');
  });

  it("caps a page at the server's maximum", async () => {
    const { json } = setup({ maxPageSize: 7 });
    expect((await json("users?limit=500")).body.users).toHaveLength(7);
  });

  it("refuses a malformed limit", async () => {
    expect((await setup().get("users?limit=0")).status).toBe(400);
  });
});

describe("filter, sort and fields", () => {
  it("filters with each operator, case-insensitively", async () => {
    const { json, token } = setup();
    const t = await token();
    const users = async (filter: string) => ids((await json(`users?filter=${encodeURIComponent(filter)}`, t)).body.users);
    expect(await users("familyName='BRIGHTWATER'")).toEqual(["mw-s-01", "mw-g-brightwater"]);
    expect(await users("givenName~'ad'")).toEqual(["mw-s-01"]);
    expect(await users("grades='10' AND familyName<'h'")).toEqual(["mw-s-06"]);
    expect(await users("roles.role='guardian' OR roles.role='parent'")).toEqual(["mw-g-brightwater", "mw-g-garrow"]);
    expect((await users("status!='active'"))).toEqual([]);
    expect((await users("identifier>='T202'"))).toEqual(["mw-t-quill", "mw-t-reyes"]);
    expect((await users("identifier<='E301'"))).toEqual(["mw-staff-lund", "mw-admin-varga"]);
    expect(ids((await json(`classes?filter=${encodeURIComponent("terms.sourcedId='mw-fall'")}`, t)).body.classes)).toHaveLength(4);
  });

  it("refuses a filter on a field the collection lacks", async () => {
    const response = await setup().get(`users?filter=${encodeURIComponent("nickname='x'")}`);
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain("invalid_filter_field");
  });

  it("sorts ascending and descending", async () => {
    const { json, token } = setup();
    const t = await token();
    expect(ids((await json("orgs?sort=name&orderBy=desc", t)).body.orgs)).toEqual(["maplewood", "mw-ms", "mw-hs"]);
    expect(ids((await json("courses?sort=courseCode", t)).body.courses)).toEqual(["mw-eng9", "mw-alg", "mw-bio"]);
    expect((await setup().get("orgs?sort=colour")).status).toBe(400);
  });

  it("selects fields, and returns everything for a field it does not have", async () => {
    const { json, token } = setup();
    const t = await token();
    expect((await json("courses?fields=sourcedId,title", t)).body.courses![0]).toEqual({ sourcedId: "mw-bio", title: "Biology" });
    expect(Object.keys((await json("courses?fields=sourcedId,colour", t)).body.courses![0]!)).toContain("org");
    expect((await setup().get("courses?fields=sourcedId,,title")).status).toBe(400);
  });
});

describe("delta", () => {
  it("stamps changed and removed records with the clock, so dateLastModified>= finds only them", async () => {
    const { fake, clock, json } = setup();
    clock.ms = Date.parse("2026-10-21T08:00:00.000Z");
    fake.upsert("users", { ...fake.record("users", "mw-s-02"), givenName: "Bonnie" });
    fake.remove("users", "mw-s-03");
    const filter = encodeURIComponent("dateLastModified>='2026-10-21T00:00:00.000Z'");
    const users = (await json(`users?filter=${filter}`)).body.users!;
    expect(users.map((u) => [u.sourcedId, u.status, u.dateLastModified])).toEqual([
      ["mw-s-02", "active", "2026-10-21T08:00:00.000Z"],
      ["mw-s-03", "tobedeleted", "2026-10-21T08:00:00.000Z"],
    ]);
    // The removed student's enrollments go with them.
    expect(ids((await json(`enrollments?filter=${filter}`)).body.enrollments)).toEqual(["mw-bio-p2:mw-s-03", "mw-eng9-p1:mw-s-03"]);
  });
});

describe("faults", () => {
  it("serves an outage as a 5xx status-info body", async () => {
    const { fake, get, token } = setup();
    const t = await token();
    fake.inject({ kind: "outage", status: 502, times: 1, match: { path: "/users" } });
    const response = await get("users", t);
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).toContain("internal_server_error");
    expect((await get("users", t)).status).toBe(200);
  });

  it("rate-limits with Retry-After and server_busy", async () => {
    const { fake, get, token } = setup();
    const t = await token();
    fake.inject({ kind: "rate-limit", retryAfterSeconds: 7, times: 1 });
    const response = await get("orgs", t);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("7");
    expect(JSON.stringify(await response.json())).toContain("server_busy");
  });

  it("fails the connection on a network error", async () => {
    const { fake, get, token } = setup();
    const t = await token();
    fake.inject({ kind: "network-error", times: 1 });
    await expect(get("orgs", t)).rejects.toBeInstanceOf(TypeError);
  });

  it("breaks one record of the next list page, each collection its own way", async () => {
    const { fake, json, token } = setup();
    const t = await token();
    fake.inject({ kind: "malformed-record", times: 6 });
    expect((await json("orgs", t)).body.orgs![0]!.type).toBe("District");
    expect((await json("academicSessions", t)).body.academicSessions![0]!.startDate).toBe("08/17/2026");
    expect((await json("courses", t)).body.courses![0]).not.toHaveProperty("org");
    expect((await json("classes", t)).body.classes![0]).not.toHaveProperty("terms");
    const user = (await json("users", t)).body.users![0]!;
    expect(user).not.toHaveProperty("roles");
    expect(user).toMatchObject({ role: "student", orgs: [expect.objectContaining({ sourcedId: "mw-hs" })] });
    const [broken, intact] = (await json("enrollments", t)).body.enrollments!;
    expect(broken).not.toHaveProperty("user");
    expect(intact).toHaveProperty("user");
    // Used up: the store itself was never changed.
    expect((await json("users", t)).body.users![0]).toHaveProperty("roles");
  });

  it("marks a large share of students and their enrollments tobedeleted", async () => {
    const { fake, clock } = setup();
    clock.ms = Date.parse("2026-10-22T00:00:00.000Z");
    fake.inject({ kind: "large-removal", fraction: 0.5 });
    const removed = fake.records("users").filter((u) => u.status === "tobedeleted");
    expect(removed.map((u) => u.sourcedId)).toEqual(["mw-s-01", "mw-s-02", "mw-s-03", "mw-s-04", "mw-s-05"]);
    expect(removed.every((u) => u.dateLastModified === "2026-10-22T00:00:00.000Z")).toBe(true);
    const enrollments = fake.records("enrollments").filter((e) => e.status === "tobedeleted");
    expect(enrollments).toHaveLength(10);
  });
});
