// The roster a deployed tool reads through the LTI Platform (NRPS, SCHO-179): the tool is a
// subject of the district's real policy engine on the `lti-service` channel, with no authority but
// what its deployments give it, and the service hands out only the offering's active members under
// the tool's opaque subjects. Everything here runs over in-memory stores; the workerd tests in
// `educateos-district-worker` run it end to end.
import { describe, expect, it } from "vitest";
import { InMemoryAcademicStore } from "@educateos/academics";
import { PrincipalId } from "@educateos/contracts";
import { NORTHFIELD } from "@educateos/fixtures";
import { LTI_SCOPES, type PlatformServiceGrant } from "@educateos/lti";
import { directoryPolicyInformation, PolicyEngine, type PolicyAuditEvent } from "@educateos/policy";
import {
  InMemoryRecordTable,
  LtiPlatformNrpsService,
  LtiPlatformToolService,
  PlatformServiceRefused,
  platformToolForPrincipal,
  platformToolPolicySources,
  platformToolPrincipalId,
  TablePlatformSubjectStore,
  TablePlatformToolStore,
} from "../src/index.ts";
import { ADMIN, AMARA, as, BIO, ENG9, FLOOR, MORGAN, NF } from "./setup.ts";

const TOOL = {
  name: "Quiz Garden",
  loginInitiationUrl: "https://tool.example/lti/login",
  redirectUris: ["https://tool.example/lti/launch"],
  targetLinkUri: "https://tool.example/lti/launch",
  jwksUrl: "https://tool.example/.well-known/jwks.json",
};
const LEARNER = "http://purl.imsglobal.org/vocab/lis/v2/membership#Learner";
const INSTRUCTOR = "http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor";
const ALL = { role: null, limit: null, page: null };

function platform() {
  const academics = InMemoryAcademicStore.seeded(NORTHFIELD);
  const table = new InMemoryRecordTable();
  const store = new TablePlatformToolStore(table);
  const sources = platformToolPolicySources(store);
  const audit: PolicyAuditEvent[] = [];
  const engine = new PolicyEngine({
    information: directoryPolicyInformation(academics, { effectivePolicy: async () => FLOOR }, sources),
    audit: { record: async (event) => void audit.push(event) },
  });
  const directory = async () => (await academics.load()).snapshot;
  const tools = new LtiPlatformToolService({ districtId: NF, authorizer: engine, directory, store });
  const subjects = new TablePlatformSubjectStore(table);
  const nrps = new LtiPlatformNrpsService({
    districtId: NF,
    authorizer: engine,
    directory,
    tools: store,
    subjects,
    membershipsUrl: (deploymentId, offeringId) => `https://district.example/lti/platform/nrps/${deploymentId}/${offeringId}/memberships`,
  });
  /** The grant a token for `scopes` would verify to now. */
  const grant = async (toolId: string, scopes: PlatformServiceGrant["scopes"] = [LTI_SCOPES.contextMembershipReadonly]): Promise<PlatformServiceGrant> => ({
    tool: (await store.tool(toolId))!,
    deployments: (await store.deployments()).filter((d) => d.toolId === toolId && d.status === "active"),
    scopes,
    expiresAt: Date.now() + 60_000,
  });
  return { engine, audit, store, tools, subjects, nrps, grant };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(PlatformServiceRefused);
  return (error as PlatformServiceRefused).code;
}

