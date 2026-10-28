// The signed operations API in workerd (SCHO-263): through the Worker's own fetch handler, over the
// district's real SQLite Durable Object. A district administrator enrolls an admin key through the
// Access-signed admin route; the admin's own signing code (`@educateos/fleet/ops`) then calls every
// ops route; the keyring, the nonces and the audit log survive a restart of the object, and two
// copies of one signed request are served once even when they race. The full refusal matrix runs
// in @educateos/district-app's devices.test.ts. Every response body is read, so an eviction never
// waits on an open request.

import { env, evictDurableObject, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { NORTHFIELD } from "@educateos/fixtures";
import { OPS_RESPONSES, signOpsRequest, SigningIdentity, type OpsRouteName, type OpsScope } from "@educateos/fleet/ops";
import { ROUTES } from "@educateos/district-app/routes";
import { ACCESS_AUDIENCE, ACCESS_ISSUER } from "./fixtures.ts";

const ADMIN = "prn_nf-district-admin";
const district = () => env.DISTRICT.getByName(NORTHFIELD.district.id);

async function accessAssertion(principalId: string): Promise<string> {
  const subject = NORTHFIELD.principals.find((p) => p.id === principalId)!.externalIdentities[0]!.subject;
  const key = await importJWK(JSON.parse(env.TEST_ACCESS_PRIVATE_JWK) as JWK, "RS256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: ACCESS_ISSUER, aud: ACCESS_AUDIENCE, sub: subject, iat: now, exp: now + 300 })
    .setProtectedHeader({ alg: "RS256", kid: "test-access-key" })
    .sign(key);
}

/** Fetches through the Worker and reads the whole body. */
async function fetchJson(request: Request): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await SELF.fetch(request);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

/** A district admin's call to an Access-signed admin route. */
async function admin(method: "GET" | "POST", path: string, body?: unknown) {
  return fetchJson(new Request(`https://district.example${path}`, {
    method,
    headers: { "cf-access-jwt-assertion": await accessAssertion(ADMIN), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

/** An admin key enrolled through district /admin → Operations, as the admin edition's registration says. */
async function enroll(scopes: OpsScope[] = ["health", "analytics", "directory:read", "directory:write", "devices", "releases"]): Promise<SigningIdentity> {
  const identity = await SigningIdentity.generate();
  const registration = { adminOrigin: "https://admin.educateos.io", keyId: identity.keyId, publicKey: identity.publicKey, scopes };
  const enrolled = await admin("POST", "/api/admin/ops/keys", { registration, scopes });
  expect(enrolled.status).toBe(201);
  ROUTES["admin.enrollOpsKey"].response.parse(enrolled.body);
  return identity;
}

/** A signed ops request, as the admin edition sends it. */
async function signed(identity: SigningIdentity, method: string, path: string, options: { body?: unknown; nonce?: string } = {}): Promise<Request> {
  const url = new URL(path, "https://district.example");
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers = await signOpsRequest(identity, { method, url, operator: "ops@educateos.io", ...(body === undefined ? {} : { body }), ...(options.nonce === undefined ? {} : { nonce: options.nonce }) });
  return new Request(url, { method, headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body }) });
}

async function ops(identity: SigningIdentity, method: string, path: string, route: OpsRouteName, body?: unknown) {
  const result = await fetchJson(await signed(identity, method, path, body === undefined ? {} : { body }));
  if (result.status === 200) OPS_RESPONSES[route].parse(result.body);
  return result;
}

describe("the ops API in the district Worker", () => {
  it("refuses every ops route without a signature, even with a valid Access assertion", async () => {
    const assertion = await accessAssertion(ADMIN);
    for (const path of ["/api/ops/health", "/api/ops/analytics?range=24h", "/api/ops/directory", "/api/ops/devices", "/api/ops/releases", "/api/ops"]) {
      for (const headers of [{}, { "cf-access-jwt-assertion": assertion }] as Record<string, string>[]) {
        expect(await fetchJson(new Request(`https://district.example${path}`, { headers }))).toMatchObject({ status: 401, body: { reason: "missing-signature" } });
      }
    }
  });

  it("serves every route to an enrolled key, through the Worker, and records each in the district's audit log", async () => {
    const identity = await enroll();
    expect(await ops(identity, "GET", "/api/ops/health", "health")).toMatchObject({ status: 200, body: { status: "ok" } });
    expect((await ops(identity, "GET", "/api/ops/releases", "releases")).status).toBe(200);
    expect((await ops(identity, "GET", "/api/ops/directory?role=admin", "directory.list")).body.entries).toStrictEqual([expect.objectContaining({ principal: ADMIN })]);
    expect((await ops(identity, "GET", `/api/ops/directory/${ADMIN}`, "directory.get")).status).toBe(200);
    expect((await ops(identity, "GET", "/api/ops/devices", "devices.list")).status).toBe(200);
    expect((await ops(identity, "POST", "/api/ops/devices/revoke-below-version", "devices.revoke-below-version", { minimumVersion: "0.0.1" })).status).toBe(200);

    // The analytics proxy reads Cloudflare with the district's token, and never follows a redirect.
    const analytics = await ops(identity, "GET", "/api/ops/analytics?range=24h", "analytics");
    expect(analytics).toMatchObject({ status: 200, body: { range: "24h", workers: [{ script: "educateos-district-worker", invocations: 120, cpuTimeP50Ms: 1.5 }], durableObjects: { requests: 80, storageBytes: 4096 } } });
    const asked = await district().analyticsRequests();
    expect(asked.length).toBeGreaterThanOrEqual(2);
    expect(asked.every((r) => r.redirect === "manual" && r.authorization === "Bearer test-analytics-token")).toBe(true);
    // Cached for five minutes in the object.
    expect((await ops(identity, "GET", "/api/ops/analytics?range=24h", "analytics")).status).toBe(200);
    expect(await district().analyticsRequests()).toHaveLength(asked.length);

    const audit = await admin("GET", "/api/admin/ops/audit");
    expect(audit.status).toBe(200);
    const entries = ROUTES["admin.opsAudit"].response.parse(audit.body).entries.filter((e) => e.keyId === identity.keyId);
    expect(entries.map((e) => e.route).toReversed()).toStrictEqual([
      "health", "releases", "directory.list", "directory.get", "devices.list", "devices.revoke-below-version", "analytics", "analytics",
    ]);
  });

  it("keeps its keyring, nonces and audit log in their own tables, across a restart of the object", async () => {
    const identity = await enroll(["health"]);
    const first = await signed(identity, "GET", "/api/ops/health");
    const replay = new Request(first.url, { headers: first.headers });
    expect((await fetchJson(first)).status).toBe(200);

    await evictDurableObject(district());
    // The nonce outlived the object: a replay after a restart is still refused.
    expect(await fetchJson(replay)).toMatchObject({ status: 401, body: { reason: "replayed" } });
    // And the key is still enrolled.
    expect((await ops(identity, "GET", "/api/ops/health", "health")).status).toBe(200);

    const tables = await runInDurableObject(district(), async (_instance, state) =>
      state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'educateos\\_ops%' ESCAPE '\\' ORDER BY name").toArray().map((r) => r.name));
    expect(tables).toStrictEqual(["educateos_ops_audit", "educateos_ops_keys", "educateos_ops_nonces"]);
    const results = await runInDurableObject(district(), async (_instance, state) =>
      state.storage.sql.exec("SELECT result FROM educateos_ops_audit WHERE key_id = ? ORDER BY seq", identity.keyId).toArray().map((r) => r.result));
    expect(results).toStrictEqual(["ok", "refused:replayed", "ok"]);
  });

  it("serves two copies of one signed request once, even when they race", async () => {
    const identity = await enroll(["health"]);
    const nonce = "racing-nonce-0123456789";
    const copies = await Promise.all([signed(identity, "GET", "/api/ops/health", { nonce }), signed(identity, "GET", "/api/ops/health", { nonce })]);
    const answers = await Promise.all(copies.map((request) => fetchJson(request)));
    expect(answers.map((a) => a.status).toSorted()).toStrictEqual([200, 401]);
  });

  it("forgets expired nonces, and refuses a removed key after a restart", async () => {
    const identity = await enroll(["health"]);
    await runInDurableObject(district(), async (_instance, state) => {
      state.storage.sql.exec("INSERT INTO educateos_ops_nonces (key_id, nonce, expires_at) VALUES ('ed25519-old', 'old-nonce-0123456789', 1)");
    });
    expect((await ops(identity, "GET", "/api/ops/health", "health")).status).toBe(200);
    const left = await runInDurableObject(district(), async (_instance, state) =>
      state.storage.sql.exec("SELECT COUNT(*) AS n FROM educateos_ops_nonces WHERE expires_at < ?", Date.now()).toArray()[0]!.n);
    expect(left).toBe(0);

    expect((await admin("POST", `/api/admin/ops/keys/${identity.keyId}/remove`, {})).status).toBe(200);
    await evictDurableObject(district());
    expect(await fetchJson(await signed(identity, "GET", "/api/ops/health"))).toMatchObject({ status: 401, body: { reason: "unknown-key" } });
  });
});
