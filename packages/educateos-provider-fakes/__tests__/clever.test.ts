import { describe, expect, it } from "vitest";
import { SAMPLE_DISTRICT } from "../src/index.ts";
import { CLEVER_RATE_LIMIT_PER_MINUTE, CleverDataFake, cleverUserId, type CleverEvent } from "../src/clever/index.ts";

const API = "https://api.clever.com/v3.1";

interface Item {
  data: Record<string, unknown> & { id: string };
  uri: string;
}
interface Page {
  data: Item[];
  links: { rel: string; uri: string }[];
}

function setup(options: Partial<ConstructorParameters<typeof CleverDataFake>[0]> = {}) {
  let clock = Date.parse("2026-10-20T12:00:00Z");
  const fake = new CleverDataFake({ seed: SAMPLE_DISTRICT, now: () => clock, ...options });
  const get = (path: string, token: string | null = fake.districtToken) =>
    fake.fetch(path.startsWith("http") ? path : `https://api.clever.com${path.startsWith("/v3") ? "" : "/v3.1"}${path}`, {
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    });
  const page = async (path: string) => {
    const response = await get(path);
    expect(response.status).toBe(200);
    return (await response.json()) as Page;
  };
  /** Follows `next` links from `path` to the last page. */
  const all = async (path: string) => {
    const items: Item[] = [];
    let next: string | undefined = path;
    let pages = 0;
    while (next !== undefined) {
      const body = await page(next);
      pages += 1;
      items.push(...body.data);
      next = body.links.find((l) => l.rel === "next")?.uri;
    }
    return { items, pages };
  };
  return { fake, get, page, all, tick: (ms: number) => (clock += ms) };
}

