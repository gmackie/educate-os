// SCHO-203: the Clever client, roster source and the shared sync runner against the wire-faithful
// Clever Data API v3.1 fake from @educateos/provider-fakes: a complete sync, an events delta with
// a persisted cursor, retried 429s and outages, malformed records and events, a large removal that
// is held rather than applied, and the Cedar Valley demo district end to end.
import { District, DistrictDirectorySnapshot, IntegrationSyncRun, checkDirectoryIntegrity, externalIdentityKey } from "@educateos/contracts";
import { CEDARVALLEY, demoDistrict, districtSeed } from "@educateos/fixtures";
import { createDirectoryPrincipalResolver, identityFromCleverClaims } from "@educateos/identity";
import { CleverDataFake, OidcFake, SAMPLE_DISTRICT, routeFetch, type DistrictSeed } from "@educateos/provider-fakes";
import { describe, expect, it } from "vitest";
import { clever, integrationHealth, oneroster } from "../src/index.ts";

const ISSUER = "https://clever.com";
const START = Date.parse("2026-10-20T15:00:00Z");

function emptyState(district: DistrictDirectorySnapshot["district"]): oneroster.RosterSyncState {
  return {
    roster: {
      snapshot: DistrictDirectorySnapshot.parse({ district, schools: [], terms: [], courses: [], offerings: [], principals: [], enrollments: [], roleAssignments: [] }),
      sources: oneroster.EMPTY_SOURCE_MAP,
    },
  };
}

const MAPLEWOOD = District.parse({ id: "dst_maplewood", name: "Maplewood Unified (synthetic)", timeZone: "America/Chicago", trustedIssuers: [ISSUER] });

function setup(seed: DistrictSeed = SAMPLE_DISTRICT, options: { pageSize?: number; token?: string; districtId?: string; rateLimitPerMinute?: number } = {}) {
  const clock = { ms: START };
  const fake = new CleverDataFake({ seed, now: () => clock.ms, ...(options.rateLimitPerMinute === undefined ? {} : { rateLimitPerMinute: options.rateLimitPerMinute }) });
  const sleeps: number[] = [];
  const client = new clever.CleverDataClient({
    connection: { districtId: options.districtId ?? fake.districtId, pageSize: options.pageSize ?? 4 },
    token: options.token ?? fake.districtToken,
    fetch: fake.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.ms += ms;
    },
    clock: () => clock.ms,
  });
  return { fake, clock, sleeps, client, source: clever.cleverRosterSource(client) };
}

async function sync(
  state: oneroster.RosterSyncState,
  source: oneroster.RosterSource,
  mode: "complete" | "delta" = "complete",
  extra: Partial<oneroster.RosterSyncInput> = {},
  issuer = ISSUER,
) {
  let now = START;
  const result = await oneroster.runRosterSync({
    state,
    source,
    mode,
    config: { issuer, subject: clever.CLEVER_SUBJECT_FIELD },
    runId: `run-${mode}`,
    clock: () => new Date((now += 1000)),
    ...extra,
  });
  expect(IntegrationSyncRun.parse(result.run)).toEqual(result.run);
  return result;
}

async function synced(...args: Parameters<typeof sync>) {
  const result = await sync(...args);
  if (result.run.outcome !== "succeeded") throw new Error(JSON.stringify({ run: result.run, issues: result.preview?.issues }, null, 2));
  return result;
}

function principalOf(state: oneroster.RosterSyncState, cleverId: string) {
  const id = Object.entries(state.roster.sources.principals).find(([, s]) => s.sourcedId === cleverId)?.[0];
  return state.roster.snapshot.principals.find((p) => p.id === id);
}

const active = <T extends { status: string }>(records: readonly T[]) => records.filter((r) => r.status === "active");

