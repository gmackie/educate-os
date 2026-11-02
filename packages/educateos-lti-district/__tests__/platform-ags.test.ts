// The LTI Platform's Assignment and Grade Services (SCHO-179) over the district's record table and
// real policy engine: every call is decided with the tool itself as the subject, through its
// deployment, never as the administrator who deployed it; a tool's score is only ever an IF-06
// approval a teacher of the offering decides, pinned to the line item's revision; an approval
// applies the score reviewed, at most once, and never over a later official one; a deployment that
// loses the service, a learner who leaves and a changed line item all stop a queued score. The
// approval queue's writes are compare-and-set.
import { describe, expect, it } from "vitest";
import { LTI_SCOPES, type PlatformServiceGrant } from "@educateos/lti";
import type { AuthorizationRequest, PrincipalId } from "@educateos/contracts";
import { OPEN_APPROVAL_STATES, type PendingToolAction } from "@educateos/policy";
import {
  LtiPlatformAgsService,
  LtiPlatformToolService,
  PLATFORM_AGS_SCORE_TOOL,
  platformToolPrincipalId,
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
  const deployment = await admin.deploy(as(ADMIN), { toolId: tool.id, offerings: [BIO], services: { agsLineItems: true, agsResults: true, agsScores: true } });
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
  const toolPrincipal = platformToolPrincipalId(tool.id);
  /** Sets a person's status in the directory, as a roster sync would. */
  const setStatus = async (principalId: PrincipalId, status: "active" | "inactive") => {
    const { snapshot, version } = await district.academics.load();
    await district.academics.commit({ ...snapshot, principals: snapshot.principals.map((person) => (person.id === principalId ? { ...person, status } : person)) }, version);
  };
  /** The engine's decision for the tool, on the `lti-service` channel, of `action` on `resource` in Biology. */
  const decide = async (action: AuthorizationRequest["action"], resource: Omit<AuthorizationRequest["resource"], "scope">) => district.engine.decide({
    subject: { principalId: toolPrincipal, districtId: NF },
    action,
    resource: { ...resource, scope: { level: "offering", districtId: NF, schoolId: "sch_nf-high", offeringId: BIO } } as AuthorizationRequest["resource"],
    context: { channel: "lti-service", termState: "active" },
  });
  return { district, admin, tool, deployment, ags, grant, lineItemId, created, subject, score, post, pending, toolPrincipal, setStatus, decide };
}