describe("Clever Data API v3.1 fake: records", () => {
  it("serves v3.1 list shapes, wrapping each record with its uri", async () => {
    const { fake, page } = setup();
    const body = await page("/schools");
    expect(body.data).toHaveLength(2);
    expect(body.data[0]!.uri).toBe(`/v3.1/schools/${body.data[0]!.data.id}`);
    expect(body.data[0]!.data).toMatchObject({ district: fake.districtId, sis_id: expect.any(String), school_number: expect.any(String) });
    expect(body.links[0]).toEqual({ rel: "self", uri: "/v3.1/schools" });
    const hs = body.data.find((s) => s.data["sis_id"] === "mw-hs")!.data;
    expect(hs).toMatchObject({ name: "Maplewood High School", school_number: "301", low_grade: "9", high_grade: "12" });
    expect(hs["id"]).toMatch(/^[0-9a-f]{24}$/);
  });

  it("projects users with the v3 roles object, and filters by role", async () => {
    const { fake, all, get } = setup({ extraRoles: { "mw-t-reyes": ["staff"] } });
    const students = (await all("/users?role=student")).items;
    expect(students).toHaveLength(10);
    const ada = students.find((u) => u.data.id === fake.userId("mw-s-01"))!.data;
    expect(ada).toMatchObject({
      district: fake.districtId,
      email: "ada.brightwater@maplewood.example",
      name: { first: "Ada", last: "Brightwater", middle: "" },
      roles: { student: { grade: "9", sis_id: "mw-s-01", student_number: "S1001", legacy_id: fake.userId("mw-s-01"), credentials: { district_username: "ada.brightwater" } } },
    });
    expect(Object.keys(ada["roles"] as object)).toEqual(["student"]);
    const reyes = (await (await get(`/users/${fake.userId("mw-t-reyes")}`)).json()) as { data: Record<string, unknown> };
    expect(Object.keys(reyes.data["roles"] as object)).toEqual(["teacher", "staff"]);
    const roles = reyes.data["roles"] as Record<string, { legacy_id: string; schools: string[] }>;
    expect(roles["teacher"]!.legacy_id).not.toBe(reyes.data["id"]);
    expect(roles["teacher"]!.schools).toHaveLength(2);
    expect((await all("/users?role=teacher")).items).toHaveLength(3);
    expect((await all("/users?role=staff")).items.map((u) => u.data.id).toSorted()).toEqual([fake.userId("mw-staff-lund"), fake.userId("mw-t-reyes")].toSorted());
    expect((await all("/users?role=district_admin")).items).toHaveLength(1);
    const contacts = (await all("/users?role=contact")).items;
    expect(contacts.find((c) => c.data.id === fake.userId("mw-g-brightwater"))!.data["roles"]).toMatchObject({
      contact: { student_relationships: [{ student: fake.userId("mw-s-01"), relationship: "Parent" }] },
    });
    expect((await get("/users?role=principal")).status).toBe(400);
  });

  it("serves sections with primary teacher, co-teachers and students, and their related endpoints", async () => {
    const { fake, page, get } = setup();
    const id = fake.idOf("sections", "mw-eng9-p1");
    const section = ((await (await get(`/sections/${id}`)).json()) as { data: Record<string, unknown> }).data;
    expect(section).toMatchObject({
      name: "English 9 - Quill - Period 1",
      subject: "english/language arts",
      teacher: fake.userId("mw-t-quill"),
      teachers: [fake.userId("mw-t-quill"), fake.userId("mw-t-reyes")],
      school: fake.idOf("schools", "mw-hs"),
      term_id: fake.idOf("terms", "mw-fall"),
      course: fake.idOf("courses", "mw-eng9"),
      period: "1",
    });
    expect(section["students"]).toHaveLength(5);
    expect((await page(`/sections/${id}/users?role=student`)).data).toHaveLength(5);
    expect((await page(`/sections/${id}/users?role=teacher`)).data).toHaveLength(2);
    expect((await page(`/sections/${id}/users`)).data).toHaveLength(7);
    expect((await page(`/schools/${fake.idOf("schools", "mw-hs")}/sections`)).data).toHaveLength(4);
    expect((await page(`/schools/${fake.idOf("schools", "mw-ms")}/sections`)).data).toHaveLength(0);
    expect((await page(`/users/${fake.userId("mw-s-01")}/sections`)).data).toHaveLength(2);
    expect((await page(`/users/${fake.userId("mw-s-01")}/myteachers`)).data.map((u) => u.data.id).toSorted()).toEqual(
      [fake.userId("mw-t-okafor"), fake.userId("mw-t-quill"), fake.userId("mw-t-reyes")].toSorted(),
    );
    expect((await page(`/users/${fake.userId("mw-s-01")}/mycontacts`)).data.map((u) => u.data.id)).toEqual([fake.userId("mw-g-brightwater")]);
    expect((await page(`/users/${fake.userId("mw-t-okafor")}/mystudents`)).data).toHaveLength(10);
    expect((await page(`/terms/${fake.idOf("terms", "mw-fall")}/sections`)).data).toHaveLength(4);
    const term = (await (await get(`/sections/${id}/term`)).json()) as { data: Record<string, unknown> };
    expect(term.data).toMatchObject({ name: "Fall 2026", start_date: "2026-08-17", end_date: "2026-12-18" });
    expect((await (await get(`/districts/${fake.districtId}`)).json()).data).toMatchObject({ id: fake.districtId, name: SAMPLE_DISTRICT.name });
    expect((await get(`/users/${"0".repeat(24)}`)).status).toBe(404);
  });

  it("shares Clever user IDs with the OIDC preset's derivation", () => {
    const { fake } = setup();
    expect(fake.userId("mw-s-01")).toBe(cleverUserId(SAMPLE_DISTRICT, "mw-s-01"));
  });
});

describe("Clever Data API v3.1 fake: paging", () => {
  it("defaults to 100, sorts by ascending ID, and follows next links to the last page", async () => {
    const { page, all } = setup();
    const everyone = (await page("/users")).data;
    expect(everyone).toHaveLength(SAMPLE_DISTRICT.people.length);
    const ids = everyone.map((u) => u.data.id);
    expect(ids).toEqual(ids.toSorted());
    const first = await page("/users?limit=4");
    expect(first.data).toHaveLength(4);
    expect(first.links).toContainEqual({ rel: "next", uri: `/v3.1/users?limit=4&starting_after=${ids[3]}` });
    expect(first.links.some((l) => l.rel === "prev")).toBe(false);
    const { items, pages } = await all("/users?limit=4");
    expect(pages).toBe(Math.ceil(ids.length / 4));
    expect(items.map((u) => u.data.id)).toEqual(ids);
    const last = await page(`/users?limit=4&starting_after=${ids[ids.length - 2]}`);
    expect(last.data).toHaveLength(1);
    expect(last.links.some((l) => l.rel === "next")).toBe(false);
    expect(last.links.find((l) => l.rel === "prev")!.uri).toBe(`/v3.1/users?limit=4&ending_before=${ids[ids.length - 1]}`);
  });

  it("pages backwards with ending_before, and keeps the role filter in links", async () => {
    const { page } = setup();
    const ids = (await page("/users?role=student")).data.map((u) => u.data.id);
    const before = await page(`/users?role=student&limit=3&ending_before=${ids[5]}`);
    expect(before.data.map((u) => u.data.id)).toEqual(ids.slice(2, 5));
    expect(before.links.find((l) => l.rel === "next")!.uri).toBe(`/v3.1/users?role=student&limit=3&starting_after=${ids[4]}`);
  });

  it("refuses a limit over 10000 with 413 and a nonsense limit with 400", async () => {
    const { get } = setup();
    expect((await get("/users?limit=10001")).status).toBe(413);
    expect((await get("/users?limit=10000")).status).toBe(200);
    expect((await get("/users?limit=0")).status).toBe(400);
  });
});