describe("Clever Data API client", () => {
  it("reads every collection through the fake's links paging without an issue", async () => {
    const { client, fake } = setup();
    for (const collection of clever.CLEVER_COLLECTIONS) {
      const { items } = await client.list(collection);
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) expect(clever.CLEVER_RECORD_SCHEMAS[collection].safeParse(item).success).toBe(true);
    }
    // pageSize 4: ten students, five staff and two contacts are seventeen users, five pages.
    expect(fake.requestsTo("/v3.1/users").map((r) => r.url.searchParams.has("starting_after"))).toEqual([false, true, true, true, true]);
    expect(fake.requests.every((r) => r.headers.get("authorization") === `Bearer ${fake.districtToken}`)).toBe(true);
  });

  it("refuses a connection that names no Clever district ID", () => {
    expect(() => new clever.CleverDataClient({ connection: { districtId: "not-an-id" }, token: "t", fetch })).toThrow(/Clever district ID/);
  });

  it("follows no redirect: one is a failed request, and the fetch is asked not to follow it", async () => {
    let asked: RequestRedirect | undefined;
    const redirecting: typeof fetch = async (_input, init) => {
      asked = init?.redirect;
      return new Response(null, { status: 302, headers: { location: "https://evil.example/" } });
    };
    const client = new clever.CleverDataClient({ connection: { districtId: "0".repeat(24) }, token: "t", fetch: redirecting });
    await expect(client.list("users")).rejects.toMatchObject({ code: "invalid-response" });
    expect(asked).toBe("manual");
  });

  it("follows no link to another resource", async () => {
    const fetchStub: typeof fetch = async () =>
      Response.json({ data: [{ data: { id: "a" } }], links: [{ rel: "next", uri: "https://evil.example/v3.1/users?starting_after=a" }] });
    const client = new clever.CleverDataClient({ connection: { districtId: "0".repeat(24) }, token: "t", fetch: fetchStub });
    await expect(client.list("users")).rejects.toMatchObject({ code: "invalid-response" });
  });
});

