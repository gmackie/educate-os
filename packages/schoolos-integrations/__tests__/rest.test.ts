import { describe, expect, it } from "vitest";
import { RosterSyncError, oneroster } from "../src/index.ts";
import { CREDENTIALS, FakeOneRosterServer, ORIGIN, TOKEN_URL } from "./fixtures/northfield-rest.ts";

const CONFIG = { baseUrl: ORIGIN, tokenUrl: TOKEN_URL, scopes: [oneroster.ROSTER_CORE_READONLY_SCOPE], pageSize: 4 };

function clientFor(server: FakeOneRosterServer, options: Partial<oneroster.OneRosterRestClientOptions> & { now?: { ms: number } } = {}) {
  const sleeps: number[] = [];
  const now = options.now ?? { ms: Date.parse("2026-10-20T15:00:00Z") };
  const client = new oneroster.OneRosterRestClient({
    config: CONFIG,
    credentials: CREDENTIALS,
    fetch: server.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    clock: () => now.ms,
    ...options,
  });
  return { client, sleeps, now };
}

async function failure(promise: Promise<unknown>): Promise<RosterSyncError> {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(RosterSyncError);
  return error as RosterSyncError;
}

const gets = (server: FakeOneRosterServer, collection: string) =>
  server.received.filter((r) => r.method === "GET" && r.url.pathname.endsWith(`/${collection}`));

describe("paging", () => {
  it("follows Link headers to the last page", async () => {
    const server = new FakeOneRosterServer();
    const { records } = await clientFor(server).client.list("enrollments");
    expect(records.map((r) => r.sourcedId)).toEqual(server.collections.enrollments.map((e) => e.sourcedId).toSorted());
    expect(gets(server, "enrollments").map((r) => r.url.searchParams.get("offset"))).toEqual(["0", "4", "8", "12", "16"]);
  });

  it("pages by X-Total-Count alone, when the server caps the page below the size asked", async () => {
    const server = new FakeOneRosterServer();
    server.headers.link = false;
    server.maxPageSize = 3;
    const { records } = await clientFor(server).client.list("enrollments");
    expect(records).toHaveLength(17);
    expect(gets(server, "enrollments").map((r) => r.url.searchParams.get("offset"))).toEqual(["0", "3", "6", "9", "12", "15"]);
  });

  it("reads until an empty page when the server sends neither header", async () => {
    const server = new FakeOneRosterServer();
    server.headers = { link: false, total: false };
    const { records } = await clientFor(server).client.list("enrollments");
    expect(records).toHaveLength(17);
    expect(gets(server, "enrollments").at(-1)?.url.searchParams.get("offset")).toBe("17");
  });

  it("fails a collection that changed under the read rather than miss a record", async () => {
    const server = new FakeOneRosterServer();
    // After the first page, a record ahead of the cursor is removed, shifting every later one.
    server.faults.push((r) => {
      if (r.url.searchParams.get("offset") === "4") server.collections.enrollments.splice(0, 1);
      return undefined;
    });
    expect((await failure(clientFor(server).client.list("enrollments"))).code).toBe("inconsistent-paging");
  });

  it("fails on a record listed twice", async () => {
    const server = new FakeOneRosterServer();
    server.faults.push((r) => {
      if (r.url.searchParams.get("offset") === "4") server.collections.enrollments.unshift({ sourcedId: "e-00" });
      return undefined;
    });
    expect((await failure(clientFor(server).client.list("enrollments"))).code).toBe("inconsistent-paging");
  });

  it("refuses a Link to another origin, and never sends the token there", async () => {
    const server = new FakeOneRosterServer();
    server.faults.push((r) =>
      r.url.pathname.endsWith("/orgs")
        ? Response.json({ orgs: [] }, { headers: { link: '<https://elsewhere.example/ims/oneroster/rostering/v1p2/orgs?offset=4>; rel="next"' } })
        : undefined
    );
    expect((await failure(clientFor(server).client.list("orgs"))).code).toBe("invalid-response");
    expect(server.received.some((r) => r.url.origin !== ORIGIN)).toBe(false);
  });

  it("sends the filter, sort and paging parameters", async () => {
    const server = new FakeOneRosterServer();
    await clientFor(server).client.list("users", { filter: "dateLastModified>='2026-10-01T00:00:00.000Z'" });
    const params = Object.fromEntries(gets(server, "users")[0]!.url.searchParams);
    expect(params).toEqual({ limit: "4", offset: "0", sort: "sourcedId", orderBy: "asc", filter: "dateLastModified>='2026-10-01T00:00:00.000Z'" });
  });
});