describe("Clever Data API v3.1 fake: auth and rate limits", () => {
  it("refuses a missing or unknown token with 401 and Clever's JSON error", async () => {
    const { get } = setup({ districtTokens: ["district-token-a"] });
    const none = await get("/users", null);
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ error: "Unauthorized" });
    expect((await get("/users", "other")).status).toBe(401);
    expect((await get("/users", "district-token-a")).status).toBe(200);
  });

  it("sends X-RateLimit-* headers, and a real 429 with an empty body once the minute's budget is spent", async () => {
    const { get, tick } = setup({ rateLimitPerMinute: 2 });
    const ok = await get("/schools");
    expect(ok.headers.get("x-ratelimit-limit")).toBe("2");
    expect(ok.headers.get("x-ratelimit-remaining")).toBe("1");
    expect(Number(ok.headers.get("x-ratelimit-reset"))).toBeGreaterThan(Date.parse("2026-10-20T12:00:00Z") / 1000);
    expect(ok.headers.get("x-ratelimit-bucket")).toBeTruthy();
    await get("/schools");
    const limited = await get("/schools");
    expect(limited.status).toBe(429);
    expect(await limited.text()).toBe("");
    expect(limited.headers.get("x-ratelimit-remaining")).toBe("0");
    tick(60_000);
    expect((await get("/schools")).status).toBe(200);
    expect(CLEVER_RATE_LIMIT_PER_MINUTE).toBe(1200);
  });
});

describe("Clever Data API v3.1 fake: faults", () => {
  it("serves an outage as a 5xx JSON error", async () => {
    const { fake, get } = setup();
    fake.inject({ kind: "outage", times: 1 });
    const down = await get("/users");
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ error: expect.any(String) });
    expect((await get("/users")).status).toBe(200);
  });

  it("serves an injected 429 with an empty body, Retry-After and X-RateLimit-* headers", async () => {
    const { fake, get } = setup();
    fake.inject({ kind: "rate-limit", retryAfterSeconds: 30, times: 1 });
    const limited = await get("/users");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("30");
    expect(limited.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(await limited.text()).toBe("");
  });

  it("fails the connection on a network error", async () => {
    const { fake, get } = setup();
    fake.inject({ kind: "network-error", times: 1, match: { path: "/sections" } });
    await expect(get("/sections")).rejects.toThrow(TypeError);
    expect((await get("/sections")).status).toBe(200);
  });

  it("breaks one record of the next list page: a user without name.last, a section with null students", async () => {
    const { fake, page } = setup();
    fake.inject({ kind: "malformed-record", times: 1, match: { path: "/users" } });
    const users = await page("/users?role=student");
    const broken = users.data.filter((u) => (u.data["name"] as Record<string, unknown>)["last"] === undefined);
    expect(broken).toHaveLength(1);
    expect(users.data).toHaveLength(10);
    expect((await page("/users?role=student")).data.every((u) => (u.data["name"] as Record<string, unknown>)["last"] !== undefined)).toBe(true);
    fake.inject({ kind: "malformed-record", times: 1, match: { path: "/sections" } });
    expect((await page("/sections")).data.filter((s) => s.data["students"] === null)).toHaveLength(1);
  });

  it("applies a large removal as users.deleted and sections.updated events", async () => {
    const { fake, page } = setup();
    fake.inject({ kind: "large-removal", fraction: 0.5 });
    expect((await page("/users?role=student")).data).toHaveLength(5);
    const events = (await page("/events")).data.map((e) => e.data as unknown as CleverEvent);
    expect(events.filter((e) => e.type === "users.deleted")).toHaveLength(5);
    const updates = events.filter((e) => e.type === "sections.updated");
    expect(updates.length).toBeGreaterThan(0);
    const bio = updates.find((e) => e.data.object.id === fake.idOf("sections", "mw-bio-p2"))!;
    expect((bio.data.previous_attributes!["students"] as string[]).length).toBe(6);
    expect((bio.data.object["students"] as string[]).length).toBe(1);
    // Within a batch, updates precede deletes.
    expect(events.findIndex((e) => e.type === "users.deleted")).toBeGreaterThan(events.findLastIndex((e) => e.type === "sections.updated"));
  });
});

