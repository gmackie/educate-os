// Resolving who a model call is for from the district's records (SCHO-132), never from the call.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AiCallDescriptor } from "@gadgets/workshop-shared/ai-call-guard";
import { AiPrincipal, AiWorkspaceContext } from "@schoolos/ai-governance";
import { RIVERBEND } from "@schoolos/fixtures";
import { guardDirectoryOver, type GuardSubject } from "@schoolos/district-app/guard-directory";
import { DEFAULT_GUARD_MESSAGES, GuardConfig, readGuardConfig } from "../src/config.ts";
import { configuredGuardDirectory, DistrictGuardContextResolver, type GuardDirectoryPort } from "../src/context.ts";
import { AiCallGuardService } from "../src/guard.ts";
import { ConfiguredGovernanceSource } from "../src/ledger-object.ts";
import { hallMonitorClient } from "../src/hall-monitor.ts";
import type { HallMonitorClient } from "@gmacko/hall-monitor-client";
import type { EvaluationRequest } from "@gmacko/hall-monitor-contracts";
import { AMARA_BIO_GADGET, TEST_CONFIG, USERS } from "./fixtures.ts";

const config = readGuardConfig(env.AI_GUARD_CONFIG);
const resolver = new DistrictGuardContextResolver(configuredGuardDirectory(config), config);
const PROFILES = TEST_CONFIG.profiles;
const AMARA = AiPrincipal.parse({ principalId: "prn_nf-student-amara", districtId: "dst_northfield" });
const BIO_WORKSPACE = AiWorkspaceContext.parse({ kind: "course", offeringId: "off_nf-bio-fall-p2" });

function initiator(id: string, type: "user" | "gadget" | "agent" = "user", gadgetId?: string): Pick<AiCallDescriptor, "initiator" | "gadgetId"> {
  return { initiator: { type, id }, ...(gadgetId === undefined ? {} : { gadgetId }) };
}

let ledgers = 0;
function guardOver(directory: GuardDirectoryPort) {
  const ledger = env.AI_LEDGER.getByName(`context-ledger-${ledgers++}`);
  const real = hallMonitorClient(env, config)!;
  const evaluated: EvaluationRequest[] = [];
  const hallMonitor = { evaluate: (request: EvaluationRequest) => (evaluated.push(request), real.evaluate(request)) } as HallMonitorClient;
  return { ledger, evaluated, guard: new AiCallGuardService({ config, ledger, resolver: new DistrictGuardContextResolver(directory, config), hallMonitor }) };
}

function call(user: string, overrides: Partial<AiCallDescriptor> = {}): AiCallDescriptor {
  return {
    callId: crypto.randomUUID(),
    logicalRequestId: "logical-1",
    kind: "language-model",
    callSite: "chat.message",
    initiator: { type: "user", id: user },
    model: { provider: "anthropic", id: "claude-sonnet-example" },
    maxOutputTokens: 1000,
    newMessages: [{ id: "msg-0", role: "user", parts: [{ type: "text", text: "How do cells divide?" }] }],
    ...overrides,
  };
}

