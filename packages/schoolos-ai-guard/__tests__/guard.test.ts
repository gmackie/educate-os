// The guard against a real ledger Durable Object and a fake Hall Monitor reached through a real
// service binding. Each test gets its own ledger object, so pools start full.

import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiCallDescriptor, AiCallOutcome } from "@gadgets/workshop-shared/ai-call-guard";
import type { HallMonitorClient } from "@gmacko/hall-monitor-client";
import { LEDGER_ENTRIES_TABLE } from "@schoolos/ai-governance/durable-object-store";
import { DEFAULT_GUARD_MESSAGES, readGuardConfig } from "../src/config.ts";
import { StaticGuardContextResolver } from "../src/context.ts";
import { AiCallGuardService } from "../src/guard.ts";
import { hallMonitorClient, serviceTokenSource } from "../src/hall-monitor.ts";
import { CHECK_COST, MODERATOR, SAFETY_ALLOCATION, TEST_CONFIG, USERS } from "./fixtures.ts";

const config = readGuardConfig(env.AI_GUARD_CONFIG);
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
    expect(await guard.beforeModelCall(descriptor)).toEqual({ action: "proceed" });

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
    expect(await guard.beforeModelCall(descriptor)).toEqual({ action: "proceed" });
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

  it("lets a coached message proceed", async () => {
    const { guard } = setup();
    expect(await guard.beforeModelCall(call(USERS.student, ["just give me the answer [[coach]]"]))).toEqual({ action: "proceed" });
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
    expect(await guard.beforeModelCall(descriptor)).toEqual({ action: "proceed" });
    expect((await ledger.request(`${descriptor.callId}.m0.c0`))?.settlement).toMatchObject({
      hasUnknownCost: true,
      chargedUsdNano: config.moderation.maxUsdNanoPerCheck,
      attempts: [{ state: "unknown", usage: { inputTokens: 800, cacheReadTokens: 200 } }],
    });
  });

  it("skips moderation for a profile that does not moderate input, and for calls with no new text", async () => {
    const { guard, ledger } = setup(null);
    const unmoderated = call(USERS.unmoderated, ["anything"]);
    expect(await guard.beforeModelCall(unmoderated)).toEqual({ action: "proceed" });
    expect(await ledger.request(`${unmoderated.callId}.m0.c0`)).toBeNull();
    const imageOnly = call(USERS.student, [], {
      newMessages: [{ id: "img", role: "user", parts: [{ type: "image", mimeType: "image/png", digest: "a".repeat(64) }] }],
    });
    expect(await guard.beforeModelCall(imageOnly)).toEqual({ action: "proceed" });
  });

  it("refuses unknown initiators, agent initiators and unpriced models before holding anything", async () => {
    const { guard, ledger } = setup();
    const stranger = call("stranger@example.com", ["hi"]);
    expect(await guard.beforeModelCall(stranger)).toMatchObject({ action: "deny", reason: "unknown_principal" });
    expect(await guard.beforeModelCall(call("gpt-5", ["hi"], { initiator: { type: "agent", id: USERS.student } }))).toMatchObject({ action: "deny", reason: "unknown_principal" });
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
        await guard.afterModelCall({ callId: descriptor.callId, status: "completed", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });
      }
    }
    expect(captured.length).toBeGreaterThan(5);
    const logged = JSON.stringify(captured);
    expect(logged).not.toContain(secret);
    expect(logged).toContain("moderation_block");
    // Twelve full guard round trips through the ledger Durable Object: slow on shared CI runners.
  }, 30_000);
});

describe("SchoolOsAiCallGuard", () => {
  it("is reachable as the kernel binds it, with the district ledger behind it", async () => {
    const descriptor = call(USERS.student, ["How do plants make food?"]);
    expect(await env.AI_CALL_GUARD.beforeModelCall(descriptor)).toEqual({ action: "proceed" });
    await env.AI_CALL_GUARD.afterModelCall({ callId: descriptor.callId, status: "completed", usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 } });
    const district = env.AI_LEDGER.getByName(config.districtId);
    expect((await district.request(descriptor.callId))?.settlement?.hasUnknownCost).toBe(false);
    expect((await district.request(`${descriptor.callId}.m0.c0`))?.settlement?.chargedUsdNano).toBe(CHECK_COST);
  });
});

describe("service tokens", () => {
  it("signs the claims Hall Monitor verifies, and reuses a token until near expiry", async () => {
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const jwk = { ...await crypto.subtle.exportKey("jwk", pair.privateKey) as JsonWebKey, kid: "guard-1" };
    const getToken = serviceTokenSource({ ...env, HALL_MONITOR_SIGNING_KEY: JSON.stringify(jwk), HALL_MONITOR_ISSUER: "schoolos-guard" }, config)!;
    const token = await getToken();
    expect(await getToken()).toBe(token);

    const [header, payload, signature] = token.split(".") as [string, string, string];
    expect(decodeSegment(header)).toEqual({ alg: "EdDSA", typ: "JWT", kid: "guard-1" });
    expect(decodeSegment(payload)).toMatchObject({ iss: "schoolos-guard", aud: "hall-monitor", tenant: "tenant_schoolos", scope: "evaluate" });
    const valid = await crypto.subtle.verify({ name: "Ed25519" }, pair.publicKey,
      Uint8Array.fromBase64(signature, { alphabet: "base64url" }), new TextEncoder().encode(`${header}.${payload}`));
    expect(valid).toBe(true);
  });
});
