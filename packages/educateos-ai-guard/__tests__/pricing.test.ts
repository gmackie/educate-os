// Settlement pricing from AI Gateway logs and the shared price book, and the nightly reconciliation
// that settles unknown costs and records the month's allocation snapshot (SCHO-134).

import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AiCallDescriptor } from "@gadgets/workshop-shared/ai-call-guard";
import { billingPeriodOf } from "@educateos/ai-governance";
import { GuardConfig, readGuardConfig } from "../src/config.ts";
import { StaticGuardContextResolver } from "../src/context.ts";
import { cloudflareGatewayLogs, type GatewayLog, type GatewayLogSource } from "../src/gateway-logs.ts";
import { AiCallGuardService } from "../src/guard.ts";
import { runReconciliation } from "../src/reconciliation.ts";
import worker from "../src/worker.ts";
import { TEST_CONFIG, USERS, WORKERS_AI } from "./fixtures.ts";

const config = readGuardConfig(env.AI_GUARD_CONFIG);
const DAY_MS = 86_400_000;
const USAGE = { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 };

/** A gateway whose logs a test fills in; `fail` makes every lookup throw. */
class FakeGatewayLogs implements GatewayLogSource {
  readonly logs = new Map<string, GatewayLog>();
  readonly lookups: string[] = [];
  fail = false;

  async log(id: string): Promise<GatewayLog | null> {
    this.lookups.push(id);
    if (this.fail) throw new Error("gateway unreachable");
    return this.logs.get(id) ?? null;
  }
}

let ledgers = 0;
function setup(gatewayLogs: GatewayLogSource | null = null) {
  const ledger = env.AI_LEDGER.getByName(`pricing-ledger-${ledgers++}`);
  const guard = new AiCallGuardService({ config, ledger, resolver: new StaticGuardContextResolver(config), hallMonitor: null, gatewayLogs });
  return { guard, ledger };
}

/** An admitted call by an unmoderated user, so no moderation spend muddies the ledger. */
async function admitted(guard: AiCallGuardService, overrides: Partial<AiCallDescriptor> = {}): Promise<AiCallDescriptor> {
  const descriptor: AiCallDescriptor = {
    callId: crypto.randomUUID(),
    logicalRequestId: "logical-1",
    kind: "language-model",
    callSite: "chat.message",
    initiator: { type: "user", id: USERS.unmoderated },
    model: { provider: "anthropic", id: "claude-sonnet-example" },
    maxOutputTokens: 1000,
    newMessages: [],
    ...overrides,
  };
  expect(await guard.beforeModelCall(descriptor)).toEqual({ action: "proceed" });
  return descriptor;
}