describe("DistrictGuardContextResolver", () => {
  it("maps a high-school student, in their course workspace, to the 9-12 profile and the course's funding", async () => {
    expect(await resolver.resolve(initiator(USERS.student, "user", AMARA_BIO_GADGET))).toEqual({
      principal: { principalId: "prn_nf-student-amara", districtId: "dst_northfield" },
      workspace: { kind: "course", offeringId: "off_nf-bio-fall-p2" },
      audience: "student",
      gradeBand: "9-12",
      profile: PROFILES["student-9-12"],
    });
    // A gadget initiator's calls are its owner's; an unregistered gadget is their personal workspace.
    expect(await resolver.resolve(initiator(USERS.student, "gadget", "gadget-elsewhere"))).toMatchObject({ workspace: { kind: "personal" }, audience: "student" });
  });

  it("maps students to the profile of the youngest grade their call is for", async () => {
    expect(await resolver.resolve(initiator(USERS.middleSchooler))).toMatchObject({ audience: "student", gradeBand: "6-8", profile: PROFILES["student-6-8"] });
    expect(await resolver.resolve(initiator(USERS.unmoderated))).toMatchObject({ gradeBand: "6-8", profile: PROFILES["student-6-8"] });

    const subject = (gradeBands: string[]): GuardSubject => ({
      principal: { principalId: "prn_nf-student-felix", districtId: "dst_northfield" } as GuardSubject["principal"],
      kind: "student",
      roles: [],
      workspace: { kind: "personal" },
      gradeBands,
    });
    const answering = (answer: GuardSubject) => new DistrictGuardContextResolver({ guardSubject: async () => answer, admittedSubject: async () => null, ledgerDirectory: async () => null }, config);
    expect(await answering(subject(["K-5"])).resolve(initiator("x"))).toMatchObject({ gradeBand: "K-2", profile: PROFILES["student-k5"] });
    expect(await answering(subject(["4"])).resolve(initiator("x"))).toMatchObject({ gradeBand: "3-5", profile: PROFILES["student-k5"] });
    // A K-8 school is moderated as its youngest students.
    expect(await answering(subject(["9-12", "K-8"])).resolve(initiator("x"))).toMatchObject({ gradeBand: "K-2", profile: PROFILES["student-k5"] });
    // A student the directory places nowhere gets the strictest profile, and no unverified band.
    const unplaced = await answering(subject([])).resolve(initiator("x"));
    expect(unplaced).toMatchObject({ audience: "student", profile: PROFILES["student-k5"] });
    expect(unplaced).not.toHaveProperty("gradeBand");
  });

  it("maps teachers and administrators to the educator profile", async () => {
    for (const user of [USERS.teacher, USERS.admin]) {
      const context = await resolver.resolve(initiator(user));
      expect(context).toMatchObject({ audience: "educator", workspace: { kind: "personal" }, profile: PROFILES.educator });
      expect(context).not.toHaveProperty("gradeBand");
    }
  });

  it("knows no one by a directory email, a static binding or an agent's name", async () => {
    // Elena has a static binding (contextSource "static" would accept it) but no Workshop user link.
    expect(await resolver.resolve(initiator(USERS.educatorFailsClosed))).toBeNull();
    expect(await resolver.resolve(initiator("sam.rivera@northfield.example"))).toBeNull();
    expect(await resolver.resolve(initiator(USERS.student, "agent"))).toBeNull();
    // Someone else's course workspace is refused, not billed to its owner.
    expect(await resolver.resolve(initiator(USERS.middleSchooler, "user", AMARA_BIO_GADGET))).toBeNull();
  });

  it("keeps districts apart", async () => {
    // Another district's link to the same Workshop user key is ignored.
    const rbLink = { districtId: "dst_riverbend", workshopUser: "morgan.lee@riverbend-only.example", principalId: "prn_rb-morgan-lee", confirmedBy: "prn_rb-district-admin", confirmedAt: "2026-10-20T15:00:00Z" };
    const mixed = GuardConfig.parse({ ...TEST_CONFIG, workshopUserLinks: [...TEST_CONFIG.workshopUserLinks, rbLink] });
    expect(await new DistrictGuardContextResolver(configuredGuardDirectory(mixed), mixed).resolve(initiator(rbLink.workshopUser))).toBeNull();
    // A directory answering for another district's principal (a misbound binding, say) is refused.
    const riverbendAnswer: GuardSubject = {
      principal: { principalId: RIVERBEND.principals[1]!.id, districtId: RIVERBEND.district.id },
      kind: "staff",
      roles: ["teacher"],
      workspace: { kind: "personal" },
      gradeBands: [],
    };
    expect(await new DistrictGuardContextResolver({ guardSubject: async () => riverbendAnswer, admittedSubject: async () => null, ledgerDirectory: async () => null }, config).resolve(initiator(USERS.teacher))).toBeNull();
  });

  it("resolves through the district app's binding", async () => {
    const bound = new DistrictGuardContextResolver(env.SCHOOLOS_DISTRICT!, config);
    expect(await bound.resolve(initiator(USERS.student, "user", AMARA_BIO_GADGET))).toMatchObject({ workspace: { kind: "course" }, profile: PROFILES["student-9-12"] });
    expect(await bound.resolve(initiator("stranger@example.com"))).toBeNull();
    expect(await bound.resolveAdmitted(AMARA, BIO_WORKSPACE)).toMatchObject({ audience: "student", gradeBand: "9-12" });
  });

  it("resolves an admitted call's principal afresh, by the principal and workspace its reservation records", async () => {
    // The same context the call was admitted under, looked up without the Workshop user.
    expect(await resolver.resolveAdmitted(AMARA, BIO_WORKSPACE)).toEqual(await resolver.resolve(initiator(USERS.student, "user", AMARA_BIO_GADGET)));
    expect(await resolver.resolveAdmitted(AiPrincipal.parse({ principalId: "prn_nf-unknown", districtId: "dst_northfield" }), { kind: "personal" })).toBeNull();
    expect(await resolver.resolveAdmitted({ ...AMARA, districtId: RIVERBEND.district.id }, BIO_WORKSPACE)).toBeNull();
    // A principal who stopped being active since the call was admitted is no longer served.
    const directory = { ...config.directory!, principals: config.directory!.principals.map((p) => (p.id === AMARA.principalId ? { ...p, status: "graduated" as const } : p)) };
    const graduated = GuardConfig.parse({ ...TEST_CONFIG, directory });
    expect(await new DistrictGuardContextResolver(configuredGuardDirectory(graduated), graduated).resolveAdmitted(AMARA, BIO_WORKSPACE)).toBeNull();
  });

  it("lets the ledger read the district's profile-free directory through the binding instead of the config", async () => {
    const { directory: _configured, ...rest } = TEST_CONFIG;
    const bare = GuardConfig.parse(rest);
    const viaBinding = await new ConfiguredGovernanceSource(bare, env.SCHOOLOS_DISTRICT!).directory();
    expect(viaBinding.enrollments).toEqual(config.directory!.enrollments);
    expect(JSON.stringify(viaBinding.principals)).not.toContain("@");
    await expect(new ConfiguredGovernanceSource(bare).directory()).rejects.toMatchObject({ code: "unavailable" });
    // Another district's directory over the binding is refused.
    const misbound = { guardSubject: async () => null, admittedSubject: async () => null, ledgerDirectory: async () => RIVERBEND };
    await expect(new ConfiguredGovernanceSource(bare, misbound).directory()).rejects.toMatchObject({ code: "unavailable" });
    // With no directory and no binding, a call cannot be resolved and fails closed.
    expect(await guardOver(configuredGuardDirectory(bare)).guard.beforeModelCall(call(USERS.student))).toMatchObject({ action: "deny", reason: "context_unavailable" });
  });

  it("requires a profile for every audience class in district mode", () => {
    const { "student-6-8": _omitted, ...profiles } = TEST_CONFIG.profiles;
    expect(GuardConfig.safeParse({ ...TEST_CONFIG, profiles }).success).toBe(false);
    expect(GuardConfig.safeParse({ ...TEST_CONFIG, profiles, contextSource: "static" }).success).toBe(true);
  });
});

