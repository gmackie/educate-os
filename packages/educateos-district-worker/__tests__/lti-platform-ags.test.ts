// The district's LTI Platform Assignment and Grade Services in workerd (SCHO-179), end to end over the
// district's real SQLite Durable Object, with `FakeLtiTool` playing the third-party tool's server:
// a launch advertises the AGS endpoint, the tool gets a service token with a client assertion,
// creates a line item and posts scores. Every call is decided with the tool itself as the subject,
// through its deployment, so it keeps working when the administrator who deployed it leaves. A score
// only ever waits for a teacher of the offering, who approves it (then, and only then, it is a
// result the tool can read) or declines it. Everyone else, every other offering, tool or learner, a
// deployment without the service and a revoked one are refused. With `LTI_PLATFORM` unset none of it
// exists.

import { env, evictDurableObject, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { NORTHFIELD } from "@educateos/fixtures";
import { FakeLtiTool, LTI_SCOPES, PlatformKeyRing, type FakeLtiToolScore } from "@educateos/provider-fakes";
import { POLICY_AUDIT_TABLE } from "@educateos/policy/durable-object-audit-sink";
import { startDistrict } from "../src/district.ts";
import { ACCESS_AUDIENCE, ACCESS_AUDIENCES, ACCESS_ISSUER, LTI_TOOL_ORIGIN, PLATFORM_TOOL_JWKS_URL, TEST_CONFIG } from "./fixtures.ts";

const ADMIN = "prn_nf-district-admin";
const AMARA = "prn_nf-student-amara";
const MORGAN = "prn_nf-morgan-lee";
const RIVERA = "prn_nf-teacher-rivera";
const OFFERING = "off_nf-bio-fall-p2";
const OTHER_OFFERING = "off_nf-eng9-fall-p3";
const AGS_SCOPES = [LTI_SCOPES.lineItem, LTI_SCOPES.lineItemReadonly, LTI_SCOPES.resultReadonly, LTI_SCOPES.score];
const RESOURCE_LINK = "https://purl.imsglobal.org/spec/lti/claim/resource_link";

const district = () => env.DISTRICT.getByName(NORTHFIELD.district.id);

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

async function api(principalId: string, method: "GET" | "POST", path: string, body: unknown = {}): Promise<{ status: number; body: any }> {
  const response = await fetchWorker(`${LTI_TOOL_ORIGIN}${path}`, {
    method,
    headers: { "cf-access-jwt-assertion": await signIn(principalId), "content-type": "application/json" },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}

/**
 * A fake tool whose server signs its client assertions with the key the test district's platform
 * fetch publishes at {@link PLATFORM_TOOL_JWKS_URL}, registered by the district admin and deployed to
 * {@link OFFERING} with all three AGS services.
 */
async function deployedTool(services: Record<string, boolean> = { agsLineItems: true, agsResults: true, agsScores: true }): Promise<{ tool: FakeLtiTool; deploymentId: string }> {
  const jwk = JSON.parse(env.TEST_PLATFORM_PRIVATE_JWK) as JWK;
  const keys = new PlatformKeyRing({
    kid: jwk.kid!,
    privateKey: (await importJWK(jwk, "RS256")) as CryptoKey,
    publicJwk: JSON.parse(env.TEST_PLATFORM_PUBLIC_JWK) as JWK,
  });
  const tool = await FakeLtiTool.create({
    origin: new URL(PLATFORM_TOOL_JWKS_URL).origin,
    platformIssuer: LTI_TOOL_ORIGIN,
    platformAuthUrl: `${LTI_TOOL_ORIGIN}/lti/platform/auth`,
    platformJwks: async () => (await fetchWorker(`${LTI_TOOL_ORIGIN}/lti/platform/jwks`)).json() as Promise<{ keys: JWK[] }>,
    platformTokenUrl: `${LTI_TOOL_ORIGIN}/lti/platform/token`,
    fetch: fetchWorker,
    keys,
  });
  const registered = await api(ADMIN, "POST", "/api/lti/platform-tools", tool.registration());
  expect(registered.status).toBe(200);
  tool.clientId = registered.body.id as string;
  const deployed = await api(ADMIN, "POST", "/api/lti/platform-deployments", { toolId: tool.clientId, offerings: [OFFERING], services });
  expect(deployed.status).toBe(200);
  const deploymentId = deployed.body.id as string;
  tool.deploymentIds.push(deploymentId);
  return { tool, deploymentId };
}

/** Launches `principalId` into the tool through the deployment: the launch the tool verified. */
async function launch(tool: FakeLtiTool, principalId: string, deploymentId: string) {
  const response = await fetchWorker(`${LTI_TOOL_ORIGIN}/api/lti/platform-launches`, {
    method: "POST",
    headers: { "cf-access-jwt-assertion": await signIn(principalId), "content-type": "application/json" },
    body: JSON.stringify({ deploymentId, offeringId: OFFERING }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  const { loginUrl } = (await response.json()) as { loginUrl: string };
  const html = await (await fetchWorker(tool.initiateLogin(loginUrl), { headers: { cookie } })).text();
  const fields: Record<string, string> = {};
  for (const [, name, value] of html.matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g)) fields[name!] = value!;
  return tool.receiveLaunch(fields);
}

/** Sets a person's status in the district's directory, as a roster sync would. */
async function setStatus(principalId: string, status: "active" | "inactive") {
  await runInDurableObject(district(), (_instance, state) => {
    const row = state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM academic_principals WHERE id = ?", principalId).one();
    state.storage.sql.exec("UPDATE academic_principals SET record_json = ? WHERE id = ?", JSON.stringify({ ...JSON.parse(row.record_json), status }), principalId);
  });
}

/** The district's policy decisions so far, from its audit table. */
async function auditEvents(): Promise<{ principalId?: string; channel?: string; ruleId: string; grantId?: string }[]> {
  return runInDurableObject(district(), (_instance, state) =>
    state.storage.sql.exec<{ event_json: string }>(`SELECT event_json FROM ${POLICY_AUDIT_TABLE}`).toArray().map((row) => JSON.parse(row.event_json)));
}

let clock = Date.parse("2026-11-01T10:00:00Z");
/** A fully graded score for `userId`, each later than the last. */
function score(userId: string, scoreGiven: number, overrides: Partial<FakeLtiToolScore> = {}): FakeLtiToolScore {
  clock += 1000;
  return { userId, scoreGiven, scoreMaximum: 10, activityProgress: "Completed", gradingProgress: "FullyGraded", timestamp: new Date(clock).toISOString(), ...overrides };
}

/** A tool, deployed with AGS, with a line item for the resource link Amara launched from. */
async function withLineItem() {
  const { tool, deploymentId } = await deployedTool();
  const learner = await launch(tool, AMARA, deploymentId);
  const token = await tool.serviceToken(AGS_SCOPES);
  const created = await tool.createLineItem(learner.ags!.lineitems!, token, {
    label: "Cell structure quiz",
    scoreMaximum: 10,
    resourceLinkId: (learner.claims[RESOURCE_LINK] as { id: string }).id,
  });
  expect(created.status).toBe(201);
  const lineItem = ((await created.json()) as { id: string }).id;
  return { tool, deploymentId, token, lineItem, amara: learner.claims.sub! };
}

async function results(tool: FakeLtiTool, lineItem: string, token: string): Promise<{ userId: string; resultScore: number }[]> {
  const response = await tool.results(lineItem, token);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/vnd.ims.lis.v2.resultcontainer+json");
  return response.json() as Promise<{ userId: string; resultScore: number }[]>;
}

describe("the district's LTI Platform Assignment and Grade Services", () => {
  it("advertises the endpoint in the launch and keeps line items to the deployment and offering", async () => {
    const { tool, deploymentId } = await deployedTool();
    const learner = await launch(tool, AMARA, deploymentId);
    const lineItems = `${LTI_TOOL_ORIGIN}/lti/platform/ags/${deploymentId}/${OFFERING}/lineitems`;
    expect(learner.ags).toEqual({ scope: AGS_SCOPES, lineitems: lineItems });

    const token = await tool.serviceToken(AGS_SCOPES);
    const resourceLinkId = (learner.claims[RESOURCE_LINK] as { id: string }).id;
    const created = await tool.createLineItem(lineItems, token, { label: "Lab report", scoreMaximum: 20, resourceLinkId, id: "https://ignored.example" });
    expect(created.status).toBe(201);
    expect(created.headers.get("content-type")).toBe("application/vnd.ims.lis.v2.lineitem+json");
    expect(created.headers.get("cache-control")).toBe("no-store");
    const item = (await created.json()) as { id: string; label: string };
    expect(item.id).toMatch(new RegExp(`^${lineItems}/lli_[A-Za-z0-9_-]{22}$`));

    const listed = await tool.listLineItems(lineItems, token);
    expect(listed.headers.get("content-type")).toBe("application/vnd.ims.lis.v2.lineitemcontainer+json");
    expect(await listed.json()).toEqual([{ id: item.id, label: "Lab report", scoreMaximum: 20, resourceLinkId }]);

    // The next launch from that resource link names its line item.
    expect((await launch(tool, AMARA, deploymentId)).ags).toEqual({ scope: AGS_SCOPES, lineitems: lineItems, lineitem: item.id });

    // A teacher replaces it; the tool removes it while no result of it is official.
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/vnd.ims.lis.v2.lineitem+json" };
    const replaced = await fetchWorker(item.id, { method: "PUT", headers: auth, body: JSON.stringify({ label: "Lab report 1", scoreMaximum: 25 }) });
    expect(await replaced.json()).toEqual({ id: item.id, label: "Lab report 1", scoreMaximum: 25 });
    expect((await fetchWorker(item.id, { method: "DELETE", headers: auth })).status).toBe(204);
    expect((await fetchWorker(item.id, { headers: auth })).status).toBe(404);

    // Another offering, even one in the district, is not this deployment's.
    expect((await tool.listLineItems(lineItems.replace(OFFERING, OTHER_OFFERING), token)).status).toBe(404);
    // Nor is another tool's deployment, in the same offering.
    const other = await deployedTool();
    expect((await tool.listLineItems(lineItems.replace(deploymentId, other.deploymentId), token)).status).toBe(404);
  });

  it("queues a score for a teacher, who alone makes it official and visible in results", async () => {
    const { tool, token, lineItem, amara } = await withLineItem();
    const posted = await tool.postScore(lineItem, token, score(amara, 8, { comment: "Well labelled." }));
    expect(posted.status).toBe(204);
    expect(posted.headers.get("cache-control")).toBe("no-store");
    // Pending is not a result.
    expect(await results(tool, lineItem, token)).toEqual([]);

    await evictDurableObject(district());
    const queue = await api(MORGAN, "GET", "/api/lti/platform-scores");
    expect(queue.status).toBe(200);
    const pending = queue.body.scores.find((s: { lineItem: { id: string } }) => lineItem.endsWith(s.lineItem.id));
    expect(pending).toMatchObject({ studentId: AMARA, studentName: expect.any(String), offeringId: OFFERING, scoreGiven: 8, scoreMaximum: 10, comment: "Well labelled.", toolName: "Fake LTI tool" });
    expect(pending.digest).toMatch(/^[0-9a-f]{64}$/);

    // The student and a teacher of another offering can neither see nor approve it.
    for (const principal of [AMARA, RIVERA]) {
      expect((await api(principal, "GET", "/api/lti/platform-scores")).body.scores).toEqual([]);
      expect((await api(principal, "POST", `/api/lti/platform-scores/${pending.approvalId}/approve`, { digest: pending.digest })).status).toBe(404);
    }
    // Nor can the administrator who deployed the tool: the tool, not they, requested it.
    expect((await api(ADMIN, "GET", "/api/lti/platform-scores")).body.scores).toEqual([]);
    expect((await api(ADMIN, "POST", `/api/lti/platform-scores/${pending.approvalId}/approve`, { digest: pending.digest })).status).toBe(404);
    expect(await results(tool, lineItem, token)).toEqual([]);

    // Only the score reviewed is applied.
    expect((await api(MORGAN, "POST", `/api/lti/platform-scores/${pending.approvalId}/approve`, { digest: "0".repeat(64) })).status).toBe(409);
    const approved = await api(MORGAN, "POST", `/api/lti/platform-scores/${pending.approvalId}/approve`, { digest: pending.digest });
    expect(approved).toEqual({ status: 200, body: { status: "applied" } });
    expect((await api(MORGAN, "POST", `/api/lti/platform-scores/${pending.approvalId}/approve`, {})).body).toEqual({ status: "already-applied" });

    expect(await results(tool, lineItem, token)).toEqual([{
      id: `${lineItem}/results?user_id=${encodeURIComponent(amara)}`,
      scoreOf: lineItem,
      userId: amara,
      resultScore: 8,
      resultMaximum: 10,
      comment: "Well labelled.",
    }]);
    // A line item with an official result stays.
    expect((await fetchWorker(lineItem, { method: "DELETE", headers: { authorization: `Bearer ${token}` } })).status).toBe(409);
  });

  it("decides each call as the tool through its deployment, and keeps working after its administrator leaves", async () => {
    const { tool, deploymentId, token, lineItem, amara } = await withLineItem();
    await setStatus(ADMIN, "inactive");
    try {
      expect((await tool.listLineItems(lineItem.slice(0, lineItem.lastIndexOf("/")), token)).status).toBe(200);
      expect((await tool.postScore(lineItem, token, score(amara, 7))).status).toBe(204);
      const pending = (await api(MORGAN, "GET", "/api/lti/platform-scores")).body.scores.find((s: { lineItem: { id: string } }) => lineItem.endsWith(s.lineItem.id));
      expect((await api(MORGAN, "POST", `/api/lti/platform-scores/${pending.approvalId}/approve`, { digest: pending.digest })).body).toEqual({ status: "applied" });
      expect(await results(tool, lineItem, token)).toEqual([expect.objectContaining({ userId: amara, resultScore: 7 })]);
    } finally {
      await setStatus(ADMIN, "active");
    }

    // The district's policy audit shows the tool as the subject and the deployment as the grant.
    const decisions = (await auditEvents()).filter((event) => event.channel === "lti-service" && event.grantId === deploymentId);
    expect(new Set(decisions.map((event) => event.principalId))).toEqual(new Set([expect.stringMatching(/^prn_lti-tool-[0-9a-f]+$/)]));
    expect(new Set(decisions.map((event) => event.ruleId))).toEqual(new Set(["lti.tool.line-items.write", "lti.tool.line-items", "lti.tool.score", "lti.tool.results"]));
    expect((await auditEvents()).some((event) => event.channel === "lti-service" && event.principalId === ADMIN)).toBe(false);
  });

  it("leaves nothing official when the teacher declines a score", async () => {
    const { tool, token, lineItem, amara } = await withLineItem();
    expect((await tool.postScore(lineItem, token, score(amara, 3))).status).toBe(204);
    const pending = (await api(MORGAN, "GET", "/api/lti/platform-scores")).body.scores.find((s: { lineItem: { id: string } }) => lineItem.endsWith(s.lineItem.id));
    expect((await api(MORGAN, "POST", `/api/lti/platform-scores/${pending.approvalId}/decline`, {})).status).toBe(400);
    expect((await api(MORGAN, "POST", `/api/lti/platform-scores/${pending.approvalId}/decline`, { reason: "Retake scheduled." })).body).toEqual({ status: "declined" });
    expect((await api(MORGAN, "POST", `/api/lti/platform-scores/${pending.approvalId}/approve`, {})).status).toBe(409);
    expect(await results(tool, lineItem, token)).toEqual([]);
    expect((await api(MORGAN, "GET", "/api/lti/platform-scores")).body.scores.some((s: { approvalId: string }) => s.approvalId === pending.approvalId)).toBe(false);
  });

  it("refuses scores for anyone but an active learner of the offering, and stale or malformed ones", async () => {
    const { tool, deploymentId, token, lineItem, amara } = await withLineItem();
    const teacher = (await launch(tool, MORGAN, deploymentId)).claims.sub!;
    expect((await tool.postScore(lineItem, token, score(teacher, 9))).status).toBe(400);
    expect((await tool.postScore(lineItem, token, score("not-a-subject", 9))).status).toBe(400);

    const first = score(amara, 6);
    expect((await tool.postScore(lineItem, token, first)).status).toBe(204);
    // AGS 2.0 §3.4.6: a score no later than the last one received is refused.
    expect((await tool.postScore(lineItem, token, first)).status).toBe(409);
    expect((await tool.postScore(lineItem, token, { ...first, timestamp: "2020-01-01T00:00:00Z" })).status).toBe(409);
    expect((await tool.postScore(lineItem, token, score(amara, -1))).status).toBe(400);
    expect((await tool.postScore(lineItem, token, score(amara, 5, { scoreMaximum: undefined }))).status).toBe(400);
    // Progress without a final grade is accepted and queues nothing.
    const before = (await api(MORGAN, "GET", "/api/lti/platform-scores")).body.scores.length;
    expect((await tool.postScore(lineItem, token, score(amara, 0, { scoreGiven: undefined, gradingProgress: "Pending", activityProgress: "Submitted" }))).status).toBe(204);
    expect((await api(MORGAN, "GET", "/api/lti/platform-scores")).body.scores).toHaveLength(before);
  });

  it("refuses calls without a current token, without the scope, without the service and after revocation", async () => {
    const { tool, deploymentId, token, lineItem, amara } = await withLineItem();
    const container = lineItem.slice(0, lineItem.lastIndexOf("/"));
    const anonymous = await fetchWorker(container);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toBe('Bearer error="invalid_token"');
    expect((await tool.listLineItems(container, "lst_notatokennotatokennotatokennotatokennotatok")).status).toBe(401);

    const readOnly = await tool.serviceToken([LTI_SCOPES.lineItemReadonly]);
    expect((await tool.listLineItems(container, readOnly)).status).toBe(200);
    const refused = await tool.createLineItem(container, readOnly, { label: "Extra", scoreMaximum: 1 });
    expect(refused.status).toBe(403);
    expect(refused.headers.get("www-authenticate")).toBe('Bearer error="insufficient_scope"');
    expect((await tool.postScore(lineItem, readOnly, score(amara, 1))).status).toBe(403);
    expect((await tool.results(lineItem, readOnly)).status).toBe(403);

    // The deployment loses the scores service: the token no longer sends scores, and no new one can.
    expect((await api(ADMIN, "POST", `/api/lti/platform-deployments/${deploymentId}`, { services: { agsLineItems: true, agsResults: true, agsScores: false } })).status).toBe(200);
    expect((await tool.postScore(lineItem, token, score(amara, 2))).status).toBe(403);
    await expect(tool.serviceToken([LTI_SCOPES.score])).rejects.toThrow(/invalid_scope/);
    expect((await tool.listLineItems(container, token)).status).toBe(200);

    // Revoked, the deployment's token is dead.
    expect((await api(ADMIN, "POST", `/api/lti/platform-deployments/${deploymentId}/revoke`)).status).toBe(200);
    expect((await tool.listLineItems(container, token)).status).toBe(401);
  });

  it("refuses scores, and reading results, for a deployment with only the line items service", async () => {
    const { tool, deploymentId } = await deployedTool({ agsLineItems: true });
    const learner = await launch(tool, AMARA, deploymentId);
    expect(learner.ags!.scope).toEqual([LTI_SCOPES.lineItem, LTI_SCOPES.lineItemReadonly]);
    await expect(tool.serviceToken([LTI_SCOPES.score])).rejects.toThrow(/invalid_scope/);
    await expect(tool.serviceToken([LTI_SCOPES.resultReadonly])).rejects.toThrow(/invalid_scope/);
    const token = await tool.serviceToken([LTI_SCOPES.lineItem]);
    const lineItem = ((await (await tool.createLineItem(learner.ags!.lineitems!, token, { label: "Quiz", scoreMaximum: 5 })).json()) as { id: string }).id;
    expect((await tool.postScore(lineItem, token, score(learner.claims.sub!, 5))).status).toBe(403);
  });

  it("has no AGS endpoints when LTI_PLATFORM is unset", async () => {
    await runInDurableObject(env.DISTRICT.getByName("lti-platform-ags-off"), async (_instance, state) => {
      const off = await startDistrict(state.storage, {
        config: JSON.stringify(TEST_CONFIG),
        accessIssuer: ACCESS_ISSUER,
        accessAudiences: ACCESS_AUDIENCES,
        ltiToolOrigin: LTI_TOOL_ORIGIN,
      }, { importFetch: async () => new Response(null, { status: 404 }) });
      const ags = await off.lti!.serveTool(new Request(`${LTI_TOOL_ORIGIN}/lti/platform/ags/ltd_aaaaaaaaaaaaaaaaaaaaaa/${OFFERING}/lineitems`));
      expect(ags!.status).toBe(404);
      const queue = await off.lti!.serveAdmin(new Request(`${LTI_TOOL_ORIGIN}/api/lti/platform-scores`, { headers: { "cf-access-jwt-assertion": await signIn(MORGAN) } }));
      expect(queue.status).toBe(404);
    });
  });
});