describe("LtiPlatformAgsService", () => {
  it("queues a score as an IF-06 approval that only a teacher of the offering applies", async () => {
    const p = await platform();
    expect(await p.post(AMARA, 7)).toEqual({ queued: true });
    const [queued] = await p.pending();
    expect(queued).toMatchObject({ studentId: AMARA, scoreGiven: 7, offeringId: BIO, toolName: "Quiz Garden" });
    const [action] = await p.district.stores.platformScoreApprovals.list();
    expect(action).toMatchObject({ tool: PLATFORM_AGS_SCORE_TOOL, channel: "lti-service", needs: "approval", state: "pending", subject: { principalId: p.toolPrincipal } });
    expect(action!.target).toMatchObject({ resource: { kind: "official-grade", ownerPrincipalId: AMARA }, version: "1" });
    expect(await p.ags.results(await p.grant(), p.deployment.id, BIO, p.lineItemId, {})).toEqual([]);

    expect(await rejection(p.ags.approveScore(as(AMARA), queued!.approvalId, {}))).toBe("not-found");
    expect(await rejection(p.ags.approveScore(as(RIVERA), queued!.approvalId, {}))).toBe("not-found");
    // The administrator who deployed the tool has no part in its scores: not its requester, nor a teacher.
    expect(await rejection(p.ags.approveScore(as(ADMIN), queued!.approvalId, {}))).toBe("not-found");
    expect(await p.ags.pendingScores(as(ADMIN))).toEqual([]);
    // Over an agent or tool channel, even the offering's teacher cannot decide it.
    expect(await rejection(p.ags.approveScore({ ...as(MORGAN), channel: "agent" }, queued!.approvalId, {}))).toBe("not-found");

    expect(await p.ags.approveScore(as(MORGAN), queued!.approvalId, { digest: queued!.digest })).toEqual({ status: "applied" });
    const results = await p.ags.results(await p.grant(), p.deployment.id, BIO, p.lineItemId, {});
    expect(results).toEqual([expect.objectContaining({ userId: await p.subject(AMARA), resultScore: 7, resultMaximum: 10 })]);
    expect(await p.ags.results(await p.grant(), p.deployment.id, BIO, p.lineItemId, { userId: await p.subject(DMITRI) })).toEqual([]);
    expect(await p.district.stores.platformAgs.result(p.lineItemId, AMARA)).toMatchObject({ version: 1, correlationId: action!.correlationId });
  });

  it("decides every call as the tool through its deployment, audited with both", async () => {
    const p = await platform();
    await p.ags.listLineItems(await p.grant(), p.deployment.id, BIO, {});
    await p.post(AMARA, 7);
    await p.ags.results(await p.grant(), p.deployment.id, BIO, p.lineItemId, {});
    const tool = p.district.audit.filter((event) => event.principalId === p.toolPrincipal);
    expect(tool.map((event) => [event.action, event.ruleId, event.grantId])).toEqual([
      ["create", "lti.tool.line-items.write", p.deployment.id],
      ["list", "lti.tool.line-items", p.deployment.id],
      ["grade", "lti.tool.score", p.deployment.id],
      ["list", "lti.tool.results", p.deployment.id],
    ]);
    expect(tool.every((event) => event.channel === "lti-service")).toBe(true);
    // No call was decided as the administrator who deployed the tool.
    expect(p.district.audit.some((event) => event.principalId === ADMIN && event.channel === "lti-service")).toBe(false);
  });

  it("keeps working after the administrator who deployed it is deactivated", async () => {
    const p = await platform();
    await p.setStatus(ADMIN, "inactive");
    const created = await p.ags.createLineItem(await p.grant(), p.deployment.id, BIO, { label: "Quiz 2", scoreMaximum: 5 });
    expect(created).toMatchObject({ label: "Quiz 2" });
    expect(await p.post(AMARA, 9)).toEqual({ queued: true });
    const [queued] = await p.pending();
    expect(await p.ags.approveScore(as(MORGAN), queued!.approvalId, { digest: queued!.digest })).toEqual({ status: "applied" });
    expect(await p.ags.results(await p.grant(), p.deployment.id, BIO, p.lineItemId, {})).toHaveLength(1);
  });

  it("is refused by the policy itself without the deployment's service, or for anything else on the channel", async () => {
    const p = await platform();
    const gradebook = { kind: "gradebook", classification: "teacher-only" } as const;
    const official = { kind: "official-grade", id: p.lineItemId, classification: "course" } as const;
    expect((await p.decide("create", gradebook)).ruleId).toBe("lti.tool.line-items.write");
    expect((await p.decide("grade", { ...official, ownerPrincipalId: AMARA })).decision.effect).toBe("require-approval");

    await p.admin.changeDeployment(as(ADMIN), p.deployment.id, { services: { agsLineItems: true, agsResults: true, agsScores: false } });
    expect(await p.decide("grade", { ...official, ownerPrincipalId: AMARA })).toMatchObject({ decision: { effect: "deny" }, ruleId: "guard.lti-service.tool-rules-only" });
    expect((await p.decide("list", official)).ruleId).toBe("lti.tool.results");
    // Managing the gradebook's columns does not reach the grades in them.
    await p.admin.changeDeployment(as(ADMIN), p.deployment.id, { services: { agsLineItems: true, agsResults: false, agsScores: false } });
    expect(await p.decide("list", official)).toMatchObject({ decision: { effect: "deny" }, ruleId: "guard.lti-service.tool-rules-only" });
    expect((await p.decide("list", gradebook)).ruleId).toBe("lti.tool.line-items");
    await p.admin.changeDeployment(as(ADMIN), p.deployment.id, { services: { agsLineItems: false, agsResults: false, agsScores: true } });
    for (const [action, resource] of [["create", gradebook], ["list", gradebook], ["update", { ...gradebook, id: p.lineItemId }], ["list", official]] as const) {
      expect(await p.decide(action, resource)).toMatchObject({ decision: { effect: "deny" }, ruleId: "guard.lti-service.tool-rules-only" });
    }
    expect((await p.decide("grade", { ...official, ownerPrincipalId: AMARA })).decision.effect).toBe("require-approval");

    // Nothing else reaches the channel: not an official grade read, a submission, another tool's line item.
    for (const [action, resource] of [
      ["read", { ...official, ownerPrincipalId: AMARA }],
      ["approve", { ...official, ownerPrincipalId: AMARA }],
      ["list", { kind: "submission", classification: "course" }],
      ["grade", { ...official, id: "lli_aaaaaaaaaaaaaaaaaaaaaa", ownerPrincipalId: AMARA }],
    ] as const) {
      expect(await p.decide(action, resource)).toMatchObject({ decision: { effect: "deny" }, ruleId: "guard.lti-service.tool-rules-only" });
    }
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
    // The tool's own call, decided again at approval, no longer has the deployment's grant.
    expect(await rejection(p.ags.approveScore(as(MORGAN), revoked!.approvalId, {}))).toBe("not-found");
    expect(await p.district.stores.platformScoreApprovals.get(revoked!.approvalId)).toMatchObject({ state: "declined", declineReason: "The change is no longer permitted." });
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
    expect(await p.ags.launchClaims({ deployment: { ...p.deployment, services: { ...p.deployment.services, agsLineItems: false, agsResults: false, agsScores: false } }, offeringId: BIO, resourceLinkId: "link-1" })).toEqual({});
  });
});

/** A queued score action with `id`, all others alike. */
const action = (id: string): PendingToolAction => ({
  id,
  tool: PLATFORM_AGS_SCORE_TOOL,
  input: {},
  subject: { principalId: platformToolPrincipalId("ltt_AbC-_09xyzXYZ012345678"), districtId: NF },
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