describe("Clever roster sync against the Clever fake", () => {
  it("syncs the whole district: staff, students and sections, but no guardians", async () => {
    const { source, fake } = setup();
    const { state, run, preview } = await synced(emptyState(MAPLEWOOD), source);
    expect(run).toMatchObject({ mode: "complete", outcome: "succeeded", quarantined: 0 });
    expect(run.counts.principals.added).toBe(15);
    expect(run.counts.enrollments.added).toBe(25);
    expect(run.counts.offerings.added).toBe(4);
    expect(checkDirectoryIntegrity(state.roster.snapshot)).toEqual([]);

    const ada = principalOf(state, fake.userId("mw-s-01"))!;
    expect(ada).toMatchObject({ kind: "student", status: "active", displayName: "Ada Brightwater", email: "ada.brightwater@maplewood.example" });
    // The subject is the Clever user ID, which is the `sub` Clever SSO asserts.
    expect(ada.externalIdentities).toEqual([{ districtId: "dst_maplewood", issuer: ISSUER, subject: fake.userId("mw-s-01") }]);
    expect(state.roster.sources.principals[ada.id]).toMatchObject({ system: "clever", sourcedId: fake.userId("mw-s-01") });
    expect(principalOf(state, fake.userId("mw-admin-varga"))).toMatchObject({ kind: "staff" });
    expect(principalOf(state, fake.userId("mw-g-brightwater"))).toBeUndefined();
    expect(preview!.issues).toContainEqual(expect.objectContaining({ severity: "warning", sourcedId: fake.userId("mw-g-brightwater"), message: expect.stringMatching(/guardian/) }));
    // District administration is never granted from a roster.
    expect(state.roster.snapshot.roleAssignments.some((a) => a.role === "district-admin")).toBe(false);

    // Clever courses carry no grades, and these sections list none, so each takes its school's.
    const courses = state.roster.snapshot.courses.map((c) => `${c.title}|${c.subject}|${c.gradeBand}`).toSorted();
    expect(courses).toEqual(["Algebra I|mathematics|9-12", "Biology|science|9-12", "English 9|english-language-arts|9-12"]);
    // Two teachers share English 9: the lead teaches, the other co-teaches.
    const roles = state.roster.snapshot.enrollments.filter((e) => e.role !== "student").map((e) => e.role).toSorted();
    expect(roles).toEqual(["co-teacher", "teacher", "teacher", "teacher", "teacher"]);
    // The newest event is noted before the collections are read.
    expect(fake.requests[0]!.url.search).toBe("?ending_before=last&limit=1");
    expect(state.sourceCursor).toBe("clever-events:");
  });

  it("applies an events delta from the persisted cursor, and moves the cursor", async () => {
    const { source, fake, clock } = setup();
    const first = await synced(emptyState(MAPLEWOOD), source);
    clock.ms = Date.parse("2026-10-21T09:00:00Z");
    fake.updatePerson("mw-s-02", { givenName: "Bonnie" });
    fake.removePerson("mw-s-03");
    fake.updateSection("mw-alg-p3", { studentIds: ["mw-s-06", "mw-s-07", "mw-s-08", "mw-s-09"] });
    fake.requests.length = 0;

    const { state, run } = await synced(first.state, source, "delta");
    expect(principalOf(state, fake.userId("mw-s-02"))!.displayName).toBe("Bonnie Calder");
    expect(principalOf(state, fake.userId("mw-s-03"))!.status).toBe("inactive");
    expect(run.counts.principals).toEqual({ added: 0, updated: 1, deactivated: 1 });
    // Cleo's two enrollments, and Jun's Algebra I place.
    expect(run.counts.enrollments.deactivated).toBe(3);
    expect(fake.requests.every((r) => r.url.pathname === "/v3.1/events")).toBe(true);
    expect(fake.requests[0]!.url.searchParams.has("starting_after")).toBe(false);
    expect(state.sourceCursor).toBe(`clever-events:${fake.events.at(-1)!.id}`);
    expect(state.roster.snapshot.enrollments).toHaveLength(first.state.roster.snapshot.enrollments.length);

    // Nothing new: the next delta starts after the last event, reads none, and changes nothing.
    fake.requests.length = 0;
    const again = await synced(state, source, "delta");
    expect(fake.requests[0]!.url.searchParams.get("starting_after")).toBe(fake.events.at(-1)!.id);
    expect(again.state).toEqual(state);
    expect(oneroster.hasChanges(again.preview!.changes)).toBe(false);
  });

  it("adds a new student and section from events", async () => {
    const { source, fake, clock } = setup();
    const { state } = await synced(emptyState(MAPLEWOOD), source);
    clock.ms += 60_000;
    fake.addPerson({ id: "mw-s-11", role: "student", givenName: "Kai", familyName: "Lindqvist", email: "kai.lindqvist@maplewood.example", schoolIds: ["mw-hs"], grade: "09" }, ["mw-bio-p4"]);
    fake.addSection({ id: "mw-bio-p6", title: "Biology, period 6", courseId: "mw-bio", schoolId: "mw-hs", termIds: ["mw-fall"], period: "6", teacherIds: ["mw-t-okafor"], studentIds: ["mw-s-11"] });
    const { state: next, run } = await synced(state, source, "delta");
    expect(principalOf(next, fake.userId("mw-s-11"))).toMatchObject({ status: "active", kind: "student" });
    expect(run.counts.offerings.added).toBe(1);
    expect(run.counts.enrollments.added).toBe(3);
  });

  it("refuses a delta before any complete sync", async () => {
    const { source } = setup();
    expect((await sync(emptyState(MAPLEWOOD), source, "delta")).run).toMatchObject({ outcome: "failed", errorCode: "no-baseline" });
  });

  it("reports an event cursor Clever no longer holds as no-baseline, and keeps the state", async () => {
    const { source } = setup();
    const { state } = await synced(emptyState(MAPLEWOOD), source);
    const stale = { ...state, sourceCursor: `clever-events:${"f".repeat(24)}` };
    const result = await sync(stale, source, "delta");
    expect(result.run).toMatchObject({ outcome: "failed", errorCode: "no-baseline" });
    expect(result.state).toBe(stale);
  });

  it("is retried through a 429 with Retry-After and a 503", async () => {
    const { source, fake, sleeps } = setup();
    fake.inject({ kind: "rate-limit", retryAfterSeconds: 3, times: 1, match: { path: "/users" } });
    fake.inject({ kind: "outage", status: 503, times: 1, match: { path: "/sections" } });
    await synced(emptyState(MAPLEWOOD), source);
    expect(sleeps).toContain(3000);
    expect(sleeps).toHaveLength(2);
  });

  it("waits out Clever's own 429 until X-RateLimit-Reset", async () => {
    const { source, sleeps, clock } = setup(SAMPLE_DISTRICT, { rateLimitPerMinute: 5, pageSize: 100 });
    clock.ms = START + 40_000;
    await synced(emptyState(MAPLEWOOD), source);
    // Seven requests at five a minute: the sixth waits the 20 seconds until the next minute's bucket.
    expect(sleeps).toEqual([20_000]);
    expect(clock.ms).toBe(START + 60_000);
  });

  it("fails the sync as source-unavailable when the outage outlasts the retries, and keeps the state", async () => {
    const { source, fake } = setup();
    const { state } = await synced(emptyState(MAPLEWOOD), source);
    fake.inject({ kind: "outage", match: { path: "/events" } });
    const result = await sync(state, source, "delta");
    expect(result.run).toMatchObject({ outcome: "failed", errorCode: "source-unavailable" });
    expect(result.state).toBe(state);
  });

  it("fails as auth-failed for a rejected token, or one that reads another district", async () => {
    const wrongToken = setup(SAMPLE_DISTRICT, { token: "not-the-token" });
    expect((await sync(emptyState(MAPLEWOOD), wrongToken.source)).run).toMatchObject({ outcome: "failed", errorCode: "auth-failed" });
    const wrongDistrict = setup(SAMPLE_DISTRICT, { districtId: "a".repeat(24) });
    const result = await sync(emptyState(MAPLEWOOD), wrongDistrict.source);
    expect(result.run).toMatchObject({ outcome: "failed", errorCode: "auth-failed" });
  });

  it("reports a malformed user as an issue that rejects the feed", async () => {
    const { source, fake } = setup();
    fake.inject({ kind: "malformed-record", times: 1, match: { path: "/users" } });
    const { run, preview } = await sync(emptyState(MAPLEWOOD), source);
    expect(run).toMatchObject({ outcome: "failed", errorCode: "feed-rejected" });
    expect(preview?.issues).toContainEqual(expect.objectContaining({ severity: "error", file: "users.csv", column: "name.last" }));
  });

  it("reports a section with a null roster as an issue that rejects the feed", async () => {
    const { source, fake } = setup();
    fake.inject({ kind: "malformed-record", times: 1, match: { path: "/sections" } });
    const { run, preview } = await sync(emptyState(MAPLEWOOD), source);
    expect(run).toMatchObject({ outcome: "failed", errorCode: "feed-rejected" });
    expect(preview?.issues).toContainEqual(expect.objectContaining({ severity: "error", file: "classes.csv", column: "students" }));
  });

  it("rejects a delta with a malformed event and leaves the cursor where it was", async () => {
    const { source, fake, clock } = setup();
    const { state } = await synced(emptyState(MAPLEWOOD), source);
    clock.ms += 60_000;
    fake.updatePerson("mw-s-02", { givenName: "Bonnie" });
    fake.inject({ kind: "malformed-record", times: 1, match: { path: "/events" } });
    const result = await sync(state, source, "delta");
    expect(result.run).toMatchObject({ outcome: "failed", errorCode: "feed-rejected" });
    expect(result.state.sourceCursor).toBe(state.sourceCursor);
    // The fault has passed: the same delta now applies.
    expect((await synced(state, source, "delta")).run.counts.principals.updated).toBe(1);
  });

  it("holds a large removal for an administrator rather than applying it, and applies it once approved", async () => {
    const { source, fake, clock } = setup();
    const { state } = await synced(emptyState(MAPLEWOOD), source);
    clock.ms += 60_000;
    fake.inject({ kind: "large-removal", fraction: 0.5 });

    const held = await sync(state, source, "delta");
    expect(held.run).toMatchObject({ outcome: "failed", errorCode: "removal-held", quarantined: 0 });
    expect(held.state).toBe(state);
    expect(held.held).toMatchObject({ principals: { deactivated: 5, active: 15 }, enrollments: { deactivated: 10, active: 25 } });
    expect(held.preview!.changes.principals.deactivated).toHaveLength(5);

    // An approval names exactly this removal; the next delta applies it.
    const approved = await synced(state, source, "delta", { approvedRemoval: held.held!.fingerprint });
    expect(approved.run.counts.principals.deactivated).toBe(5);
    expect(active(approved.state.roster.snapshot.principals)).toHaveLength(10);
    // A different approval does not.
    expect((await sync(state, source, "delta", { approvedRemoval: "0".repeat(64) })).run.errorCode).toBe("removal-held");
  });

  it("keeps its event cursor in the sync store, and reports a held removal in its health", async () => {
    const { source, fake, clock } = setup();
    const store = new oneroster.InMemoryRosterSyncStore();
    const stored = (mode: "complete" | "delta") => {
      let now = clock.ms;
      return oneroster.runStoredRosterSync({
        store,
        initial: () => emptyState(MAPLEWOOD),
        source,
        mode,
        config: { issuer: ISSUER, subject: clever.CLEVER_SUBJECT_FIELD },
        runId: `run-${mode}-${clock.ms}`,
        clock: () => new Date((now += 1000)),
      });
    };
    const sla = { maxStalenessMinutes: 24 * 60 };
    await stored("complete");
    clock.ms += 60_000;
    fake.updatePerson("mw-s-02", { givenName: "Bonnie" });
    await stored("delta");
    expect((await store.load())!.state.sourceCursor).toBe(`clever-events:${fake.events.at(-1)!.id}`);
    expect(integrationHealth(await store.runs(), sla, new Date(clock.ms + 120_000))).toMatchObject({ status: "healthy", consecutiveFailures: 0 });

    clock.ms += 60_000;
    fake.inject({ kind: "large-removal", fraction: 0.5 });
    await stored("delta");
    expect(integrationHealth(await store.runs(), sla, new Date(clock.ms + 120_000))).toMatchObject({
      status: "degraded",
      consecutiveFailures: 1,
      lastErrorCode: "removal-held",
    });
    // The held run moved nothing: the cursor still points before the removal's events.
    expect((await store.load())!.state.sourceCursor).not.toBe(`clever-events:${fake.events.at(-1)!.id}`);
  });

  it("keeps a course's grades from the sections a delta does not list", async () => {
    const graded: DistrictSeed = {
      ...SAMPLE_DISTRICT,
      sections: SAMPLE_DISTRICT.sections.map((s) => ({ ...s, grades: s.id === "mw-bio-p4" ? ["10"] : ["09"] })),
    };
    const { source, fake, clock } = setup(graded);
    const { state } = await synced(emptyState(MAPLEWOOD), source);
    const biology = () => state.roster.snapshot.courses.find((c) => c.title.startsWith("Biology"))!;
    expect(biology().gradeBand).toBe("9-10");
    clock.ms += 60_000;
    fake.mutate((seed) => ({
      ...seed,
      courses: seed.courses.map((c) => (c.id === "mw-bio" ? { ...c, title: "Biology I" } : c)),
      sections: seed.sections.map((s) => (s.id === "mw-bio-p2" ? { ...s, period: "5" } : s)),
    }));
    const { state: next } = await synced(state, source, "delta");
    expect(next.roster.snapshot.courses.find((c) => c.id === biology().id)).toMatchObject({ title: "Biology I", gradeBand: "9-10", subject: "science" });
  });

  it("reports a malformed contact without blocking the roster, since contacts are never imported", async () => {
    const { fake, client } = setup();
    const contact = fake.userId("mw-g-garrow");
    const fetchWithBrokenContact: typeof fetch = async (input, init) => {
      const response = await fake.fetch(input, init);
      if (!new URL(input instanceof Request ? input.url : String(input)).pathname.endsWith("/users")) return response;
      const body = (await response.json()) as { data: { data: { id: string; name: Record<string, unknown> } }[] };
      for (const item of body.data) if (item.data.id === contact) delete item.data.name["last"];
      return Response.json(body);
    };
    const source = clever.cleverRosterSource(new clever.CleverDataClient({ connection: { districtId: client.districtId, pageSize: 4 }, token: fake.districtToken, fetch: fetchWithBrokenContact }));
    const { preview } = await synced(emptyState(MAPLEWOOD), source);
    expect(preview!.issues).toContainEqual(expect.objectContaining({ severity: "warning", sourcedId: contact, column: "name.last" }));
  });

  it("syncs whole rosters for an app Clever refuses events, and refuses its deltas", async () => {
    const { fake, client } = setup();
    const noEvents: typeof fetch = async (input, init) =>
      new URL(input instanceof Request ? input.url : String(input)).pathname.endsWith("/events") ? new Response(null, { status: 401 }) : fake.fetch(input, init);
    const source = clever.cleverRosterSource(new clever.CleverDataClient({ connection: { districtId: client.districtId }, token: fake.districtToken, fetch: noEvents }));
    const { state, preview } = await synced(emptyState(MAPLEWOOD), source);
    expect(state.sourceCursor).toBeUndefined();
    expect(preview!.issues).toContainEqual(expect.objectContaining({ severity: "warning", message: expect.stringMatching(/events API/) }));
    expect((await sync(state, source, "delta")).run).toMatchObject({ outcome: "failed", errorCode: "no-baseline" });
  });

  it("does not hold a small removal", async () => {
    const { source, fake, clock } = setup();
    const { state } = await synced(emptyState(MAPLEWOOD), source);
    clock.ms += 60_000;
    fake.removePerson("mw-s-03");
    fake.removePerson("mw-s-04");
    expect((await synced(state, source, "delta")).run.counts.principals.deactivated).toBe(2);
  });
});

