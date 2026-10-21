import { DistrictDirectorySnapshot, checkDirectoryIntegrity, IntegrationSyncRun } from "@schoolos/contracts";
import { NORTHFIELD } from "@schoolos/fixtures";
import { describe, expect, it } from "vitest";
import { oneroster } from "../src/index.ts";
import type { RosterSource } from "../src/index.ts";
import { loadExport } from "./fixtures/load.ts";
import { DEMOGRAPHICS_SENTINEL, PASSWORD_SENTINEL } from "./fixtures/northfield-export.ts";
import type { Variant } from "./fixtures/northfield-export.ts";
import { CREDENTIALS, FakeOneRosterServer, MODIFIED, ORIGIN, TOKEN_URL, northfieldRest } from "./fixtures/northfield-rest.ts";

const CONFIG: oneroster.OneRosterImportConfig = { issuer: "https://idp.northfield.example", subject: { field: "username" } };
const START = Date.parse("2026-10-20T15:00:00Z");

const EMPTY: oneroster.RosterSyncState = {
  roster: {
    snapshot: DistrictDirectorySnapshot.parse({
      district: NORTHFIELD.district,
      schools: [],
      terms: [],
      courses: [],
      offerings: [],
      principals: [],
      enrollments: [],
      roleAssignments: [],
    }),
    sources: oneroster.EMPTY_SOURCE_MAP,
  },
};

/** A clock that ticks one second per reading, so every run's timestamps are reproducible. */
function tickingClock(start = START) {
  let now = start;
  return () => new Date((now += 1000));
}

function restSource(server: FakeOneRosterServer, pageSize = 4) {
  return oneroster.restRosterSource(new oneroster.OneRosterRestClient({
    config: { baseUrl: ORIGIN, tokenUrl: TOKEN_URL, scopes: [oneroster.ROSTER_CORE_READONLY_SCOPE], pageSize },
    credentials: CREDENTIALS,
    fetch: server.fetch,
    sleep: async () => {},
  }));
}

async function sync(state: oneroster.RosterSyncState, source: RosterSource, mode: "complete" | "delta" = "complete", runId = "run-1") {
  const result = await oneroster.runRosterSync({ state, source, mode, config: CONFIG, runId, clock: tickingClock() });
  expect(IntegrationSyncRun.parse(result.run)).toEqual(result.run);
  return result;
}

async function synced(state: oneroster.RosterSyncState, source: RosterSource, mode: "complete" | "delta" = "complete") {
  const result = await sync(state, source, mode);
  if (result.run.outcome !== "succeeded") throw new Error(JSON.stringify(result.preview?.issues ?? result.run, null, 2));
  return result;
}

function principalOf(state: oneroster.RosterSyncState, sourcedId: string) {
  const entry = Object.entries(state.roster.sources.principals).find(([, s]) => s.sourcedId === sourcedId)!;
  const principal = state.roster.snapshot.principals.find((p) => p.id === entry[0])!;
  return { id: entry[0], active: principal.status === "active", principal };
}

function enrollmentOf(state: oneroster.RosterSyncState, sourcedId: string) {
  const id = Object.entries(state.roster.sources.enrollments).find(([, s]) => s === sourcedId)![0];
  return state.roster.snapshot.enrollments.find((e) => e.id === id)!;
}

function totalChanges(run: IntegrationSyncRun): number {
  return Object.values(run.counts).reduce((sum, c) => sum + Object.values(c).reduce((a: number, b: number) => a + b, 0), 0);
}

const byKey = (items: readonly unknown[]) => items.toSorted((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));

/** A snapshot with every list in ID order, so two sources' results compare whatever order they listed records in. */
function normalized(snapshot: DistrictDirectorySnapshot) {
  return Object.fromEntries(Object.entries(snapshot).map(([k, v]) => [k, Array.isArray(v) ? byKey(v) : v]));
}

/** Both sources, serving the same variant of the district. */
const SOURCES: [string, (variant: Variant) => RosterSource][] = [
  ["CSV", (variant) => oneroster.csvRosterSource(loadExport(variant))],
  ["REST", (variant) => restSource(new FakeOneRosterServer(northfieldRest(variant)))],
];

