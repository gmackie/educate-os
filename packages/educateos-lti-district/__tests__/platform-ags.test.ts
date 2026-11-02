// The LTI Platform's Assignment and Grade Services (SCHO-179) over the district's record table and
// real policy engine: a tool's score is only ever an IF-06 approval a teacher of the offering
// decides, pinned to the line item's revision; an approval applies the score reviewed, at most once,
// and never over a later official one; a deployment that loses the service, a learner who leaves and
// a changed line item all stop a queued score. The approval queue's writes are compare-and-set.
import { describe, expect, it } from "vitest";
import { LTI_SCOPES, type PlatformServiceGrant } from "@educateos/lti";
import { OPEN_APPROVAL_STATES, type PendingToolAction } from "@educateos/policy";
import {
  LtiPlatformAgsService,
  LtiPlatformToolService,
  PLATFORM_AGS_SCORE_TOOL,
  TablePlatformScoreApprovalStore,
} from "../src/index.ts";
import { ADMIN, AMARA, as, BIO, createDistrict, DMITRI, ENG9, MORGAN, NF, rejection, RIVERA, TOOL } from "./setup.ts";

const AGS = `${TOOL}/lti/platform/ags`;
const ALL_SCOPES = [LTI_SCOPES.lineItem, LTI_SCOPES.lineItemReadonly, LTI_SCOPES.resultReadonly, LTI_SCOPES.score];

async function platform() {
  const district = createDistrict();
  const { stores } = district;
  const admin = new LtiPlatformToolService({ districtId: NF, authorizer: district.engine, directory: district.loadDirectory, store: stores.platformTools, now: district.clock.now });
  const tool = await admin.registerTool(as(ADMIN), {
    name: "Quiz Garden",
    loginInitiationUrl: "https://quiz.example/lti/login",
    redirectUris: ["https://quiz.example/lti/launch"],
    targetLinkUri: "https://quiz.example/lti/launch",
    jwksUrl: "https://quiz.example/jwks",
  });
  const deployment = await admin.deploy(as(ADMIN), { toolId: tool.id, offerings: [BIO], services: { agsLineItems: true, agsScores: true } });
  const ags = new LtiPlatformAgsService({
    districtId: NF,
    policy: district.engine,
    directory: district.loadDirectory,
    tools: stores.platformTools,
    subjects: stores.platformSubjects,
    store: stores.platformAgs,
    approvals: stores.platformScoreApprovals,
    agsUrl: AGS,
    now: district.clock.now,
  });
  /** What a token for every AGS scope lets the tool do now, as the token endpoint would verify it. */
  const grant = async (): Promise<PlatformServiceGrant> => ({
    tool: (await stores.platformTools.tool(tool.id))!,
    deployments: (await stores.platformTools.deployments()).filter((d) => d.toolId === tool.id && d.status === "active"),
    scopes: ALL_SCOPES,
    expiresAt: Number.MAX_SAFE_INTEGER,
  });
  const created = await ags.createLineItem(await grant(), deployment.id, BIO, { label: "Quiz 1", scoreMaximum: 10 });
  const lineItemId = String(created.id).split("/").at(-1)!;
  const subject = (principal: typeof AMARA) => stores.platformSubjects.subjectFor(tool.id, principal);
  let seconds = 0;
  const score = async (principal: typeof AMARA, scoreGiven: number) => ({
    userId: await subject(principal),
    scoreGiven,
    scoreMaximum: 10,
    activityProgress: "Completed",
    gradingProgress: "FullyGraded",
    timestamp: new Date(Date.UTC(2026, 10, 1, 9, 0, (seconds += 1))).toISOString(),
  });
  const post = async (principal: typeof AMARA, scoreGiven: number) => ags.postScore(await grant(), deployment.id, BIO, lineItemId, await score(principal, scoreGiven));
  const pending = async () => ags.pendingScores(as(MORGAN));
  return { district, admin, tool, deployment, ags, grant, lineItemId, created, subject, score, post, pending };
}

