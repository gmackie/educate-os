import { describe, expect, it } from "vitest";
import { Heartbeat } from "@schoolos/fleet";
import { IssueInvoiceRequest } from "../src/index.ts";
import { CLERK, DAY, setup, TERM_START } from "./support.ts";

const DUE_AT = new Date(Date.parse(TERM_START) + 30 * DAY).toISOString();
const PLAN_FEE = [{ kind: "plan-fee" as const, code: "pilot-term", quantity: 1, unitAmountCents: 250_000 }];

function heartbeat(instanceId: string, aggregateAiSpendCents?: number): Heartbeat {
  return Heartbeat.parse({
    instanceId,
    sequence: 1,
    sentAt: TERM_START,
    releaseVersion: "0.1.0",
    probes: [],
    ...(aggregateAiSpendCents === undefined ? {} : { aggregateAiSpendCents }),
  });
}

async function activePilot(aiUsageSharing: "opted-in" | "opted-out") {
  const context = await setup({ aiUsageSharing });
  const subscription = await context.subscribe();
  await context.service.activate(subscription.subscriptionId, CLERK);
  return { ...context, subscription };
}

describe("independent Cloudflare bills: invoices carry SchoolOS fees only", () => {
  it("has no line kind for Cloudflare pass-through, and the request has no field for Cloudflare costs", async () => {
    const { service, accountId } = await activePilot("opted-out");
    await expect(
      service.issueInvoice({ accountId, lines: [{ kind: "cloudflare-usage" as never, code: "workers", quantity: 1, unitAmountCents: 1 }], dueAt: DUE_AT }, CLERK),
    ).rejects.toMatchObject({ code: "validation-failed" });
    const smuggled = { accountId, lines: PLAN_FEE, dueAt: DUE_AT, cloudflareBillCents: 123_456 };
    expect(IssueInvoiceRequest.safeParse(smuggled).success).toBe(false);
    await expect(service.issueInvoice(smuggled as never, CLERK)).rejects.toMatchObject({ code: "validation-failed" });
  });

  it("an invoice's total is exactly its SchoolOS lines", async () => {
    const { service, accountId, subscription } = await activePilot("opted-out");
    const invoice = await service.issueInvoice(
      { accountId, subscriptionId: subscription.subscriptionId, lines: [...PLAN_FEE, { kind: "support", code: "onboarding", quantity: 3, unitAmountCents: 15_000 }], dueAt: DUE_AT },
      CLERK,
    );
    expect(invoice.lines.map((line) => line.kind)).toEqual(["plan-fee", "support"]);
    expect(invoice.totalCents).toBe(295_000);
  });

  it("AI credit overage can't be entered by hand", async () => {
    const { service, accountId } = await activePilot("opted-in");
    await expect(
      service.issueInvoice({ accountId, lines: [{ kind: "ai-credit-overage" as never, code: "ai", quantity: 1, unitAmountCents: 1 }], dueAt: DUE_AT }, CLERK),
    ).rejects.toMatchObject({ code: "validation-failed" });
  });
});

describe("aggregate AI usage informs a usage line only if the district opted in", () => {
  it("adds a SchoolOS overage line for spend beyond the plan's AI credit allowance when opted in", async () => {
    const { service, accountId, instanceId, subscription } = await activePilot("opted-in");
    // The pilot plan includes 50,000 cents of SchoolOS-funded AI credit.
    const invoice = await service.issueInvoice(
      { accountId, subscriptionId: subscription.subscriptionId, lines: PLAN_FEE, aiUsageHeartbeat: heartbeat(instanceId, 80_000), dueAt: DUE_AT },
      CLERK,
    );
    expect(invoice.lines.at(-1)).toEqual({ kind: "ai-credit-overage", code: "ai-credit-overage", quantity: 1, unitAmountCents: 30_000, amountCents: 30_000 });
    expect(invoice.totalCents).toBe(280_000);
  });

  it("adds no line for spend within the allowance, or for a heartbeat that carries no spend", async () => {
    const { service, accountId, instanceId, subscription } = await activePilot("opted-in");
    for (const hb of [heartbeat(instanceId, 50_000), heartbeat(instanceId)]) {
      const invoice = await service.issueInvoice(
        { accountId, subscriptionId: subscription.subscriptionId, lines: PLAN_FEE, aiUsageHeartbeat: hb, dueAt: DUE_AT },
        CLERK,
      );
      expect(invoice.lines.map((line) => line.kind)).toEqual(["plan-fee"]);
    }
  });

  it("refuses to use AI usage from a district that has not opted in", async () => {
    const { service, accountId, instanceId, subscription } = await activePilot("opted-out");
    await expect(
      service.issueInvoice(
        { accountId, subscriptionId: subscription.subscriptionId, lines: PLAN_FEE, aiUsageHeartbeat: heartbeat(instanceId, 80_000), dueAt: DUE_AT },
        CLERK,
      ),
    ).rejects.toMatchObject({ code: "policy-violation" });
  });

  it("stops using AI usage as soon as the district opts out", async () => {
    const { service, accountId, instanceId, subscription } = await activePilot("opted-in");
    await service.setAiUsageSharing(accountId, "opted-out", CLERK);
    await expect(
      service.issueInvoice(
        { accountId, subscriptionId: subscription.subscriptionId, lines: PLAN_FEE, aiUsageHeartbeat: heartbeat(instanceId, 80_000), dueAt: DUE_AT },
        CLERK,
      ),
    ).rejects.toMatchObject({ code: "policy-violation" });
    const change = (await service.auditTrail(accountId)).find((event) => event.action === "account.ai-usage-sharing-changed");
    expect(change).toMatchObject({ before: { state: "opted-in" }, after: { state: "opted-out" } });
  });

  it("refuses a heartbeat from an instance the account doesn't pay for", async () => {
    const { service, accountId, subscription } = await activePilot("opted-in");
    await expect(
      service.issueInvoice(
        { accountId, subscriptionId: subscription.subscriptionId, lines: PLAN_FEE, aiUsageHeartbeat: heartbeat("ins_riverbend", 80_000), dueAt: DUE_AT },
        CLERK,
      ),
    ).rejects.toMatchObject({ code: "not-found" });
  });
});
