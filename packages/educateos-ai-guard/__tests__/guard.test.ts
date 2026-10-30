// The guard against a real ledger Durable Object and a fake Hall Monitor reached through a real
// service binding. Each test gets its own ledger object, so pools start full.

import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiCallDescriptor, AiCallOutcome } from "@gadgets/workshop-shared/ai-call-guard";
import type { HallMonitorClient } from "@gmacko/hall-monitor-client";
import { LEDGER_ENTRIES_TABLE } from "@educateos/ai-governance/durable-object-store";
import { DEFAULT_COACHING_INSTRUCTIONS, DEFAULT_GUARD_MESSAGES, readGuardConfig } from "../src/config.ts";
import { StaticGuardContextResolver } from "../src/context.ts";
import { AiCallGuardService } from "../src/guard.ts";
import { hallMonitorClient, serviceTokenSource } from "../src/hall-monitor.ts";
import { CHECK_COST, MODERATOR, SAFETY_ALLOCATION, TEST_CONFIG, USERS } from "./fixtures.ts";

const config = readGuardConfig(env.AI_GUARD_CONFIG);
/** What a student's call is admitted with: their profile requires output moderation. */
const SCREENED = { action: "proceed", screenOutput: true } as const;
/** The hold for a call capped at 1,000 output tokens: 100,000 prompt tokens at the cache-write rate plus the output. */
const HOLD_1000 = "390000000";

let ledgers = 0;

/** A guard over a fresh ledger, with the fake Hall Monitor unless another client (or none) is given. */
function setup(hallMonitor: HallMonitorClient | null = hallMonitorClient(env, config)) {
  const ledger = env.AI_LEDGER.getByName(`ledger-${ledgers++}`);
  const guard = new AiCallGuardService({ config, ledger, resolver: new StaticGuardContextResolver(config), hallMonitor });
  return { guard, ledger };
}

function call(user: string, texts: string[], overrides: Partial<AiCallDescriptor> = {}): AiCallDescriptor {
  return {
    callId: crypto.randomUUID(),
    logicalRequestId: "logical-1",
    kind: "language-model",
    callSite: "chat.message",
    initiator: { type: "user", id: user },
    gadgetId: "gadget-1",
    chatId: 1,
    model: { provider: "anthropic", id: "claude-sonnet-example" },
    maxOutputTokens: 1000,
    newMessages: texts.map((text, i) => ({ id: `msg-${i}`, role: "user", parts: [{ type: "text", text }] })),
    ...overrides,
  };
}

