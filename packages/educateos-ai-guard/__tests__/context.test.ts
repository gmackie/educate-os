// Resolving who a model call is for from the district's records (SCHO-132), never from the call.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AiCallDescriptor } from "@gadgets/workshop-shared/ai-call-guard";
import { AiPrincipal, AiWorkspaceContext } from "@educateos/ai-governance";
import { RIVERBEND } from "@educateos/fixtures";
import { guardDirectoryOver, type GuardSubject } from "@educateos/district-app/guard-directory";
import { DEFAULT_GUARD_MESSAGES, GuardConfig, readGuardConfig } from "../src/config.ts";
import { audienceOf, configuredGuardDirectory, DistrictGuardContextResolver, gadgetGradeBand, STUDENT_GRADE_BANDS, studentProfileKey, type GuardDirectoryPort, type StudentGradeBand } from "../src/context.ts";
import { AiCallGuardService } from "../src/guard.ts";
import { ConfiguredGovernanceSource } from "../src/ledger-object.ts";
import { hallMonitorClient } from "../src/hall-monitor.ts";
import type { HallMonitorClient } from "@gmacko/hall-monitor-client";
import type { EvaluationRequest } from "@gmacko/hall-monitor-contracts";
import { AMARA_BIO_GADGET, TEST_CONFIG, USERS } from "./fixtures.ts";

