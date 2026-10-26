// The OneRoster REST client, roster source and sync runner, unchanged, against the wire-faithful
// OneRoster 1.2 fake from @educateos/provider-fakes seeded with its sample district: a complete
// sync, a delta after mutations, retried 429s and 5xx, a malformed record, and a large removal.
import { DistrictDirectorySnapshot, IntegrationSyncRun } from "@educateos/contracts";
import { NORTHFIELD } from "@educateos/fixtures";
import { DEFAULT_ONEROSTER_CLIENT, OneRosterFake, SAMPLE_DISTRICT } from "@educateos/provider-fakes";
import { describe, expect, it } from "vitest";
import { oneroster } from "../src/index.ts";

const CONFIG: oneroster.OneRosterImportConfig = { issuer: NORTHFIELD.district.trustedIssuers[0]!, subject: { field: "username" } };
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

function setup() {
  const clock = { ms: START };
  const fake = new OneRosterFake({ seed: SAMPLE_DISTRICT, now: () => clock.ms });
  const sleeps: number[] = [];
  const client = new oneroster.OneRosterRestClient({
    config: { baseUrl: fake.baseUrl, tokenUrl: fake.tokenUrl, scopes: [oneroster.ROSTER_CORE_READONLY_SCOPE], pageSize: 4 },
    credentials: DEFAULT_ONEROSTER_CLIENT,
    fetch: fake.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    clock: () => clock.ms,
  });
  return { fake, clock, sleeps, client, source: oneroster.restRosterSource(client) };
}

async function sync(state: oneroster.RosterSyncState, source: ReturnType<typeof setup>["source"], mode: "complete" | "delta" = "complete") {
  let now = START;
  const result = await oneroster.runRosterSync({ state, source, mode, config: CONFIG, runId: `run-${mode}`, clock: () => new Date((now += 1000)) });
  expect(IntegrationSyncRun.parse(result.run)).toEqual(result.run);
  return result;
}

async function synced(state: oneroster.RosterSyncState, source: ReturnType<typeof setup>["source"], mode: "complete" | "delta" = "complete") {
  const result = await sync(state, source, mode);
  if (result.run.outcome !== "succeeded") throw new Error(JSON.stringify(result.preview?.issues ?? result.run, null, 2));
  return result;
}

function principalOf(state: oneroster.RosterSyncState, sourcedId: string) {
  const id = Object.entries(state.roster.sources.principals).find(([, s]) => s.sourcedId === sourcedId)![0];
  return state.roster.snapshot.principals.find((p) => p.id === id)!;
}

const activePrincipals = (state: oneroster.RosterSyncState) => state.roster.snapshot.principals.filter((p) => p.status === "active").length;

describe("the OneRoster provider fake", () => {
  it("passes the client's strict 1.2 schemas in every collection", async () => {
    const { client, fake } = setup();
    for (const collection of oneroster.ROSTER_COLLECTIONS) {
      const read = await client.list(collection);
      expect(read.issues).toEqual([]);
      expect(read.records).toHaveLength(fake.records(collection).length);
    }
  });

  it("serves a complete sync of the sample district", async () => {
    const { source, fake } = setup();
    const { state, run } = await synced(EMPTY, source);
    expect(run).toMatchObject({ mode: "complete", outcome: "succeeded", quarantined: 0 });
    expect(run.counts.enrollments.added).toBe(25);
    expect(principalOf(state, "mw-s-01").displayName).toBe("Ada Brightwater");
    // pageSize 4: the client followed Link next through every page of every collection.
    expect(fake.requestsTo("/enrollments").map((r) => r.url.searchParams.get("offset"))).toEqual(["0", "4", "8", "12", "16", "20", "24"]);
    expect(fake.tokens.issued).toBe(1);
  });

  it("serves a delta after mutations: an update and a removal", async () => {
    const { source, fake, clock } = setup();
    const { state } = await synced(EMPTY, source);
    clock.ms = Date.parse("2026-10-21T09:00:00Z");
    fake.upsert("users", { ...fake.record("users", "mw-s-02"), givenName: "Bonnie" });
    fake.remove("users", "mw-s-03");
    fake.requests.length = 0;

    const { state: next, run } = await synced(state, source, "delta");
    expect(principalOf(next, "mw-s-02").displayName).toBe("Bonnie Calder");
    expect(principalOf(next, "mw-s-03").status).not.toBe("active");
    expect(run.counts.principals).toEqual({ added: 0, updated: 1, deactivated: 1 });
    expect(run.counts.enrollments.deactivated).toBe(2);
    const filters = new Set(fake.requests.filter((r) => r.method === "GET").map((r) => r.url.searchParams.get("filter")));
    expect(filters).toEqual(new Set([`dateLastModified>='${new Date(Date.parse(SAMPLE_DISTRICT.modified) - oneroster.DELTA_OVERLAP_MS).toISOString()}'`]));
    expect(next.cursors?.["users.csv"]).toBe(new Date(clock.ms - oneroster.DELTA_OVERLAP_MS).toISOString());
  });

  it("is retried through a 429 with Retry-After and a 5xx", async () => {
    const { source, fake, sleeps } = setup();
    fake.inject({ kind: "rate-limit", retryAfterSeconds: 3, times: 1, match: { path: "/users" } });
    fake.inject({ kind: "outage", status: 503, times: 1, match: { path: "/classes" } });
    await synced(EMPTY, source);
    expect(sleeps).toContain(3000);
    expect(sleeps).toHaveLength(2);
  });

  it("fails the sync as source-unavailable when the outage outlasts the retries", async () => {
    const { source, fake } = setup();
    fake.inject({ kind: "outage", match: { path: "/users" } });
    expect((await sync(EMPTY, source)).run).toMatchObject({ outcome: "failed", errorCode: "source-unavailable" });
  });

  it("reports a malformed record as an issue that rejects the feed", async () => {
    const { source, fake } = setup();
    fake.inject({ kind: "malformed-record", times: 1, match: { path: "/users" } });
    const { run, preview } = await sync(EMPTY, source);
    expect(run).toMatchObject({ outcome: "failed", errorCode: "feed-rejected" });
    expect(preview?.issues).toContainEqual(expect.objectContaining({ severity: "error", file: "users.csv", sourcedId: "mw-admin-varga" }));
  });

  // The sync has no mass-removal guard: a delta listing half the students as tobedeleted applies
  // in full. This pins today's behaviour so that adding a guard is a visible change.
  it("applies a large removal in full: there is no safety threshold", async () => {
    const { source, fake, clock } = setup();
    const { state } = await synced(EMPTY, source);
    const before = activePrincipals(state);
    clock.ms = Date.parse("2026-10-21T09:00:00Z");
    fake.inject({ kind: "large-removal", fraction: 0.5 });
    const { state: next, run } = await synced(state, source, "delta");
    expect(run.counts.principals.deactivated).toBe(5);
    expect(run.counts.enrollments.deactivated).toBe(10);
    expect(activePrincipals(next)).toBe(before - 5);
  });
});
