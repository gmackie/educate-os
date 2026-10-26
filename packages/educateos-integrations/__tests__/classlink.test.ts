// SCHO-204: the OneRoster REST client's OAuth 2.0 client-credentials profile as ClassLink's Roster
// Server uses it, against the SCHO-201 OneRoster fake: the token endpoint, both client
// authentication methods, token caching, refresh on expiry and on 401, scopes, faults, and no
// secret or token in any error, run record or log line.
import { DEFAULT_ONEROSTER_CLIENT, OneRosterFake, ROSTER_CORE_READONLY, ROSTER_DEMOGRAPHICS_READONLY, SAMPLE_DISTRICT, type OneRosterFakeOptions } from "@educateos/provider-fakes";
import { DistrictDirectorySnapshot, EducateOsError } from "@educateos/contracts";
import { NORTHFIELD } from "@educateos/fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RosterSyncError, classlink, oneroster } from "../src/index.ts";

const START = Date.parse("2026-10-20T15:00:00Z");
const SERVER = "https://maplewood-vn-v2.rosterserver.example";

function setup(options: Partial<OneRosterFakeOptions> = {}, connection: Partial<classlink.ClassLinkRosterOptions["connection"]> = {}, credentials = DEFAULT_ONEROSTER_CLIENT) {
  const clock = { ms: START };
  const fake = new OneRosterFake({ seed: SAMPLE_DISTRICT, now: () => clock.ms, baseUrl: SERVER, ...options });
  const sleeps: number[] = [];
  const config = classlink.classLinkRosterConfig({ tenantId: "2041", serverUrl: SERVER, ...connection }, 4);
  const client = new oneroster.OneRosterRestClient({
    config,
    credentials,
    fetch: fake.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    clock: () => clock.ms,
  });
  return { fake, clock, sleeps, client, tokenRequests: () => fake.requests.filter((r) => r.method === "POST") };
}

const EMPTY: oneroster.RosterSyncState = {
  roster: {
    snapshot: DistrictDirectorySnapshot.parse({ district: NORTHFIELD.district, schools: [], terms: [], courses: [], offerings: [], principals: [], enrollments: [], roleAssignments: [] }),
    sources: oneroster.EMPTY_SOURCE_MAP,
  },
};