/** The ledger rows of one type for one request. */
async function rows(ledger: DurableObjectStub, requestId: string, type: string): Promise<number> {
  return runInDurableObject(ledger, (_instance, state) =>
    state.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${LEDGER_ENTRIES_TABLE} WHERE request_id = ? AND entry_type = ?`, requestId, type).one().n as number);
}

afterEach(() => vi.restoreAllMocks());

describe("beforeModelCall", () => {
  it("allows a call: holds generative funds and charges the check to the safety pool", async () => {
    const { guard, ledger } = setup();
    const descriptor = call(USERS.student, ["How do cells divide?"]);
    expect(await guard.beforeModelCall(descriptor)).toEqual(SCREENED);

    const generative = await ledger.request(descriptor.callId);
    expect(generative?.reservation).toMatchObject({ fundingPurpose: "generative", poolId: "fpl_nf-bio-fall", heldUsdNano: HOLD_1000 });
    expect(generative?.settlement).toBeUndefined();
    expect(generative?.voided).toBeUndefined();

    const check = await ledger.request(`${descriptor.callId}.m0.c0`);
    expect(check?.reservation).toMatchObject({ fundingPurpose: "safety", poolId: "fpl_nf-safety", model: MODERATOR });
    // The receipt's amounts flow into the ledger unchanged; its inclusive input count is split.
    expect(check?.settlement).toMatchObject({
      chargedUsdNano: CHECK_COST,
      hasUnknownCost: false,
      priceBookId: "hm-prices-2026-10-20",
      attempts: [{
        attemptIndex: 0,
        state: "provider_reported",
        actualUsdNano: CHECK_COST,
        gatewayLogId: "gw-log-1",
        usage: { inputTokens: 800, cacheReadTokens: 200, outputTokens: 1, cacheWriteTokens: 0 },
      }],
    });
  });

  it("moderates each new message, and each text chunk Hall Monitor accepts", async () => {
    const { guard, ledger } = setup();
    const descriptor = call(USERS.student, ["first", "x".repeat(70_000)]);
    expect(await guard.beforeModelCall(descriptor)).toEqual(SCREENED);
    for (const check of ["m0.c0", "m1.c0", "m1.c1", "m1.c2"]) {
      expect((await ledger.request(`${descriptor.callId}.${check}`))?.settlement?.chargedUsdNano).toBe(CHECK_COST);
    }
    expect(await ledger.request(`${descriptor.callId}.m1.c3`)).toBeNull();
  });

  it.each(["block", "hold"])("denies a %s, releases the generative hold and keeps the safety charge", async (decision) => {
    const { guard, ledger } = setup();
    const descriptor = call(USERS.student, ["fine", `not fine [[${decision}]]`]);
    expect(await guard.beforeModelCall(descriptor)).toEqual({ action: "deny", reason: `moderation_${decision}`, message: DEFAULT_GUARD_MESSAGES.blocked });
    expect((await ledger.request(descriptor.callId))?.voided).toBeDefined();
    expect((await ledger.request(`${descriptor.callId}.m0.c0`))?.settlement?.chargedUsdNano).toBe(CHECK_COST);
    expect((await ledger.request(`${descriptor.callId}.m1.c0`))?.settlement?.chargedUsdNano).toBe(CHECK_COST);
  });

  it("answers support with the deployment's supportive message, never a refusal", async () => {
    const { guard, ledger } = setup();
    const descriptor = call(USERS.student, ["I don't want to be here anymore [[support]]"]);
    const decision = await guard.beforeModelCall(descriptor);
    expect(decision).toEqual({ action: "deny", reason: "moderation_support", message: TEST_CONFIG.messages.support });
    expect((await ledger.request(descriptor.callId))?.voided).toBeDefined();
    expect((await ledger.request(`${descriptor.callId}.m0.c0`))?.settlement?.chargedUsdNano).toBe(CHECK_COST);
  });

  describe("coaching", () => {
    const COACHED = { ...SCREENED, instructions: DEFAULT_COACHING_INSTRUCTIONS };

    it("lets a coached message proceed with the coaching instructions, for any profile", async () => {
      const { guard } = setup();
      expect(await guard.beforeModelCall(call(USERS.student, ["just give me the answer [[coach]]"]))).toEqual(COACHED);
      expect(await guard.beforeModelCall(call(USERS.educatorProceeds, ["write it for me [[coach]]"])))
        .toEqual({ action: "proceed", instructions: DEFAULT_COACHING_INSTRUCTIONS });
    });

    it("coaches an allowed academic-integrity flag only where the profile scaffolds answers", async () => {
      const { guard } = setup();
      expect(await guard.beforeModelCall(call(USERS.student, ["what is the answer to question 3 [[integrity]]"]))).toEqual(COACHED);
      expect(await guard.beforeModelCall(call(USERS.educatorProceeds, ["answer key please [[integrity]]"]))).toEqual({ action: "proceed" });
    });

    it("never coaches a decision model, which takes no instructions", async () => {
      const { guard } = setup();
      expect(await guard.beforeModelCall(call(USERS.student, ["[[coach]]"], { kind: "decision-model" }))).toEqual({ action: "proceed" });
    });

    it("uses the deployment's own instructions", async () => {
      const custom = readGuardConfig(JSON.stringify({ ...TEST_CONFIG, coachingInstructions: "Ask for their attempt first." }));
      const guard = new AiCallGuardService({
        config: custom,
        ledger: env.AI_LEDGER.getByName(`ledger-${ledgers++}`),
        resolver: new StaticGuardContextResolver(custom),
        hallMonitor: hallMonitorClient(env, custom),
      });
      expect(await guard.beforeModelCall(call(USERS.student, ["[[coach]]"]))).toEqual({ ...SCREENED, instructions: "Ask for their attempt first." });
    });

    it("rejects instructions longer than the Workshop accepts", () => {
      expect(() => readGuardConfig(JSON.stringify({ ...TEST_CONFIG, coachingInstructions: "x".repeat(4001) }))).toThrow(/coachingInstructions/);
    });
  });

  it("turns generative AI off when the safety pool cannot fund moderation", async () => {
    const { guard, ledger } = setup();
    const student = config.principals[0]!;
    await ledger.reserve({
      requestId: "drain",
      principal: { principalId: student.principalId, districtId: config.districtId },
      workspace: student.workspace,
      model: MODERATOR,
      estimatedMaxUsdNano: SAFETY_ALLOCATION,
      fundingPurpose: "safety",
    });
    const descriptor = call(USERS.student, ["How do cells divide?"]);
    expect(await guard.beforeModelCall(descriptor)).toEqual({ action: "deny", reason: "safety_budget_exhausted", message: DEFAULT_GUARD_MESSAGES.aiUnavailable });
    expect((await ledger.request(descriptor.callId))?.voided).toBeDefined();
    // Hall Monitor was never asked, so nothing was spent on it.
    expect(await ledger.request(`${descriptor.callId}.m0.c0`)).toBeNull();
  });

  describe("when Hall Monitor is down", () => {
    it("fails closed for a student, recording the check's cost as unknown rather than $0", async () => {
      const { guard, ledger } = setup();
      const descriptor = call(USERS.student, ["hello [[down]]"]);
      expect(await guard.beforeModelCall(descriptor)).toEqual({ action: "deny", reason: "moderation_unavailable", message: DEFAULT_GUARD_MESSAGES.aiUnavailable });
      expect((await ledger.request(descriptor.callId))?.voided).toBeDefined();
      expect((await ledger.request(`${descriptor.callId}.m0.c0`))?.settlement).toMatchObject({ hasUnknownCost: true, chargedUsdNano: config.moderation.maxUsdNanoPerCheck });
    });

    it("fails closed for a student even when their profile says to proceed", async () => {
      const { guard } = setup();
      expect(await guard.beforeModelCall(call(USERS.studentMisconfigured, ["hello [[down]]"]))).toMatchObject({ action: "deny", reason: "moderation_unavailable" });
    });

    it("follows an educator's profile", async () => {
      const { guard, ledger } = setup();
      const proceeds = call(USERS.educatorProceeds, ["hello [[down]]"]);
      expect(await guard.beforeModelCall(proceeds)).toEqual({ action: "proceed" });
      expect((await ledger.request(proceeds.callId))?.voided).toBeUndefined();
      expect(await guard.beforeModelCall(call(USERS.educatorFailsClosed, ["hello [[down]]"]))).toMatchObject({ action: "deny", reason: "moderation_unavailable" });
    });

    it("fails closed for a student when no Hall Monitor is configured at all", async () => {
      const { guard } = setup(null);
      expect(await guard.beforeModelCall(call(USERS.student, ["hello"]))).toMatchObject({ action: "deny", reason: "moderation_unavailable" });
    });
  });

  it("charges an unpriced Hall Monitor attempt at the hold until reconciliation", async () => {
    const { guard, ledger } = setup();
    const descriptor = call(USERS.student, ["hello [[unpriced]]"]);
    expect(await guard.beforeModelCall(descriptor)).toEqual(SCREENED);
    expect((await ledger.request(`${descriptor.callId}.m0.c0`))?.settlement).toMatchObject({
      hasUnknownCost: true,
      chargedUsdNano: config.moderation.maxUsdNanoPerCheck,
      attempts: [{ state: "unknown", usage: { inputTokens: 800, cacheReadTokens: 200 } }],
    });
  });

  it("skips moderation for an educator profile that does not moderate input, and for calls with no new text", async () => {
    const { guard, ledger } = setup(null);
    const unmoderated = call(USERS.unmoderated, ["anything"]);
    expect(await guard.beforeModelCall(unmoderated)).toEqual({ action: "proceed" });
    expect(await ledger.request(`${unmoderated.callId}.m0.c0`)).toBeNull();
    expect(await guard.beforeModelCall(call(USERS.student, []))).toEqual(SCREENED);
  });

  it("refuses a student's image, which Hall Monitor cannot screen, but not an educator's (SCHO-307)", async () => {
    const { guard, ledger } = setup();
    const image = { id: "img", role: "user" as const, parts: [{ type: "image" as const, mimeType: "image/png", digest: "a".repeat(64) }] };
    for (const newMessages of [[image], [{ ...image, parts: [{ type: "text" as const, text: "What is this?" }, ...image.parts] }]]) {
      const student = call(USERS.student, [], { newMessages });
      expect(await guard.beforeModelCall(student)).toEqual({ action: "deny", reason: "image_unscreened", message: DEFAULT_GUARD_MESSAGES.imageUnscreened });
      // The hold is released: a refused call costs the student nothing.
      expect((await ledger.request(student.callId))?.voided).toBeDefined();
    }
    expect(await guard.beforeModelCall(call(USERS.educatorProceeds, [], { newMessages: [image] }))).toEqual({ action: "proceed" });
  });

  it("moderates a gadget's own model calls for the youngest students, whoever owns the gadget (SCHO-307)", async () => {
    const hallMonitor = hallMonitorClient(env, config)!;
    const evaluate = vi.spyOn(hallMonitor, "evaluate");
    const { guard } = setup(hallMonitor);
    // A teacher's own chat call is moderated as theirs, and is not screened.
    expect(await guard.beforeModelCall(call(USERS.educatorProceeds, ["Plan a lesson"]))).toEqual({ action: "proceed" });
    expect(evaluate.mock.calls.at(-1)![0]).toMatchObject({ policy: { profileId: "educator" }, context: { audience: "educator" } });
    // Their gadget's call might be typed by a student it was shared with.
    const gadget = call(USERS.educatorProceeds, ["Tell me a secret"], { initiator: { type: "gadget", id: USERS.educatorProceeds } });
    expect(await guard.beforeModelCall(gadget)).toEqual(SCREENED);
    expect(evaluate.mock.calls.at(-1)![0]).toMatchObject({ policy: { profileId: "k12-elementary" }, context: { audience: "student", gradeBand: "K-2" } });
    // Its reply is screened the same way, when the Workshop says whose call it was.
    expect(await guard.screenModelOutput(gadget.callId, { parts: [{ type: "text", text: "A reply" }], initiator: gadget.initiator })).toEqual({ action: "release" });
    expect(evaluate.mock.calls.at(-1)![0]).toMatchObject({ evaluationKind: "interaction.output", policy: { profileId: "k12-elementary" }, context: { audience: "student" } });
  });

  it("fails closed for a gadget's call when Hall Monitor is down, even for an educator whose profile proceeds (SCHO-307)", async () => {
    const { guard } = setup(null);
    const gadget = call(USERS.educatorProceeds, ["hello"], { initiator: { type: "gadget", id: USERS.educatorProceeds } });
    expect(await guard.beforeModelCall(gadget)).toMatchObject({ action: "deny", reason: "moderation_unavailable" });
  });

  it("refuses unknown initiators, agent initiators and unpriced models before holding anything", async () => {
    const { guard, ledger } = setup();
    const stranger = call("stranger@example.com", ["hi"]);
    expect(await guard.beforeModelCall(stranger)).toEqual({ action: "deny", reason: "unknown_principal", message: DEFAULT_GUARD_MESSAGES.unknownPrincipal });
    expect(await guard.beforeModelCall(call("gpt-5", ["hi"], { initiator: { type: "agent", id: USERS.student } }))).toMatchObject({ action: "deny", reason: "agent_initiator" });
    const unpriced = call(USERS.student, ["hi"], { model: { provider: "openai", id: "gpt-unpriced" } });
    expect(await guard.beforeModelCall(unpriced)).toEqual({ action: "deny", reason: "model_unpriced", message: DEFAULT_GUARD_MESSAGES.notAllowed });
    expect(await ledger.request(stranger.callId)).toBeNull();
    expect(await ledger.request(unpriced.callId)).toBeNull();
  });

  it("refuses a call over the principal's cap with the budget message, without moderating it", async () => {
    const { guard, ledger } = setup();
    const descriptor = call(USERS.student, ["hi"], { maxOutputTokens: 300_000 });
    expect(await guard.beforeModelCall(descriptor)).toEqual({ action: "deny", reason: "ledger_principal_cap_reached", message: DEFAULT_GUARD_MESSAGES.budget });
    expect(await ledger.request(`${descriptor.callId}.m0.c0`)).toBeNull();
  });
});

describe("output screening", () => {
  const reply = (text: string) => ({ parts: [{ type: "text" as const, text }] });

  /** A guard that has admitted one call by `user`, and a spy on the Hall Monitor requests it makes. */
  async function admittedFor(user: string) {
    const hallMonitor = hallMonitorClient(env, config)!;
    const evaluate = vi.spyOn(hallMonitor, "evaluate");
    const { guard, ledger } = setup(hallMonitor);
    const descriptor = call(user, ["Explain photosynthesis."]);
    expect((await guard.beforeModelCall(descriptor)).action).toBe("proceed");
    evaluate.mockClear();
    return { guard, ledger, callId: descriptor.callId, evaluate };
  }

  it("is asked for only where the profile requires output moderation, and only for language models", async () => {
    const { guard } = setup();
    expect(await guard.beforeModelCall(call(USERS.student, ["hi"]))).toEqual(SCREENED);
    expect(await guard.beforeModelCall(call(USERS.educatorProceeds, ["hi"]))).toEqual({ action: "proceed" });
    expect(await guard.beforeModelCall(call(USERS.student, ["hi"], { kind: "decision-model" }))).toEqual({ action: "proceed" });
  });

  it("releases an allowed response, charging the check to the safety pool as interaction.output", async () => {
    const { guard, ledger, callId, evaluate } = await admittedFor(USERS.student);
    expect(await guard.screenModelOutput(callId, reply("Plants turn light into sugar."))).toEqual({ action: "release" });

    expect(evaluate).toHaveBeenCalledOnce();
    expect(evaluate.mock.calls[0]![0]).toMatchObject({
      requestId: `${callId}.o.c0`,
      evaluationKind: "interaction.output",
      policy: { profileId: "k12-student", revision: "r3" },
      context: { audience: "student", gradeBand: "9-12", parentRequestId: callId },
      content: { type: "text", text: "Plants turn light into sugar." },
    });
    const check = await ledger.request(`${callId}.o.c0`);
    expect(check?.reservation).toMatchObject({ fundingPurpose: "safety", poolId: "fpl_nf-safety", model: MODERATOR });
    expect(check?.settlement?.chargedUsdNano).toBe(CHECK_COST);
    // The generative hold is left for afterModelCall to settle.
    const generative = await ledger.request(callId);
    expect(generative?.settlement).toBeUndefined();
    expect(generative?.voided).toBeUndefined();
  });

  it("releases a coached response", async () => {
    const { guard, callId } = await admittedFor(USERS.student);
    expect(await guard.screenModelOutput(callId, reply("Here is the answer [[coach]]"))).toEqual({ action: "release" });
  });

  it.each(["block", "hold"])("withholds a %s with the neutral message", async (decision) => {
    const { guard, ledger, callId } = await admittedFor(USERS.student);
    expect(await guard.screenModelOutput(callId, reply(`unsafe [[${decision}]]`)))
      .toEqual({ action: "withhold", reason: `moderation_${decision}`, message: DEFAULT_GUARD_MESSAGES.outputWithheld });
    expect((await ledger.request(`${callId}.o.c0`))?.settlement?.chargedUsdNano).toBe(CHECK_COST);
  });

  it("withholds a support with the supportive message", async () => {
    const { guard, callId } = await admittedFor(USERS.student);
    expect(await guard.screenModelOutput(callId, reply("worrying [[support]]")))
      .toEqual({ action: "withhold", reason: "moderation_support", message: TEST_CONFIG.messages.support });
  });

  it("screens a long response chunk by chunk and stops at the first that may not be shown", async () => {
    const { guard, ledger, callId } = await admittedFor(USERS.student);
    const text = `${"x".repeat(32_000)}[[block]]${"y".repeat(32_000)}`;
    expect(await guard.screenModelOutput(callId, { parts: [{ type: "text", text }] })).toMatchObject({ action: "withhold", reason: "moderation_block" });
    expect(await ledger.request(`${callId}.o.c1`)).not.toBeNull();
    expect(await ledger.request(`${callId}.o.c2`)).toBeNull();
  });

  it("withholds when Hall Monitor is down, even where the profile would proceed", async () => {
    const { guard, ledger, callId } = await admittedFor(USERS.educatorProceeds);
    expect(await guard.screenModelOutput(callId, reply("hello [[down]]")))
      .toEqual({ action: "withhold", reason: "moderation_unavailable", message: DEFAULT_GUARD_MESSAGES.aiUnavailable });
    expect((await ledger.request(`${callId}.o.c0`))?.settlement).toMatchObject({ hasUnknownCost: true });
  });

  it("withholds when the safety pool cannot fund the check", async () => {
    const { guard, ledger, callId } = await admittedFor(USERS.student);
    const student = config.principals[0]!;
    await ledger.reserve({
      requestId: "drain",
      principal: { principalId: student.principalId, districtId: config.districtId },
      workspace: student.workspace,
      model: MODERATOR,
      // Everything the input check left.
      estimatedMaxUsdNano: String(BigInt(SAFETY_ALLOCATION) - BigInt(CHECK_COST)),
      fundingPurpose: "safety",
    });
    expect(await guard.screenModelOutput(callId, reply("fine"))).toMatchObject({ action: "withhold", reason: "safety_budget_exhausted" });
  });

  it("withholds the response of a call it never admitted, or one already settled", async () => {
    const { guard, callId } = await admittedFor(USERS.student);
    expect(await guard.screenModelOutput("never-admitted", reply("fine"))).toMatchObject({ action: "withhold", reason: "unknown_call" });
    await guard.afterModelCall({ callId, status: "completed", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });
    expect(await guard.screenModelOutput(callId, reply("fine"))).toMatchObject({ action: "withhold", reason: "unknown_call" });
  });
});

/** A guard that has admitted one call by an educator. */
async function admitted() {
  const { guard, ledger } = setup();
  const descriptor = call(USERS.educatorProceeds, ["hello"]);
  expect(await guard.beforeModelCall(descriptor)).toEqual({ action: "proceed" });
  return { guard, ledger, callId: descriptor.callId };
}

/** One base64url segment of a JWS, as JSON. */
function decodeSegment(part: string): unknown {
  return JSON.parse(new TextDecoder().decode(Uint8Array.fromBase64(part, { alphabet: "base64url" })));
}

describe("afterModelCall", () => {
  const usage = { input: 1000, output: 500, cacheRead: 2000, cacheWrite: 0 };

  it("settles exactly once at the rate table's price, however often the outcome is delivered", async () => {
    const { guard, ledger, callId } = await admitted();
    const outcome: AiCallOutcome = { callId, status: "completed", usage, aiGatewayLogId: "gw-123" };
    await guard.afterModelCall(outcome);
    await Promise.all([guard.afterModelCall(outcome), guard.afterModelCall(outcome), guard.afterModelCall(outcome)]);
    await guard.afterModelCall(outcome);

    expect(await rows(ledger, callId, "settlement")).toBe(1);
    // 1,000 × $3/M + 500 × $15/M + 2,000 × $0.30/M = $0.0111, exactly.
    expect((await ledger.request(callId))?.settlement).toMatchObject({
      chargedUsdNano: "11100000",
      hasUnknownCost: false,
      priceBookId: "anthropic-list-2026-10",
      attempts: [{ attemptIndex: 0, state: "estimated", gatewayLogId: "gw-123", usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 0 } }],
    });
  });

  it("releases a failed or aborted call that billed nothing", async () => {
    for (const status of ["failed", "aborted"] as const) {
      const { guard, ledger, callId } = await admitted();
      await guard.afterModelCall({ callId, status });
      await guard.afterModelCall({ callId, status, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
      expect((await ledger.request(callId))?.voided).toBeDefined();
      expect(await rows(ledger, callId, "void")).toBe(1);
    }
  });

  it("settles a failed call that reported usage, since the provider billed it", async () => {
    const { guard, ledger, callId } = await admitted();
    await guard.afterModelCall({ callId, status: "failed", usage });
    expect((await ledger.request(callId))?.settlement?.chargedUsdNano).toBe("11100000");
  });

  it("records a completed call with no reported usage as an unknown cost, charged at the hold", async () => {
    const { guard, ledger, callId } = await admitted();
    await guard.afterModelCall({ callId, status: "completed" });
    expect((await ledger.request(callId))?.settlement).toMatchObject({ hasUnknownCost: true, chargedUsdNano: HOLD_1000, attempts: [{ state: "unknown" }] });
  });

  it("ignores an outcome for a call it never admitted", async () => {
    const { guard, ledger } = setup();
    await guard.afterModelCall({ callId: "never-admitted", status: "completed", usage });
    expect(await ledger.request("never-admitted")).toBeNull();
  });
});

describe("privacy", () => {
  it("never logs message text", async () => {
    const captured: unknown[] = [];
    for (const level of ["debug", "log", "info", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void captured.push(args));
    }
    const secret = "my-secret-diary-entry-7f3a";
    for (const user of [USERS.student, USERS.educatorProceeds]) {
      for (const marker of ["", "[[block]]", "[[support]]", "[[coach]]", "[[down]]", "[[unpriced]]"]) {
        const { guard } = setup();
        const descriptor = call(user, [`${secret} ${marker}`]);
        await guard.beforeModelCall(descriptor);
        await guard.screenModelOutput(descriptor.callId, { parts: [{ type: "text", text: `${secret} reply ${marker}` }] });
        await guard.afterModelCall({ callId: descriptor.callId, status: "completed", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });
      }
    }
    expect(captured.length).toBeGreaterThan(5);
    const logged = JSON.stringify(captured);
    expect(logged).not.toContain(secret);
    expect(logged).toContain("moderation_block");
    expect(logged).toContain("ai_guard.output.withheld");
    // Twelve full guard round trips through the ledger Durable Object: slow on shared CI runners.
  }, 120_000);
});

describe("EducateOsAiCallGuard", () => {
  it("is reachable as the kernel binds it, with the district ledger behind it", async () => {
    const descriptor = call(USERS.student, ["How do plants make food?"]);
    expect(await env.AI_CALL_GUARD.beforeModelCall(descriptor)).toEqual(SCREENED);
    expect(await env.AI_CALL_GUARD.screenModelOutput(descriptor.callId, { parts: [{ type: "text", text: "Photosynthesis." }] })).toEqual({ action: "release" });
    await env.AI_CALL_GUARD.afterModelCall({ callId: descriptor.callId, status: "completed", usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 } });
    const district = env.AI_LEDGER.getByName(config.districtId);
    expect((await district.request(descriptor.callId))?.settlement?.hasUnknownCost).toBe(false);
    expect((await district.request(`${descriptor.callId}.m0.c0`))?.settlement?.chargedUsdNano).toBe(CHECK_COST);
    expect((await district.request(`${descriptor.callId}.o.c0`))?.settlement?.chargedUsdNano).toBe(CHECK_COST);
  });
});

describe("service tokens", () => {
  it("signs the claims Hall Monitor verifies, with a new single-use token for every call", async () => {
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const jwk = { ...await crypto.subtle.exportKey("jwk", pair.privateKey) as JsonWebKey, kid: "guard-1" };
    const getToken = serviceTokenSource({ ...env, HALL_MONITOR_SIGNING_KEY: JSON.stringify(jwk), HALL_MONITOR_ISSUER: "educateos-guard" }, config)!;
    const token = await getToken();
    // Hall Monitor answers a replayed jti with 401, so a token is never reused.
    const next = await getToken();
    expect(next).not.toBe(token);
    const jti = (part: string) => (decodeSegment(part.split(".")[1]!) as { jti: string }).jti;
    expect(jti(next)).not.toBe(jti(token));

    const [header, payload, signature] = token.split(".") as [string, string, string];
    expect(decodeSegment(header)).toEqual({ alg: "EdDSA", typ: "JWT", kid: "guard-1" });
    expect(decodeSegment(payload)).toMatchObject({ iss: "educateos-guard", aud: "hall-monitor", tenant: "tenant_educateos", scope: "evaluate" });
    expect(decodeSegment(payload)).not.toHaveProperty("hm_governance");
    const claims = decodeSegment(payload) as { iat: number; exp: number };
    expect(claims.exp - claims.iat).toBe(60);
    const valid = await crypto.subtle.verify({ name: "Ed25519" }, pair.publicKey,
      Uint8Array.fromBase64(signature, { alphabet: "base64url" }), new TextEncoder().encode(`${header}.${payload}`));
    expect(valid).toBe(true);
  });
});
