// The district's LTI 1.3 Tool in workerd (SCHO-177), over the district's real SQLite Durable Object
// and a synthetic LMS: a district admin invites the LMS to register, trusts and approves it, and
// links a student's LMS account; the student's launch then lands as that principal. A replayed or
// spoofed launch is refused, and the registration, the tool's keys and their rotation all survive
// restarts of the object.

import { env, evictDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { NORTHFIELD } from "@educateos/fixtures";
import { LTI_CLAIM, LTI_VERSION } from "@educateos/lti";
import { ACCESS_AUDIENCE, ACCESS_ISSUER, LMS_ISSUER, LTI_TOOL_ORIGIN } from "./fixtures.ts";

const ADMIN = "prn_nf-district-admin";
const RIVERA = "prn_nf-teacher-rivera";
const AMARA = "prn_nf-student-amara";
const ENG9 = "off_nf-eng9-fall-p3";
const CONTEXT = "lms-course-eng9";
const AMARA_LMS_SUBJECT = "lms-user-amara";

/**
 * Fetches through the Worker and reads the whole body before returning, so no response is left
 * open in the district's object: an unread body keeps its request running, and the object cannot be
 * restarted under it.
 */
async function fetchTool(input: string | URL, init?: RequestInit): Promise<Response> {
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

/** Calls an `/api` route as `principalId`, through the Worker's own fetch handler. */
async function api(principalId: string, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetchTool(`${LTI_TOOL_ORIGIN}${path}`, {
    method,
    headers: { "cf-access-jwt-assertion": await signIn(principalId), "content-type": "application/json" },
    ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
  });
  return { status: response.status, body: await response.json() };
}

/** An id_token from the synthetic LMS, signed with `key` (the LMS's own by default). */
async function idToken(nonce: string, claims: Record<string, unknown> = {}, key = env.TEST_PLATFORM_PRIVATE_JWK): Promise<string> {
  const jwk = JSON.parse(key) as JWK;
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: LMS_ISSUER,
    aud: "lms-client-1",
    sub: AMARA_LMS_SUBJECT,
    iat: now,
    exp: now + 300,
    nonce,
    [LTI_CLAIM.messageType]: "LtiResourceLinkRequest",
    [LTI_CLAIM.version]: LTI_VERSION,
    [LTI_CLAIM.deploymentId]: "lms-deploy-1",
    [LTI_CLAIM.targetLinkUri]: `${LTI_TOOL_ORIGIN}/lti/launch`,
    [LTI_CLAIM.context]: { id: CONTEXT, label: "ENG9", title: "English 9" },
    [LTI_CLAIM.resourceLink]: { id: "rl-course-nav" },
    "https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice": {
      context_memberships_url: `${LMS_ISSUER}/api/lti/courses/9/names_and_roles`,
      service_versions: ["2.0"],
    },
    ...claims,
  }).setProtectedHeader({ alg: "RS256", kid: jwk.kid ?? "test-platform-key", typ: "JWT" }).sign(await importJWK(jwk, "RS256"));
}

/** Starts a login as the LMS's browser redirect does: the state, the nonce and the state cookie. */
async function login(): Promise<{ state: string; nonce: string; cookie: string }> {
  const query = new URLSearchParams({ iss: LMS_ISSUER, login_hint: "hint", target_link_uri: `${LTI_TOOL_ORIGIN}/lti/launch`, client_id: "lms-client-1" });
  const response = await fetchTool(`${LTI_TOOL_ORIGIN}/lti/login?${query}`, { redirect: "manual" });
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location")!);
  expect(location.origin + location.pathname).toBe(`${LMS_ISSUER}/api/lti/authorize_redirect`);
  const state = location.searchParams.get("state")!;
  return { state, nonce: location.searchParams.get("nonce")!, cookie: response.headers.get("set-cookie")!.split(";")[0]! };
}

function launch(token: string, state: string, cookie: string): Promise<Response> {
  return fetchTool(`${LTI_TOOL_ORIGIN}/lti/launch`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id_token: token, state }),
  });
}

/** The tool JWKS the Worker publishes. */
async function published(): Promise<{ kid: string; d?: string }[]> {
  return ((await (await fetchTool(`${LTI_TOOL_ORIGIN}/lti/jwks`)).json()) as { keys: { kid: string; d?: string }[] }).keys;
}