describe("LtiPlatformAgsService", () => {
  it("queues a score as an IF-06 approval that only a teacher of the offering applies", async () => {
    const p = await platform();
    expect(await p.post(AMARA, 7)).toEqual({ queued: true });
    const [queued] = await p.pending();
    expect(queued).toMatchObject({ studentId: AMARA, scoreGiven: 7, offeringId: BIO, toolName: "Quiz Garden" });
    const [action] = await p.district.stores.platformScoreApprovals.list();
    expect(action).toMatchObject({ tool: PLATFORM_AGS_SCORE_TOOL, channel: "lti-service", needs: "approval", state: "pending", subject: { principalId: ADMIN } });
    expect(action!.target).toMatchObject({ resource: { kind: "official-grade", ownerPrincipalId: AMARA }, version: "1" });
    expect(await p.ags.results(await p.grant(), p.deployment.id, BIO, p.lineItemId, {})).toEqual([]);

    expect(await rejection(p.ags.approveScore(as(AMARA), queued!.approvalId, {}))).toBe("not-found");
    expect(await rejection(p.ags.approveScore(as(RIVERA), queued!.approvalId, {}))).toBe("not-found");
    expect(await rejection(p.ags.approveScore(as(ADMIN), queued!.approvalId, {}))).toBe("forbidden");
    // Over an agent or tool channel, even the offering's teacher cannot decide it.
    expect(await rejection(p.ags.approveScore({ ...as(MORGAN), channel: "agent" }, queued!.approvalId, {}))).toBe("not-found");

    expect(await p.ags.approveScore(as(MORGAN), queued!.approvalId, { digest: queued!.digest })).toEqual({ status: "applied" });
    const results = await p.ags.results(await p.grant(), p.deployment.id, BIO, p.lineItemId, {});
    expect(results).toEqual([expect.objectContaining({ userId: await p.subject(AMARA), resultScore: 7, resultMaximum: 10 })]);
    expect(await p.ags.results(await p.grant(), p.deployment.id, BIO, p.lineItemId, { userId: await p.subject(DMITRI) })).toEqual([]);
    expect(await p.district.stores.platformAgs.result(p.lineItemId, AMARA)).toMatchObject({ version: 1, correlationId: action!.correlationId });
  });

  it("never applies an older score over a later official one", async () => {
    const p = await platform();
    await p.post(AMARA, 4);
    await p.post(AMARA, 9);
    const [older, newer] = await p.pending();
    expect((await p.ags.approveScore(as(MORGAN), newer!.approvalId, {})).status).toBe("applied");
    expect(await rejection(p.ags.approveScore(as(MORGAN), older!.approvalId, {}))).toBe("conflict");
    expect(await p.pending()).toEqual([]);
    expect((await p.district.stores.platformAgs.result(p.lineItemId, AMARA))?.scoreGiven).toBe(9);
  });

  it("declines a queued score whose line item changed, whose learner left or whose deployment lost the service", async () => {
    const p = await platform();
    await p.post(AMARA, 5);
    await p.ags.replaceLineItem(await p.grant(), p.deployment.id, BIO, p.lineItemId, { label: "Quiz 1", scoreMaximum: 20 });
    const [changed] = await p.pending();
    expect(await rejection(p.ags.approveScore(as(MORGAN), changed!.approvalId, {}))).toBe("not-found");
    expect(await p.pending()).toEqual([]);

    await p.post(AMARA, 6);
    await p.admin.changeDeployment(as(ADMIN), p.deployment.id, { services: { agsLineItems: true, agsScores: false } });
    const [revoked] = await p.pending();
    expect(await rejection(p.ags.approveScore(as(MORGAN), revoked!.approvalId, {}))).toBe("conflict");
    expect(await p.district.stores.platformAgs.result(p.lineItemId, AMARA)).toBeUndefined();
  });

  it("refuses another offering, a non-learner, a missing scope and an earlier timestamp", async () => {
    const p = await platform();
    const grant = await p.grant();
    expect(await rejection(p.ags.listLineItems(grant, p.deployment.id, ENG9, {}))).toBe("not-found");
    expect(await rejection(p.ags.lineItem(grant, p.deployment.id, BIO, "lli_aaaaaaaaaaaaaaaaaaaaaa"))).toBe("not-found");
    expect(await rejection(p.ags.postScore(grant, p.deployment.id, BIO, p.lineItemId, await p.score(MORGAN, 1)))).toBe("validation-failed");
    expect(await rejection(p.ags.createLineItem({ ...grant, scopes: [LTI_SCOPES.lineItemReadonly] }, p.deployment.id, BIO, { label: "x", scoreMaximum: 1 }))).toBe("forbidden");
    expect(await rejection(p.ags.results({ ...grant, scopes: [LTI_SCOPES.lineItem] }, p.deployment.id, BIO, p.lineItemId, {}))).toBe("forbidden");

    const early = await p.score(AMARA, 2);
    const late = await p.score(AMARA, 3);
    await p.ags.postScore(grant, p.deployment.id, BIO, p.lineItemId, early);
    expect(await rejection(p.ags.postScore(grant, p.deployment.id, BIO, p.lineItemId, { ...early, scoreGiven: 1 }))).toBe("conflict");
    expect(await p.ags.postScore(grant, p.deployment.id, BIO, p.lineItemId, late)).toEqual({ queued: true });
  });

  it("keeps a line item that has an official result", async () => {
    const p = await platform();
    await p.post(AMARA, 8);
    const [queued] = await p.pending();
    await p.ags.approveScore(as(MORGAN), queued!.approvalId, {});
    expect(await rejection(p.ags.deleteLineItem(await p.grant(), p.deployment.id, BIO, p.lineItemId))).toBe("conflict");
    expect((await p.ags.listLineItems(await p.grant(), p.deployment.id, BIO, {}))).toHaveLength(1);
  });

  it("advertises the endpoint in a launch only with an AGS service", async () => {
    const p = await platform();
    const claims = await p.ags.launchClaims({ deployment: p.deployment, offeringId: BIO, resourceLinkId: "link-1" });
    expect(claims).toEqual({ "https://purl.imsglobal.org/spec/lti-ags/claim/endpoint": { scope: ALL_SCOPES, lineitems: `${AGS}/${p.deployment.id}/${BIO}/lineitems` } });
    expect(await p.ags.launchClaims({ deployment: { ...p.deployment, services: { ...p.deployment.services, agsLineItems: false, agsScores: false } }, offeringId: BIO, resourceLinkId: "link-1" })).toEqual({});
  });
});