describe("settlement pricing", () => {
  it("settles at the AI Gateway log's cost when the gateway reports one", async () => {
    const gateway = new FakeGatewayLogs();
    gateway.logs.set("log-1", { cost: 0.0123, tokens_in: 1000, tokens_out: 200 });
    const { guard, ledger } = setup(gateway);
    const call = await admitted(guard);
    await guard.afterModelCall({ callId: call.callId, status: "completed", usage: USAGE, aiGatewayLogId: "log-1" });
    const { settlement } = (await ledger.request(call.callId))!;
    expect(settlement).toMatchObject({ chargedUsdNano: "12300000", hasUnknownCost: false });
    expect(settlement?.priceBookId).toBeUndefined();
    expect(settlement?.attempts).toEqual([{
      attemptIndex: 0,
      gatewayLogId: "log-1",
      state: "provider_reported",
      actualUsdNano: "12300000",
      usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }]);
  });

  it("estimates from the deployment's rates when the log has no cost yet, or the gateway is down", async () => {
    const gateway = new FakeGatewayLogs();
    gateway.logs.set("log-pending", { cost: null });
    for (const [logId, fail] of [["log-pending", false], ["log-missing", false], ["log-pending", true]] as const) {
      gateway.fail = fail;
      const { guard, ledger } = setup(gateway);
      const call = await admitted(guard);
      await guard.afterModelCall({ callId: call.callId, status: "completed", usage: USAGE, aiGatewayLogId: logId });
      // 1,000 input tokens at $3/M plus 200 output tokens at $15/M.
      expect((await ledger.request(call.callId))?.settlement).toMatchObject({
        chargedUsdNano: "6000000",
        priceBookId: "anthropic-list-2026-10",
        attempts: [{ state: "estimated", gatewayLogId: logId }],
      });
    }
  });

  it("holds and settles a model listed without rates at the shared Cloudflare price book", async () => {
    const { guard, ledger } = setup();
    const call = await admitted(guard, { model: { provider: WORKERS_AI.provider, id: WORKERS_AI.modelId }, maxOutputTokens: undefined });
    // 10,000 assumed prompt tokens at $0.038/M; Clef has no output rate.
    expect((await ledger.request(call.callId))?.reservation.heldUsdNano).toBe("380000");
    await guard.afterModelCall({ callId: call.callId, status: "completed", usage: { input: 5000, output: 3, cacheRead: 0, cacheWrite: 0 } });
    expect((await ledger.request(call.callId))?.settlement).toMatchObject({
      chargedUsdNano: "190000",
      priceBookId: "cloudflare-2026-10-20",
      attempts: [{ state: "estimated", actualUsdNano: "190000" }],
    });
  });

  it("refuses a model listed without rates that the shared book does not price, and half-priced rates", async () => {
    const unpriced = GuardConfig.parse({ ...TEST_CONFIG, modelRates: [...TEST_CONFIG.modelRates, { provider: "cloudflare", modelId: "@cf/meta/unpriced", reserveInputTokens: 10, defaultMaxOutputTokens: 10 }] });
    const ledger = env.AI_LEDGER.getByName(`pricing-ledger-${ledgers++}`);
    const guard = new AiCallGuardService({ config: unpriced, ledger, resolver: new StaticGuardContextResolver(unpriced), hallMonitor: null });
    expect(await guard.beforeModelCall({ ...(await sampleCall()), model: { provider: "cloudflare", id: "@cf/meta/unpriced" } })).toMatchObject({ action: "deny", reason: "model_unpriced" });
    const halfPriced = { ...TEST_CONFIG.modelRates[0], cacheWriteUsdNanoPerMTok: undefined };
    expect(GuardConfig.safeParse({ ...TEST_CONFIG, modelRates: [halfPriced] }).success).toBe(false);
  });
});

async function sampleCall(): Promise<AiCallDescriptor> {
  return {
    callId: crypto.randomUUID(),
    logicalRequestId: "logical-1",
    kind: "language-model",
    callSite: "chat.message",
    initiator: { type: "user", id: USERS.unmoderated },
    model: { provider: "anthropic", id: "claude-sonnet-example" },
    newMessages: [],
  };
}

describe("cloudflareGatewayLogs", () => {
  it("reads a log's cost and token counts with the API token, and nothing else", async () => {
    const requests: Request[] = [];
    const source = cloudflareGatewayLogs({ accountId: "acct-1", gatewayId: "district-gw", apiToken: "secret-token" }, async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.endsWith("/gone")) return new Response(null, { status: 404 });
      if (request.url.endsWith("/broken")) return new Response("oops", { status: 500 });
      if (request.url.endsWith("/odd")) return Response.json({ result: { cost: -1 } });
      return Response.json({ success: true, result: { id: "log-1", cost: 0.000038, tokens_in: 10, tokens_out: 1, request: "prompt text" } });
    });
    expect(await source.log("log-1")).toEqual({ cost: 0.000038, tokens_in: 10, tokens_out: 1 });
    expect(requests[0]!.url).toBe("https://api.cloudflare.com/client/v4/accounts/acct-1/ai-gateway/gateways/district-gw/logs/log-1");
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer secret-token");
    expect(await source.log("gone")).toBeNull();
    await expect(source.log("broken")).rejects.toThrow("500");
    await expect(source.log("odd")).rejects.toThrow("unexpected shape");
    // An ID that is not a path segment is never sent.
    expect(await source.log("../../user/tokens")).toBeNull();
    expect(requests).toHaveLength(4);
  });
});