describe("the guard over the district's records", () => {
  it("bills a student's call to their course workspace and moderates it under their grade's profile", async () => {
    const { guard, ledger, evaluated } = guardOver(configuredGuardDirectory(config));
    const descriptor = call(USERS.student, { gadgetId: AMARA_BIO_GADGET });
    expect(await guard.beforeModelCall(descriptor)).toEqual({ action: "proceed", screenOutput: true });
    expect(evaluated.map((request) => [request.policy, request.context.audience, request.context.gradeBand]))
      .toEqual([[{ profileId: "k12-high", revision: "r2" }, "student", "9-12"]]);
    expect((await ledger.request(descriptor.callId))?.reservation).toMatchObject({ poolId: "fpl_nf-bio-fall", principalId: "prn_nf-student-amara" });
  });

  it("screens a student's response under the same grade's profile", async () => {
    const { guard, evaluated } = guardOver(configuredGuardDirectory(config));
    const descriptor = call(USERS.student, { gadgetId: AMARA_BIO_GADGET });
    await guard.beforeModelCall(descriptor);
    expect(await guard.screenModelOutput(descriptor.callId, { parts: [{ type: "text", text: "Cells divide by mitosis." }] })).toEqual({ action: "release" });
    expect(evaluated.at(-1)).toMatchObject({ policy: { profileId: "k12-high", revision: "r2" }, context: { audience: "student", gradeBand: "9-12" } });
    expect(await guard.screenModelOutput(descriptor.callId, { parts: [{ type: "text", text: "unsafe [[block]]" }] })).toMatchObject({ action: "withhold", reason: "moderation_block" });
  });

  it("withholds the response of a student who stopped being active after the call was admitted", async () => {
    let status: "active" | "graduated" = "active";
    const directory = guardDirectoryOver(async () => ({
      directory: { ...config.directory!, principals: config.directory!.principals.map((p) => (p.id === AMARA.principalId ? { ...p, status } : p)) },
      workspaces: config.workspaces,
      workshopUserLinks: config.workshopUserLinks,
    }));
    const { guard } = guardOver(directory);
    const descriptor = call(USERS.student, { gadgetId: AMARA_BIO_GADGET });
    expect(await guard.beforeModelCall(descriptor)).toEqual({ action: "proceed", screenOutput: true });
    status = "graduated";
    expect(await guard.screenModelOutput(descriptor.callId, { parts: [{ type: "text", text: "Cells divide by mitosis." }] })).toMatchObject({ action: "withhold", reason: "unknown_principal" });
  });

  it("denies an unlinked user with a message saying how to fix it, before holding anything", async () => {
    const { guard, ledger } = guardOver(configuredGuardDirectory(config));
    const descriptor = call("sam.rivera@northfield.example");
    expect(await guard.beforeModelCall(descriptor)).toEqual({ action: "deny", reason: "unknown_principal", message: DEFAULT_GUARD_MESSAGES.unknownPrincipal });
    expect(await ledger.request(descriptor.callId)).toBeNull();
  });

  it("denies a linked principal that is no longer active, before holding anything", async () => {
    // A graduated or roster-dropped student keeps their link and their work, but no grant, AI funding included.
    for (const status of ["inactive", "graduated"] as const) {
      const directory = { ...config.directory!, principals: config.directory!.principals.map((p) => (p.id === "prn_nf-student-amara" ? { ...p, status } : p)) };
      const { guard, ledger } = guardOver(configuredGuardDirectory(GuardConfig.parse({ ...TEST_CONFIG, directory })));
      const descriptor = call(USERS.student, { gadgetId: AMARA_BIO_GADGET });
      expect(await guard.beforeModelCall(descriptor)).toEqual({ action: "deny", reason: "unknown_principal", message: DEFAULT_GUARD_MESSAGES.unknownPrincipal });
      expect(await ledger.request(descriptor.callId)).toBeNull();
    }
  });

  it("fails closed when the directory is unreachable or answers nonsense", async () => {
    for (const directory of [
      { guardSubject: async () => { throw new Error("district app down"); }, admittedSubject: async () => null, ledgerDirectory: async () => null },
      { guardSubject: async () => ({ principal: { principalId: "prn_nf-student-amara", districtId: "dst_northfield" }, kind: "student", role: "teacher" }), admittedSubject: async () => null, ledgerDirectory: async () => null },
    ] satisfies GuardDirectoryPort[]) {
      const { guard, ledger } = guardOver(directory);
      const descriptor = call(USERS.student);
      expect(await guard.beforeModelCall(descriptor)).toEqual({ action: "deny", reason: "context_unavailable", message: DEFAULT_GUARD_MESSAGES.aiUnavailable });
      expect(await ledger.request(descriptor.callId)).toBeNull();
    }
  });
});
