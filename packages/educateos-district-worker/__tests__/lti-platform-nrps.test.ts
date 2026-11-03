// The district's LTI Platform roster service (NRPS 2.0, SCHO-179) in workerd, end to end over the
// district's real SQLite Durable Object, with `FakeLtiTool` playing the third-party tool: a launch
// through a deployment that allows NRPS advertises the offering's membership URL, the tool gets a
// service token with a client assertion and reads the class, each member under the same opaque
// subject as their launch. Another offering, another tool's deployment, a deployment without
// NRPS, a token without the scope, and a revoked deployment are all refused. With `LTI_PLATFORM`
// unset none of it exists.

import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { NORTHFIELD } from "@educateos/fixtures";
import { FakeLtiTool, FakeLtiToolError, PlatformKeyRing } from "@educateos/provider-fakes";
import { startDistrict } from "../src/district.ts";
import { ACCESS_AUDIENCE, ACCESS_AUDIENCES, ACCESS_ISSUER, LTI_TOOL_ORIGIN, TEST_CONFIG } from "./fixtures.ts";

const ADMIN = "prn_nf-district-admin";
const AMARA = "prn_nf-student-amara";
const MORGAN = "prn_nf-morgan-lee";
const OFFERING = "off_nf-bio-fall-p2";
const OTHER_OFFERING = "off_nf-eng9-fall-p3";
const LIS = "http://purl.imsglobal.org/vocab/lis/v2/membership#";
const NRPS_SCOPE = "https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly";
const SCORE_SCOPE = "https://purl.imsglobal.org/spec/lti-ags/scope/score";
const MEMBERSHIP_CONTAINER = "application/vnd.ims.lti-nrps.v2.membershipcontainer+json";
const PLATFORM = `${LTI_TOOL_ORIGIN}/lti/platform`;

/** Fetches through the Worker and reads the whole body, so no request stays open in the object. */
async function fetchWorker(input: string, init?: RequestInit): Promise<Response> {
  const response = await SELF.fetch(input, { redirect: "manual", ...init });
  const body = await response.arrayBuffer();
  return new Response(response.status === 204 ? null : body, { status: response.status, headers: response.headers });
}

