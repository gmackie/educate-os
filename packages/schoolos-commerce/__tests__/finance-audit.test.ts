import { RIVERBEND } from "@schoolos/fixtures";
import { describe, expect, it } from "vitest";
import { FinanceAuditEvent } from "../src/index.ts";
import { CLERK, CONTROLLER, DAY, idsFor, setup, TERM_START } from "./support.ts";

const DUE_AT = new Date(Date.parse(TERM_START) + 30 * DAY).toISOString();

/** Runs a full commercial lifecycle and returns the context. */
async function lifecycle() {
  const context = await setup({ aiUsageSharing: "opted-in" });
  const { service, accountId, instanceId } = context;
  const po = await service.submitPurchaseOrder({ accountId, poNumber: "NF-1", amountCents: 500_000, documentRef: "doc_po-nf-1" }, CLERK);
  await service.approvePurchaseOrder(po.purchaseOrderId, CONTROLLER);
  const subscription = await context.subscribe({ paymentMethod: "purchase-order", purchaseOrderId: po.purchaseOrderId });
  await service.activate(subscription.subscriptionId, CLERK);
  const grant = await service.awardGrant(
    { accountId, funder: "foundation", programCode: "nf-foundation", awardedCents: 100_000, expiresAt: "2027-09-01T00:00:00.000Z", documentRef: "doc_award" },
    CLERK,
  );
  const invoice = await service.issueInvoice(
    { accountId, subscriptionId: subscription.subscriptionId, lines: [{ kind: "plan-fee", code: "pilot-term", quantity: 1, unitAmountCents: 250_000 }], dueAt: DUE_AT },
    CLERK,
  );
  await service.applyGrantCredits(invoice.invoiceId, CLERK);
  await service.recordManualPayment(invoice.invoiceId, 150_000, "po-remit-1", CLERK);
  await service.issueEntitlement(subscription.subscriptionId, instanceId, CLERK);
  return { ...context, po, subscription, grant, invoice };
}

describe("finance audit", () => {
  it("records every state change, with actor, action, before/after summary and timestamp", async () => {
    const { service, accountId } = await lifecycle();
    const trail = await service.auditTrail(accountId);
    for (const event of trail) expect(FinanceAuditEvent.safeParse(event).success, event.action).toBe(true);
    expect(trail.map((event) => event.action)).toEqual([
      "account.opened",
      "account.instance-linked",
      "purchase-order.submitted",
      "purchase-order.approved",
      "subscription.started",
      "subscription.activated",
      "grant.awarded",
      "invoice.issued",
      "invoice.credits-applied",
      "payment.recorded",
      "invoice.paid",
      "entitlement.issued",
    ]);
    expect(trail.find((e) => e.action === "invoice.credits-applied")).toMatchObject({
      actor: CLERK,
      subject: { kind: "invoice" },
      before: { state: "open", amountCents: 250_000 },
      after: { state: "open", amountCents: 150_000 },
    });
    expect(trail.find((e) => e.action === "entitlement.issued")).toMatchObject({ subject: { kind: "instance" }, after: { state: "active", revision: 1 } });
  });

  it("is append-only: later changes only add to the trail, and callers can't edit what is stored", async () => {
    const { service, accountId, subscription } = await lifecycle();
    const before = await service.auditTrail(accountId);
    before[0].action = "subscription.cancelled";
    before.pop();

    const earlier = await service.auditTrail(accountId);
    await service.cancel(subscription.subscriptionId, CLERK);
    const later = await service.auditTrail(accountId);
    expect(later.slice(0, earlier.length)).toEqual(earlier);
    expect(later.slice(earlier.length).map((e) => e.action)).toEqual(["subscription.cancelled"]);
    expect(earlier[0].action).toBe("account.opened");
  });

  it("keeps each account's trail to itself", async () => {
    const { service } = await lifecycle();
    const riverbend = idsFor(RIVERBEND).accountId;
    await service.openAccount({ accountId: riverbend, districtLabel: RIVERBEND.district.name }, CLERK);
    const trail = await service.auditTrail(riverbend);
    expect(trail.map((e) => e.action)).toEqual(["account.opened"]);
    expect(trail.every((e) => e.accountId === riverbend)).toBe(true);
  });

  it("a refused change leaves no audit event", async () => {
    const { service, accountId, invoice, po } = await lifecycle();
    const before = await service.auditTrail(accountId);
    await expect(service.recordManualPayment(invoice.invoiceId, 999_999, "too-much", CLERK)).rejects.toThrow();
    await expect(service.approvePurchaseOrder(po.purchaseOrderId, CONTROLLER)).rejects.toThrow();
    await service.reconciliationReport(accountId);
    expect(await service.auditTrail(accountId)).toEqual(before);
  });
});

describe("reconciliation: invoices against payments against credits", () => {
  it("balances a lifecycle to the cent", async () => {
    const { service, accountId, invoice } = await lifecycle();
    const report = await service.reconciliationReport(accountId);
    expect(report.balanced).toBe(true);
    expect(report.invoices).toEqual([
      {
        invoiceId: invoice.invoiceId,
        status: "paid",
        subtotalCents: 250_000,
        creditsAppliedCents: 100_000,
        totalCents: 150_000,
        paidCents: 150_000,
        refundedCents: 0,
        balanceCents: 0,
      },
    ]);
    expect(report.totals).toEqual({
      invoicedCents: 250_000,
      creditsAppliedCents: 100_000,
      paidCents: 150_000,
      refundedCents: 0,
      outstandingCents: 0,
      grantsAwardedCents: 100_000,
      grantsExpiredCents: 0,
      grantsRemainingCents: 0,
    });
  });

  it("flags books that don't add up: an invoice's credits disagreeing with the ledger, or its status with its balance", async () => {
    const { service, store, accountId, invoice } = await lifecycle();
    const stored = await service.invoice(invoice.invoiceId);
    // Simulate a bad write in the store, bypassing the service.
    await store.put("invoice", invoice.invoiceId, { ...stored, creditsAppliedCents: 0, totalCents: 250_000 });
    const report = await service.reconciliationReport(accountId);
    expect(report.balanced).toBe(false);
    expect(report.discrepancies).toEqual([
      { code: "credits-mismatch", invoiceId: invoice.invoiceId, invoiceCents: 0, ledgerCents: 100_000 },
      { code: "status-mismatch", invoiceId: invoice.invoiceId, status: "paid", balanceCents: 100_000 },
    ]);
  });

  it("flags an overpayment from the processor", async () => {
    const context = await setup();
    const { service, accountId, processor } = context;
    await service.ensureProcessorCustomer(accountId, CLERK);
    const invoice = await service.issueInvoice({ accountId, lines: [{ kind: "support", code: "hours", quantity: 2, unitAmountCents: 10_000 }], dueAt: DUE_AT }, CLERK);
    await service.chargeInvoice(invoice.invoiceId, CLERK);
    // The processor reports more than was asked for: commerce records the money that moved and
    // reconciliation surfaces it for a human.
    const [delivery] = processor.takeDeliveries() as { tag: string; event: { amountCents: number } }[];
    delivery.event.amountCents = 25_000;
    await service.handleProcessorDelivery(delivery);
    const report = await service.reconciliationReport(accountId);
    expect(report.discrepancies).toEqual([{ code: "overpaid", invoiceId: invoice.invoiceId, overpaidCents: 5_000 }]);
  });
});