describe.each(SOURCES)("a complete sync from the %s source", (_name, sourceOf) => {
  it("builds the Northfield directory", async () => {
    const { state, run } = await synced(EMPTY, sourceOf("northfield"));
    expect(checkDirectoryIntegrity(state.roster.snapshot)).toEqual([]);
    expect(state.roster.snapshot.principals.map((p) => p.displayName).toSorted())
      .toEqual(NORTHFIELD.principals.map((p) => p.displayName).toSorted());
    expect(run).toMatchObject({ mode: "complete", outcome: "succeeded", quarantined: 0 });
    expect(run.counts.principals.added).toBe(11);
    expect(run.counts.enrollments.added).toBe(17);
  });

  it("changes nothing when run again over an unchanged roster", async () => {
    const first = await synced(EMPTY, sourceOf("northfield"));
    const second = await synced(first.state, sourceOf("northfield"));
    expect(totalChanges(second.run)).toBe(0);
    expect(second.state).toEqual(first.state);
  });

  it("deactivates a user the roster no longer lists, and their enrollment", async () => {
    const first = await synced(EMPTY, sourceOf("northfield"));
    const { state, run } = await synced(first.state, sourceOf("dropped-student"));
    expect(principalOf(state, "u-felix").active).toBe(false);
    expect(enrollmentOf(state, "e-17").status).toBe("inactive");
    expect(run.counts.principals).toEqual({ added: 0, updated: 0, deactivated: 1 });
  });

  it("holds back a quarantined user and counts them", async () => {
    const { run, state } = await synced(EMPTY, sourceOf("duplicate-username"));
    expect(run.quarantined).toBe(2);
    expect(Object.values(state.roster.sources.principals).map((s) => s.sourcedId)).not.toContain("u-elena");
  });
});

describe("swapping sources", () => {
  it("gives the same directory from the CSV export and the REST server", async () => {
    const [csv, rest] = await Promise.all(SOURCES.map(([, sourceOf]) => synced(EMPTY, sourceOf("northfield"))));
    expect(normalized(rest!.state.roster.snapshot)).toEqual(normalized(csv!.state.roster.snapshot));
    expect(rest!.state.roster.sources).toEqual(csv!.state.roster.sources);
  });

  it("lets a REST complete sync take over from a CSV import with no changes", async () => {
    const fromCsv = await synced(EMPTY, oneroster.csvRosterSource(loadExport("northfield")));
    const fromRest = await synced(fromCsv.state, restSource(new FakeOneRosterServer()));
    expect(totalChanges(fromRest.run)).toBe(0);
    expect(fromRest.state.cursor).toBe(MODIFIED);
  });

  it("is deterministic: the same state and source give the same run and state", async () => {
    const [a, b] = await Promise.all([1, 2].map(() => synced(EMPTY, restSource(new FakeOneRosterServer()))));
    expect(b).toEqual(a);
  });

  it("never reads demographics or keeps a password or phone number", async () => {
    const server = new FakeOneRosterServer();
    const { state } = await synced(EMPTY, restSource(server));
    expect(server.received.some((r) => r.url.pathname.includes("demographics"))).toBe(false);
    const kept = JSON.stringify(state);
    expect(kept).not.toContain(PASSWORD_SENTINEL);
    expect(kept).not.toContain("555-0100");
    expect(kept).not.toContain(DEMOGRAPHICS_SENTINEL);
  });
});

/** A REST server and the state a complete sync of it leaves. */
async function baseline() {
  const server = new FakeOneRosterServer();
  const { state } = await synced(EMPTY, restSource(server));
  expect(state.cursor).toBe(MODIFIED);
  return { server, state };
}

