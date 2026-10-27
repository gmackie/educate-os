// SCHO-77: Google Classroom district sync against the wire-faithful Classroom fake
// (@educateos/provider-fakes), seeded with the Harbor and Cedar Valley demo districts. Covers the
// service account's delegated tokens, paging, scope checks, 429 and outage faults, Harbor end to
// end (Classroom as the roster, then a teacher-approved grade written back to coursework EducateOS
// created), and Cedar Valley's course and identity linking over its Clever-rostered directory.
import { DistrictDirectorySnapshot, IntegrationSyncRun, checkDirectoryIntegrity } from "@educateos/contracts";
import type { OfferingId, PrincipalId } from "@educateos/contracts";
import { demoDistrict, type DemoDistrict } from "@educateos/fixtures";
import {
  CLASSROOM_ISSUER,
  ClassroomAdapter,
  ClassroomGradeSink,
  GradePassback,
  InMemoryGradeApprovalStore,
  InMemoryGradeRouteStore,
  InMemoryPassbackLedger,
  type ClassroomGradeRoute,
} from "@educateos/lti";
import { CLASSROOM_SCOPES, GoogleClassroomFake, type AssignmentSeed, type DistrictSeed } from "@educateos/provider-fakes";
import { describe, expect, it } from "vitest";
import { RosterSyncError, googleclassroom, oneroster } from "../src/index.ts";
import { classroomDistrictSeed, emailOf, fakeDelegation, workspaceDomain } from "./fixtures/classroom-district.ts";

const START = Date.parse("2026-10-20T15:00:00Z");
const S = CLASSROOM_SCOPES;
// The fake's scope URLs are Google's own, so the client's scope sets apply to it unchanged.
const ROSTER = [...googleclassroom.CLASSROOM_ROSTER_SCOPES];
const GRADES = [...googleclassroom.CLASSROOM_GRADE_SCOPES];

const HARBOR_CONFIG: googleclassroom.ClassroomRosterConfigInput = {
  term: { sourcedId: "hb-2026-27", title: "2026-27", startDate: "2026-08-24", endDate: "2027-06-11" },
  schools: [
    { sourcedId: "hb-high", name: "Harbor Charter High Campus", grades: ["09", "10", "11", "12"] },
    { sourcedId: "hb-middle", name: "Harbor Charter Middle Campus", grades: ["06", "07", "08"], courses: ["d:off_hb-math7-b1"] },
  ],
  defaultSchool: "hb-high",
};

/** A teacher-made assignment in Marine Science, which Classroom will not let EducateOS grade. */
const TEACHER_MADE: AssignmentSeed = {
  id: "hb-marine-tidepool", sectionId: "off_hb-marine-b1", title: "Tide pool survey", maxPoints: 20,
  submissions: [{ studentId: "prn_hb-student-nia", state: "TURNED_IN" }],
};

interface WorldOptions {
  scopes?: readonly string[];
  apiDisabled?: boolean;
  seed?: DistrictSeed;
}

function world(demo: DemoDistrict, options: WorldOptions = {}) {
  const clock = { ms: START };
  const seed = options.seed ?? classroomDistrictSeed(demo, demo.slug === "harbor" ? [TEACHER_MADE] : []);
  // The server pages at 3, the client asks for 2, so every list takes several pages.
  const fake = new GoogleClassroomFake({ seed, now: () => clock.ms, maxPageSize: 3, apiDisabled: options.apiDisabled ?? false });
  const tokens = fakeDelegation(fake, seed, options.scopes ?? GRADES);
  const admin = seed.people.find((p) => p.role === "administrator")!.email;
  const sleeps: number[] = [];
  const client = new googleclassroom.GoogleClassroomClient({
    tokens, admin, fetch: fake.fetch, pageSize: 2, clock: () => clock.ms,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { seed, fake, tokens, client, sleeps, clock };
}

function emptyState(directory: DistrictDirectorySnapshot): oneroster.RosterSyncState {
  return {
    roster: {
      snapshot: DistrictDirectorySnapshot.parse({ district: directory.district, schools: [], terms: [], courses: [], offerings: [], principals: [], enrollments: [], roleAssignments: [] }),
      sources: oneroster.EMPTY_SOURCE_MAP,
    },
  };
}

async function sync(client: googleclassroom.GoogleClassroomClient, state = emptyState(demoDistrict("harbor").directory)) {
  let now = START;
  const result = await oneroster.runRosterSync({
    state,
    source: googleclassroom.classroomRosterSource(client, HARBOR_CONFIG),
    mode: "complete",
    config: googleclassroom.CLASSROOM_IDENTITY,
    runId: "run-classroom",
    clock: () => new Date((now += 1000)),
  });
  expect(IntegrationSyncRun.parse(result.run)).toEqual(result.run);
  return result;
}

async function synced(client: googleclassroom.GoogleClassroomClient, state?: oneroster.RosterSyncState) {
  const result = await sync(client, state);
  if (result.run.outcome !== "succeeded") throw new Error(JSON.stringify(result.preview?.issues ?? result.run, null, 2));
  return result;
}

/** Each active enrollment as `name|course|section|role`, which survives the importer deriving its own IDs. */
function enrollmentKeys(snapshot: DistrictDirectorySnapshot): string[] {
  const name = new Map(snapshot.principals.map((p) => [p.id, p.displayName]));
  const title = new Map(snapshot.courses.map((c) => [c.id, c.title]));
  const offering = new Map(snapshot.offerings.map((o) => [o.id, `${title.get(o.courseId)}|${o.sectionName}`]));
  return snapshot.enrollments
    .filter((e) => e.status === "active")
    .map((e) => `${name.get(e.principalId)}|${offering.get(e.offeringId)}|${e.role === "student" ? "student" : "staff"}`)
    .toSorted();
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error && "code" in error) return String(error.code);
    throw error;
  }
  throw new Error("expected a rejection");
}