describe("Cedar Valley over Clever, end to end", () => {
  const demo = demoDistrict("cedarvalley");
  const IDP = CEDARVALLEY.district.trustedIssuers[0]!;

  /** The fixture's directory, with each subject as the Clever fake names the person. */
  function expected(fake: CleverDataFake): DistrictDirectorySnapshot {
    return {
      ...CEDARVALLEY,
      principals: CEDARVALLEY.principals.map((p) => ({
        ...p,
        externalIdentities: p.externalIdentities.map((i) => ({ ...i, subject: fake.userId(p.id) })),
      })),
    };
  }
  const people = (s: DistrictDirectorySnapshot) =>
    s.principals.filter((p) => p.kind !== "guardian").map((p) => `${externalIdentityKey(p.externalIdentities[0]!)}|${p.kind}|${p.status}|${p.displayName}`).toSorted();
  function enrollmentKeys(snapshot: DistrictDirectorySnapshot): string[] {
    const subject = new Map(snapshot.principals.map((p) => [p.id, p.externalIdentities[0]!.subject]));
    const title = new Map(snapshot.courses.map((c) => [c.id, c.title]));
    const course = new Map(snapshot.offerings.map((o) => [o.id, title.get(o.courseId)]));
    return snapshot.enrollments.map((e) => `${subject.get(e.principalId)}|${course.get(e.offeringId)}|${e.role}|${e.status}`).toSorted();
  }

  it("rebuilds the directory from a complete sync and a mid-term drop delivered as an event", async () => {
    // As the roster stood before Sofia Marquez left Earth Science 8.
    const { fake, source, clock } = setup(districtSeed(demo, { includeEndedEnrollments: true }));
    const first = await synced(emptyState(CEDARVALLEY.district), source, "complete", {}, IDP);
    clock.ms = Date.parse("2026-10-21T09:00:00Z");
    const section = fake.seed.sections.find((s) => s.id === "off_cv-earthsci-p1")!;
    fake.updateSection(section.id, { studentIds: section.studentIds.filter((id) => id !== "prn_cv-student-sofia") });
    const { state, run } = await synced(first.state, source, "delta", {}, IDP);
    expect(run.counts.enrollments.deactivated).toBe(1);

    const imported = state.roster.snapshot;
    const want = expected(fake);
    expect(checkDirectoryIntegrity(imported)).toEqual([]);
    expect(people(imported)).toEqual(people(want));
    expect(enrollmentKeys(imported)).toEqual(enrollmentKeys(want));
    // School grade bands come from their classes' grades, as for OneRoster: the row model carries
    // no school grades, so Clever's low_grade and high_grade only fill in course grades.
    expect(imported.schools.map((s) => s.name).toSorted()).toEqual(want.schools.map((s) => s.name).toSorted());
    expect(imported.courses.map((c) => `${c.title}|${c.subject}|${c.gradeBand}`).toSorted())
      .toEqual(want.courses.map((c) => `${c.title}|${c.subject}|${c.gradeBand}`).toSorted());
    expect(imported.terms.map((t) => `${t.name}|${t.startsOn}|${t.endsOn}|${t.state}`)).toEqual(want.terms.map((t) => `${t.name}|${t.startsOn}|${t.endsOn}|${t.state}`));
  });

  it("keeps the Nguyen twins apart despite their shared family email, and imports no guardian", async () => {
    const { fake, source } = setup(districtSeed(demo));
    const { state, preview } = await synced(emptyState(CEDARVALLEY.district), source, "complete", {}, IDP);
    const an = principalOf(state, fake.userId("prn_cv-student-an"))!;
    const bao = principalOf(state, fake.userId("prn_cv-student-bao"))!;
    expect(an.id).not.toBe(bao.id);
    expect([an.email, bao.email]).toEqual(["family.nguyen@cedarvalley.example", "family.nguyen@cedarvalley.example"]);
    expect(principalOf(state, fake.userId("prn_cv-guardian-nguyen"))).toBeUndefined();
    expect(preview!.issues).toContainEqual(expect.objectContaining({ sourcedId: fake.userId("prn_cv-guardian-nguyen"), message: expect.stringMatching(/guardian/) }));
  });

  it("gives Dana Whitaker a teaching role at both schools", async () => {
    const { fake, source } = setup(districtSeed(demo));
    const { state } = await synced(emptyState(CEDARVALLEY.district), source, "complete", {}, IDP);
    const dana = principalOf(state, fake.userId("prn_cv-teacher-whitaker"))!;
    const schools = state.roster.snapshot.roleAssignments
      .filter((a) => a.principalId === dana.id && a.role === "teacher")
      .map((a) => state.roster.snapshot.schools.find((s) => s.id === (a.scope as { schoolId: string }).schoolId)!.name)
      .toSorted();
    expect(schools).toEqual(["Cedar Valley High School", "Cedar Valley Middle School"]);
  });

  it("signs each person in through Clever SSO as the principal the Clever roster made", async () => {
    const seed = districtSeed(demo);
    const { fake, source } = setup(seed);
    const { state } = await synced(emptyState(CEDARVALLEY.district), source, "complete", {}, IDP);
    const resolver = createDirectoryPrincipalResolver(state.roster.snapshot);
    const client = { clientId: "cedarvalley-test", clientSecret: "test-client-value", redirectUris: ["https://cedarvalley.educateos.example/callback"] };
    const idp = new OidcFake({ seed, preset: "clever", clients: [client] });
    const fetch = routeFetch(Object.fromEntries(idp.origins.map((origin) => [origin, idp])));
    const config = (await (await fetch(idp.discoveryUrl)).json()) as Record<string, string>;

    for (const personId of ["prn_cv-student-an", "prn_cv-student-bao", "prn_cv-teacher-whitaker", "prn_cv-district-admin"]) {
      const authorize = new URL(config["authorization_endpoint"]!);
      for (const [k, v] of Object.entries({ client_id: client.clientId, redirect_uri: client.redirectUris[0]!, response_type: "code", scope: "openid email profile", state: "s", login_hint: personId })) {
        authorize.searchParams.set(k, v);
      }
      const code = new URL((await fetch(authorize, { redirect: "manual" })).headers.get("location")!).searchParams.get("code")!;
      const { access_token: token } = (await (await fetch(config["token_endpoint"]!, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${btoa(`${client.clientId}:${client.clientSecret}`)}` },
        body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: client.redirectUris[0]! }),
      })).json()) as { access_token: string };
      const userinfo = (await (await fetch(config["userinfo_endpoint"]!, { headers: { authorization: `Bearer ${token}` } })).json()) as Record<string, unknown>;
      const identity = identityFromCleverClaims(userinfo, { districtId: fake.districtId, issuer: IDP });
      expect((await resolver.resolve(identity)).principalId, personId).toBe(principalOf(state, fake.userId(personId))!.id);
    }
  });

  it("holds a removal of half its students", async () => {
    const { fake, source, clock } = setup(districtSeed(demo));
    const { state } = await synced(emptyState(CEDARVALLEY.district), source, "complete", {}, IDP);
    clock.ms += 60_000;
    fake.inject({ kind: "large-removal", fraction: 0.5 });
    const held = await sync(state, source, "delta", {}, IDP);
    expect(held.run).toMatchObject({ outcome: "failed", errorCode: "removal-held" });
    expect(held.held!.principals.deactivated).toBe(3);
    expect(active(held.state.roster.snapshot.principals.filter((p) => p.kind === "student"))).toHaveLength(6);
  });
});