describe("a delta sync", () => {
  const LATER = "2026-10-15T08:30:00.000Z";

  it("asks only for records modified since the cursor", async () => {
    const { server, state } = await baseline();
    server.received.length = 0;
    await synced(state, restSource(server), "delta");
    const filters = server.received.filter((r) => r.method === "GET").map((r) => r.url.searchParams.get("filter"));
    expect(new Set(filters)).toEqual(new Set([`dateLastModified>='${MODIFIED}'`]));
  });

  it("updates the records it lists and advances the cursor", async () => {
    const { server, state } = await baseline();
    server.upsert("users", { ...server.record("users", "u-amara"), givenName: "Amarachi", dateLastModified: LATER });
    const { state: next, run } = await synced(state, restSource(server), "delta");
    expect(principalOf(next, "u-amara").principal.displayName).toBe("Amarachi Okafor");
    expect(run.counts.principals).toEqual({ added: 0, updated: 1, deactivated: 0 });
    expect(run.cursor).toBe(LATER);
    expect(next.cursor).toBe(LATER);
  });

  it("never deactivates a record because the delta does not list it", async () => {
    const { server, state } = await baseline();
    // Felix vanishes from the server, and one unrelated record changes so the delta is not empty.
    server.collections.users = server.collections.users.filter((u) => u.sourcedId !== "u-felix");
    server.collections.enrollments = server.collections.enrollments.filter((e) => e.sourcedId !== "e-17");
    server.upsert("users", { ...server.record("users", "u-dmitri"), dateLastModified: LATER });
    const { state: next, run } = await synced(state, restSource(server), "delta");
    expect(principalOf(next, "u-felix").active).toBe(true);
    expect(enrollmentOf(next, "e-17").status).toBe("active");
    expect(run.counts.principals.deactivated + run.counts.enrollments.deactivated).toBe(0);
  });

  it("deactivates a record it marks tobedeleted", async () => {
    const { server, state } = await baseline();
    server.upsert("users", { ...server.record("users", "u-felix"), status: "tobedeleted", dateLastModified: LATER });
    const { state: next, run } = await synced(state, restSource(server), "delta");
    expect(principalOf(next, "u-felix").active).toBe(false);
    expect(enrollmentOf(next, "e-17").status).toBe("inactive");
    expect(run.counts.principals.deactivated).toBe(1);
  });

  it("adds a new enrollment while keeping every unlisted one", async () => {
    const { server, state } = await baseline();
    server.upsert("enrollments", {
      ...server.record("enrollments", "e-13"),
      sourcedId: "e-18",
      user: { ...(server.record("enrollments", "e-13").user as object), sourcedId: "u-amara" },
      dateLastModified: LATER,
    });
    const { state: next, run } = await synced(state, restSource(server), "delta");
    expect(enrollmentOf(next, "e-18").status).toBe("active");
    expect(run.counts.enrollments).toEqual({ added: 1, updated: 0, deactivated: 0 });
    expect(next.roster.snapshot.enrollments).toHaveLength(18);
  });

  it("changes nothing when the same delta runs again", async () => {
    const { server, state } = await baseline();
    server.upsert("users", { ...server.record("users", "u-felix"), status: "tobedeleted", dateLastModified: LATER });
    const once = await synced(state, restSource(server), "delta");
    const twice = await synced(once.state, restSource(server), "delta");
    expect(totalChanges(twice.run)).toBe(0);
    expect(twice.state).toEqual(once.state);
  });

  it("is refused before any complete sync, and from a CSV source", async () => {
    expect((await sync(EMPTY, restSource(new FakeOneRosterServer()), "delta")).run.errorCode).toBe("no-baseline");
    const { state } = await synced(EMPTY, oneroster.csvRosterSource(loadExport("northfield")));
    expect((await sync(state, oneroster.csvRosterSource(loadExport("northfield")), "delta")).run.errorCode)
      .toBe("delta-unsupported");
  });
});

const usersOutage = (r: { url: URL }) => (r.url.pathname.endsWith("/users") ? new Response(null, { status: 503 }) : undefined);

describe("a failed sync", () => {
  const LATER = "2026-10-15T08:30:00.000Z";

  it("leaves the state and cursor where they were, and the next run catches up", async () => {
    const server = new FakeOneRosterServer();
    const { state } = await synced(EMPTY, restSource(server));
    server.upsert("users", { ...server.record("users", "u-felix"), status: "tobedeleted", dateLastModified: LATER });
    // Orgs to classes read fine; users keeps failing.
    server.persistentFaults.push(usersOutage);

    const failed = await sync(state, restSource(server), "delta", "run-2");
    expect(failed.run).toMatchObject({ outcome: "failed", errorCode: "source-unavailable", cursor: MODIFIED });
    expect(failed.run.quarantined).toBeUndefined();
    expect(totalChanges(failed.run)).toBe(0);
    expect(failed.state).toBe(state);

    server.persistentFaults.length = 0;
    const recovered = await synced(failed.state, restSource(server), "delta");
    expect(principalOf(recovered.state, "u-felix").active).toBe(false);
    expect(recovered.state.cursor).toBe(LATER);
  });

  it("records a feed that does not apply as rejected, with nothing applied", async () => {
    const server = new FakeOneRosterServer();
    const { state } = await synced(EMPTY, restSource(server));
    // An enrollment naming a user the server never lists blocks the whole feed.
    server.upsert("enrollments", {
      ...server.record("enrollments", "e-13"),
      user: { ...(server.record("enrollments", "e-13").user as object), sourcedId: "u-nobody" },
      dateLastModified: LATER,
    });
    const { run, state: after, preview } = await sync(state, restSource(server), "delta");
    expect(run).toMatchObject({ outcome: "failed", errorCode: "feed-rejected", cursor: MODIFIED, quarantined: 0 });
    expect(after).toBe(state);
    expect(preview?.issues).toContainEqual(expect.objectContaining({ file: "enrollments.csv", sourcedId: "e-13", column: "userSourcedId" }));
  });

  it("records a record that fails validation as rejected, naming it", async () => {
    const server = new FakeOneRosterServer();
    server.upsert("users", { ...server.record("users", "u-chen"), nickname: "RC" });
    const { run, preview } = await sync(EMPTY, restSource(server));
    expect(run.errorCode).toBe("feed-rejected");
    expect(preview?.issues).toContainEqual(expect.objectContaining({ severity: "error", file: "users.csv", sourcedId: "u-chen" }));
  });
});
