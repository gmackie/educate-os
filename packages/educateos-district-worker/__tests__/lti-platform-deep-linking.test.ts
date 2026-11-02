// The district's LTI Platform Deep Linking in workerd (SCHO-179), end to end over the district's real
// SQLite Durable Object, with `FakeLtiTool` playing the third-party tool: a teacher of the offering
// starts a deep linking request, their browser carries the launch cookie to `/lti/platform/auth` and
// the deep linking cookie back to the flow's return URL with the tool's signed response, and each
// resource link becomes a draft in the offering that students neither see nor launch. A launch of a
// created link carries that link's ID. Every other caller, deployment, and every tampered,
// replayed, unsigned or unbound response is refused on EducateOS with nothing created. With
// `LTI_PLATFORM` unset none of it exists.

import { env, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT, UnsecuredJWT, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { NORTHFIELD } from "@educateos/fixtures";
import { FakeLtiTool, PlatformKeyRing, type FakeLtiToolLaunch } from "@educateos/provider-fakes";
import { startDistrict } from "../src/district.ts";
import { LTI_DEEP_LINK_COOKIE, LTI_LAUNCH_COOKIE } from "../src/lti-platform.ts";
import { ACCESS_AUDIENCE, ACCESS_AUDIENCES, ACCESS_ISSUER, LTI_TOOL_ORIGIN, PLATFORM_TOOL_JWKS_URL, TEST_CONFIG } from "./fixtures.ts";

const ADMIN = "prn_nf-district-admin";
const AMARA = "prn_nf-student-amara";
const MORGAN = "prn_nf-morgan-lee";
const RIVERA = "prn_nf-teacher-rivera";
const OFFERING = "off_nf-bio-fall-p2";
const LIS = "http://purl.imsglobal.org/vocab/lis/v2/membership#";
const TOOL_ORIGIN = new URL(PLATFORM_TOOL_JWKS_URL).origin;

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

async function api(principalId: string, method: "GET" | "POST", path: string, body: unknown = {}): Promise<Response> {
  return fetchWorker(`${LTI_TOOL_ORIGIN}${path}`, {
    method,
    headers: { "cf-access-jwt-assertion": await signIn(principalId), "content-type": "application/json" },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
}

/**
 * A fake tool that signs with the key the test district's platform fetch publishes at
 * {@link PLATFORM_TOOL_JWKS_URL}, registered by the district admin and deployed to {@link OFFERING}.
 */
async function deployedTool(services: Record<string, boolean> = { deepLinking: true }): Promise<{ tool: FakeLtiTool; deploymentId: string }> {
  const jwk = JSON.parse(env.TEST_PLATFORM_PRIVATE_JWK) as JWK;
  const keys = new PlatformKeyRing({
    kid: jwk.kid!,
    privateKey: (await importJWK(jwk, "RS256")) as CryptoKey,
    publicJwk: JSON.parse(env.TEST_PLATFORM_PUBLIC_JWK) as JWK,
  });
  const tool = await FakeLtiTool.create({
    origin: TOOL_ORIGIN,
    platformIssuer: LTI_TOOL_ORIGIN,
    platformAuthUrl: `${LTI_TOOL_ORIGIN}/lti/platform/auth`,
    platformJwks: async () => (await fetchWorker(`${LTI_TOOL_ORIGIN}/lti/platform/jwks`)).json() as Promise<{ keys: JWK[] }>,
    keys,
  });
  const registered = await api(ADMIN, "POST", "/api/lti/platform-tools", tool.registration());
  expect(registered.status).toBe(200);
  tool.clientId = ((await registered.json()) as { id: string }).id;
  const deployed = await api(ADMIN, "POST", "/api/lti/platform-deployments", { toolId: tool.clientId, offerings: [OFFERING], services });
  expect(deployed.status).toBe(200);
  const deploymentId = ((await deployed.json()) as { id: string }).id;
  tool.deploymentIds.push(deploymentId);
  return { tool, deploymentId };
}

/** The `name=value` of the cookie `name` among a response's `Set-Cookie` headers. */
function cookieOf(response: Response, name: string): { cookie: string; header: string } {
  const header = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`))!;
  return { cookie: header.split(";")[0]!, header };
}

/** The fields of the form the platform's page posts. */
function postedFields(html: string): Record<string, string> {
  const unescape = (text: string) => text.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  const fields: Record<string, string> = {};
  for (const [, name, value] of html.matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g)) fields[unescape(name!)] = unescape(value!);
  return fields;
}

/**
 * Starts a deep linking request as `principalId` and carries it through the tool's login and the
 * platform's authorization endpoint: the request the tool verified, and the deep linking cookie.
 */
async function startFlow(tool: FakeLtiTool, deploymentId: string, principalId = MORGAN): Promise<{ launch: FakeLtiToolLaunch; cookie: string; setCookie: string }> {
  const started = await api(principalId, "POST", "/api/lti/platform-deep-links", { deploymentId, offeringId: OFFERING });
  expect(started.status).toBe(200);
  expect(started.headers.get("cache-control")).toBe("no-store");
  const launchCookie = cookieOf(started, LTI_LAUNCH_COOKIE).cookie;
  const deepLink = cookieOf(started, LTI_DEEP_LINK_COOKIE);
  const { loginUrl } = (await started.json()) as { loginUrl: string };
  const answer = await fetchWorker(tool.initiateLogin(loginUrl), { headers: { cookie: launchCookie } });
  expect(answer.status).toBe(200);
  const launch = await tool.receiveLaunch(postedFields(await answer.text()));
  return { launch, cookie: deepLink.cookie, setCookie: deepLink.header };
}

/** Posts a deep linking response form back to the platform, as the teacher's browser does. */
function postBack(form: { action: string; fields: { JWT: string } }, cookie: string | undefined): Promise<Response> {
  return fetchWorker(form.action, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...cookie === undefined ? {} : { cookie } },
    body: new URLSearchParams(form.fields).toString(),
  });
}

/** The drafts in {@link OFFERING} from the deployment that `principalId` may see. */
async function drafts(principalId: string, deploymentId: string): Promise<{ id: string; title: string; text?: string; url?: string; status: string }[]> {
  const response = await api(principalId, "GET", `/api/lti/platform-resource-links?offeringId=${OFFERING}&deploymentId=${deploymentId}`);
  expect(response.status).toBe(200);
  return response.json();
}

/** Asserts a refusal answered on EducateOS: no redirect, no form, the deep linking cookie cleared. */
async function expectRefused(response: Response, status = 403): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("set-cookie")).toMatch(new RegExp(`^${LTI_DEEP_LINK_COOKIE}=; Max-Age=0;`));
  const html = await response.text();
  expect(html).toContain("could not be added");
  expect(html).not.toContain("<form");
  expect(html).not.toContain("<script");
}

const CELLS = { type: "ltiResourceLink", title: "Cell structure", text: "An interactive cell.", url: `${TOOL_ORIGIN}/content/cells` };
const MITOSIS = { type: "ltiResourceLink", title: "Mitosis lab", url: `${TOOL_ORIGIN}/content/mitosis`, custom: { secret: "dropped" }, lineItem: { scoreMaximum: 10 } };

describe("adding a third-party tool's content to an offering by deep linking", () => {
  it("lets a teacher add two links as drafts students cannot see, and a launch of one carries its ID", async () => {
    const { tool, deploymentId } = await deployedTool();
    const { launch, cookie, setCookie } = await startFlow(tool, deploymentId);
    expect(setCookie).toMatch(new RegExp(`^${LTI_DEEP_LINK_COOKIE}=[A-Za-z0-9_-]{43}; Max-Age=1800; Path=/lti/platform/deep-links/; Secure; HttpOnly; SameSite=None$`));
    expect(launch.claims["https://purl.imsglobal.org/spec/lti/claim/message_type"]).toBe("LtiDeepLinkingRequest");
    expect(launch.roles).toEqual([`${LIS}Instructor`]);
    expect(launch.contextId).toBe(OFFERING);
    expect(launch.resourceLinkId).toBeUndefined();
    expect(launch.deepLinking).toMatchObject({
      accept_types: ["ltiResourceLink"],
      accept_presentation_document_targets: ["iframe", "window"],
      accept_multiple: true,
      auto_create: false,
    });
    expect(launch.deepLinking!.deep_link_return_url).toMatch(new RegExp(`^${LTI_TOOL_ORIGIN}/lti/platform/deep-links/[A-Za-z0-9_-]{43}$`));
    expect(launch.deepLinking!.data).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // Two links, and an HTML item the platform does not accept.
    const form = await tool.deepLinkingResponse(launch, [CELLS, { type: "html", html: "<script>alert(1)</script>" }, MITOSIS]);
    const answer = await postBack(form, cookie);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(answer.headers.get("referrer-policy")).toBe("no-referrer");
    expect(answer.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(answer.headers.get("set-cookie")).toBe(`${LTI_DEEP_LINK_COOKIE}=; Max-Age=0; Path=/lti/platform/deep-links/; Secure; HttpOnly; SameSite=None`);
    expect(await answer.text()).toContain("2 drafts were added");

    const added = await drafts(MORGAN, deploymentId);
    expect(added.map(({ title, text, url, status }) => ({ title, text, url, status }))).toEqual([
      { title: "Cell structure", text: "An interactive cell.", url: CELLS.url, status: "draft" },
      { title: "Mitosis lab", text: undefined, url: MITOSIS.url, status: "draft" },
    ]);
    // Custom parameters and line items are not kept.
    expect(JSON.stringify(added)).not.toContain("dropped");
    expect(JSON.stringify(added)).not.toContain("scoreMaximum");
    // A student of the offering sees no draft, and may not launch one.
    expect(await drafts(AMARA, deploymentId)).toEqual([]);
    const studentLaunch = await api(AMARA, "POST", "/api/lti/platform-launches", { deploymentId, offeringId: OFFERING, resourceLinkId: added[0]!.id });
    expect(studentLaunch.status).toBe(403);
    expect(studentLaunch.headers.get("set-cookie")).toBeNull();

    // The teacher launches the second draft: its resource link claim is the draft's ID.
    const started = await api(MORGAN, "POST", "/api/lti/platform-launches", { deploymentId, offeringId: OFFERING, resourceLinkId: added[1]!.id });
    expect(started.status).toBe(200);
    const { loginUrl } = (await started.json()) as { loginUrl: string };
    const html = await (await fetchWorker(tool.initiateLogin(loginUrl), { headers: { cookie: cookieOf(started, LTI_LAUNCH_COOKIE).cookie } })).text();
    const relaunch = await tool.receiveLaunch(postedFields(html));
    expect(relaunch.claims["https://purl.imsglobal.org/spec/lti/claim/message_type"]).toBe("LtiResourceLinkRequest");
    expect(relaunch.resourceLinkId).toBe(added[1]!.id);
    // A launch without one keeps the deployment's own resource link.
    const plain = await api(MORGAN, "POST", "/api/lti/platform-launches", { deploymentId, offeringId: OFFERING });
    const plainLaunch = await tool.receiveLaunch(postedFields(await (await fetchWorker(tool.initiateLogin(((await plain.json()) as { loginUrl: string }).loginUrl), {
      headers: { cookie: cookieOf(plain, LTI_LAUNCH_COOKIE).cookie },
    })).text()));
    expect(plainLaunch.resourceLinkId).not.toBe(added[1]!.id);
    expect(plainLaunch.resourceLinkId).toBeDefined();

    // Another deployment's link, or one that does not exist, cannot be launched here.
    const other = await deployedTool();
    expect((await api(MORGAN, "POST", "/api/lti/platform-launches", { deploymentId: other.deploymentId, offeringId: OFFERING, resourceLinkId: added[0]!.id })).status).toBe(403);
    expect((await api(MORGAN, "POST", "/api/lti/platform-launches", { deploymentId, offeringId: OFFERING, resourceLinkId: "lrl_nosuchlink0000000000000" })).status).toBe(403);
  });

  it("refuses to start for a student, someone outside the offering, or a deployment without deep linking", async () => {
    const { deploymentId } = await deployedTool();
    for (const principalId of [AMARA, RIVERA]) {
      const refused = await api(principalId, "POST", "/api/lti/platform-deep-links", { deploymentId, offeringId: OFFERING });
      expect(refused.status).toBe(403);
      expect(refused.headers.get("set-cookie")).toBeNull();
    }
    const without = await deployedTool({ nrps: true });
    const refused = await api(MORGAN, "POST", "/api/lti/platform-deep-links", { deploymentId: without.deploymentId, offeringId: OFFERING });
    expect(refused.status).toBe(403);
    expect(refused.headers.get("set-cookie")).toBeNull();
    // A cross-site form cannot start one with a teacher's Access session.
    const form = await fetchWorker(`${LTI_TOOL_ORIGIN}/api/lti/platform-deep-links`, {
      method: "POST",
      headers: { "cf-access-jwt-assertion": await signIn(MORGAN), "content-type": "application/x-www-form-urlencoded" },
      body: `deploymentId=${deploymentId}&offeringId=${OFFERING}`,
    });
    expect(form.status).toBe(400);
  });

  it("refuses tampered, misaddressed, unsigned, replayed, foreign or unbound responses, creating nothing", async () => {
    const { tool, deploymentId } = await deployedTool();
    const refuse = async (
      respond: (launch: FakeLtiToolLaunch) => Promise<{ action: string; fields: { JWT: string } }>,
      cookie: (own: string) => string | undefined = (own) => own,
    ) => {
      const flow = await startFlow(tool, deploymentId);
      await expectRefused(await postBack(await respond(flow.launch), cookie(flow.cookie)));
    };

    await refuse((launch) => tool.deepLinkingResponse(launch, [CELLS], { data: "tampered" }));
    await refuse((launch) => tool.deepLinkingResponse(launch, [CELLS], { audience: "https://other-platform.example" }));
    await refuse((launch) => tool.deepLinkingResponse(launch, [CELLS], { deploymentId: "ltd_someotherdeployment000" }));
    await refuse((launch) => tool.deepLinkingResponse(launch, [CELLS], { sign: async (claims) => new UnsecuredJWT(claims).encode() }));
    await refuse((launch) => tool.deepLinkingResponse(launch, [CELLS], {
      sign: (claims) => new SignJWT(claims).setProtectedHeader({ alg: "HS256", kid: tool.keys.signingKey.kid }).sign(new TextEncoder().encode("a shared secret of thirty-two bytes")),
    }));
    // Signed by a key the tool does not publish.
    const forger = await PlatformKeyRing.create();
    await refuse((launch) => tool.deepLinkingResponse(launch, [CELLS], { sign: (claims) => forger.sign(claims, { kid: tool.keys.signingKey.kid }) }));
    // Expired.
    await refuse((launch) => tool.deepLinkingResponse(launch, [CELLS], { issuedAt: Math.floor(Date.now() / 1000) - 3600 }));
    // A link to anywhere but the tool's registered origin refuses the whole response.
    await refuse((launch) => tool.deepLinkingResponse(launch, [CELLS, { type: "ltiResourceLink", title: "Elsewhere", url: "https://attacker.example/x" }]));
    // More links than the platform takes.
    await refuse((launch) => tool.deepLinkingResponse(launch, Array.from({ length: 11 }, (_, n) => ({ ...CELLS, title: `Link ${n}` }))));
    // No cookie, or another flow's.
    await refuse((launch) => tool.deepLinkingResponse(launch, [CELLS]), () => undefined);
    const elsewhere = await startFlow(tool, deploymentId);
    await refuse((launch) => tool.deepLinkingResponse(launch, [CELLS]), () => elsewhere.cookie);

    // A response is accepted once: the flow is spent, and its nonce cannot be used for another flow.
    const first = await startFlow(tool, deploymentId);
    const accepted = await tool.deepLinkingResponse(first.launch, [], { nonce: "nonce-used-once" });
    const answer = await postBack(accepted, first.cookie);
    expect(answer.status).toBe(200);
    expect(await answer.text()).toContain("Nothing was added");
    await expectRefused(await postBack(accepted, first.cookie));
    await refuse((launch) => tool.deepLinkingResponse(launch, [CELLS], { nonce: "nonce-used-once" }));
    // An unknown flow, and a malformed post.
    await expectRefused(await postBack({ action: `${LTI_TOOL_ORIGIN}/lti/platform/deep-links/nosuchflow`, fields: accepted.fields }, first.cookie));
    const json = await fetchWorker(first.launch.deepLinking!.deep_link_return_url, { method: "POST", headers: { "content-type": "application/json", cookie: first.cookie }, body: "{}" });
    await expectRefused(json, 400);

    expect(await drafts(MORGAN, deploymentId)).toEqual([]);
  });

  it("refuses a response once the deployment no longer allows deep linking", async () => {
    const { tool, deploymentId } = await deployedTool();
    const flow = await startFlow(tool, deploymentId);
    expect((await api(ADMIN, "POST", `/api/lti/platform-deployments/${deploymentId}`, { services: { deepLinking: false } })).status).toBe(200);
    await expectRefused(await postBack(await tool.deepLinkingResponse(flow.launch, [CELLS]), flow.cookie));
    expect(await drafts(MORGAN, deploymentId)).toEqual([]);
  });

  it("has no deep linking routes when LTI_PLATFORM is unset", async () => {
    await runInDurableObject(env.DISTRICT.getByName("lti-platform-off"), async (_instance, state) => {
      const district = await startDistrict(state.storage, {
        config: JSON.stringify(TEST_CONFIG),
        accessIssuer: ACCESS_ISSUER,
        accessAudiences: ACCESS_AUDIENCES,
        ltiToolOrigin: LTI_TOOL_ORIGIN,
      }, { importFetch: async () => new Response(null, { status: 404 }) });
      const back = await district.lti!.serveTool(new Request(`${LTI_TOOL_ORIGIN}/lti/platform/deep-links/someflow`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "JWT=x",
      }));
      expect(back!.status).toBe(404);
      expect(back!.headers.get("set-cookie")).toBeNull();
      const headers = { "cf-access-jwt-assertion": await signIn(MORGAN), "content-type": "application/json" };
      const start = await district.lti!.serveAdmin(new Request(`${LTI_TOOL_ORIGIN}/api/lti/platform-deep-links`, {
        method: "POST",
        headers,
        body: JSON.stringify({ deploymentId: "ltd_nosuchdeploymentxxxxxx", offeringId: OFFERING }),
      }));
      expect(start.status).toBe(404);
      expect(start.headers.get("set-cookie")).toBeNull();
      const list = await district.lti!.serveAdmin(new Request(`${LTI_TOOL_ORIGIN}/api/lti/platform-resource-links?offeringId=${OFFERING}`, { headers }));
      expect(list.status).toBe(404);
    });
  });
});