describe("authentication", () => {
  it("authenticates with HTTP Basic and the configured scopes, and reuses the token", async () => {
    const server = new FakeOneRosterServer();
    const { client } = clientFor(server);
    for (const collection of oneroster.ROSTER_COLLECTIONS) await client.list(collection);
    expect(server.tokensIssued).toBe(1);
    const token = server.received.find((r) => r.url.href === TOKEN_URL)!;
    expect(new URLSearchParams(token.body)).toEqual(new URLSearchParams({ grant_type: "client_credentials", scope: oneroster.ROSTER_CORE_READONLY_SCOPE }));
    expect(token.body).not.toContain(CREDENTIALS.clientSecret);
  });

  it("refreshes a token before it expires", async () => {
    const server = new FakeOneRosterServer();
    server.tokenLifetimeSeconds = 600;
    const { client, now } = clientFor(server);
    await client.list("orgs");
    now.ms += 530_000;
    await client.list("orgs");
    expect(server.tokensIssued).toBe(1);
    now.ms += 20_000;
    await client.list("orgs");
    expect(server.tokensIssued).toBe(2);
  });

  it("refreshes once when the server rejects a cached token", async () => {
    const server = new FakeOneRosterServer();
    const { client } = clientFor(server);
    await client.list("orgs");
    server.revokeTokens();
    const { records } = await client.list("orgs");
    expect(records).toHaveLength(3);
    expect(server.tokensIssued).toBe(2);
  });

  it("fails as auth-failed when the new token is rejected too, or the client is refused", async () => {
    const server = new FakeOneRosterServer();
    server.persistentFaults.push((r) => (r.url.href === TOKEN_URL ? undefined : new Response(null, { status: 401 })));
    expect((await failure(clientFor(server).client.list("orgs"))).code).toBe("auth-failed");
    expect(server.tokensIssued).toBe(2);

    const refused = new FakeOneRosterServer();
    const error = await failure(clientFor(refused, { credentials: { ...CREDENTIALS, clientSecret: "wrong-secret" } }).client.list("orgs"));
    expect(error.code).toBe("auth-failed");
  });

  it("keeps secrets and tokens out of every error", async () => {
    const server = new FakeOneRosterServer();
    // A token endpoint that echoes what it was sent, as some do in their error bodies.
    server.faults.push((r) => new Response(`bad request: ${r.authorization} ${r.body}`, { status: 500 }));
    server.faults.push((r) => new Response(`bad request: ${r.authorization} ${r.body}`, { status: 500 }));
    server.faults.push((r) => new Response(`bad request: ${r.authorization} ${r.body}`, { status: 500 }));
    server.faults.push((r) => new Response(`bad request: ${r.authorization} ${r.body}`, { status: 500 }));
    const tokenError = await failure(clientFor(server).client.list("orgs"));

    const after = new FakeOneRosterServer();
    after.faults.push((r) => (r.url.href === TOKEN_URL ? undefined : new Response(`token ${r.authorization} refused`, { status: 403 })));
    const listError = await failure(clientFor(after).client.list("orgs"));

    for (const error of [tokenError, listError]) {
      const text = `${error.message} ${error.stack} ${JSON.stringify(error)}`;
      expect(text).not.toContain(CREDENTIALS.clientSecret);
      expect(text).not.toContain(btoa(`${CREDENTIALS.clientId}:${CREDENTIALS.clientSecret}`));
      expect(text).not.toContain("token-1");
    }
    expect(listError.code).toBe("auth-failed");
  });
});