const config = readGuardConfig(env.AI_GUARD_CONFIG);
const resolver = new DistrictGuardContextResolver(configuredGuardDirectory(config), config);
const PROFILES = config.profiles;
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
    const bound = new DistrictGuardContextResolver(env.EDUCATEOS_DISTRICT!, config);
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
    const viaBinding = await new ConfiguredGovernanceSource(bare, env.EDUCATEOS_DISTRICT!).directory();
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

  it("refuses a student profile that skips input moderation or streams replies unscreened (SCHO-307)", () => {
    for (const unsafe of [{ moderateInput: false }, { outputModeration: "optional" }, { outputModeration: "off" }]) {
      for (const key of ["student-k5", "student-6-8", "student-9-12"] as const) {
        const profiles = { ...TEST_CONFIG.profiles, [key]: { ...TEST_CONFIG.profiles[key], ...unsafe } };
        expect(GuardConfig.safeParse({ ...TEST_CONFIG, profiles }).success).toBe(false);
      }
      // A static binding of a student to such a profile is refused too; an educator's is not.
      const profiles = { ...TEST_CONFIG.profiles, lax: { ...TEST_CONFIG.profiles.student, ...unsafe } };
      const binding = { ...TEST_CONFIG.principals[0]!, profile: "lax" };
      expect(GuardConfig.safeParse({ ...TEST_CONFIG, profiles, principals: [binding] }).success).toBe(false);
      expect(GuardConfig.safeParse({ ...TEST_CONFIG, profiles, principals: [{ ...binding, audience: "educator" }] }).success).toBe(true);
    }
    expect(GuardConfig.safeParse({ ...TEST_CONFIG, profiles: { ...TEST_CONFIG.profiles, educator: { ...TEST_CONFIG.profiles.educator, moderateInput: false } } }).success).toBe(true);
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

describe("gadgetGradeBand (SCHO-325)", () => {
  const OWN_BANDS = [...STUDENT_GRADE_BANDS, undefined] as const;
  const DECLARATIONS = [...STUDENT_GRADE_BANDS, undefined, "adult", "educator", "k-2", "9-12 ", "", "K-12"] as const;
  const rank = (band: string | undefined) => (band === undefined ? 0 : STUDENT_GRADE_BANDS.indexOf(band as StudentGradeBand));

  it("is K-2 for a gadget that declares no student band, whoever owns it", () => {
    for (const declared of [undefined, "adult", "educator", "k-2", "9-12 ", "", "K-12"]) {
      expect(gadgetGradeBand(declared, { audience: "educator" })).toBe("K-2");
      for (const gradeBand of OWN_BANDS) expect(gadgetGradeBand(declared, { audience: "student", ...(gradeBand ? { gradeBand } : {}) })).toBe("K-2");
    }
  });

  it("is the younger of the declared band and a student's own: a declaration never loosens a student's screening", () => {
    for (const declared of DECLARATIONS) {
      for (const gradeBand of OWN_BANDS) {
        const band = gadgetGradeBand(declared, { audience: "student", ...(gradeBand ? { gradeBand } : {}) });
        // Never older than the student's own band, or than what the gadget declares.
        expect(rank(band)).toBeLessThanOrEqual(rank(gradeBand));
        expect(rank(band)).toBeLessThanOrEqual(STUDENT_GRADE_BANDS.includes(declared as StudentGradeBand) ? rank(declared) : 0);
      }
    }
    expect(gadgetGradeBand("9-12", { audience: "student", gradeBand: "6-8" })).toBe("6-8");
    expect(gadgetGradeBand("K-2", { audience: "student", gradeBand: "9-12" })).toBe("K-2");
    expect(gadgetGradeBand("6-8", { audience: "student", gradeBand: "9-12" })).toBe("6-8");
    // A student placed in no band is the youngest.
    expect(gadgetGradeBand("9-12", { audience: "student" })).toBe("K-2");
    // A band Hall Monitor knows but no student is in counts as none.
    expect(gadgetGradeBand("9-12", { audience: "student", gradeBand: "adult" })).toBe("K-2");
  });

  it("is the declared band for staff, who are never screened as educators through a gadget", () => {
    for (const band of STUDENT_GRADE_BANDS) expect(gadgetGradeBand(band, { audience: "educator" })).toBe(band);
  });

  it("maps each band to the profile audienceOf gives a student of that band", () => {
    for (const band of STUDENT_GRADE_BANDS) {
      const subject: GuardSubject = { principal: AMARA, kind: "student", roles: [], workspace: { kind: "personal" }, gradeBands: [band] };
      expect(studentProfileKey(band)).toBe(audienceOf(subject).key);
    }
  });
});

describe("a gadget's calls over the district's records (SCHO-325)", () => {
  const gadget = (user: string, audience?: string, overrides: Partial<AiCallDescriptor> = {}) =>
    call(user, { initiator: { type: "gadget", id: user }, callSite: "gadget.llm", ...(audience === undefined ? {} : { audience }), ...overrides });
  const screened = (evaluated: EvaluationRequest[]) => evaluated.map((request) => [request.evaluationKind, request.policy.profileId, request.context.audience, request.context.gradeBand]);

  it("screens a student's gadget at the younger of its declared band and the student's, input and output", async () => {
    const { guard, evaluated } = guardOver(configuredGuardDirectory(config));
    // Amara is in 9-12. A 6-8 tutor is screened at 6-8; a 9-12 one at 9-12; an undeclared one at K-2.
    for (const [audience, profileId, band] of [["6-8", "k12-middle", "6-8"], ["9-12", "k12-high", "9-12"], [undefined, "k12-elementary", "K-2"], ["K-2", "k12-elementary", "K-2"]] as const) {
      evaluated.length = 0;
      const descriptor = gadget(USERS.student, audience, { gadgetId: AMARA_BIO_GADGET });
      expect(await guard.beforeModelCall(descriptor)).toEqual({ action: "proceed", screenOutput: true });
      expect(await guard.screenModelOutput(descriptor.callId, { parts: [{ type: "text", text: "Try the first step." }], initiator: descriptor.initiator, ...(audience === undefined ? {} : { audience }) })).toEqual({ action: "release" });
      expect(screened(evaluated)).toEqual([["interaction.input", profileId, "student", band], ["interaction.output", profileId, "student", band]]);
    }
  });

  it("never screens a younger student's gadget at an older declared band", async () => {
    const { guard, evaluated } = guardOver(configuredGuardDirectory(config));
    // Felix is in 6-8: a 9-12 declaration is screened at 6-8.
    const descriptor = gadget(USERS.middleSchooler, "9-12");
    expect(await guard.beforeModelCall(descriptor)).toEqual({ action: "proceed", screenOutput: true });
    expect(screened(evaluated)).toEqual([["interaction.input", "k12-middle", "student", "6-8"]]);
  });

  it("screens a teacher's gadget as a student's, at its declared band, failing closed", async () => {
    const { guard, evaluated } = guardOver(configuredGuardDirectory(config));
    const descriptor = gadget(USERS.teacher, "9-12");
    expect(await guard.beforeModelCall(descriptor)).toEqual({ action: "proceed", screenOutput: true });
    expect(screened(evaluated)).toEqual([["interaction.input", "k12-high", "student", "9-12"]]);
    // A declaration that names no student band never makes a teacher's gadget an educator's.
    for (const audience of ["adult", "educator"]) {
      evaluated.length = 0;
      expect(await guard.beforeModelCall(gadget(USERS.teacher, audience))).toEqual({ action: "proceed", screenOutput: true });
      expect(screened(evaluated)).toEqual([["interaction.input", "k12-elementary", "student", "K-2"]]);
    }
  });

  it("screens output at K-2 when the Workshop does not name the call's audience again", async () => {
    const { guard, evaluated } = guardOver(configuredGuardDirectory(config));
    const descriptor = gadget(USERS.student, "9-12", { gadgetId: AMARA_BIO_GADGET });
    await guard.beforeModelCall(descriptor);
    evaluated.length = 0;
    expect(await guard.screenModelOutput(descriptor.callId, { parts: [{ type: "text", text: "A reply" }], initiator: descriptor.initiator })).toEqual({ action: "release" });
    expect(screened(evaluated)).toEqual([["interaction.output", "k12-elementary", "student", "K-2"]]);
  });

  it("ignores a declared audience on a call that is not a gadget's", async () => {
    const { guard, evaluated } = guardOver(configuredGuardDirectory(config));
    expect(await guard.beforeModelCall(call(USERS.middleSchooler, { audience: "K-2" }))).toEqual({ action: "proceed", screenOutput: true });
    expect(await guard.beforeModelCall(call(USERS.teacher, { audience: "K-2" }))).toEqual({ action: "proceed" });
    expect(screened(evaluated)).toEqual([["interaction.input", "k12-middle", "student", "6-8"], ["interaction.input", "educator", "educator", undefined]]);
  });
});
