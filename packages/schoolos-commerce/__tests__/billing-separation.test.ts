import { describe, expect, it } from "vitest";
import { usdNanoFromCents, type UsdNano } from "@schoolos/contracts";
import { Heartbeat } from "@schoolos/fleet";
import { InvoiceLine, IssueInvoiceRequest } from "../src/index.ts";
import { CLERK, DAY, setup, TERM_START } from "./support.ts";

const DUE_AT = new Date(Date.parse(TERM_START) + 30 * DAY).toISOString();
const PLAN_FEE = [{ kind: "plan-fee" as const, code: "pilot-term", quantity: 1, unitAmountCents: 250_000 }];

function heartbeat(instanceId: string, aggregateAiSpendCents?: number): Heartbeat {
  return heartbeatSpending(instanceId, aggregateAiSpendCents === undefined ? undefined : usdNanoFromCents(aggregateAiSpendCents));
}

function heartbeatSpending(instanceId: string, aggregateAiSpendUsdNano?: UsdNano): Heartbeat {
  return Heartbeat.parse({
    instanceId,
    sequence: 1,
    sentAt: TERM_START,
    releaseVersion: "0.1.0",
    probes: [],
    ...(aggregateAiSpendUsdNano === undefined ? {} : { aggregateAiSpendUsdNano }),
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

  it("the AI usage report can't be entered by hand", async () => {
    const { service, accountId } = await activePilot("opted-in");
    await expect(
      service.issueInvoice({ accountId, lines: [{ kind: "ai-usage-report" as never, code: "ai", quantity: 1, unitAmountCents: 1 }], dueAt: DUE_AT }, CLERK),
    ).rejects.toMatchObject({ code: "validation-failed" });
  });
});

// SCHO-98: the heartbeat's figure is the district's own AI Gateway spend, already on its
// Cloudflare bill, so an invoice may report it but never charge for it.
describe("aggregate AI usage is reported on an invoice, never charged, and only if the district opted in", () => {
  it("adds a zero-amount reporting line with the district's own spend when opted in", async () => {
    const { service, accountId, instanceId, subscription } = await activePilot("opted-in");
    const invoice = await service.issueInvoice(
      { accountId, subscriptionId: subscription.subscriptionId, lines: PLAN_FEE, aiUsageHeartbeat: heartbeat(instanceId, 80_000), dueAt: DUE_AT },
      CLERK,
    );
    expect(invoice.lines.at(-1)).toEqual({ kind: "ai-usage-report", code: "ai-gateway-spend", quantity: 1, unitAmountCents: 0, amountCents: 0, reportedUsdNano: usdNanoFromCents(80_000) });
    expect(invoice).toMatchObject({ subtotalCents: 250_000, totalCents: 250_000 });
    const report = await service.reconciliationReport(accountId);
    expect(report.totals.invoicedCents).toBe(250_000);
  });

  it("reports a sub-cent spend exactly, in nanodollars", async () => {
    const { service, accountId, instanceId, subscription } = await activePilot("opted-in");
    const invoice = await service.issueInvoice(
      { accountId, subscriptionId: subscription.subscriptionId, lines: PLAN_FEE, aiUsageHeartbeat: heartbeatSpending(instanceId, "500000038000"), dueAt: DUE_AT },
      CLERK,
    );
    expect(invoice.lines.at(-1)).toMatchObject({ kind: "ai-usage-report", amountCents: 0, reportedUsdNano: "500000038000" });
  });

  it("still reads a heartbeat from an agent that reports its spend in cents", async () => {
    const { service, accountId, instanceId, subscription } = await activePilot("opted-in");
    const legacy = { instanceId, sequence: 1, sentAt: TERM_START, releaseVersion: "0.1.0", probes: [], aggregateAiSpendCents: 80_000 };
    const invoice = await service.issueInvoice(
      { accountId, subscriptionId: subscription.subscriptionId, lines: PLAN_FEE, aiUsageHeartbeat: legacy, dueAt: DUE_AT },
      CLERK,
    );
    expect(invoice.lines.at(-1)).toMatchObject({ kind: "ai-usage-report", amountCents: 0, reportedUsdNano: usdNanoFromCents(80_000) });
  });

  it("charges nothing however large the spend, and adds no line for a heartbeat that carries none", async () => {
    const { service, accountId, instanceId, subscription } = await activePilot("opted-in");
    const large = await service.issueInvoice(
      { accountId, subscriptionId: subscription.subscriptionId, lines: PLAN_FEE, aiUsageHeartbeat: heartbeat(instanceId, 9_000_000), dueAt: DUE_AT },
      CLERK,
    );
    expect(large.totalCents).toBe(250_000);
    const none = await service.issueInvoice(
      { accountId, subscriptionId: subscription.subscriptionId, lines: PLAN_FEE, aiUsageHeartbeat: heartbeat(instanceId), dueAt: DUE_AT },
      CLERK,
    );
    expect(none.lines.map((line) => line.kind)).toEqual(["plan-fee"]);
  });

  it("an invoice line can't report usage and charge for it, or report usage under another kind", () => {
    const line = { kind: "ai-usage-report", code: "ai-gateway-spend", quantity: 1, unitAmountCents: 0, amountCents: 0, reportedUsdNano: "800000000000" } as const;
    expect(InvoiceLine.safeParse(line).success).toBe(true);
    expect(InvoiceLine.safeParse({ ...line, unitAmountCents: 80_000, amountCents: 80_000 }).success).toBe(false);
    expect(InvoiceLine.safeParse({ ...line, kind: "support" }).success).toBe(false);
    expect(InvoiceLine.safeParse({ kind: "ai-usage-report", code: "ai", quantity: 1, unitAmountCents: 0, amountCents: 0 }).success).toBe(false);
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