/** An Access assertion for a Northfield principal, signed with this run's key. */
async function signIn(principalId: string): Promise<string> {
  const subject = NORTHFIELD.principals.find((p) => p.id === principalId)!.externalIdentities[0]!.subject;
  const key = await importJWK(JSON.parse(env.TEST_ACCESS_PRIVATE_JWK) as JWK, "RS256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: ACCESS_ISSUER, aud: ACCESS_AUDIENCE, sub: subject, iat: now, exp: now + 300 })
    .setProtectedHeader({ alg: "RS256", kid: "test-access-key" })
    .sign(key);
}

async function api(principalId: string, path: string, body?: unknown): Promise<Response> {
  return fetchWorker(`${LTI_TOOL_ORIGIN}${path}`, {
    method: "POST",
    headers: { "cf-access-jwt-assertion": await signIn(principalId), "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

/**
 * A fake tool on the origin whose JWKS the test district's fetch publishes, so its client
 * assertions verify, registered by the district admin.
 */
async function registeredTool(): Promise<FakeLtiTool> {
  const jwk = JSON.parse(env.TEST_PLATFORM_PRIVATE_JWK) as JWK;
  const keys = new PlatformKeyRing({
    kid: jwk.kid!,
    privateKey: (await importJWK(jwk, "RS256")) as CryptoKey,
    publicJwk: JSON.parse(env.TEST_PLATFORM_PUBLIC_JWK) as JWK,
  });
  const tool = await FakeLtiTool.create({
    origin: "https://quiz-tool.example",
    platformIssuer: LTI_TOOL_ORIGIN,
    platformAuthUrl: `${PLATFORM}/auth`,
    platformTokenUrl: `${PLATFORM}/token`,
    platformJwks: async () => (await fetchWorker(`${PLATFORM}/jwks`)).json() as Promise<{ keys: JWK[] }>,
    fetch: fetchWorker,
    keys,
  });
  const registered = await api(ADMIN, "/api/lti/platform-tools", tool.registration());
  expect(registered.status).toBe(200);
  tool.clientId = ((await registered.json()) as { id: string }).id;
  return tool;
}

/** Deploys `tool` to `offerings` with `services` and `privacy`, and returns the deployment's ID. */
async function deploy(tool: FakeLtiTool, offerings: string[], services: Record<string, boolean>, privacy?: Record<string, boolean>): Promise<string> {
  const deployed = await api(ADMIN, "/api/lti/platform-deployments", { toolId: tool.clientId, offerings, services, ...privacy === undefined ? {} : { privacy } });
  expect(deployed.status).toBe(200);
  const id = ((await deployed.json()) as { id: string }).id;
  tool.deploymentIds.push(id);
  return id;
}

/** Launches `principalId` into `tool` through `deploymentId`, as the launch tests do. */
async function launch(tool: FakeLtiTool, principalId: string, deploymentId: string) {
  const started = await api(principalId, "/api/lti/platform-launches", { deploymentId, offeringId: OFFERING });
  expect(started.status).toBe(200);
  const cookie = started.headers.get("set-cookie")!.split(";")[0]!;
  const { loginUrl } = (await started.json()) as { loginUrl: string };
  const html = await (await fetchWorker(tool.initiateLogin(loginUrl), { headers: { cookie } })).text();
  const fields: Record<string, string> = {};
  for (const [, name, value] of html.matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g)) fields[name!] = value!;
  return tool.receiveLaunch(fields);
}

const membershipsUrl = (deploymentId: string, offeringId = OFFERING) => `${PLATFORM}/nrps/${deploymentId}/${offeringId}/memberships`;

/** Expects `call` to be refused with `reason`. */
async function expectRefused(call: Promise<unknown>, reason: string): Promise<void> {
  const error = await call.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(FakeLtiToolError);
  expect((error as FakeLtiToolError).reason).toBe(reason);
}

describe("the district's LTI Platform roster service", () => {
  it("advertises the roster in the launch, and the tool reads the class under the launch's subjects", async () => {
    const tool = await registeredTool();
    const deploymentId = await deploy(tool, [OFFERING], { nrps: true });
    const amara = await launch(tool, AMARA, deploymentId);
    expect(amara.membershipsUrl).toBe(membershipsUrl(deploymentId));
    expect(amara.claims["https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice"]).toEqual({
      context_memberships_url: membershipsUrl(deploymentId),
      service_versions: ["2.0"],
    });
    const morgan = await launch(tool, MORGAN, deploymentId);

    const token = await tool.serviceToken([NRPS_SCOPE]);
    const raw = await fetchWorker(amara.membershipsUrl!, { headers: { authorization: `Bearer ${token}` } });
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toBe(MEMBERSHIP_CONTAINER);
    expect(raw.headers.get("cache-control")).toBe("no-store");
    const text = await raw.text();
    // No internal ID, name or email leaves the district by default.
    expect(text).not.toMatch(/prn_|enr_|Amara|Okafor|@/);

    const roster = await tool.memberships(amara.membershipsUrl!, token);
    expect(roster.id).toBe(membershipsUrl(deploymentId));
    expect(roster.context).toEqual({ id: OFFERING, label: "Biology I", title: "Biology I, Period 2" });
    expect(roster.next).toBeUndefined();
    expect(roster.members).toHaveLength(5);
    for (const member of roster.members) expect(Object.keys(member).toSorted()).toEqual(["roles", "status", "user_id"]);
    expect(roster.members.find((m) => m.user_id === amara.claims.sub)).toEqual({ user_id: amara.claims.sub, roles: [`${LIS}Learner`], status: "Active" });
    expect(roster.members.find((m) => m.user_id === morgan.claims.sub)).toEqual({ user_id: morgan.claims.sub, roles: [`${LIS}Instructor`], status: "Active" });
    expect(roster.members.filter((m) => m.roles.includes(`${LIS}Learner`))).toHaveLength(4);

    // A student who has not launched yet gets a subject now, and keeps it.
    const again = await tool.memberships(amara.membershipsUrl!, token);
    expect(again.members.map((m) => m.user_id).toSorted()).toEqual(roster.members.map((m) => m.user_id).toSorted());

    // The role filter, by short name or full URI, and paging with Link: rel="next".
    expect((await tool.memberships(`${amara.membershipsUrl}?role=Learner`, token)).members).toHaveLength(4);
    expect((await tool.memberships(`${amara.membershipsUrl}?role=${encodeURIComponent(`${LIS}Instructor`)}`, token)).members.map((m) => m.user_id)).toEqual([morgan.claims.sub]);
    expect((await tool.memberships(`${amara.membershipsUrl}?role=Mentor`, token)).members).toEqual([]);
    const first = await tool.memberships(`${amara.membershipsUrl}?limit=3`, token);
    expect(first.members).toHaveLength(3);
    expect(first.next).toBe(`${membershipsUrl(deploymentId)}?limit=3&page=2`);
    const second = await tool.memberships(first.next!, token);
    expect(second.next).toBeUndefined();
    expect([...first.members, ...second.members].map((m) => m.user_id).toSorted()).toEqual(roster.members.map((m) => m.user_id).toSorted());
    for (const query of ["limit=0", "limit=1001", "page=2", "limit=2&page=0", "limit=x"]) {
      expect((await fetchWorker(`${amara.membershipsUrl}?${query}`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(400);
    }
  });

  it("refuses another offering, another deployment of the tool without NRPS, and another tool's deployment", async () => {
    const tool = await registeredTool();
    const deploymentId = await deploy(tool, [OFFERING], { nrps: true });
    const elsewhere = await deploy(tool, [OTHER_OFFERING], { nrps: false });
    const other = await registeredTool();
    const othersDeployment = await deploy(other, [OFFERING], { nrps: true });
    const token = await tool.serviceToken([NRPS_SCOPE]);

    expect((await tool.memberships(membershipsUrl(deploymentId), token)).members).toHaveLength(5);
    await expectRefused(tool.memberships(membershipsUrl(deploymentId, OTHER_OFFERING), token), "memberships refused (403)");
    await expectRefused(tool.memberships(membershipsUrl(elsewhere, OTHER_OFFERING), token), "memberships refused (403)");
    await expectRefused(tool.memberships(membershipsUrl(othersDeployment), token), "memberships refused (403)");
    await expectRefused(tool.memberships(membershipsUrl("ltd_nosuchdeploymentxxxxxx"), token), "memberships refused (403)");

    // A missing or unknown token is an invalid_token challenge.
    const anonymous = await fetchWorker(membershipsUrl(deploymentId));
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toBe('Bearer error="invalid_token"');
    await expectRefused(tool.memberships(membershipsUrl(deploymentId), "not-a-token"), "memberships refused (401 invalid_token)");
    // Only GET reads a roster.
    expect((await fetchWorker(membershipsUrl(deploymentId), { method: "POST", headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
  });

  it("advertises nothing and issues no roster token through a deployment without NRPS, and wants the scope", async () => {
    const tool = await registeredTool();
    const deploymentId = await deploy(tool, [OFFERING], { agsScores: true });
    const launched = await launch(tool, AMARA, deploymentId);
    expect(launched.membershipsUrl).toBeUndefined();
    expect(launched.claims["https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice"]).toBeUndefined();
    await expectRefused(tool.serviceToken([NRPS_SCOPE]), "token refused (invalid_scope)");

    // A token for another service is short of the roster's scope.
    const scoreToken = await tool.serviceToken([SCORE_SCOPE]);
    const refused = await fetchWorker(membershipsUrl(deploymentId), { headers: { authorization: `Bearer ${scoreToken}` } });
    expect(refused.status).toBe(403);
    expect(refused.headers.get("www-authenticate")).toBe(`Bearer error="insufficient_scope", scope="${NRPS_SCOPE}"`);
  });

  it("refuses the next call once the deployment is revoked", async () => {
    const tool = await registeredTool();
    const kept = await deploy(tool, [OFFERING], { nrps: true });
    const revoked = await deploy(tool, [OFFERING], { nrps: true });
    const token = await tool.serviceToken([NRPS_SCOPE]);
    expect((await tool.memberships(membershipsUrl(revoked), token)).members).toHaveLength(5);

    expect((await api(ADMIN, `/api/lti/platform-deployments/${revoked}/revoke`)).status).toBe(200);
    await expectRefused(tool.memberships(membershipsUrl(revoked), token), "memberships refused (403)");
    expect((await tool.memberships(membershipsUrl(kept), token)).members).toHaveLength(5);

    // With no deployment left allowing NRPS, the token itself is no longer good.
    expect((await api(ADMIN, `/api/lti/platform-deployments/${kept}/revoke`)).status).toBe(200);
    await expectRefused(tool.memberships(membershipsUrl(kept), token), "memberships refused (401 invalid_token)");
  });

  it("names people and shares emails only as the deployment allows each", async () => {
    const tool = await registeredTool();
    const deploymentId = await deploy(tool, [OFFERING], { nrps: true }, { name: true });
    const token = await tool.serviceToken([NRPS_SCOPE]);
    const named = await tool.memberships(membershipsUrl(deploymentId), token);
    const amaraNamed = named.members.find((m) => m.name === "Amara Okafor");
    expect(amaraNamed).toMatchObject({ given_name: "Amara", family_name: "Okafor" });
    expect(named.members.every((m) => m.email === undefined)).toBe(true);

    expect((await api(ADMIN, `/api/lti/platform-deployments/${deploymentId}`, { privacy: { name: false, email: true } })).status).toBe(200);
    const emailed = await tool.memberships(membershipsUrl(deploymentId), token);
    expect(emailed.members.every((m) => m.name === undefined && m.given_name === undefined)).toBe(true);
    expect(emailed.members.find((m) => m.user_id === amaraNamed!.user_id)!.email).toBe("family.okafor@northfield.example");
    // People with no email on record (Dmitri, Elena and Lucía) are listed without one.
    expect(emailed.members.filter((m) => m.email === undefined)).toHaveLength(3);
  });

  it("has no roster route when LTI_PLATFORM is unset", async () => {
    await runInDurableObject(env.DISTRICT.getByName("lti-platform-nrps-off"), async (_instance, state) => {
      const district = await startDistrict(state.storage, {
        config: JSON.stringify(TEST_CONFIG),
        accessIssuer: ACCESS_ISSUER,
        accessAudiences: ACCESS_AUDIENCES,
        ltiToolOrigin: LTI_TOOL_ORIGIN,
      }, { importFetch: async () => new Response(null, { status: 404 }) });
      const response = await district.lti!.serveTool(new Request(membershipsUrl("ltd_nosuchdeploymentxxxxxx"), { headers: { authorization: "Bearer x" } }));
      expect(response!.status).toBe(404);
      expect(response!.headers.get("www-authenticate")).toBeNull();
    });
  });
});