// ── Domain-wide delegation ───────────────────────────────────────────

async function serviceAccountKey() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const body = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n");
  const key = {
    type: "service_account",
    project_id: "educateos-example",
    private_key_id: "kid-1",
    private_key: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`,
    client_email: "classroom-sync@educateos-example.iam.gserviceaccount.com",
    token_uri: "https://attacker.example/token",
  };
  return { key, publicKey: pair.publicKey };
}

/** Google's token endpoint for the jwt-bearer grant: verifies the assertion and issues a token. */
function tokenEndpoint(publicKey: CryptoKey, refuse?: { status: number; error: string }) {
  const seen: { url: string; header: Record<string, unknown>; claims: Record<string, unknown> }[] = [];
  const decode = (part: string) => JSON.parse(atob(part.replaceAll("-", "+").replaceAll("_", "/"))) as Record<string, unknown>;
  const handler = async (input: RequestInfo | URL, init?: RequestInit) => {
    const form = new URLSearchParams(String(init?.body));
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [h, c, sig] = form.get("assertion")!.split(".");
    const signature = Uint8Array.from(atob(sig!.replaceAll("-", "+").replaceAll("_", "/")), (ch) => ch.charCodeAt(0));
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, signature, new TextEncoder().encode(`${h}.${c}`));
    seen.push({ url: String(input), header: decode(h!), claims: decode(c!) });
    if (!valid) return Response.json({ error: "invalid_grant" }, { status: 400 });
    if (refuse !== undefined) return Response.json({ error: refuse.error, error_description: "Client is unauthorized" }, { status: refuse.status });
    return Response.json({ access_token: `ya29.delegated-${seen.length}`, token_type: "Bearer", expires_in: 3599 });
  };
  return { seen, fetch: handler as typeof fetch };
}

const unreachable = (() => {
  throw new Error("unreachable");
}) as typeof fetch;

describe("a service account's delegated tokens", () => {
  it("signs an RS256 jwt-bearer assertion for the impersonated user, and caches each user's token", async () => {
    const { key, publicKey } = await serviceAccountKey();
    const endpoint = tokenEndpoint(publicKey);
    const now = { ms: START };
    const tokens = googleclassroom.serviceAccountTokens({ key: JSON.stringify(key), scopes: ROSTER, fetch: endpoint.fetch, clock: () => now.ms });
    const [a, b] = await Promise.all([tokens.token("admin@harbor.example"), tokens.token("admin@harbor.example")]);
    expect(a).toBe("ya29.delegated-1");
    expect(b).toBe(a);
    expect(await tokens.token("hb-teacher-asante@harbor.example")).toBe("ya29.delegated-2");
    expect(endpoint.seen).toHaveLength(2);
    const [first] = endpoint.seen;
    // The key's own token_uri is ignored: assertions only ever go to Google.
    expect(first!.url).toBe(googleclassroom.GOOGLE_TOKEN_URL);
    expect(first!.header).toEqual({ alg: "RS256", typ: "JWT", kid: "kid-1" });
    expect(first!.claims).toEqual({
      iss: key.client_email,
      sub: "admin@harbor.example",
      scope: ROSTER.join(" "),
      aud: googleclassroom.GOOGLE_TOKEN_URL,
      iat: START / 1000,
      exp: START / 1000 + 3600,
    });

    // Refreshed a minute before expiry, or after Google refuses the token.
    now.ms += 3599_000 - 59_000;
    expect(await tokens.token("admin@harbor.example")).toBe("ya29.delegated-3");
    tokens.invalidate("admin@harbor.example", "ya29.delegated-3");
    expect(await tokens.token("admin@harbor.example")).toBe("ya29.delegated-4");
  });

  it("fails as auth-failed when the domain has not delegated the scopes, without naming the key", async () => {
    const { key, publicKey } = await serviceAccountKey();
    const endpoint = tokenEndpoint(publicKey, { status: 401, error: "unauthorized_client" });
    const tokens = googleclassroom.serviceAccountTokens({ key, scopes: ROSTER, fetch: endpoint.fetch });
    const error = await tokens.token("admin@harbor.example").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RosterSyncError);
    expect((error as RosterSyncError).code).toBe("auth-failed");
    expect((error as Error).message).not.toContain("PRIVATE KEY");
    expect((error as Error).message).not.toContain(key.client_email);
  });

  it("retries a failing token endpoint, then fails as source-unavailable", async () => {
    const { key } = await serviceAccountKey();
    let calls = 0;
    const down = (async () => {
      calls++;
      return new Response("unavailable", { status: 503 });
    }) as typeof fetch;
    const tokens = googleclassroom.serviceAccountTokens({ key, scopes: ROSTER, fetch: down, sleep: async () => {} });
    expect(await rejection(tokens.token("admin@harbor.example"))).toBe("source-unavailable");
    expect(calls).toBe(4);
  });

  it("refuses a key that is not a service account key, and a subject that is not a Workspace email", async () => {
    const { key } = await serviceAccountKey();
    expect(() => googleclassroom.serviceAccountTokens({ key: { ...key, type: "authorized_user" }, scopes: ROSTER, fetch: unreachable })).toThrow(RosterSyncError);
    expect(() => googleclassroom.serviceAccountTokens({ key: "{not json", scopes: ROSTER, fetch: unreachable })).toThrow(RosterSyncError);
    const tokens = googleclassroom.serviceAccountTokens({ key, scopes: ROSTER, fetch: unreachable });
    expect(await rejection(tokens.token("104000000000000000101"))).toBe("internal-error");
  });
});

// ── Harbor: Classroom is the roster ──────────────────────────────────

describe("Harbor's Classroom roster sync", () => {
  const harbor = demoDistrict("harbor");

  it("imports courses, teachers and students into the directory it was seeded from", async () => {
    const { client, fake } = world(harbor);
    const { state, run, preview } = await synced(client);
    const imported = state.roster.snapshot;
    expect(checkDirectoryIntegrity(imported)).toEqual([]);
    expect(run).toMatchObject({ mode: "complete", outcome: "succeeded", quarantined: 0 });
    expect(preview!.issues.filter((i) => i.severity === "error")).toEqual([]);

    // Everyone on a Classroom roster arrives, under Google's issuer, with their Workspace email.
    // The administrator teaches nothing and the guardian has no account, so neither is imported.
    const onRoster = new Set<string>(harbor.directory.enrollments.filter((e) => e.status === "active").map((e) => e.principalId));
    const people = (s: DistrictDirectorySnapshot, only?: Set<string>) =>
      s.principals.filter((p) => only === undefined || only.has(p.id)).map((p) => `${p.displayName}|${p.kind}`).toSorted();
    expect(people(imported)).toEqual(people(harbor.directory, onRoster));
    for (const principal of imported.principals) {
      expect(principal.externalIdentities).toEqual([{ districtId: "dst_harbor", issuer: CLASSROOM_ISSUER, subject: expect.stringMatching(/^\d{21}$/) }]);
      expect(principal.email).toMatch(/^hb-[a-z-]+@harbor\.gedu\.example$/);
    }
    expect(enrollmentKeys(imported)).toEqual(enrollmentKeys(harbor.directory));
    expect(imported.schools.map((s) => `${s.name}|${s.gradeBands.join()}`).toSorted()).toEqual(["Harbor Charter High Campus|9-12", "Harbor Charter Middle Campus|6-8"]);
    const math7 = imported.offerings.find((o) => imported.courses.find((c) => c.id === o.courseId)!.title === "Math 7")!;
    expect(math7.schoolId).toBe(imported.schools.find((s) => s.name.includes("Middle"))!.id);
    // Ruth Delaney teaches at both campuses: one principal, teaching at each.
    const delaney = imported.principals.find((p) => p.displayName === "Ruth Delaney")!;
    const schools = imported.roleAssignments.filter((r) => r.principalId === delaney.id && r.scope.level !== "district").map((r) => ("schoolId" in r.scope ? r.scope.schoolId : ""));
    expect(new Set(schools).size).toBe(2);

    // The client followed page tokens, and read aliases because the configuration names a course by one.
    expect(fake.requests.some((r) => r.url.pathname.endsWith("/students") && r.url.searchParams.has("pageToken"))).toBe(true);
    expect(fake.requests.some((r) => r.url.pathname.endsWith("/aliases"))).toBe(true);
  });

  it("imports only listed courses in a shared domain, even with a default school", async () => {
    const { client, fake } = world(harbor);
    const batch = await googleclassroom.classroomRosterSource(client, {
      ...HARBOR_CONFIG,
      courseSelection: "listed",
    }).read({ mode: "complete" });
    expect(batch.issues).toEqual([]);
    expect(batch.feed["classes.csv"]).toHaveLength(1);
    expect(batch.feed["courses.csv"].map((c) => c.title)).toEqual(["Math 7"]);
    expect(batch.feed["users.csv"].map((u) => `${u.givenName} ${u.familyName}`).toSorted()).toEqual(["Rosa Iqbal", "Ruth Delaney", "Sami Torres"]);
    const rosterRequests = fake.requests.filter((r) => /\/(teachers|students)$/.test(r.url.pathname));
    expect(rosterRequests.length).toBeGreaterThan(0);
    const ids = new Set(batch.feed["classes.csv"].map((c) => c.sourcedId));
    expect(rosterRequests.every((r) => ids.has(r.url.pathname.split("/").at(-2)!))).toBe(true);
  });

  it("keeps conflicting school mappings as errors when reading listed courses", async () => {
    const { client } = world(harbor);
    const math = (await client.listCourses()).records.find((c) => c.name === "Math 7")!;
    const batch = await googleclassroom.classroomRosterSource(client, {
      ...HARBOR_CONFIG, courseSelection: "listed",
      schools: HARBOR_CONFIG.schools.map((s, i) => ({ ...s, courses: [i === 0 ? math.id : "d:off_hb-math7-b1"] })),
    }).read({ mode: "complete" });
    expect(batch.feed["classes.csv"]).toEqual([]);
    expect(batch.issues).toContainEqual(expect.objectContaining({ severity: "error", message: expect.stringContaining("more than one school") }));
  });

  it("is idempotent, and deactivates a student Classroom drops", async () => {
    const { client, fake } = world(harbor);
    const first = await synced(client);
    const again = await synced(client, first.state);
    expect(again.run.counts).toMatchObject({ principals: { added: 0, updated: 0, deactivated: 0 }, enrollments: { added: 0, updated: 0, deactivated: 0 } });
    expect(again.state.roster.snapshot).toEqual(first.state.roster.snapshot);

    fake.removeStudent("off_hb-math7-b1", "prn_hb-student-sami");
    const dropped = await synced(client, again.state);
    expect(dropped.run.counts.enrollments.deactivated).toBe(1);
    // Sami is on no other roster, so the principal goes inactive too: deactivated, never deleted.
    expect(dropped.state.roster.snapshot.principals.find((p) => p.displayName === "Sami Torres")!.status).toBe("inactive");
  });

  it("stops importing an archived course and keeps its offering", async () => {
    const { client, fake } = world(harbor);
    const first = await synced(client);
    fake.setCourseState("off_hb-gov-b3", "ARCHIVED");
    const { state } = await synced(client, first.state);
    const snapshot = state.roster.snapshot;
    const gov = snapshot.offerings.find((o) => snapshot.courses.find((c) => c.id === o.courseId)!.title === "US Government")!;
    expect(gov).toBeDefined();
    expect(snapshot.enrollments.filter((e) => e.offeringId === gov.id).map((e) => e.status)).toEqual(["inactive", "inactive"]);
  });

  it("quarantines a person who is a teacher in one course and a student in another", async () => {
    const { fake, tokens, seed } = world(harbor);
    // Classroom lists Owen Kerr, a student elsewhere, as a co-teacher of Math 7.
    const math7Teachers = `/v1/courses/${fake.courseId("off_hb-math7-b1")}/teachers`;
    const owen = { courseId: fake.courseId("off_hb-math7-b1"), userId: fake.userId("prn_hb-student-owen"), profile: { name: { givenName: "Owen", familyName: "Kerr", fullName: "Owen Kerr" } } };
    const coTeaching = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fake.fetch(input, init);
      if (new URL(String(input)).pathname !== math7Teachers) return response;
      const body = (await response.json()) as { teachers?: unknown[]; nextPageToken?: string };
      return Response.json(body.nextPageToken === undefined ? { ...body, teachers: [...(body.teachers ?? []), owen] } : body);
    }) as typeof fetch;
    const client = new googleclassroom.GoogleClassroomClient({ tokens, admin: emailOf(seed, "prn_hb-school-admin"), fetch: coTeaching, sleep: async () => {} });
    const { run, preview, state } = await synced(client);
    expect(run.quarantined).toBe(1);
    expect(preview!.quarantined).toEqual([expect.objectContaining({ sourcedId: owen.userId, reason: "conflicting-roles" })]);
    expect(state.roster.snapshot.principals.some((p) => p.displayName === "Owen Kerr")).toBe(false);
  });

  it("fails as auth-failed without a roster scope, and when Classroom data access is off", async () => {
    const narrow = await sync(world(harbor, { scopes: [S.coursesReadonly] }).client);
    expect(narrow.run).toMatchObject({ outcome: "failed", errorCode: "auth-failed" });
    expect(narrow.state.roster.snapshot.principals).toEqual([]);
    expect((await sync(world(harbor, { apiDisabled: true }).client)).run).toMatchObject({ outcome: "failed", errorCode: "auth-failed" });
  });

  it("is retried through a 429 with Retry-After and a 503, and fails when they outlast the retries", async () => {
    const flaky = world(harbor);
    flaky.fake.inject({ kind: "rate-limit", retryAfterSeconds: 7, times: 1, match: { path: "/students" } });
    flaky.fake.inject({ kind: "outage", status: 503, times: 1, match: { path: "/teachers" } });
    await synced(flaky.client);
    expect(flaky.sleeps).toContain(7000);
    expect(flaky.sleeps).toHaveLength(2);

    const limited = world(harbor);
    limited.fake.inject({ kind: "rate-limit", retryAfterSeconds: 1, match: { path: "/courses" } });
    expect((await sync(limited.client)).run).toMatchObject({ outcome: "failed", errorCode: "rate-limited" });
    const down = world(harbor);
    down.fake.inject({ kind: "outage", match: { path: "/students" } });
    expect((await sync(down.client)).run).toMatchObject({ outcome: "failed", errorCode: "source-unavailable" });
    const offline = world(harbor);
    offline.fake.inject({ kind: "network-error", match: { path: "/courses" } });
    expect((await sync(offline.client)).run).toMatchObject({ outcome: "failed", errorCode: "source-unavailable" });
  });

  it("rejects the whole feed over a malformed roster entry, rather than dropping that person", async () => {
    const { client, fake } = world(harbor);
    const first = await synced(client);
    fake.inject({ kind: "malformed-record", times: 1, match: { path: "/students" } });
    const { run, preview, state } = await sync(client, first.state);
    expect(run).toMatchObject({ outcome: "failed", errorCode: "feed-rejected" });
    expect(preview?.issues).toContainEqual(expect.objectContaining({ severity: "error", file: "enrollments.csv", message: expect.stringContaining("userId") }));
    expect(state).toBe(first.state);
  });

  it("fails as inconsistent paging when Classroom repeats a page token", async () => {
    const { seed, fake, tokens } = world(harbor);
    const looping = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fake.fetch(input, init);
      if (!new URL(String(input)).pathname.endsWith("/courses")) return response;
      return Response.json({ ...((await response.json()) as object), nextPageToken: "same" });
    }) as typeof fetch;
    const client = new googleclassroom.GoogleClassroomClient({ tokens, admin: emailOf(seed, "prn_hb-school-admin"), fetch: looping, sleep: async () => {} });
    expect((await sync(client)).run).toMatchObject({ outcome: "failed", errorCode: "inconsistent-paging" });
  });

  it("holds a large removal for an administrator, and applies exactly the approved one", async () => {
    const { client, fake } = world(harbor);
    const first = await synced(client);
    fake.inject({ kind: "large-removal", fraction: 0.5 });
    const held = await sync(client, first.state);
    expect(held.run).toMatchObject({ outcome: "failed", errorCode: "removal-held" });
    expect(held.state).toBe(first.state);
    let now = START;
    const approved = await oneroster.runRosterSync({
      state: first.state, source: googleclassroom.classroomRosterSource(client, HARBOR_CONFIG), mode: "complete",
      config: googleclassroom.CLASSROOM_IDENTITY, runId: "run-approved", clock: () => new Date((now += 1000)),
      approvedRemoval: held.held!.fingerprint,
    });
    expect(approved.run.outcome).toBe("succeeded");
    expect(approved.run.counts.principals.deactivated).toBe(3);
  });

  it("leaves out a roster member from outside the district's Workspace domains, with a warning", async () => {
    const base = classroomDistrictSeed(harbor);
    const seed: DistrictSeed = {
      ...base,
      people: [...base.people, { id: "hb-guest", role: "teacher", givenName: "Guest", familyName: "Speaker", email: "guest@visitors.example", schoolIds: [base.schools[0]!.id] }],
      sections: base.sections.map((s) => (s.id === "off_hb-marine-b1" ? { ...s, teacherIds: [...s.teacherIds, "hb-guest"] } : s)),
    };
    const { client } = world(harbor, { seed });
    let now = START;
    const { run, preview, state } = await oneroster.runRosterSync({
      state: emptyState(harbor.directory),
      source: googleclassroom.classroomRosterSource(client, { ...HARBOR_CONFIG, domains: [workspaceDomain(harbor)] }),
      mode: "complete", config: googleclassroom.CLASSROOM_IDENTITY, runId: "run-domains", clock: () => new Date((now += 1000)),
    });
    expect(run.outcome).toBe("succeeded");
    expect(preview!.issues).toContainEqual(expect.objectContaining({ severity: "warning", message: expect.stringContaining("outside the district's Workspace domains") }));
    expect(state.roster.snapshot.principals.some((p) => p.displayName === "Guest Speaker")).toBe(false);
  });

  it("refreshes a token Google rejects, once", async () => {
    const { client, fake, tokens } = world(harbor);
    const first = await synced(client);
    fake.revokeTokens();
    await synced(client, first.state);
    expect(tokens.issued.get("hb-school-admin@harbor.gedu.example")).toBe(2);
  });

  it("refuses a redirect rather than following it", async () => {
    const { seed, tokens } = world(harbor);
    const redirecting = (async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } })) as typeof fetch;
    const client = new googleclassroom.GoogleClassroomClient({ tokens, admin: emailOf(seed, "prn_hb-school-admin"), fetch: redirecting, sleep: async () => {} });
    expect((await sync(client)).run).toMatchObject({ outcome: "failed", errorCode: "invalid-response" });
  });

  it("fails as response-too-large past the list limit", async () => {
    const { seed, fake, tokens } = world(harbor);
    const client = new googleclassroom.GoogleClassroomClient({
      tokens, admin: emailOf(seed, "prn_hb-school-admin"), fetch: fake.fetch, sleep: async () => {},
      limits: { ...googleclassroom.DEFAULT_CLASSROOM_LIMITS, maxListItems: 2 },
    });
    expect((await sync(client)).run).toMatchObject({ outcome: "failed", errorCode: "response-too-large" });
  });

  it("refuses a configuration naming one course under two schools, and a delta", async () => {
    const { client } = world(harbor);
    expect(() => googleclassroom.classroomRosterSource(client, {
      ...HARBOR_CONFIG,
      schools: HARBOR_CONFIG.schools.map((s) => ({ ...s, courses: ["d:off_hb-math7-b1"] })),
    })).toThrow(RosterSyncError);
    const first = await synced(client);
    let now = START;
    const delta = await oneroster.runRosterSync({
      state: first.state, source: googleclassroom.classroomRosterSource(client, HARBOR_CONFIG), mode: "delta",
      config: googleclassroom.CLASSROOM_IDENTITY, runId: "run-delta", clock: () => new Date((now += 1000)),
    });
    expect(delta.run).toMatchObject({ outcome: "failed", errorCode: "delta-unsupported" });
  });
});

// ── Grades: coursework EducateOS creates, teacher-approved grades written back ──

async function harborGrades() {
  const w = world(demoDistrict("harbor"));
  const { state } = await synced(w.client);
  const directory = state.roster.snapshot;
  const marine = directory.offerings.find((o) => directory.courses.find((c) => c.id === o.courseId)!.title === "Marine Science")!.id;
  const routes: ClassroomGradeRoute[] = Object.entries(state.roster.sources.offerings).map(([offeringId, courseId]) => ({
    offeringId: offeringId as OfferingId, authority: "lms:hb-classroom", via: "google-classroom", courseId,
  }));
  const courseId = routes.find((r) => r.offeringId === marine)!.courseId;
  const routeStore = new InMemoryGradeRouteStore(routes);
  const provider = new googleclassroom.GoogleClassroomProvider(w.client);
  const approvals = new InMemoryGradeApprovalStore();
  const passback = new GradePassback({
    districtId: directory.district.id,
    directory: async () => directory,
    routes: routeStore,
    approvals,
    ledger: new InMemoryPassbackLedger(),
    sinks: [new ClassroomGradeSink(provider)],
    now: () => w.clock.ms,
  });
  const adapter = new ClassroomAdapter({ districtId: directory.district.id, provider, routes: routeStore, now: () => w.clock.ms });
  const principal = (name: string) => directory.principals.find((p) => p.displayName === name)!;
  /** Records Kwame Asante's approval of a Marine Science grade, and returns the passback request. */
  const approve = (column: string, studentName: string, scoreGiven: number, scoreMaximum = 20) => {
    const approval = {
      offeringId: marine, studentId: principal(studentName).id as PrincipalId, column, gradeVersion: 1, scoreGiven, scoreMaximum,
      approverId: principal("Kwame Asante").id as PrincipalId, approvedAt: new Date(w.clock.ms - 60_000).toISOString(),
    };
    approvals.record(approval);
    const { approverId: _approver, approvedAt: _at, ...request } = approval;
    return request;
  };
  return { ...w, provider, marine, courseId, adapter, passback, approve, principal };
}

describe("Harbor's grade sync", () => {
  it("creates coursework as the course owner, and writes a teacher-approved grade to it once", async () => {
    const { adapter, passback, approve, fake, marine, courseId, principal, tokens } = await harborGrades();
    const column = await adapter.createCourseWork(marine, { title: "Kelp forest lab", maxPoints: 20 });
    expect(fake.courseWorkOf(courseId).find((w) => w.id === column.id)).toMatchObject({
      title: "Kelp forest lab", state: "PUBLISHED", maxPoints: 20, associatedWithDeveloper: true, creatorUserId: fake.userId("prn_hb-teacher-asante"),
    });
    expect(tokens.issued.has("hb-teacher-asante@harbor.gedu.example")).toBe(true);
    // Only EducateOS's own coursework is a column: the teacher-made tide pool survey is not.
    expect((await adapter.courseWork(marine)).map((w) => w.title)).toEqual(["Kelp forest lab"]);

    const request = approve(column.id, "Nia Fontaine", 17.5);
    expect(await passback.publish(request)).toEqual({ status: "posted", route: "google-classroom" });
    expect(await passback.publish(request)).toEqual({ status: "already-posted", route: "google-classroom" });
    expect(fake.submission(fake.submissionId(column.id, "prn_hb-student-nia"))).toMatchObject({
      userId: principal("Nia Fontaine").externalIdentities[0]!.subject, assignedGrade: 17.5, draftGrade: 17.5,
    });
    const patches = fake.requests.filter((r) => r.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]!.url.searchParams.get("updateMask")).toBe("assignedGrade,draftGrade");
  });

  it("refuses coursework a teacher made, locally, before Google would", async () => {
    const { passback, approve, fake, provider, courseId } = await harborGrades();
    const teacherMade = fake.courseWorkId("hb-marine-tidepool");
    expect(await rejection(passback.publish(approve(teacherMade, "Nia Fontaine", 15)))).toBe("forbidden");
    expect(await rejection(provider.setAssignedGrade({ courseId, courseWorkId: teacherMade, userId: fake.userId("prn_hb-student-nia"), assignedGrade: 15 }))).toBe("forbidden");
    expect(fake.requests.filter((r) => r.method === "PATCH")).toEqual([]);
  });

  it("refuses a grade Classroom would round, and a missing coursework scope", async () => {
    const { adapter, provider, marine, courseId, fake } = await harborGrades();
    const column = await adapter.createCourseWork(marine, { title: "Quiz", maxPoints: 10 });
    expect(await rejection(provider.setAssignedGrade({ courseId, courseWorkId: column.id, userId: fake.userId("prn_hb-student-nia"), assignedGrade: 7.125 }))).toBe("validation-failed");
    const readOnly = new googleclassroom.GoogleClassroomProvider(world(demoDistrict("harbor"), { scopes: ROSTER }).client);
    expect(await rejection(readOnly.createCourseWork({ courseId, draft: { title: "Essay", maxPoints: 10 } }))).toBe("forbidden");
  });

  it("never sends a create twice, and finds coursework Google made when the answer was lost", async () => {
    const { seed, fake, tokens, courseId } = await harborGrades();
    const posts = () => fake.requests.filter((r) => r.method === "POST").length;
    // Google refuses before acting: nothing was made, and the 503 is not retried.
    fake.inject({ kind: "outage", times: 1, match: { method: "POST" } });
    const provider = new googleclassroom.GoogleClassroomProvider(new googleclassroom.GoogleClassroomClient({ tokens, admin: emailOf(seed, "prn_hb-school-admin"), fetch: fake.fetch, sleep: async () => {} }));
    expect(await rejection(provider.createCourseWork({ courseId, draft: { title: "Lab", maxPoints: 10 } }))).toBe("unavailable");
    expect(posts()).toBe(1);
    // Google acts, but the answer is lost: the column is found by its reference, not made again.
    const lossy = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fake.fetch(input, init);
      return init?.method === "POST" ? new Response("{}", { status: 502 }) : response;
    }) as typeof fetch;
    const lost = new googleclassroom.GoogleClassroomProvider(new googleclassroom.GoogleClassroomClient({ tokens, admin: emailOf(seed, "prn_hb-school-admin"), fetch: lossy, sleep: async () => {} }));
    const found = await lost.createCourseWork({ courseId, draft: { title: "Lab", maxPoints: 10 } });
    expect(posts()).toBe(2);
    expect(fake.courseWorkOf(courseId).filter((w) => w.title === "Lab").map((w) => w.id)).toEqual([found.id]);
  });

  it("is unavailable when Classroom keeps failing, and when its data access is off", async () => {
    const { courseId } = await harborGrades();
    const down = world(demoDistrict("harbor"));
    down.fake.inject({ kind: "outage" });
    expect(await rejection(new googleclassroom.GoogleClassroomProvider(down.client).listRoster(courseId))).toBe("unavailable");
    const off = world(demoDistrict("harbor"), { apiDisabled: true });
    expect(await rejection(new googleclassroom.GoogleClassroomProvider(off.client).listRoster(courseId))).toBe("unavailable");
  });
});

// ── Cedar Valley: Clever is the roster, Classroom the LMS ────────────

describe("Cedar Valley's Classroom course linking", () => {
  const cedarvalley = demoDistrict("cedarvalley");
  const trusting = DistrictDirectorySnapshot.parse({
    ...cedarvalley.directory,
    district: { ...cedarvalley.directory.district, trustedIssuers: [...cedarvalley.directory.district.trustedIssuers, CLASSROOM_ISSUER] },
  });
  const plan = (client: googleclassroom.GoogleClassroomClient) => googleclassroom.planClassroomLinks({ directory: cedarvalley.directory, client });

  it("links every course to its Clever-rostered offering by alias, and every member by name, creating nobody", async () => {
    const { client } = world(cedarvalley);
    const proposed = await plan(client);
    expect(proposed.unresolved).toEqual([]);
    expect(proposed.courses.map((c) => `${c.offeringId}|${c.basis}`).toSorted()).toEqual([
      "off_cv-alg1-p3|alias", "off_cv-earthsci-p1|alias", "off_cv-eng8-p2|alias", "off_cv-whist7-p4|alias",
    ]);
    // The Workspace accounts are on their own domain, so no email matches or contradicts: names decide.
    expect(proposed.identities.every((i) => i.basis === "name")).toBe(true);
    const onRoster = new Set<string>(cedarvalley.directory.enrollments.filter((e) => e.status === "active").map((e) => e.principalId));
    expect(proposed.identities.map((i) => i.principalId).toSorted()).toEqual([...onRoster].toSorted());

    const { directory, routes } = googleclassroom.applyClassroomLinks({ directory: trusting, courses: proposed.courses, identities: proposed.identities, authority: "lms:cv-classroom", acceptNameMatches: true });
    expect(directory.principals).toHaveLength(cedarvalley.directory.principals.length);
    expect(checkDirectoryIntegrity(directory)).toEqual([]);
    expect(directory.principals.find((p) => p.id === "prn_cv-teacher-whitaker")!.externalIdentities.map((i) => i.issuer))
      .toEqual(["https://clever.cedarvalley.example", CLASSROOM_ISSUER]);
    expect(routes).toHaveLength(4);

    // Planning again over the linked directory proposes nothing new.
    const again = await googleclassroom.planClassroomLinks({ directory, client });
    expect(again.identities).toEqual([]);
    expect(again.unresolved).toEqual([]);
  });

  it("needs the district to trust Google before linking accounts", async () => {
    const proposed = await plan(world(cedarvalley).client);
    expect(() => googleclassroom.applyClassroomLinks({ directory: cedarvalley.directory, courses: proposed.courses, identities: proposed.identities, authority: "lms:cv-classroom" }))
      .toThrow(expect.objectContaining({ code: "conflict" }));
  });

  it("proposes a course without an alias by name and section, and links neither of two accounts matching one person", async () => {
    const base = classroomDistrictSeed(cedarvalley);
    const seed: DistrictSeed = {
      ...base,
      sections: base.sections.map((s) => (s.id === "off_cv-eng8-p2" ? { ...s, aliases: [] } : s)),
      // Bao's Workspace account is named like An's, so only an email could tell the twins apart.
      people: base.people.map((p) => (p.id === "prn_cv-student-bao" ? { ...p, givenName: "An" } : p)),
    };
    const proposed = await plan(world(cedarvalley, { seed }).client);
    expect(proposed.courses.find((c) => c.offeringId === "off_cv-eng8-p2")!.basis).toBe("name-and-section");
    // Both accounts match An by name, so neither is proposed.
    expect(proposed.unresolved.map((u) => u.reason)).toContain("inconsistent-match");
    expect(proposed.identities.some((i) => i.principalId === "prn_cv-student-an" || i.principalId === "prn_cv-student-bao")).toBe(false);
  });

  it("links by Workspace email where it is the directory's, and refuses a name match the email contradicts", async () => {
    const base = classroomDistrictSeed(cedarvalley);
    const seed: DistrictSeed = {
      ...base,
      people: base.people.map((p) =>
        p.id === "prn_cv-teacher-whitaker" ? { ...p, email: "dana.whitaker@cedarvalley.example" }
          // A namesake's account: Rowan's name, an address on the directory's own domain that is not Rowan's.
          : p.id === "prn_cv-student-rowan" ? { ...p, email: "rowan.ellis2@cedarvalley.example" } : p),
    };
    const rowan = DistrictDirectorySnapshot.parse({
      ...cedarvalley.directory,
      principals: cedarvalley.directory.principals.map((p) => (p.id === "prn_cv-student-rowan" ? { ...p, email: "rowan.ellis@cedarvalley.example" } : p)),
    });
    const proposed = await googleclassroom.planClassroomLinks({ directory: rowan, client: world(cedarvalley, { seed }).client });
    expect(proposed.identities.find((i) => i.principalId === "prn_cv-teacher-whitaker")!.basis).toBe("email");
    expect(proposed.identities.some((i) => i.principalId === "prn_cv-student-rowan")).toBe(false);
    expect(proposed.unresolved.filter((u) => u.reason === "email-mismatch")).not.toHaveLength(0);
  });

  it("re-checks every accepted link against the directory, refusing what the plan would not propose", async () => {
    const proposed = await plan(world(cedarvalley).client);
    const apply = (identities: googleclassroom.ClassroomIdentityLink[], acceptNameMatches = true) =>
      () => googleclassroom.applyClassroomLinks({ directory: trusting, courses: proposed.courses, identities, authority: "lms:cv-classroom", acceptNameMatches });
    const isaac = proposed.identities.find((i) => i.principalId === "prn_cv-student-isaac")!;
    const earthSci = proposed.courses.find((c) => c.offeringId === "off_cv-earthsci-p1")!.courseId;
    const refused = { code: "conflict" };
    expect(apply([isaac], false)).toThrow(expect.objectContaining(refused));
    expect(apply([{ ...isaac, subject: "not-a-google-id" }])).toThrow(expect.objectContaining(refused));
    // Isaac is not enrolled in Earth Science; the district admin is enrolled nowhere and an admin.
    expect(apply([{ ...isaac, courseId: earthSci }])).toThrow(expect.objectContaining(refused));
    expect(apply([{ ...isaac, principalId: "prn_cv-district-admin" as PrincipalId }])).toThrow(expect.objectContaining(refused));
    expect(apply([{ ...isaac, courseId: "999999999999" }])).toThrow(expect.objectContaining(refused));
    expect(apply([isaac, { ...isaac, principalId: "prn_cv-student-leila" as PrincipalId }])).toThrow(expect.objectContaining(refused));
    expect(apply([isaac])().directory.principals.find((p) => p.id === "prn_cv-student-isaac")!.externalIdentities).toHaveLength(2);
  });

  it("publishes a teacher-approved grade for a linked Clever student", async () => {
    const { client, fake, clock } = world(cedarvalley);
    const proposed = await plan(client);
    const { directory, routes } = googleclassroom.applyClassroomLinks({ directory: trusting, courses: proposed.courses, identities: proposed.identities, authority: "lms:cv-classroom", acceptNameMatches: true });
    const routeStore = new InMemoryGradeRouteStore(routes);
    const provider = new googleclassroom.GoogleClassroomProvider(client);
    const offering = "off_cv-alg1-p3" as OfferingId;
    const column = await new ClassroomAdapter({ districtId: directory.district.id, provider, routes: routeStore }).createCourseWork(offering, { title: "Linear equations", maxPoints: 10 });
    const approval = {
      offeringId: offering, studentId: "prn_cv-student-isaac" as PrincipalId, column: column.id, gradeVersion: 1, scoreGiven: 9, scoreMaximum: 10,
      approverId: "prn_cv-teacher-whitaker" as PrincipalId, approvedAt: new Date(clock.ms - 60_000).toISOString(),
    };
    const passback = new GradePassback({
      districtId: directory.district.id, directory: async () => directory, routes: routeStore,
      approvals: new InMemoryGradeApprovalStore([approval]), ledger: new InMemoryPassbackLedger(), sinks: [new ClassroomGradeSink(provider)], now: () => clock.ms,
    });
    const { approverId: _approver, approvedAt: _at, ...request } = approval;
    expect(await passback.publish(request)).toEqual({ status: "posted", route: "google-classroom" });
    expect(fake.submission(fake.submissionId(column.id, "prn_cv-student-isaac"))).toMatchObject({ assignedGrade: 9 });
  });
});
