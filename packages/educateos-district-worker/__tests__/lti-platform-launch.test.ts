// The district's LTI Platform launch in workerd (SCHO-179), end to end over the district's real SQLite
// Durable Object, with `FakeLtiTool` playing the third-party tool: a signed-in person starts a
// launch in an offering they are enrolled in, their browser carries the binding cookie through the
// tool's login initiation and back to `/lti/platform/auth`, and the tool verifies the id_token the
// platform posts to it. Everyone else, and every tampered, replayed or unbound request, is refused
// on EducateOS. With `LTI_PLATFORM` unset none of it exists.

import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { NORTHFIELD } from "@educateos/fixtures";
import { FakeLtiTool } from "@educateos/provider-fakes";
import { startDistrict } from "../src/district.ts";
import { LTI_LAUNCH_COOKIE } from "../src/lti-platform.ts";
import { ACCESS_AUDIENCE, ACCESS_AUDIENCES, ACCESS_ISSUER, LTI_TOOL_ORIGIN, TEST_CONFIG } from "./fixtures.ts";

const ADMIN = "prn_nf-district-admin";
const AMARA = "prn_nf-student-amara";
const MORGAN = "prn_nf-morgan-lee";
const RIVERA = "prn_nf-teacher-rivera";
const OFFERING = "off_nf-bio-fall-p2";
const LIS = "http://purl.imsglobal.org/vocab/lis/v2/membership#";
const AUTH_URL = `${LTI_TOOL_ORIGIN}/lti/platform/auth`;

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

async function api(principalId: string, path: string, body: unknown): Promise<Response> {
  return fetchWorker(`${LTI_TOOL_ORIGIN}${path}`, {
    method: "POST",
    headers: { "cf-access-jwt-assertion": await signIn(principalId), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A fake tool registered by the district admin and deployed to `OFFERING`. */
async function deployedTool(): Promise<{ tool: FakeLtiTool; deploymentId: string }> {
  const tool = await FakeLtiTool.create({
    origin: "https://tool.example",
    platformIssuer: LTI_TOOL_ORIGIN,
    platformAuthUrl: AUTH_URL,
    platformJwks: async () => (await fetchWorker(`${LTI_TOOL_ORIGIN}/lti/platform/jwks`)).json() as Promise<{ keys: JWK[] }>,
  });
  const registered = await api(ADMIN, "/api/lti/platform-tools", tool.registration());
  expect(registered.status).toBe(200);
  tool.clientId = ((await registered.json()) as { id: string }).id;
  const deployed = await api(ADMIN, "/api/lti/platform-deployments", { toolId: tool.clientId, offerings: [OFFERING] });
  expect(deployed.status).toBe(200);
  const deploymentId = ((await deployed.json()) as { id: string }).id;
  tool.deploymentIds.push(deploymentId);
  return { tool, deploymentId };
}

/** Starts a launch as `principalId`: the login initiation URL and the cookie the browser keeps. */
async function startLaunch(principalId: string, deploymentId: string, offeringId = OFFERING): Promise<{ loginUrl: string; cookie: string; setCookie: string }> {
  const response = await api(principalId, "/api/lti/platform-launches", { deploymentId, offeringId });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const setCookie = response.headers.get("set-cookie")!;
  const { loginUrl } = (await response.json()) as { loginUrl: string };
  return { loginUrl, cookie: setCookie.split(";")[0]!, setCookie };
}

const unescapeHtml = (text: string) =>
  text.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

/** The form the platform's page posts: its action and its fields. */
async function postedForm(response: Response): Promise<{ action: string; fields: Record<string, string> }> {
  const html = await response.text();
  const action = unescapeHtml(/<form method="post" action="([^"]*)">/.exec(html)![1]!);
  const fields: Record<string, string> = {};
  for (const [, name, value] of html.matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g)) fields[unescapeHtml(name!)] = unescapeHtml(value!);
  return { action, fields };
}

/** The authentication request as an urlencoded form post instead of a redirect. */
function asFormPost(authUrl: string, cookie: string): RequestInit {
  return {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URL(authUrl).searchParams.toString(),
  };
}

/** Asserts a refusal answered on EducateOS: no redirect, no form, the cookie cleared. */
async function expectRefused(response: Response, status = 403): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("set-cookie")).toMatch(new RegExp(`^${LTI_LAUNCH_COOKIE}=; Max-Age=0;`));
  const html = await response.text();
  expect(html).not.toContain("<form");
  expect(html).not.toContain("id_token");
}

