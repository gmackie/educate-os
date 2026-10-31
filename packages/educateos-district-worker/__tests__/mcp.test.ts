// The organization MCP endpoint (SCHO-174) end to end in workerd: a synthetic authorization server
// (standing in for Nathan, NATH-6) issues access tokens, the official MCP client speaks 2026-07-28
// to the deployed Worker, and the district decides every call from its own records: identity links,
// the teacher's delegation (IF-06) and the live directory.
import { createExecutionContext, env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT, type JWK, type JWTPayload } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { NORTHFIELD } from "@educateos/fixtures";
import { ROUTES, routePath } from "@educateos/district-app/routes";
import worker from "../src/worker.ts";
import { ACCESS_AUDIENCE, ACCESS_ISSUER, MCP_ISSUER, MCP_ORIGIN, mcpSubject, TEST_CONFIG } from "./fixtures.ts";

const MORGAN = NORTHFIELD.principals.find((p) => p.id === "prn_nf-morgan-lee")!;
const RIVERA = NORTHFIELD.principals.find((p) => p.id === "prn_nf-teacher-rivera")!;
const BIO = NORTHFIELD.offerings.find((o) => o.id === "off_nf-bio-fall-p2")!;
const RESOURCE = `${MCP_ORIGIN}/mcp`;
const district = () => env.DISTRICT.getByName(NORTHFIELD.district.id);

/** Read-only access to Morgan's Biology P2 offering and its roster. */
const CEILING = {
  scope: { level: "offering", districtId: BIO.districtId, schoolId: BIO.schoolId, offeringId: BIO.id },
  actions: ["read", "list", "invoke-tool"],
  kinds: ["offering", "enrollment"],
  classifications: ["course", "district-internal"],
};

/** A teacher's own call to the district API, signed in through Access. */
async function asTeacher(principal: typeof MORGAN, name: "teacher.issueDelegation" | "teacher.revokeDelegation", input: { params?: Record<string, string>; body?: unknown }) {
  const key = await importJWK(JSON.parse(env.TEST_ACCESS_PRIVATE_JWK) as JWK, "RS256");
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ iss: ACCESS_ISSUER, aud: ACCESS_AUDIENCE, sub: principal.externalIdentities[0]!.subject, iat: now, exp: now + 300 })
    .setProtectedHeader({ alg: "RS256", kid: "test-access-key" }).sign(key);
  const spec = ROUTES[name];
  const response = await SELF.fetch(new URL(routePath(spec.path, input.params), MCP_ORIGIN), {
    method: spec.method,
    headers: { "content-type": "application/json", "cf-access-jwt-assertion": assertion },
    body: JSON.stringify(input.body ?? {}),
  });
  expect(response.status).toBeLessThan(300);
  return response.json() as Promise<{ id: string }>;
}

/** A delegation from `principal` to a client of its own, so no two tests share one. */
async function delegate(principal = MORGAN) {
  const clientId = `https://planner.example/${crypto.randomUUID()}/client.json`;
  const delegation = await asTeacher(principal, "teacher.issueDelegation", {
    body: { client: { issuer: MCP_ISSUER, clientId }, ceiling: CEILING, durationHours: 1 },
  });
  return { clientId, delegation };
}

/** An access token as the synthetic authorization server issues it; `claims` override the defaults. */
async function token(principal: typeof MORGAN, clientId: string, claims: JWTPayload = {}) {
  const key = await importJWK(JSON.parse(env.TEST_MCP_ISSUER_PRIVATE_JWK) as JWK, "ES256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: MCP_ISSUER, sub: mcpSubject(principal.id), aud: RESOURCE, iat: now, exp: now + 300, client_id: clientId, scope: "mcp:tools", ...claims })
    .setProtectedHeader({ alg: "ES256", typ: "at+jwt", kid: "test-mcp-key" }).sign(key);
}

/** The official MCP client, connected to the deployed Worker with `bearer`, recording each response's status. */
async function connect(bearer: string) {
  const statuses: number[] = [];
  const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
    fetch: async (url, init) => {
      const response = await SELF.fetch(new Request(url, init));
      statuses.push(response.status);
      return response;
    },
  });
  const client = new Client({ name: "district-conformance", version: "1" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(transport);
  return { client, statuses };
}
const outcome = async (client: Client, name: string, args: Record<string, unknown>) =>
  JSON.parse(((await client.callTool({ name, arguments: args })).content as { text: string }[])[0]!.text) as { status: string; error?: { code: string } };

/** One `/mcp` POST with `bearer`, for refusals no client gets past. */
const post = (bearer: string | undefined) => SELF.fetch(RESOURCE, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
});

