// The district's LTI Platform in workerd (SCHO-179), over the district's real SQLite Durable Object:
// its signing keys are published at `/lti/platform/jwks` with public halves only, kept apart from the
// Tool's, rotated by a district admin alone, and kept across restarts. The switch that turns it on
// accepts only `on`.

import { env, evictDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { NORTHFIELD } from "@educateos/fixtures";
import { ltiPlatformEnabled } from "../src/lti-platform.ts";
import { ACCESS_AUDIENCE, ACCESS_ISSUER, LTI_TOOL_ORIGIN } from "./fixtures.ts";

const ADMIN = "prn_nf-district-admin";
const RIVERA = "prn_nf-teacher-rivera";

/** Fetches through the Worker and reads the whole body, so no request stays open in the object. */
async function fetchWorker(input: string, init?: RequestInit): Promise<Response> {
  const response = await SELF.fetch(input, init);
  const body = await response.arrayBuffer();
  return new Response(response.status === 204 ? null : body, { status: response.status, headers: response.headers });
}

const district = () => env.DISTRICT.getByName(NORTHFIELD.district.id);

/** An Access assertion for a Northfield principal, signed with this run's key. */
async function signIn(principalId: string): Promise<string> {
  const subject = NORTHFIELD.principals.find((p) => p.id === principalId)!.externalIdentities[0]!.subject;
  const key = await importJWK(JSON.parse(env.TEST_ACCESS_PRIVATE_JWK) as JWK, "RS256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: ACCESS_ISSUER, aud: ACCESS_AUDIENCE, sub: subject, iat: now, exp: now + 300 })
    .setProtectedHeader({ alg: "RS256", kid: "test-access-key" })
    .sign(key);
}

async function api(principalId: string, method: "GET" | "POST", path: string): Promise<{ status: number; body: any }> {
  const response = await fetchWorker(`${LTI_TOOL_ORIGIN}${path}`, {
    method,
    headers: { "cf-access-jwt-assertion": await signIn(principalId), "content-type": "application/json" },
    ...(method === "POST" ? { body: "{}" } : {}),
  });
  return { status: response.status, body: await response.json() };
}

async function jwks(path: string): Promise<{ kid: string; d?: string }[]> {
  const response = await fetchWorker(`${LTI_TOOL_ORIGIN}${path}`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { keys: { kid: string; d?: string }[] }).keys;
}

describe("the district's LTI Platform keys", () => {
  it("publishes its own signing keys without sign-in, apart from the Tool's, with public halves only", async () => {
    const response = await fetchWorker(`${LTI_TOOL_ORIGIN}/lti/platform/jwks`);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    const platform = await jwks("/lti/platform/jwks");
    const tool = await jwks("/lti/jwks");
    expect(platform).toHaveLength(1);
    expect(platform[0]!.d).toBeUndefined();
    expect(Object.keys(platform[0]!).toSorted()).toEqual(["alg", "e", "kid", "kty", "n", "use"]);
    expect(tool.map((key) => key.kid)).not.toContain(platform[0]!.kid);
    expect((await fetchWorker(`${LTI_TOOL_ORIGIN}/lti/platform/nowhere`)).status).toBe(404);
    expect((await fetchWorker(`${LTI_TOOL_ORIGIN}/lti/platform/jwks`, { method: "POST" })).status).toBe(404);
  });

  it("rotates for a district admin only, keeps the previous key published, and survives restarts", async () => {
    const [first] = await jwks("/lti/platform/jwks");
    const toolBefore = await jwks("/lti/jwks");
    await evictDurableObject(district());
    expect((await jwks("/lti/platform/jwks")).map((key) => key.kid)).toEqual([first!.kid]);

    expect((await api(RIVERA, "GET", "/api/lti/platform-keys")).status).toBe(403);
    expect((await api(RIVERA, "POST", "/api/lti/platform-keys/rotate")).status).toBe(403);
    expect((await fetchWorker(`${LTI_TOOL_ORIGIN}/api/lti/platform-keys`)).status).toBe(401);
    const rotation = await api(ADMIN, "POST", "/api/lti/platform-keys/rotate");
    expect(rotation.status).toBe(200);
    expect(rotation.body.retiredKids).toEqual([first!.kid]);
    await evictDurableObject(district());
    expect((await jwks("/lti/platform/jwks")).map((key) => key.kid)).toEqual([rotation.body.signingKid, first!.kid]);
    expect((await api(ADMIN, "GET", "/api/lti/platform-keys")).body.kids).toEqual([rotation.body.signingKid, first!.kid]);
    // The Tool's keys are untouched by the platform's rotation.
    expect(await jwks("/lti/jwks")).toEqual(toolBefore);
  });

  it("is on only for the exact setting `on`", () => {
    expect(ltiPlatformEnabled("on")).toBe(true);
    for (const setting of [undefined, "", "off", "true", "ON", " on"]) expect(ltiPlatformEnabled(setting)).toBe(false);
  });
});
