import { describe, expect, it } from "vitest";
import {
  AiUsageEvent,
  InMemoryLedgerStore,
  LedgerEntry,
  ledgerGovernor,
  parseCostExportCsv,
} from "../src/index.ts";
import { AMARA, BIO_FALL, c, ELENA, GEMINI, harness, MINI, paid, PERSONAL, SONNET, tokens } from "./setup.ts";

const SECRET = "Sentinel prompt: my essay about my family, do not log";

function request(requestId: string, overrides: Record<string, unknown> = {}) {
  return { requestId, principal: AMARA, workspace: BIO_FALL, model: SONNET, estimatedMaxUsdNano: c(80), ...overrides };
}

describe("AiRequestGovernor", () => {
  it("allows with a reservation, settles after the response, and bills a retry once", async () => {
    const { ledger } = harness();
    const governor = ledgerGovernor(ledger);
    const allowed = await governor.beforeRequest(request("req-1"));
    expect(allowed).toMatchObject({ effect: "allow", reservation: { requestId: "req-1", poolId: "fpl_nf-bio-fall", heldUsdNano: c(80) } });
    // The seam retries before hearing back: same reservation, nothing more held.
    expect(await governor.beforeRequest(request("req-1"))).toEqual(allowed);

    await governor.afterResponse({ status: "completed", requestId: "req-1", usage: tokens(1_000, 400, 200, 50), actualUsdNano: c(31) });
    await governor.afterResponse({ status: "completed", requestId: "req-1", usage: tokens(1_000, 400, 200, 50), actualUsdNano: c(31) });
    // A completed request is not sent to the provider again.
    expect(await governor.beforeRequest(request("req-1"))).toMatchObject({ effect: "deny", reason: "request-already-completed" });
    expect((await ledger.report()).district).toMatchObject({ requests: 1, usageUsdNano: c(31), cacheReadTokens: 200, cacheWriteTokens: 50 });
  });

  it("voids a failed request", async () => {
    const { ledger } = harness();
    const governor = ledgerGovernor(ledger);
    await governor.beforeRequest(request("req-1"));
    expect(await governor.afterResponse({ status: "failed", requestId: "req-1" })).toEqual({ outcome: "voided", replayed: false });
    expect((await ledger.poolBalances("2026-10"))["fpl_nf-bio-fall"]!.chargedUsdNano).toBe("0");
  });

  it("denies with a generic error body that does not reveal the reason", async () => {
    const { ledger } = harness();
    const governor = ledgerGovernor(ledger);
    const denied = await governor.beforeRequest(request("req-1", { model: GEMINI }));
    expect(denied).toEqual({
      effect: "deny",
      reason: "model-disabled",
      error: { code: "policy-violation", message: "This AI model is not available under your district's policy." },
    });
    const capped = await governor.beforeRequest(request("req-2", { estimatedMaxUsdNano: c(10_000) }));
    expect(capped).toMatchObject({ effect: "deny", error: { code: "budget-exceeded" } });
    expect(JSON.stringify(capped.effect === "deny" && capped.error)).not.toContain("cap");
  });
});

describe("no content in any record", () => {
  it("rejects a prompt or response handed to the governor", async () => {
    const { ledger } = harness();
    const governor = ledgerGovernor(ledger);
    await expect(governor.beforeRequest({ ...request("req-1"), prompt: SECRET })).rejects.toMatchObject({ code: "validation-failed" });
    await expect(governor.beforeRequest({ ...request("req-1"), messages: [{ role: "user", content: SECRET }] }))
      .rejects.toMatchObject({ code: "validation-failed" });
    await governor.beforeRequest(request("req-2"));
    await expect(governor.afterResponse({ status: "completed", requestId: "req-2", usage: tokens(1, 1), actualUsdNano: c(1), response: SECRET }))
      .rejects.toMatchObject({ code: "validation-failed" });
    await expect(ledger.settle("req-2", paid({ ...tokens(1, 1), completion: SECRET } as never, "1"))).rejects.toMatchObject({ code: "validation-failed" });
    // The rejection message itself does not echo the content.
    const error = await governor.beforeRequest({ ...request("req-3"), prompt: SECRET }).catch((caught: Error) => caught);
    expect(String((error as Error).message)).not.toContain("Sentinel");
  });

  it("refuses to store a ledger entry carrying content, and refuses content in request IDs", async () => {
    const { ledger } = harness();
    const store = new InMemoryLedgerStore();
    await expect(store.transact(() => ({
      append: [{ type: "void", entrySchemaVersion: 2, requestId: "req-1", voidedAt: "2026-10-05T15:00:00.000Z", note: SECRET } as never],
      result: null,
    }))).rejects.toThrow();
    expect((await store.read()).entries).toEqual([]);
    await expect(ledger.reserve(SECRET, AMARA, BIO_FALL, SONNET, c(10))).rejects.toMatchObject({ code: "validation-failed" });
    expect(() => parseCostExportCsv(`request_id,date,provider,model,cost_usd\n${SECRET},2026-10-05,anthropic,x,0.10`)).toThrow();
  });

  it("keeps every record, event and report free of anything but identifiers, counts and amounts", async () => {
    const { ledger } = harness();
    const governor = ledgerGovernor(ledger);
    await governor.beforeRequest(request("req-1"));
    await governor.afterResponse({ status: "completed", requestId: "req-1", usage: tokens(100, 40), actualUsdNano: c(7) });
    await governor.beforeRequest(request("req-2", { principal: ELENA }));
    await governor.afterResponse({ status: "failed", requestId: "req-2" });
    await governor.beforeRequest(request("req-3", { workspace: PERSONAL, model: MINI }));
    await governor.afterResponse({ status: "completed", requestId: "req-3", usage: tokens(10, 10), actualUsdNano: c(2) });
    await ledger.reconcile("bill-1", parseCostExportCsv("request_id,date,provider,model,cost_usd\nreq-1,2026-10-05,anthropic,claude-sonnet-example,0.09"));

    const entries = await ledger.entries();
    const events = await ledger.usageEvents();
    for (const entry of entries) expect(LedgerEntry.safeParse(entry).success).toBe(true);
    for (const event of events) expect(AiUsageEvent.safeParse(event).success).toBe(true);

    // The usage event's fields are fixed: adding one is a deliberate, reviewed change.
    expect(Object.keys(AiUsageEvent.shape).toSorted()).toEqual([
      "attempts", "cacheReadTokens", "cacheWriteTokens", "chargedUsdNano", "districtId", "fundingPurpose", "hasUnknownCost",
      "inputTokens", "model", "occurredAt", "outputTokens", "poolId", "priceBookId", "principalId", "requestId", "workspace",
    ]);
    // No key anywhere in the records names content.
    const everything = JSON.stringify({ entries, events, report: await ledger.report() });
    const keys = [...everything.matchAll(/"([A-Za-z]+)":/g)].map((match) => match[1]!.toLowerCase());
    for (const banned of ["prompt", "response", "message", "messages", "content", "text", "completion", "body"]) {
      expect(keys).not.toContain(banned);
    }
    expect(everything).not.toContain("Sentinel");
  });
});