describe("retries", () => {
  it("waits as long as Retry-After asks after a 429, then succeeds", async () => {
    const server = new FakeOneRosterServer();
    server.faults.push((r) => (r.url.pathname.endsWith("/orgs") ? new Response(null, { status: 429, headers: { "retry-after": "3" } }) : undefined));
    const { client, sleeps } = clientFor(server);
    expect((await client.list("orgs")).records).toHaveLength(3);
    expect(sleeps).toEqual([3000]);
  });

  it("caps a long Retry-After, and gives up after the last attempt", async () => {
    const server = new FakeOneRosterServer();
    server.persistentFaults.push((r) =>
      r.url.pathname.endsWith("/orgs") ? new Response(null, { status: 429, headers: { "retry-after": "86400" } }) : undefined
    );
    const { client, sleeps } = clientFor(server);
    expect((await failure(client.list("orgs"))).code).toBe("rate-limited");
    expect(sleeps).toEqual([30_000, 30_000, 30_000]);
    expect(gets(server, "orgs")).toHaveLength(4);
  });

  it("backs off exponentially from server errors and network failures", async () => {
    const server = new FakeOneRosterServer();
    server.faults.push((r) => (r.url.pathname.endsWith("/orgs") ? new Response(null, { status: 503 }) : undefined));
    let down = true;
    server.faults.push((r) => {
      if (down && r.url.pathname.endsWith("/orgs")) {
        down = false;
        throw new TypeError("network down");
      }
      return undefined;
    });
    const { client, sleeps } = clientFor(server);
    expect((await client.list("orgs")).records).toHaveLength(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it("reads Retry-After as seconds or an HTTP date, ignoring anything else", () => {
    const now = Date.parse("2026-10-20T15:00:00Z");
    expect(oneroster.parseRetryAfter("120", now)).toBe(120_000);
    expect(oneroster.parseRetryAfter("Tue, 20 Oct 2026 15:00:10 GMT", now)).toBe(10_000);
    expect(oneroster.parseRetryAfter("Tue, 20 Oct 2026 14:00:00 GMT", now)).toBe(0);
    for (const bad of ["-1", "1.5", "soon", ""]) expect(oneroster.parseRetryAfter(bad, now)).toBeUndefined();
  });
});

describe("responses", () => {
  const limits = { ...oneroster.DEFAULT_REST_LIMITS, maxResponseBytes: 2048 };

  it("rejects a response larger than the cap, declared or streamed", async () => {
    const big = JSON.stringify({ orgs: [{ name: "x".repeat(4096) }] });
    const declared = new FakeOneRosterServer();
    declared.faults.push((r) => (r.url.pathname.endsWith("/orgs") ? new Response(big, { headers: { "content-length": String(big.length) } }) : undefined));
    expect((await failure(clientFor(declared, { limits }).client.list("orgs"))).code).toBe("response-too-large");

    const streamed = new FakeOneRosterServer();
    streamed.faults.push((r) => {
      if (!r.url.pathname.endsWith("/orgs")) return undefined;
      const chunk = new TextEncoder().encode(big.slice(0, 1024));
      let sent = 0;
      // An endless body: the client must stop reading at the cap.
      return new Response(new ReadableStream({ pull: (c) => void (sent++ < 1_000_000 && c.enqueue(chunk)) }));
    });
    expect((await failure(clientFor(streamed, { limits }).client.list("orgs"))).code).toBe("response-too-large");
  });

  it("rejects a page that is not the collection's list", async () => {
    for (const body of [{ users: [] }, { orgs: [], statusInfoSet: [] }, [1, 2]]) {
      const server = new FakeOneRosterServer();
      server.faults.push((r) => (r.url.pathname.endsWith("/orgs") ? Response.json(body) : undefined));
      expect((await failure(clientFor(server).client.list("orgs"))).code).toBe("invalid-response");
    }
  });

  it("reports a record with an unknown field, keeping the valid ones", async () => {
    const server = new FakeOneRosterServer();
    server.upsert("orgs", { ...server.record("orgs", "org-nf-high"), region: "north" });
    const { records, issues } = await clientFor(server).client.list("orgs");
    expect(records).toHaveLength(2);
    expect(issues).toEqual([expect.objectContaining({ severity: "error", file: "orgs.csv", sourcedId: "org-nf-high" })]);
  });

  it("admits only HTTPS endpoints", () => {
    for (const config of [{ ...CONFIG, baseUrl: "http://sis.northfield.example" }, { ...CONFIG, tokenUrl: "http://sis.northfield.example/oauth/token" }]) {
      expect(() => new oneroster.OneRosterRestClient({ config, credentials: CREDENTIALS, fetch: new FakeOneRosterServer().fetch })).toThrow(RosterSyncError);
    }
  });

  it("refuses to read a collection outside the rostering set", async () => {
    const server = new FakeOneRosterServer();
    const list = clientFor(server).client.list as (c: string) => Promise<unknown>;
    expect((await failure(list.call(clientFor(server).client, "demographics"))).code).toBe("internal-error");
    expect(server.received).toEqual([]);
  });
});
