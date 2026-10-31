import { describe, expect, it } from "vitest";
import { DelegationId, type Caller, type VerifiedPrincipal } from "@educateos/contracts";
import { InMemoryAcademicStore } from "@educateos/academics";
import { NORTHFIELD } from "@educateos/fixtures";
import {
  DelegationCeiling,
  Delegations,
  directoryPolicyInformation,
  InMemoryDelegationStore,
  InMemoryPolicyAuditSink,
  NewDelegation,
  PendingToolAction,
  PolicyEngine,
  toolCallKey,
  type Delegation,
} from "../src/index.ts";
import { courseResource, inOffering, P, req, SHARING_FLOOR } from "./setup.ts";

const HOUR_MS = 3_600_000;
const http = (principal: VerifiedPrincipal): Caller => ({ principal, channel: "http" });
const CLIENT = { issuer: "https://auth.northfield.example", clientId: "lesson-planner" };

/** Morgan teaches Biology P2 (fall) and P4 (spring); Amara is a student in both. */
const BIO = "off_nf-bio-fall-p2";
const BIO_SPRING = "off_nf-bio-spring-p4";
const CEILING: DelegationCeiling = {
  scope: inOffering(BIO).scope,
  actions: ["read", "list", "create", "update", "invoke-tool"],
  kinds: ["rubric", "submission", "course-content"],
  classifications: ["course", "teacher-only"],
};

function delegations() {
  const clock = { now: new Date("2026-10-21T09:00:00Z") };
  const now = () => clock.now;
  const store = new InMemoryDelegationStore();
  const directory = InMemoryAcademicStore.seeded(NORTHFIELD);
  const audit = new InMemoryPolicyAuditSink();
  const engine = new PolicyEngine({
    information: directoryPolicyInformation(directory, { effectivePolicy: async () => SHARING_FLOOR }, { delegations: store, now }),
    audit,
    now,
  });
  const service = new Delegations({ store, policy: engine, now });
  const issue = (overrides: object = {}) => service.issue(http(P.morgan), { client: CLIENT, ceiling: CEILING, durationHours: 24, ...overrides });
  const agentOf = (delegation: Delegation, who: VerifiedPrincipal = P.morgan): VerifiedPrincipal => ({ ...who, delegationId: delegation.id });
  return { clock, store, directory, audit, engine, service, issue, agentOf };
}