describe("the district's LTI Tool", () => {
  it("registers an LMS by invitation, links a student, and launches only that student's genuine launch", async () => {
    // A district admin invites the LMS; the LMS opens the invitation with its configuration.
    expect((await api(RIVERA, "POST", "/api/lti/invitations")).status).toBe(403);
    const invitation = await api(ADMIN, "POST", "/api/lti/invitations");
    expect(invitation.status).toBe(200);
    const register = new URL(invitation.body.url);
    expect(register.origin + register.pathname).toBe(`${LTI_TOOL_ORIGIN}/lti/register`);
    register.searchParams.set("openid_configuration", `${LMS_ISSUER}/.well-known/openid-configuration`);
    register.searchParams.set("registration_token", "lms-registration-token");
    expect((await fetchTool(register)).status).toBe(200);
    expect((await fetchTool(register)).status).toBe(401);

    // Until it is trusted and approved, the LMS cannot start a login.
    const query = new URLSearchParams({ iss: LMS_ISSUER, login_hint: "hint", target_link_uri: `${LTI_TOOL_ORIGIN}/lti/launch`, client_id: "lms-client-1" });
    expect((await fetchTool(`${LTI_TOOL_ORIGIN}/lti/login?${query}`, { redirect: "manual" })).status).toBe(401);
    const { body: { pending: [pending] } } = await api(ADMIN, "GET", "/api/lti/registrations");
    expect(pending).toMatchObject({ issuer: LMS_ISSUER, clientId: "lms-client-1", deploymentId: "lms-deploy-1" });
    const approval = { provider: "canvas", offerings: [{ contextId: CONTEXT, offeringId: ENG9 }] };
    expect((await api(ADMIN, "POST", `/api/lti/pending/${pending.id}/approve`, approval)).status).toBe(409);
    expect((await api(ADMIN, "POST", "/api/lti/trusted-issuers", { issuer: LMS_ISSUER })).body.trustedIssuers).toContain(LMS_ISSUER);
    expect((await api(ADMIN, "POST", `/api/lti/pending/${pending.id}/approve`, approval)).status).toBe(200);

    // An unlinked LMS account is shown its subject, for an administrator to link.
    let started = await login();
    let response = await launch(await idToken(started.nonce), started.state, started.cookie);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ unlinkedSignIn: { issuer: LMS_ISSUER, subject: AMARA_LMS_SUBJECT } });
    const link = await api(ADMIN, "POST", "/api/lti/identity-links", { issuer: LMS_ISSUER, subject: AMARA_LMS_SUBJECT, principalId: AMARA });
    expect(link.status).toBe(200);
    expect((await api(ADMIN, "POST", `/api/admin/identity-requests/${link.body.requestId}/approve`)).body.status).toBe("approved");

    // Her genuine launch lands as her, after a restart of the district's object.
    await evictDurableObject(district());
    started = await login();
    const token = await idToken(started.nonce);
    response = await launch(token, started.state, started.cookie);
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain("Amara");
    expect(page).toContain(ENG9);

    // The same launch again is refused: its state was single-use.
    expect((await launch(token, started.state, started.cookie)).status).toBe(401);
    // A launch signed by anyone but the LMS is refused, as is one without the login's browser cookie.
    started = await login();
    expect((await launch(await idToken(started.nonce, {}, env.TEST_ACCESS_PRIVATE_JWK), started.state, started.cookie)).status).toBe(401);
    started = await login();
    expect((await launch(await idToken(started.nonce), started.state, "")).status).toBe(401);
    // A launch whose nonce is not its login's is refused.
    started = await login();
    expect((await launch(await idToken("not-the-login-nonce"), started.state, started.cookie)).status).toBe(401);

    // The accepted launch recorded the roster service its course offers, for the mapped offering.
    const services = await api(ADMIN, "GET", `/api/lti/offerings/${ENG9}/services`);
    expect(services.body).toEqual([expect.objectContaining({
      offeringId: ENG9,
      services: expect.objectContaining({ contextId: CONTEXT, nrps: { membershipsUrl: `${LMS_ISSUER}/api/lti/courses/9/names_and_roles` } }),
    })]);
  });

  it("publishes its signing key and keeps it, and a rotation, across restarts", async () => {
    const [first] = await published();
    expect(first!.d).toBeUndefined();
    await evictDurableObject(district());
    expect((await published()).map((key) => key.kid)).toEqual([first!.kid]);

    expect((await api(RIVERA, "POST", "/api/lti/tool-keys/rotate")).status).toBe(403);
    const rotation = await api(ADMIN, "POST", "/api/lti/tool-keys/rotate");
    expect(rotation.body.retiredKids).toEqual([first!.kid]);
    await evictDurableObject(district());
    expect((await published()).map((key) => key.kid)).toEqual([rotation.body.signingKid, first!.kid]);
    expect((await api(ADMIN, "GET", "/api/lti/tool-keys")).body.kids).toEqual([rotation.body.signingKid, first!.kid]);
  });

  it("keeps the administrators' surface behind sign-in", async () => {
    const response = await fetchTool(`${LTI_TOOL_ORIGIN}/api/lti/registrations`);
    expect(response.status).toBe(401);
    expect((await fetchTool(`${LTI_TOOL_ORIGIN}/lti/nowhere`)).status).toBe(404);
  });
});