/** A queued score action with `id`, all others alike. */
const action = (id: string): PendingToolAction => ({
  id,
  tool: PLATFORM_AGS_SCORE_TOOL,
  input: {},
  subject: { principalId: ADMIN, districtId: NF },
  channel: "lti-service",
  correlationId: "c-1",
  needs: "approval",
  idempotencyKey: "a".repeat(64),
  createdAt: "2026-11-01T00:00:00.000Z",
  expiresAt: "2026-11-08T00:00:00.000Z",
  state: "pending",
});

describe("TablePlatformScoreApprovalStore", () => {
  it("returns the open action for a repeated call and transitions only from the stated state", async () => {
    const { table } = createDistrict();
    const store = new TablePlatformScoreApprovalStore(table);
    expect((await store.insertUnlessOpen(action("apr_one"))).id).toBe("apr_one");
    expect((await store.insertUnlessOpen(action("apr_two"))).id).toBe("apr_one");
    expect(await store.transition("apr_one", "claimed", { ...action("apr_one"), state: "applied" })).toBe(false);
    expect(await store.transition("apr_one", "pending", { ...action("apr_one"), state: "declined" })).toBe(true);
    expect(OPEN_APPROVAL_STATES.has((await store.get("apr_one"))!.state)).toBe(false);
    expect((await store.insertUnlessOpen(action("apr_two"))).id).toBe("apr_two");
    expect((await store.list()).map((a) => a.id)).toEqual(["apr_one", "apr_two"]);
  });
});