describe("a delegation (SCHO-175)", () => {
  it("lets the client do what both the teacher and the ceiling allow, auditing each decision with it", async () => {
    const { engine, audit, issue, agentOf } = delegations();
    const delegation = await issue();
    expect(delegation).toMatchObject({ grantorPrincipalId: P.morgan.principalId, client: CLIENT, expiresAt: "2026-10-22T09:00:00.000Z" });

    const work = courseResource(BIO, "submission", "course", { id: "sub_amara-cells", owner: "prn_nf-student-amara" });
    expect(await engine.decide(req(agentOf(delegation), "read", work, "mcp-tool"))).toMatchObject({
      decision: { effect: "allow" },
      delegationId: delegation.id,
    });
    expect(audit.events.at(-1)).toMatchObject({ effect: "allow", delegationId: delegation.id, principalId: P.morgan.principalId });
    // The ceiling never widens the teacher: what Morgan may not do herself, her client may not either.
    const rivera = courseResource("off_nf-eng9-fall-p3", "rubric", "course");
    expect((await engine.decide(req(P.morgan, "read", rivera))).decision.effect).toBe("deny");
  });

  it("refuses another offering and a sibling's records, though the teacher herself may read them", async () => {
    const { engine, audit, issue, agentOf } = delegations();
    const delegation = await issue();
    // Amara's work in Morgan's other class: Morgan reads it, her Biology P2 client does not.
    const spring = courseResource(BIO_SPRING, "submission", "course", { id: "sub_amara-spring", owner: "prn_nf-student-amara" });
    expect((await engine.decide(req(P.morgan, "read", spring))).decision.effect).toBe("allow");
    expect(await engine.decide(req(agentOf(delegation), "read", spring, "mcp-tool"))).toMatchObject({
      decision: { effect: "deny" },
      ruleId: "delegation.ceiling",
    });
    expect(audit.events.at(-1)).toMatchObject({ effect: "deny", ruleId: "delegation.ceiling", delegationId: delegation.id });
    // A student's family is never in a ceiling: guardian relationships, personal spaces and grades are not delegable.
    const family = { resource: { kind: "guardian-relationship", id: "grl_amara-mother", scope: { level: "district", districtId: P.morgan.districtId }, classification: "restricted", ownerPrincipalId: P.amara.principalId } } as const;
    expect((await engine.decide(req(agentOf(delegation), "read", family, "mcp-tool"))).ruleId).toBe("delegation.ceiling");
    // Nor an action outside the ceiling, in the class it covers.
    const rubric = courseResource(BIO, "rubric", "course");
    expect((await engine.decide(req(agentOf(delegation), "publish", rubric, "mcp-tool"))).ruleId).toBe("delegation.ceiling");
  });

  it("stops when the teacher leaves the class's roster, though the delegation has not expired", async () => {
    const { engine, directory, issue, agentOf } = delegations();
    const delegation = await issue();
    const work = courseResource(BIO, "rubric", "course");
    expect((await engine.decide(req(agentOf(delegation), "read", work, "mcp-tool"))).decision.effect).toBe("allow");

    const { snapshot, version } = await directory.load();
    const enrollments = snapshot.enrollments.map((e) => (e.id === "enr_nf-01" ? { ...e, status: "inactive" as const } : e));
    await directory.commit({ ...snapshot, enrollments }, version);
    expect(await engine.decide(req(agentOf(delegation), "read", work, "mcp-tool"))).toMatchObject({
      decision: { effect: "deny" },
      ruleId: "delegation.grantor-standing",
    });
  });

  it("stops when it expires or is revoked, and names only its own grantor", async () => {
    const { clock, engine, service, issue, agentOf } = delegations();
    const work = courseResource(BIO, "rubric", "course");
    const expiring = await issue();
    clock.now = new Date(clock.now.getTime() + 24 * HOUR_MS);
    expect((await engine.decide(req(agentOf(expiring), "read", work, "mcp-tool"))).ruleId).toBe("delegation.not-in-force");

    const revoked = await issue();
    expect((await engine.decide(req(agentOf(revoked), "read", work, "mcp-tool"))).decision.effect).toBe("allow");
    await service.revoke(http(P.morgan), revoked.id);
    expect((await engine.decide(req(agentOf(revoked), "read", work, "mcp-tool"))).ruleId).toBe("delegation.not-in-force");

    // Another principal naming Morgan's delegation, or an unknown one, gets nothing.
    const other = await issue();
    expect((await engine.decide(req(agentOf(other, P.nfAdmin), "read", work, "mcp-tool"))).ruleId).toBe("delegation.unknown");
    const unknown = { ...P.morgan, delegationId: DelegationId.parse(`dlg_${crypto.randomUUID()}`) };
    expect((await engine.decide(req(unknown, "read", work, "mcp-tool"))).ruleId).toBe("delegation.unknown");
  });

  it("opens the tool runner only when the ceiling covers invoke-tool", async () => {
    const { engine, issue, agentOf } = delegations();
    const district = { resource: { kind: "district", id: NORTHFIELD.district.id, scope: { level: "district", districtId: P.morgan.districtId }, classification: "district-internal" } } as const;
    const tools = await issue();
    expect((await engine.decide(req(agentOf(tools), "invoke-tool", district, "mcp-tool"))).decision.effect).toBe("allow");
    const noTools = await issue({ ceiling: { ...CEILING, actions: ["read"] } });
    expect((await engine.decide(req(agentOf(noTools), "invoke-tool", district, "mcp-tool"))).ruleId).toBe("delegation.ceiling");
  });

  it("is denied outright where the engine has no delegations to read", async () => {
    const { issue, agentOf } = delegations();
    const delegation = await issue();
    const engine = new PolicyEngine({
      information: directoryPolicyInformation(InMemoryAcademicStore.seeded(NORTHFIELD), { effectivePolicy: async () => SHARING_FLOOR }),
      audit: new InMemoryPolicyAuditSink(),
    });
    expect((await engine.decide(req(agentOf(delegation), "read", courseResource(BIO, "rubric", "course"), "mcp-tool"))).ruleId).toBe("delegation.unknown");
  });
});

