// The admin surface: refused without a valid Access assertion (and entirely when its audience is not
// configured), then credentials, faults and reset.
import { createExecutionContext, env, evictDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { generateKeyPair, exportJWK } from "jose";
import { oneroster } from "@educateos/integrations";
import worker from "./worker.ts";
import { ORIGIN } from "./constants.ts";
import { admin, assertion, call, clientFetch, credentials } from "./helpers.ts";

describe("admin access", () => {
  it("refuses a request without an assertion, with a foreign key, another audience or another issuer", async () => {
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    const foreign = { ...(await exportJWK(privateKey)), kid: "test-access-key" };
    const attempts: Record<string, string>[] = [
      {},
      { "cf-access-jwt-assertion": "not-a-jwt" },
      { "cf-access-jwt-assertion": await assertion({ key: foreign }) },
      { "cf-access-jwt-assertion": await assertion({ audience: "another-application" }) },
      { "cf-access-jwt-assertion": await assertion({ issuer: "https://someone-else.cloudflareaccess.com" }) },
      { "cf-access-jwt-assertion": await assertion({ withoutExpiry: true }) },
    ];
    for (const headers of attempts) {
      for (const path of ["/_admin/riverbend/credentials", "/_admin/riverbend/reset"]) {
        const answer = await call(path, { method: path.endsWith("reset") ? "POST" : "GET", headers });
        expect(answer.status, `${path} ${JSON.stringify(Object.keys(headers))}`).toBe(403);
        expect(answer.text).not.toContain("clientSecret");
      }
    }
  });

  it("refuses everything when the audience is not configured, even a valid assertion", async () => {
    const request = new Request(`${ORIGIN}/_admin/riverbend/credentials`, { headers: { "cf-access-jwt-assertion": await assertion() } });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request as Request<unknown, IncomingRequestCfProperties>, { ...env, ADMIN_ACCESS_AUD: "" }, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(403);
    await response.text();
  });

  it("404s an unknown district or path once admitted", async () => {
    expect((await admin("nowhere/credentials")).status).toBe(404);
    expect((await admin("riverbend/nothing-here")).status).toBe(404);
    expect((await admin("prairie/lti/canvas/tools")).status).toBe(404);
  });
});

describe("credentials", () => {
  it("are derived from the secret, stable across a restart, and distinct per district", async () => {
    const before = await credentials("lakeshore");
    expect(before.oneroster.clientId).toMatch(/^[0-9a-f]{32}$/);
    expect(before.classlink.oidc.clientId).toMatch(/^c\d{13}$/);
    expect(before.lti.schoology.issuer).toBe(`${ORIGIN}/lakeshore/lti/schoology`);
    await evictDurableObject(env.DISTRICTS.getByName("lakeshore"));
    expect(await credentials("lakeshore")).toEqual(before);
    const riverbend = await credentials("riverbend");
    expect(riverbend.oneroster.clientSecret).not.toBe(before.oneroster.clientSecret);
    const harbor = await credentials("harbor");
    expect(harbor.google.oidc.clientId).toMatch(/^\d{12}-[a-z0-9]{32}\.apps\.googleusercontent\.com$/);
    expect(harbor.google.oidc.clientSecret).toMatch(/^GOCSPX-/);
  });
});

describe("faults and reset", () => {
  const usersUrl = `${ORIGIN}/lakeshore/oneroster/ims/oneroster/rostering/v1p2/users`;

  async function rosterClient(ip: string) {
    const { oneroster: server } = await credentials("lakeshore");
    return new oneroster.OneRosterRestClient({
      config: { baseUrl: server.baseUrl, tokenUrl: server.tokenUrl, scopes: [oneroster.ROSTER_CORE_READONLY_SCOPE], pageSize: 100 },
      credentials: { clientId: server.clientId, clientSecret: server.clientSecret },
      fetch: clientFetch(ip),
      sleep: async () => {},
    });
  }

  it("injects an outage on one fake, lists it, and takes it out", async () => {
    const injected = await admin("lakeshore/faults", { method: "POST", body: JSON.stringify({ vendor: "oneroster", kind: "outage", status: 503, match: { path: "/users" } }) });
    expect(injected.status).toBe(201);
    const { id } = injected.json<{ id: string }>();
    const client = await rosterClient("192.0.2.60");
    await expect(client.list("users")).rejects.toThrow();
    expect((await client.list("orgs")).records.length).toBeGreaterThan(0);
    expect((await admin("lakeshore/faults")).json().faults).toEqual([expect.objectContaining({ id, vendor: "oneroster", kind: "outage" })]);
    expect((await admin(`lakeshore/faults/${id}`, { method: "DELETE" })).status).toBe(200);
    expect((await client.list("users")).issues).toEqual([]);
  });

  it("applies a rate limit and a malformed record, and clears every fault at once", async () => {
    await admin("lakeshore/faults", { method: "POST", body: JSON.stringify({ kind: "rate-limit", retryAfterSeconds: 7 }) });
    const limited = await call("/lakeshore/classlink/.well-known/openid-configuration", { ip: "192.0.2.61" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("7");
    expect((await admin("lakeshore/faults", { method: "DELETE" })).status).toBe(200);
    expect((await call("/lakeshore/classlink/.well-known/openid-configuration", { ip: "192.0.2.61" })).status).toBe(200);
    await admin("lakeshore/faults", { method: "POST", body: JSON.stringify({ vendor: "oneroster", kind: "malformed-record", times: 1 }) });
    const read = await (await rosterClient("192.0.2.62")).list("users");
    expect(read.issues.length).toBeGreaterThan(0);
  });

  it("refuses a fault it cannot serve, or one for a fake the district lacks", async () => {
    for (const body of [{ kind: "network-error" }, { kind: "outage", status: 418 }, { kind: "large-removal", fraction: 2 }, { kind: "outage", vendor: "clever" }, "[]"]) {
      const answer = await admin("lakeshore/faults", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
      expect(answer.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("removes a large share of the roster until a reset restores the seed", async () => {
    const client = await rosterClient("192.0.2.63");
    const activeStudents = async () => (await client.list("users")).records.filter((u) => u.status === "active" && u.roles.some((r) => r.role === "student")).length;
    const before = await activeStudents();
    expect((await admin("lakeshore/faults", { method: "POST", body: JSON.stringify({ kind: "large-removal", fraction: 0.5 }) })).status).toBe(201);
    expect(await activeStudents()).toBe(before - Math.ceil(before * 0.5));
    const reset = await admin("lakeshore/reset", { method: "POST" });
    expect(reset.status).toBe(200);
    expect(await activeStudents()).toBe(before);
    // A token issued before the reset belongs to fakes that are gone.
    expect((await call(usersUrl, { ip: "192.0.2.63", headers: { authorization: "Bearer or2_stale" } })).status).toBe(401);
  });
});

describe("Classroom tokens", () => {
  it("mints a token for a person, and refuses an unknown scope", async () => {
    const teacher = "harbor";
    const status = await admin(`${teacher}/credentials`);
    expect(status.status).toBe(200);
    const { seedOf } = await import("../src/fakes.ts");
    const person = seedOf("harbor").people.find((p) => p.role === "teacher")!;
    const minted = await admin("harbor/classroom/tokens", { method: "POST", body: JSON.stringify({ personId: person.id }) });
    expect(minted.status).toBe(201);
    const courses = await call(`${ORIGIN}/harbor/classroom/v1/courses?teacherId=me`, { ip: "192.0.2.70", headers: { authorization: `Bearer ${minted.json().access_token}` } });
    expect(courses.status).toBe(200);
    expect((await admin("harbor/classroom/tokens", { method: "POST", body: JSON.stringify({ personId: person.id, scopes: ["https://www.googleapis.com/auth/drive"] }) })).status).toBe(400);
    expect((await admin("riverbend/classroom/tokens", { method: "POST", body: JSON.stringify({ personId: person.id }) })).status).toBe(404);
  });
});