describe("launching a third-party tool from the district's LTI Platform", () => {
  it("launches a student and a teacher, and the tool verifies each id_token", async () => {
    const { tool, deploymentId } = await deployedTool();

    const student = await startLaunch(AMARA, deploymentId);
    expect(student.setCookie).toMatch(new RegExp(`^${LTI_LAUNCH_COOKIE}=[A-Za-z0-9_-]{43}; Max-Age=300; Path=/lti/platform/; Secure; HttpOnly; SameSite=None$`));
    const login = new URL(student.loginUrl);
    expect(`${login.origin}${login.pathname}`).toBe(tool.loginUrl);
    expect(login.searchParams.get("iss")).toBe(LTI_TOOL_ORIGIN);
    expect(login.searchParams.get("client_id")).toBe(tool.clientId);
    expect(login.searchParams.get("lti_deployment_id")).toBe(deploymentId);
    expect(login.searchParams.get("target_link_uri")).toBe(tool.launchUrl);

    const answer = await fetchWorker(tool.initiateLogin(student.loginUrl), { headers: { cookie: student.cookie } });
    expect(answer.status).toBe(200);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(answer.headers.get("referrer-policy")).toBe("no-referrer");
    expect(answer.headers.get("set-cookie")).toBe(`${LTI_LAUNCH_COOKIE}=; Max-Age=0; Path=/lti/platform/; Secure; HttpOnly; SameSite=None`);
    const csp = answer.headers.get("content-security-policy")!;
    expect(csp).toContain("form-action https://tool.example;");
    expect(csp).toContain("default-src 'none'");
    const html = await answer.clone().text();
    const nonce = /<script nonce="([^"]+)">/.exec(html)![1]!;
    expect(csp).toContain(`script-src 'nonce-${nonce}'`);
    const form = await postedForm(answer);
    expect(form.action).toBe(tool.launchUrl);
    const learner = await tool.receiveLaunch(form.fields);
    expect(learner.roles).toEqual([`${LIS}Learner`]);
    expect(learner.contextId).toBe(OFFERING);
    expect(learner.deploymentId).toBe(deploymentId);
    // The deployment shares neither name nor email by default, and the subject is opaque.
    expect(learner.claims.name).toBeUndefined();
    expect(learner.claims.email).toBeUndefined();
    expect(learner.claims.sub).not.toContain("amara");

    // The teacher's authentication request comes back as a form post; the claims say Instructor.
    const teacher = await startLaunch(MORGAN, deploymentId);
    const posted = await fetchWorker(AUTH_URL, asFormPost(tool.initiateLogin(teacher.loginUrl), teacher.cookie));
    expect(posted.status).toBe(200);
    const instructor = await tool.receiveLaunch((await postedForm(posted)).fields);
    expect(instructor.roles).toEqual([`${LIS}Instructor`]);
    expect(instructor.claims.sub).not.toBe(learner.claims.sub);

    // The same person gets the same subject on a later launch.
    const again = await startLaunch(AMARA, deploymentId);
    const relaunch = await tool.receiveLaunch((await postedForm(await fetchWorker(tool.initiateLogin(again.loginUrl), { headers: { cookie: again.cookie } }))).fields);
    expect(relaunch.claims.sub).toBe(learner.claims.sub);
  });

  it("refuses to start a launch for someone not enrolled in the offering, or outside the deployment", async () => {
    const { deploymentId } = await deployedTool();
    expect((await api(RIVERA, "/api/lti/platform-launches", { deploymentId, offeringId: OFFERING })).status).toBe(403);
    expect((await api(MORGAN, "/api/lti/platform-launches", { deploymentId, offeringId: "off_nf-bio-spring-p4" })).status).toBe(403);
    expect((await api(AMARA, "/api/lti/platform-launches", { deploymentId: "ltd_nosuchdeploymentxxxxxx", offeringId: OFFERING })).status).toBe(403);
    expect((await fetchWorker(`${LTI_TOOL_ORIGIN}/api/lti/platform-launches`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    // A cross-site form cannot start a launch with a person's Access session.
    const form = await fetchWorker(`${LTI_TOOL_ORIGIN}/api/lti/platform-launches`, {
      method: "POST",
      headers: { "cf-access-jwt-assertion": await signIn(AMARA), "content-type": "application/x-www-form-urlencoded" },
      body: `deploymentId=${deploymentId}&offeringId=${OFFERING}`,
    });
    expect(form.status).toBe(400);
    expect(form.headers.get("set-cookie")).toBeNull();
  });

  it("refuses a missing or wrong cookie, and the ticket is spent by the attempt", async () => {
    const { tool, deploymentId } = await deployedTool();
    const unbound = await startLaunch(AMARA, deploymentId);
    const authUrl = tool.initiateLogin(unbound.loginUrl);
    await expectRefused(await fetchWorker(authUrl));
    await expectRefused(await fetchWorker(authUrl, { headers: { cookie: unbound.cookie } }));

    const other = await startLaunch(AMARA, deploymentId);
    const elsewhere = await startLaunch(AMARA, deploymentId);
    await expectRefused(await fetchWorker(tool.initiateLogin(other.loginUrl), { headers: { cookie: elsewhere.cookie } }));
    // Two launch cookies at once bind nothing.
    await expectRefused(await fetchWorker(tool.initiateLogin(elsewhere.loginUrl), { headers: { cookie: `${elsewhere.cookie}; ${other.cookie}` } }));
  });

  it("refuses a replayed ticket", async () => {
    const { tool, deploymentId } = await deployedTool();
    const launch = await startLaunch(AMARA, deploymentId);
    const authUrl = tool.initiateLogin(launch.loginUrl);
    expect((await fetchWorker(authUrl, { headers: { cookie: launch.cookie } })).status).toBe(200);
    await expectRefused(await fetchWorker(authUrl, { headers: { cookie: launch.cookie } }));
    await expectRefused(await fetchWorker(AUTH_URL, asFormPost(authUrl, launch.cookie)));
  });

  it("refuses a wrong client_id or a redirect_uri the tool did not register, without redirecting to it", async () => {
    const { tool, deploymentId } = await deployedTool();
    const wrongClient = await startLaunch(AMARA, deploymentId);
    const tampered = new URL(tool.initiateLogin(wrongClient.loginUrl));
    tampered.searchParams.set("client_id", "ltt_someothertool000000000");
    await expectRefused(await fetchWorker(tampered.toString(), { headers: { cookie: wrongClient.cookie } }));

    const wrongRedirect = await startLaunch(AMARA, deploymentId);
    const redirected = await fetchWorker(tool.initiateLogin(wrongRedirect.loginUrl, { redirectUri: "https://attacker.example/lti/launch" }), { headers: { cookie: wrongRedirect.cookie } });
    expect(await redirected.clone().text()).not.toContain("attacker.example");
    await expectRefused(redirected);

    // A malformed request (no nonce), a repeated parameter or a non-form body is refused as malformed.
    const malformed = await startLaunch(AMARA, deploymentId);
    const noNonce = new URL(tool.initiateLogin(malformed.loginUrl));
    noNonce.searchParams.delete("nonce");
    await expectRefused(await fetchWorker(noNonce.toString(), { headers: { cookie: malformed.cookie } }), 400);
    const repeated = new URL(tool.initiateLogin(malformed.loginUrl));
    repeated.searchParams.append("redirect_uri", "https://attacker.example/lti/launch");
    await expectRefused(await fetchWorker(repeated.toString(), { headers: { cookie: malformed.cookie } }), 400);
    const json = await fetchWorker(AUTH_URL, { method: "POST", headers: { cookie: malformed.cookie, "content-type": "application/json" }, body: "{}" });
    await expectRefused(json, 400);
    expect(tool.launches).toHaveLength(0);
  });

  it("has no launch routes when LTI_PLATFORM is unset", async () => {
    await runInDurableObject(env.DISTRICT.getByName("lti-platform-off"), async (_instance, state) => {
      const district = await startDistrict(state.storage, {
        config: JSON.stringify(TEST_CONFIG),
        accessIssuer: ACCESS_ISSUER,
        accessAudiences: ACCESS_AUDIENCES,
        ltiToolOrigin: LTI_TOOL_ORIGIN,
      }, { importFetch: async () => new Response(null, { status: 404 }) });
      const auth = await district.lti!.serveTool(new Request(`${AUTH_URL}?scope=openid`));
      expect(auth!.status).toBe(404);
      expect(auth!.headers.get("set-cookie")).toBeNull();
      const start = await district.lti!.serveAdmin(new Request(`${LTI_TOOL_ORIGIN}/api/lti/platform-launches`, {
        method: "POST",
        headers: { "cf-access-jwt-assertion": await signIn(AMARA), "content-type": "application/json" },
        body: JSON.stringify({ deploymentId: "ltd_nosuchdeploymentxxxxxx", offeringId: OFFERING }),
      }));
      expect(start.status).toBe(404);
      expect(start.headers.get("set-cookie")).toBeNull();
    });
  });
});