describe("a tool as a policy subject", () => {
  it("maps a tool to a principal ID and back, and nothing else to a tool", () => {
    const toolId = "ltt_AbC-_09xyzXYZ012345678";
    const principalId = platformToolPrincipalId(toolId);
    expect(principalId).toMatch(/^prn_lti-tool-[0-9a-f]+$/);
    expect(platformToolForPrincipal(principalId)).toBe(toolId);
    for (const other of ["prn_nf-morgan-lee", "prn_lti-tool-", "prn_lti-tool-0", "prn_lti-tool-zz", "prn_lti-tool-6162"]) expect(platformToolForPrincipal(other)).toBeUndefined();
  });

  it("lets a tool list an offering's enrollments only through an active deployment there that allows NRPS", async () => {
    const { engine, tools } = platform();
    const tool = await tools.registerTool(as(ADMIN), TOOL);
    const deployment = await tools.deploy(as(ADMIN), { toolId: tool.id, offerings: [BIO], services: { nrps: true } });
    await tools.deploy(as(ADMIN), { toolId: tool.id, offerings: [ENG9], services: { agsScores: true } });
    const subject = { principalId: platformToolPrincipalId(tool.id), districtId: NF };
    const roster = (offeringId: string, extra: Record<string, unknown> = {}) => ({
      subject,
      action: "list",
      resource: {
        kind: "enrollment",
        scope: { level: "offering", districtId: NF, schoolId: "sch_nf-high", offeringId },
        classification: "course",
      },
      context: { channel: "lti-service" },
      ...extra,
    });

    const allowed = await engine.decide(roster(BIO));
    expect(allowed).toMatchObject({ decision: { effect: "allow" }, ruleId: "lti.tool.roster", grantId: deployment.id });
    // Another offering, or one whose deployment does not allow NRPS.
    expect((await engine.decide(roster(ENG9))).ruleId).toBe("guard.lti-service.tool-rules-only");
    // Anything else on the channel: reading the offering, another kind, another action.
    expect((await engine.decide({ ...roster(BIO), action: "read" })).decision.effect).toBe("deny");
    expect((await engine.decide({ ...roster(BIO), resource: { ...roster(BIO).resource, kind: "official-grade" } })).decision.effect).toBe("deny");
    // The tool as itself on any other channel holds no role and gets nothing.
    expect((await engine.decide({ ...roster(BIO), context: { channel: "http" } })).decision.effect).toBe("deny");
    // A person on the LTI service channel gets nothing either, however much they could do directly.
    const teacher = { principalId: MORGAN, districtId: NF };
    expect((await engine.decide({ ...roster(BIO), subject: teacher, context: { channel: "http" }, action: "read", resource: { ...roster(BIO).resource, kind: "offering", id: BIO } })).decision.effect).toBe("allow");
    expect((await engine.decide({ ...roster(BIO), subject: teacher, action: "read", resource: { ...roster(BIO).resource, kind: "offering", id: BIO } })).ruleId).toBe("guard.lti-service.tool-rules-only");

    // A revoked deployment, or a revoked tool, establishes nothing.
    await tools.revokeDeployment(as(ADMIN), deployment.id);
    expect((await engine.decide(roster(BIO))).decision.effect).toBe("deny");
    const second = await tools.deploy(as(ADMIN), { toolId: tool.id, offerings: [BIO], services: { nrps: true } });
    expect((await engine.decide(roster(BIO))).grantId).toBe(second.id);
    await tools.revokeTool(as(ADMIN), tool.id);
    expect((await engine.decide(roster(BIO))).decision.effect).toBe("deny");
  });

  it("never answers for a directory principal", async () => {
    const { store } = platform();
    const [source] = platformToolPolicySources(store).subjects;
    expect(await source!.subjectFacts(PrincipalId.parse("prn_nf-morgan-lee"))).toBeUndefined();
    expect(await source!.subjectFacts(platformToolPrincipalId("ltt_nosuchtool000000000000"))).toBeUndefined();
  });
});

