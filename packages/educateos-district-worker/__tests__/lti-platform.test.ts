// The district's LTI Platform in workerd (SCHO-179), over the district's real SQLite Durable Object:
// its signing keys are published at `/lti/platform/jwks` with public halves only, kept apart from the
// Tool's, rotated by a district admin alone, and kept across restarts; its third-party tools and
// their deployments are registered, changed and revoked by a district admin alone, durably; its
// token endpoint issues a tool an access token for its deployment's services only, with a
// single-use client assertion, and the token dies with the tool. The switch that turns it on
// accepts only `on`.

import { env, evictDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { NORTHFIELD } from "@educateos/fixtures";
import { ltiPlatformEnabled } from "../src/lti-platform.ts";
import { ACCESS_AUDIENCE, ACCESS_ISSUER, LTI_TOOL_ORIGIN, PLATFORM_TOOL_JWKS_URL } from "./fixtures.ts";

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

async function api(principalId: string, method: "GET" | "POST", path: string, body: unknown = {}): Promise<{ status: number; body: any }> {
  const response = await fetchWorker(`${LTI_TOOL_ORIGIN}${path}`, {
    method,
    headers: { "cf-access-jwt-assertion": await signIn(principalId), "content-type": "application/json" },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
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

  it("registers, deploys, changes and revokes tools for a district admin only, durably", async () => {
    const tool = {
      name: "Lab Notebook",
      loginInitiationUrl: "https://tool.example/lti/login",
      redirectUris: ["https://tool.example/lti/launch"],
      targetLinkUri: "https://tool.example/lti/launch",
      jwksUrl: "https://tool.example/.well-known/jwks.json",
    };
    expect((await api(RIVERA, "POST", "/api/lti/platform-tools", tool)).status).toBe(403);
    expect((await api(RIVERA, "GET", "/api/lti/platform-tools")).status).toBe(403);
    expect((await api(ADMIN, "POST", "/api/lti/platform-tools", { ...tool, jwksUrl: "https://elsewhere.example/jwks" })).status).toBe(400);
    // A cross-site form cannot register a tool with an administrator's session.
    const form = await fetchWorker(`${LTI_TOOL_ORIGIN}/api/lti/platform-tools`, {
      method: "POST",
      headers: { "cf-access-jwt-assertion": await signIn(ADMIN), "content-type": "application/x-www-form-urlencoded" },
      body: "name=x",
    });
    expect(form.status).toBe(400);

    const registered = await api(ADMIN, "POST", "/api/lti/platform-tools", tool);
    expect(registered.status).toBe(200);
    expect(registered.body.id).toMatch(/^ltt_/);
    const toolId = registered.body.id as string;

    expect((await api(ADMIN, "POST", "/api/lti/platform-deployments", { toolId, offerings: ["off_lk-elsewhere"] })).status).toBe(400);
    expect((await api(RIVERA, "POST", "/api/lti/platform-deployments", { toolId, offerings: ["off_nf-bio-fall-p2"] })).status).toBe(403);
    const deployed = await api(ADMIN, "POST", "/api/lti/platform-deployments", { toolId, offerings: ["off_nf-bio-fall-p2"] });
    expect(deployed.status).toBe(200);
    expect(deployed.body.services).toEqual({ nrps: false, agsLineItems: false, agsScores: false, deepLinking: false });
    expect(deployed.body.privacy).toEqual({ name: false, email: false });
    const deploymentId = deployed.body.id as string;

    const changed = await api(ADMIN, "POST", `/api/lti/platform-deployments/${deploymentId}`, { services: { nrps: true } });
    expect(changed.status).toBe(200);
    expect(changed.body.services.nrps).toBe(true);
    expect((await api(ADMIN, "POST", "/api/lti/platform-deployments/ltd_nosuchdeploymentxxxxxx", { services: {} })).status).toBe(404);

    await evictDurableObject(district());
    const listed = await api(ADMIN, "GET", "/api/lti/platform-tools");
    expect(listed.body.tools.map((t: { id: string }) => t.id)).toContain(toolId);
    expect(listed.body.deployments.find((d: { id: string }) => d.id === deploymentId).services.nrps).toBe(true);

    expect((await api(RIVERA, "POST", `/api/lti/platform-tools/${toolId}/revoke`)).status).toBe(403);
    const revoked = await api(ADMIN, "POST", `/api/lti/platform-tools/${toolId}/revoke`);
    expect(revoked.body.status).toBe("revoked");
    await evictDurableObject(district());
    const after = await api(ADMIN, "GET", "/api/lti/platform-tools");
    // Revoking the tool revoked its deployment too, and a revoked tool gets no new deployment.
    expect(after.body.deployments.find((d: { id: string }) => d.id === deploymentId).status).toBe("revoked");
    expect((await api(ADMIN, "POST", "/api/lti/platform-deployments", { toolId, offerings: ["off_nf-bio-fall-p2"] })).status).toBe(409);
    expect((await api(ADMIN, "POST", `/api/lti/platform-deployments/${deploymentId}`, { services: { nrps: false } })).status).toBe(409);
  });

  it("issues a deployed tool a service token, once per assertion, that dies with the tool", async () => {
    const tool = {
      name: "Quiz Garden",
      loginInitiationUrl: "https://quiz-tool.example/lti/login",
      redirectUris: ["https://quiz-tool.example/lti/launch"],
      targetLinkUri: "https://quiz-tool.example/lti/launch",
      jwksUrl: PLATFORM_TOOL_JWKS_URL,
    };
    const toolId = (await api(ADMIN, "POST", "/api/lti/platform-tools", tool)).body.id as string;
    const deployed = await api(ADMIN, "POST", "/api/lti/platform-deployments", { toolId, offerings: ["off_nf-bio-fall-p2"], services: { nrps: true } });
    expect(deployed.status).toBe(200);

    const tokenUrl = `${LTI_TOOL_ORIGIN}/lti/platform/token`;
    const jwk = JSON.parse(env.TEST_PLATFORM_PRIVATE_JWK) as JWK;
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({ jti: crypto.randomUUID() })
      .setProtectedHeader({ alg: "RS256", kid: jwk.kid! })
      .setIssuer(toolId).setSubject(toolId).setAudience(tokenUrl).setIssuedAt(now).setExpirationTime(now + 60)
      .sign(await importJWK(jwk, "RS256"));
    const request = (scope: string) => fetchWorker(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: assertion,
        scope,
      }).toString(),
    });

    // No Access session: tools call the endpoint from their own servers.
    const issued = await request("https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly");
    expect(issued.status).toBe(200);
    expect(issued.headers.get("cache-control")).toBe("no-store");
    const token = (await issued.json()) as { access_token: string; expires_in: number; scope: string };
    expect(token.expires_in).toBeLessThanOrEqual(3600);
    const replay = await request("https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly");
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ error: "invalid_client" });

    const verify = () => district().verifyLtiServiceToken(token.access_token);
    await evictDurableObject(district());
    expect(await verify()).toEqual({ toolId, scopes: ["https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly"] });
    await api(ADMIN, "POST", `/api/lti/platform-tools/${toolId}/revoke`);
    expect(await verify()).toBeUndefined();
    expect((await fetchWorker(tokenUrl)).status).toBe(404);
  });

  it("is on only for the exact setting `on`", () => {
    expect(ltiPlatformEnabled("on")).toBe(true);
    for (const setting of [undefined, "", "off", "true", "ON", " on"]) expect(ltiPlatformEnabled(setting)).toBe(false);
  });
});