/** Rewrites Morgan's stored directory record, as a roster sync or an administrator would. */
async function changeMorgan(change: Record<string, unknown>) {
  await runInDurableObject(district(), (_instance, state) => {
    const row = state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM academic_principals WHERE id = ?", MORGAN.id).one();
    state.storage.sql.exec("UPDATE academic_principals SET record_json = ? WHERE id = ?", JSON.stringify({ ...JSON.parse(row.record_json), ...change }), MORGAN.id);
  });
}
const SEEDED_MORGAN = TEST_CONFIG.directory.principals.find((p) => p.id === MORGAN.id)!;
afterEach(async () => { await changeMorgan(SEEDED_MORGAN); });

describe("the organization MCP endpoint (SCHO-174)", () => {
  it("publishes RFC 9728 metadata naming the configured issuer, and challenges a missing token with it", async () => {
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      const response = await SELF.fetch(`${MCP_ORIGIN}${path}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ resource: RESOURCE, authorization_servers: [MCP_ISSUER], scopes_supported: ["mcp:tools"], bearer_methods_supported: ["header"] });
    }
    const challenged = await post(undefined);
    expect(challenged.status).toBe(401);
    expect(challenged.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${MCP_ORIGIN}/.well-known/oauth-protected-resource/mcp", scope="mcp:tools"`);
  });

  it("serves nothing when the configuration leaves it off", async () => {
    const { mcp: _mcp, ...off } = TEST_CONFIG;
    for (const path of ["/mcp", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const response = await worker.fetch!(new Request(`${MCP_ORIGIN}${path}`, { method: path === "/mcp" ? "POST" : "GET" }) as never, { ...env, DISTRICT_CONFIG: JSON.stringify(off) }, createExecutionContext());
      expect(response.status).toBe(404);
    }
  });

  it("lets a delegated client discover, list and call tools inside the ceiling, and refuses one outside it", async () => {
    const { clientId } = await delegate();
    const { client } = await connect(await token(MORGAN, clientId));
    expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["get_offering", "get_roster", "update_course"]));
    // The curated catalog leaves out approvals, deletes, identity links and exports.
    expect(names.some((n) => /approve|delete|identity|export|grade/.test(n))).toBe(false);
    expect(await outcome(client, "get_roster", { offeringId: BIO.id })).toMatchObject({ status: "ok" });
    // Morgan may list the district's schools herself, but the delegation covers only her class.
    expect(await outcome(client, "list_schools", {})).toMatchObject({ status: "error", error: { code: "not-found" } });
    await client.close();
  });

  it("refuses a wrong audience, a wrong issuer, an expired token and a missing scope", async () => {
    const { clientId } = await delegate();
    const now = Math.floor(Date.now() / 1000);
    for (const claims of [
      { aud: `${MCP_ORIGIN}/api` },
      { aud: "https://other-district.example/mcp" },
      { iss: ACCESS_ISSUER },
      { iat: now - 900, exp: now - 600 },
      { scope: "openid" },
    ]) {
      expect((await post(await token(MORGAN, clientId, claims))).status).toBe(401);
    }
  });

  it("refuses, with 403, a client the teacher has not delegated to", async () => {
    await delegate(); // Morgan's delegation to another client lends this one nothing.
    const response = await post(await token(MORGAN, "https://unregistered.example/client.json"));
    expect(response.status).toBe(403);
    // Rivera holds no delegation at all.
    expect((await post(await token(RIVERA, "https://unregistered.example/client.json"))).status).toBe(403);
  });

  it("stops the next call, listing included, once the delegation is revoked, with the same unexpired token", async () => {
    const { clientId, delegation } = await delegate();
    const { client, statuses } = await connect(await token(MORGAN, clientId));
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    await asTeacher(MORGAN, "teacher.revokeDelegation", { params: { delegationId: delegation.id } });
    await expect(client.listTools()).rejects.toThrow();
    expect(statuses.at(-1)).toBe(403);
    await expect(client.callTool({ name: "get_roster", arguments: { offeringId: BIO.id } })).rejects.toThrow();
    expect(statuses.at(-1)).toBe(403);
  });

  it("stops the next call once the teacher is deactivated or their identity link is removed", async () => {
    const { clientId } = await delegate();
    const bearer = await token(MORGAN, clientId);
    expect((await post(bearer)).status).toBe(200);
    await changeMorgan({ status: "inactive" });
    expect((await post(bearer)).status).toBe(401);
    await changeMorgan({ status: "active", externalIdentities: SEEDED_MORGAN.externalIdentities.filter((i) => i.issuer !== MCP_ISSUER) });
    expect((await post(bearer)).status).toBe(401);
  });
});