async function caught(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("classLinkRosterConfig", () => {
  it("puts the token endpoint at the server URL plus /token, below any path prefix", () => {
    expect(classlink.classLinkRosterConfig({ tenantId: "2041", serverUrl: SERVER })).toEqual({
      baseUrl: SERVER,
      tokenUrl: `${SERVER}/token`,
      scopes: [ROSTER_CORE_READONLY],
      clientAuthentication: "client_secret_basic",
    });
    expect(classlink.classLinkRosterConfig({ tenantId: "2041", serverUrl: `${SERVER}/district/`, tokenPath: "/oauth/token" }).tokenUrl).toBe(`${SERVER}/district/oauth/token`);
  });

  it("refuses a connection that is not HTTPS or names no tenant", () => {
    expect(() => classlink.classLinkRosterConfig({ tenantId: "2041", serverUrl: "http://plain.example" })).toThrow(RosterSyncError);
    expect(() => classlink.classLinkRosterConfig({ tenantId: "acme", serverUrl: SERVER })).toThrow(RosterSyncError);
  });
});

describe("the OneRoster client's OAuth 2.0 profile, against the ClassLink Roster Server fake", () => {
  it("requests one token for a whole read, with HTTP Basic and the configured scope", async () => {
    const { client, fake, tokenRequests } = setup();
    for (const collection of oneroster.ROSTER_COLLECTIONS) await client.list(collection);
    expect(fake.tokens.issued).toBe(1);
    const [token] = tokenRequests();
    expect(token!.url.href).toBe(`${SERVER}/token`);
    expect(token!.headers.get("authorization")).toBe(`Basic ${btoa(`${DEFAULT_ONEROSTER_CLIENT.clientId}:${DEFAULT_ONEROSTER_CLIENT.clientSecret}`)}`);
    expect(Object.fromEntries(new URLSearchParams(token!.body))).toEqual({ grant_type: "client_credentials", scope: ROSTER_CORE_READONLY });
  });

  it("sends the credentials in the form body for client_secret_post", async () => {
    const { client, tokenRequests } = setup({}, { clientAuthentication: "client_secret_post" });
    await client.list("orgs");
    const [token] = tokenRequests();
    expect(token!.headers.get("authorization")).toBeNull();
    expect(Object.fromEntries(new URLSearchParams(token!.body))).toEqual({
      grant_type: "client_credentials",
      scope: ROSTER_CORE_READONLY,
      client_id: DEFAULT_ONEROSTER_CLIENT.clientId,
      client_secret: DEFAULT_ONEROSTER_CLIENT.clientSecret,
    });
  });

  it("refreshes the token before it expires", async () => {
    const { client, fake, clock } = setup({ tokenLifetimeSeconds: 300 });
    await client.list("orgs");
    clock.ms += 200_000;
    await client.list("orgs");
    expect(fake.tokens.issued).toBe(1);
    // Past the refresh point (a minute before expiry), the next read gets a new token first.
    clock.ms += 50_000;
    await client.list("orgs");
    expect(fake.tokens.issued).toBe(2);
  });

  it("refreshes once on a 401, and fails as auth-failed when the new token is refused too", async () => {
    const { client, fake } = setup();
    await client.list("orgs");
    fake.tokens.revokeAll();
    expect((await client.list("users")).issues).toEqual([]);
    expect(fake.tokens.issued).toBe(2);

    // A server that rejects every token: one refresh, then the read fails.
    const rejecting = setup();
    const always401 = new oneroster.OneRosterRestClient({
      config: classlink.classLinkRosterConfig({ tenantId: "2041", serverUrl: SERVER }),
      credentials: DEFAULT_ONEROSTER_CLIENT,
      fetch: async (input, init) => {
        if (init?.method === "GET") rejecting.fake.tokens.revokeAll();
        return rejecting.fake.fetch(input, init);
      },
      sleep: async () => {},
    });
    expect(await caught(always401.list("orgs"))).toMatchObject({ code: "auth-failed", message: "GET orgs failed with HTTP 401" });
    expect(rejecting.fake.tokens.issued).toBe(2);
  });

  it("asks for the scopes configured, and fails as auth-failed for a scope the client may not have", async () => {
    const granted = setup({ clients: [{ ...DEFAULT_ONEROSTER_CLIENT, scopes: [ROSTER_CORE_READONLY, ROSTER_DEMOGRAPHICS_READONLY] }] }, { scopes: [ROSTER_CORE_READONLY, ROSTER_DEMOGRAPHICS_READONLY] });
    await granted.client.list("orgs");
    expect(new URLSearchParams(granted.tokenRequests()[0]!.body).get("scope")).toBe(`${ROSTER_CORE_READONLY} ${ROSTER_DEMOGRAPHICS_READONLY}`);

    const refused = setup({}, { scopes: [ROSTER_CORE_READONLY, ROSTER_DEMOGRAPHICS_READONLY] });
    expect(await caught(refused.client.list("orgs"))).toMatchObject({ code: "auth-failed", message: "token request failed with HTTP 400" });
  });

  it("retries the token endpoint through a 429 and a 503", async () => {
    const { client, fake, sleeps } = setup();
    fake.inject({ kind: "rate-limit", retryAfterSeconds: 2, times: 1, match: { path: "/token" } });
    fake.inject({ kind: "outage", status: 503, times: 1, match: { path: "/token" } });
    await client.list("orgs");
    expect(sleeps).toContain(2000);
    expect(fake.tokens.issued).toBe(1);
  });

  it("fails a sync as source-unavailable when the token endpoint stays down", async () => {
    const { client, fake } = setup();
    fake.inject({ kind: "network-error", match: { path: "/token" } });
    const result = await oneroster.runRosterSync({
      state: EMPTY,
      source: oneroster.restRosterSource(client),
      mode: "complete",
      config: { issuer: NORTHFIELD.district.trustedIssuers[0]!, subject: { field: "username" } },
      runId: "run-1",
      clock: () => new Date(START),
    });
    expect(result.run).toMatchObject({ outcome: "failed", errorCode: "source-unavailable" });
  });
});

describe("secrets", () => {
  it("never puts a client secret or token in an error, a run record or a log line", async () => {
    const logged: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : JSON.stringify(a))).join(" "));
      });
    }
    const wrong = { clientId: DEFAULT_ONEROSTER_CLIENT.clientId, clientSecret: "SYNTHETIC-WRONG-SECRET-ee21" };
    const { client, fake } = setup({}, {}, wrong);
    const refused = await caught(client.list("orgs"));
    expect(refused).toMatchObject({ code: "auth-failed", message: "token request failed with HTTP 401" });

    const good = setup();
    await good.client.list("orgs");
    const token = good.fake.requests.find((r) => r.method === "GET")!.headers.get("authorization")!.slice("Bearer ".length);
    good.fake.inject({ kind: "outage", match: { path: "/users" } });
    const result = await oneroster.runRosterSync({
      state: EMPTY,
      source: oneroster.restRosterSource(good.client),
      mode: "complete",
      config: { issuer: NORTHFIELD.district.trustedIssuers[0]!, subject: { field: "username" } },
      runId: "run-1",
      clock: () => new Date(START),
    });
    expect(result.run.outcome).toBe("failed");

    const everything = [String(refused), refused.stack ?? "", JSON.stringify(result), ...logged].join("\n");
    for (const secret of [wrong.clientSecret, DEFAULT_ONEROSTER_CLIENT.clientSecret, token, btoa(`${wrong.clientId}:${wrong.clientSecret}`)]) {
      expect(everything).not.toContain(secret);
    }
    expect(fake.tokens.issued).toBe(0);
  });

  it("names a missing Worker secret binding, never a value", () => {
    const error = (() => {
      try {
        classlink.classLinkRosterCredentials({ CLASSLINK_ONEROSTER_CLIENT_ID: "lakeshore-educateos" });
      } catch (e) {
        return e as RosterSyncError;
      }
    })();
    expect(error).toMatchObject({ code: "auth-failed", message: "the ClassLink roster credentials are not bound: set the Worker secrets CLASSLINK_ONEROSTER_CLIENT_SECRET" });
    expect(error?.message).not.toContain("lakeshore-educateos");
    expect(() => classlink.classLinkSsoClientSecret({})).toThrow(EducateOsError);
    expect(classlink.classLinkRosterCredentials({ CLASSLINK_ONEROSTER_CLIENT_ID: "id", CLASSLINK_ONEROSTER_CLIENT_SECRET: "s" })).toEqual({ clientId: "id", clientSecret: "s" });
  });
});