describe("issuing and managing delegations", () => {
  it("refuses a ceiling over private, restricted or graded records, or a person's own decisions", () => {
    const parse = (ceiling: object) => NewDelegation.safeParse({ client: CLIENT, ceiling: { ...CEILING, ...ceiling }, durationHours: 24 }).success;
    expect(parse({})).toBe(true);
    expect(parse({ classifications: ["personal-private"] })).toBe(false);
    expect(parse({ classifications: ["restricted"] })).toBe(false);
    expect(parse({ kinds: ["official-grade"] })).toBe(false);
    expect(parse({ kinds: ["delegation"] })).toBe(false);
    for (const action of ["approve", "delete", "grade", "export", "publish", "configure"]) expect(parse({ actions: [action] })).toBe(false);
    expect(NewDelegation.safeParse({ client: CLIENT, ceiling: CEILING, durationHours: 91 * 24 }).success).toBe(false);
    expect(NewDelegation.safeParse({ client: { ...CLIENT, issuer: "http://auth.example" }, ceiling: CEILING, durationHours: 1 }).success).toBe(false);
  });

  it("lets a teacher delegate only within a class she teaches, as a person over http", async () => {
    const { service, issue, agentOf } = delegations();
    const delegation = await issue();
    const eng9 = { ...CEILING, scope: inOffering("off_nf-eng9-fall-p3").scope };
    await expect(issue({ ceiling: eng9 })).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.issue({ principal: P.morgan, channel: "agent" }, { client: CLIENT, ceiling: CEILING, durationHours: 1 })).rejects.toMatchObject({ code: "forbidden" });
    // A client cannot delegate onward.
    await expect(service.issue({ principal: agentOf(delegation), channel: "http" }, { client: CLIENT, ceiling: CEILING, durationHours: 1 })).rejects.toMatchObject({ code: "forbidden" });
    // A student cannot delegate at all.
    await expect(service.issue(http(P.amara), { client: CLIENT, ceiling: CEILING, durationHours: 1 })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("shows and revokes a delegation for its grantor and a district admin only", async () => {
    const { service, issue } = delegations();
    const delegation = await issue();
    expect((await service.list(http(P.morgan))).map((d) => d.id)).toEqual([delegation.id]);
    expect(await service.list(http(P.rivera))).toEqual([]);
    expect((await service.list(http(P.nfAdmin))).map((d) => d.id)).toEqual([delegation.id]);
    await expect(service.revoke(http(P.rivera), delegation.id)).rejects.toMatchObject({ code: "not-found" });

    const revoked = await service.revoke(http(P.nfAdmin), delegation.id);
    expect(revoked.revoked).toEqual({ by: P.nfAdmin.principalId, at: "2026-10-21T09:00:00.000Z" });
    expect(await service.revoke(http(P.morgan), delegation.id)).toEqual(revoked);
  });
});

describe("a delegated call waiting for a person", () => {
  it("is queued under its delegation, so it never shares a key with the teacher's own call", async () => {
    const call = { subject: P.morgan, channel: "agent" as const, tool: "update_course", input: { courseId: "crs_nf-biology-1" } };
    const delegated = { ...call, subject: { ...P.morgan, delegationId: DelegationId.parse(`dlg_${crypto.randomUUID()}`) } };
    expect(await toolCallKey(delegated)).not.toBe(await toolCallKey(call));
    expect(PendingToolAction.shape.subject.safeParse(delegated.subject).success).toBe(true);
  });
});