/** A completed call that reported no usage: settled as unknown, charged at its hold. */
async function unknownCost(guard: AiCallGuardService, aiGatewayLogId: string | undefined) {
  const call = await admitted(guard);
  await guard.afterModelCall({ callId: call.callId, status: "completed", ...(aiGatewayLogId === undefined ? {} : { aiGatewayLogId }) });
  return call.callId;
}

describe("nightly reconciliation", () => {
  it("settles unknown costs from their gateway logs once, and records the month's snapshot idempotently", async () => {
    const gateway = new FakeGatewayLogs();
    const { guard, ledger } = setup(gateway);
    const pending = await unknownCost(guard, "log-late");
    const priced = await unknownCost(guard, "log-ready");
    await unknownCost(guard, undefined);
    const hold = (await ledger.request(priced))!.settlement!.chargedUsdNano;
    expect((await ledger.request(priced))?.settlement?.hasUnknownCost).toBe(true);
    gateway.logs.set("log-ready", { cost: "0.0042" });
    gateway.logs.set("log-late", { cost: null });

    const scheduledTime = new Date(Date.now() + DAY_MS);
    const first = await runReconciliation({ ledger, gatewayLogs: gateway, scheduledTime });
    expect(first).toMatchObject({ outstanding: 2, billed: 1, pending: 1, failed: 0, adjustments: 1, snapshot: { written: true } });
    // The hold charged as a liability is replaced by the billed cost: one adjustment, history kept.
    expect(await ledger.outstandingUnknownCosts(10)).toEqual([expect.objectContaining({ requestId: pending, gatewayLogIds: ["log-late"] })]);
    const period = billingPeriodOf(new Date().toISOString());
    const snapshot = await ledger.allocationSnapshot(period);
    expect(snapshot?.summary.reconciliationAdjustmentUsdNano).toBe(String(4_200_000n - BigInt(hold)));
    expect(JSON.stringify(snapshot)).not.toMatch(/@|log-/);

    // The same night again changes nothing.
    gateway.lookups.length = 0;
    const again = await runReconciliation({ ledger, gatewayLogs: gateway, scheduledTime });
    expect(again).toMatchObject({ outstanding: 1, billed: 0, adjustments: 0, snapshot: { written: false } });
    expect(gateway.lookups).toEqual(["log-late"]);

    // A later night prices the late log.
    gateway.logs.set("log-late", { cost: 0.001 });
    const later = await runReconciliation({ ledger, gatewayLogs: gateway, scheduledTime: new Date(scheduledTime.getTime() + 60_000) });
    expect(later).toMatchObject({ billed: 1, adjustments: 1 });
    expect(await ledger.outstandingUnknownCosts(10)).toEqual([]);
  });

  it("still records the snapshot when the gateway's logs cannot be read", async () => {
    const gateway = new FakeGatewayLogs();
    gateway.fail = true;
    const { guard, ledger } = setup(gateway);
    await unknownCost(guard, "log-1");
    expect(await runReconciliation({ ledger, gatewayLogs: gateway, scheduledTime: new Date(Date.now() + DAY_MS) }))
      .toMatchObject({ outstanding: 1, failed: 1, adjustments: 0, snapshot: { written: true } });
    expect(await runReconciliation({ ledger, gatewayLogs: null, scheduledTime: new Date(Date.now() + DAY_MS) }))
      .toMatchObject({ outstanding: 0, snapshot: { written: false } });
  });

  it("runs on the Worker's Cron Trigger against the district ledger", async () => {
    const scheduledTime = new Date(Date.now() + DAY_MS);
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime, cron: "17 3 * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);
    const period = billingPeriodOf(new Date(scheduledTime.getTime() - DAY_MS).toISOString());
    expect(await env.AI_LEDGER.getByName(config.districtId).allocationSnapshot(period)).toMatchObject({ period, summary: { period } });
  });
});