describe("LtiPlatformNrpsService", () => {
  it("lists the offering's active members under the tool's subjects, and nothing else", async () => {
    const { tools, nrps, grant, subjects, audit } = platform();
    const tool = await tools.registerTool(as(ADMIN), TOOL);
    const deployment = await tools.deploy(as(ADMIN), { toolId: tool.id, offerings: [BIO], services: { nrps: true } });
    const amara = await subjects.subjectFor(tool.id, AMARA);

    const page = await nrps.memberships(await grant(tool.id), { deploymentId: deployment.id, offeringId: BIO }, ALL);
    expect(page.next).toBeUndefined();
    expect(page.container.id).toBe(`https://district.example/lti/platform/nrps/${deployment.id}/${BIO}/memberships`);
    expect(page.container.context).toEqual({ id: BIO, label: "Biology I", title: "Biology I, Period 2" });
    expect(page.container.members).toHaveLength(5);
    expect(page.container.members).toContainEqual({ user_id: amara, roles: [LEARNER], status: "Active" });
    expect(page.container.members.filter((m) => m.roles[0] === INSTRUCTOR)).toEqual([{ user_id: await subjects.subjectFor(tool.id, MORGAN), roles: [INSTRUCTOR], status: "Active" }]);
    expect(JSON.stringify(page.container)).not.toContain("prn_");
    expect(audit.at(-1)).toMatchObject({ ruleId: "lti.tool.roster", grantId: deployment.id });

    // Another tool sees other subjects for the same people.
    const other = await tools.registerTool(as(ADMIN), TOOL);
    const otherDeployment = await tools.deploy(as(ADMIN), { toolId: other.id, offerings: [BIO], services: { nrps: true } });
    const otherPage = await nrps.memberships(await grant(other.id), { deploymentId: otherDeployment.id, offeringId: BIO }, ALL);
    expect(otherPage.container.members.map((m) => m.user_id)).not.toContain(amara);
  });

  it("refuses without the scope, through another tool's or another offering's deployment, or without NRPS", async () => {
    const { tools, nrps, grant } = platform();
    const tool = await tools.registerTool(as(ADMIN), TOOL);
    const deployment = await tools.deploy(as(ADMIN), { toolId: tool.id, offerings: [BIO], services: { nrps: true } });
    const noNrps = await tools.deploy(as(ADMIN), { toolId: tool.id, offerings: [ENG9], services: { agsScores: true } });
    const other = await tools.registerTool(as(ADMIN), TOOL);
    const othersDeployment = await tools.deploy(as(ADMIN), { toolId: other.id, offerings: [BIO], services: { nrps: true } });

    expect(await refusal(nrps.memberships(await grant(tool.id, [LTI_SCOPES.score]), { deploymentId: deployment.id, offeringId: BIO }, ALL))).toBe("insufficient_scope");
    expect(await refusal(nrps.memberships(await grant(tool.id), { deploymentId: deployment.id, offeringId: ENG9 }, ALL))).toBe("forbidden");
    expect(await refusal(nrps.memberships(await grant(tool.id), { deploymentId: noNrps.id, offeringId: ENG9 }, ALL))).toBe("forbidden");
    expect(await refusal(nrps.memberships(await grant(tool.id), { deploymentId: othersDeployment.id, offeringId: BIO }, ALL))).toBe("forbidden");
    expect(await refusal(nrps.memberships(await grant(tool.id), { deploymentId: deployment.id, offeringId: BIO }, { role: null, limit: "0", page: null }))).toBe("invalid_request");
  });

  it("filters by role and pages in a stable order", async () => {
    const { tools, nrps, grant } = platform();
    const tool = await tools.registerTool(as(ADMIN), TOOL);
    const deployment = await tools.deploy(as(ADMIN), { toolId: tool.id, offerings: [BIO], services: { nrps: true }, privacy: { name: true, email: false } });
    const target = { deploymentId: deployment.id, offeringId: BIO };
    const g = await grant(tool.id);

    const learners = await nrps.memberships(g, target, { role: "Learner", limit: null, page: null });
    expect(learners.container.members.map((m) => m.name)).toEqual(["Amara Okafor", "Dmitri Novak", "Elena Sato", "Lucía Delgado"]);
    expect(learners.container.id).toMatch(/\?role=Learner$/);
    const first = await nrps.memberships(g, target, { role: null, limit: "2", page: null });
    expect(first.container.members.map((m) => m.name)).toEqual(["Morgan Lee", "Amara Okafor"]);
    expect(first.next).toBe(`https://district.example/lti/platform/nrps/${deployment.id}/${BIO}/memberships?limit=2&page=2`);
    const second = await nrps.memberships(g, target, { role: null, limit: "2", page: "2" });
    expect(second.container.members.map((m) => m.name)).toEqual(["Dmitri Novak", "Elena Sato"]);
    expect(second.next).toBe(`https://district.example/lti/platform/nrps/${deployment.id}/${BIO}/memberships?limit=2&page=3`);
    const third = await nrps.memberships(g, target, { role: null, limit: "2", page: "3" });
    expect(third.container.members.map((m) => m.name)).toEqual(["Lucía Delgado"]);
    expect(third.next).toBeUndefined();
    expect((await nrps.memberships(g, target, { role: null, limit: "2", page: "4" })).container.members).toEqual([]);
  });

});