describe("Clever Data API v3.1 fake: events", () => {
  it("records mutations as created, updated (with previous_attributes) and deleted events", async () => {
    const { fake, page, tick } = setup();
    expect((await page("/events")).data).toEqual([]);
    tick(1000);
    fake.updatePerson("mw-s-02", { grade: "10", familyName: "Calder-Ames" });
    tick(1000);
    fake.addPerson({ id: "mw-s-11", role: "student", givenName: "Kit", familyName: "Lorne", email: "kit.lorne@maplewood.example", schoolIds: ["mw-hs"], grade: "09" }, ["mw-alg-p3"]);
    tick(1000);
    fake.removePerson("mw-s-03");
    const events = (await page("/events")).data.map((e) => e.data as unknown as CleverEvent);
    expect(events.map((e) => e.type)).toEqual(["users.updated", "users.created", "sections.updated", "sections.updated", "sections.updated", "users.deleted"]);
    const [update] = events;
    expect(update!.data.object["name"]).toMatchObject({ last: "Calder-Ames" });
    expect(update!.data.previous_attributes).toEqual({
      name: { last: "Calder" },
      roles: { student: { grade: "9" } },
      last_modified: SAMPLE_DISTRICT.modified,
    });
    expect(update!.data.object["last_modified"]).toBe("2026-10-20T12:00:01.000Z");
    expect(update!.created).toBe("2026-10-20T12:00:01.000Z");
    expect(events[1]!.data.object["id"]).toBe(fake.userId("mw-s-11"));
    expect(events[5]!.data).toEqual({ object: expect.objectContaining({ id: fake.userId("mw-s-03") }) });
    expect(events.every((e) => /^[0-9a-f]{24}$/.test(e.id))).toBe(true);
    const ids = events.map((e) => e.id);
    expect(ids).toEqual(ids.toSorted());
  });

  it("pages events with starting_after and ending_before=last cursors, and filters by record_type", async () => {
    const { fake, page, get } = setup();
    for (const [i, id] of ["mw-s-01", "mw-s-02", "mw-s-03", "mw-s-04"].entries()) fake.updatePerson(id, { localId: `X${i}` });
    fake.updateSection("mw-bio-p4", { period: "5" });
    const latest = await page("/events?ending_before=last&limit=1");
    expect(latest.data).toHaveLength(1);
    expect((latest.data[0]!.data as unknown as CleverEvent).type).toBe("sections.updated");
    const all = (await page("/events")).data.map((e) => e.data.id);
    const after = await page(`/events?starting_after=${all[1]}&limit=2`);
    expect(after.data.map((e) => e.data.id)).toEqual(all.slice(2, 4));
    expect(after.links.find((l) => l.rel === "next")!.uri).toBe(`/v3.1/events?limit=2&starting_after=${all[3]}`);
    expect((await page(`/events?starting_after=${all[4]}`)).data).toEqual([]);
    expect((await page("/events?record_type=sections")).data).toHaveLength(1);
    expect((await page("/events?record_type=users")).data).toHaveLength(4);
    expect((await get(`/events?starting_after=${"f".repeat(24)}`)).status).toBe(400);
    const one = (await (await get(`/events/${all[0]}`)).json()) as { data: CleverEvent };
    expect(one.data.type).toBe("users.updated");
    fake.inject({ kind: "malformed-record", times: 1, match: { path: "/events" } });
    expect((await page("/events")).data.filter((e) => (e.data["data"] as CleverEvent["data"]).object["id"] === undefined)).toHaveLength(1);
  });

  it("serves v3.0 paths too, with v3.0 URIs", async () => {
    const { page } = setup();
    const body = await page("/v3.0/schools?limit=1");
    expect(body.data[0]!.uri).toMatch(/^\/v3\.0\/schools\//);
    expect(body.links.find((l) => l.rel === "next")!.uri).toMatch(/^\/v3\.0\/schools\?limit=1&starting_after=/);
    expect(API).toBe("https://api.clever.com/v3.1");
  });
});
