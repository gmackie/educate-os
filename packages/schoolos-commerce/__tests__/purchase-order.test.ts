import { RIVERBEND } from "@schoolos/fixtures";
import { describe, expect, it } from "vitest";
import { DocumentRef, type FinanceActor } from "../src/index.ts";
import { CLERK, CONTROLLER, DAY, idsFor, PILOT, PROCESSOR, setup, TERM_END, TERM_START } from "./support.ts";

const DOCUMENT = DocumentRef.parse("doc_nf-po-2026-118");
const DUE_AT = new Date(Date.parse(TERM_START) + 45 * DAY).toISOString();

async function submitted() {
  const context = await setup();
  const po = await context.service.submitPurchaseOrder(
    { accountId: context.accountId, poNumber: "NF-2026-118", amountCents: 300_000, documentRef: DOCUMENT },
    CLERK,
  );
  const subscription = await context.subscribe({ paymentMethod: "purchase-order", purchaseOrderId: po.purchaseOrderId });
  return { ...context, po, subscription };
}

const fee = (unitAmountCents: number) => [{ kind: "plan-fee" as const, code: "pilot-term", quantity: 1, unitAmountCents }];

describe("purchase order approval", () => {
  it("a PO-paid subscription can't activate until its PO is approved", async () => {
    const { service, po, subscription } = await submitted();
    expect(po.state).toBe("submitted");
    await expect(service.activate(subscription.subscriptionId, CLERK)).rejects.toMatchObject({ code: "policy-violation" });

    const approved = await service.approvePurchaseOrder(po.purchaseOrderId, CONTROLLER);
    expect(approved).toMatchObject({ state: "approved", decidedBy: CONTROLLER.ref, submittedBy: CLERK.ref });
    expect((await service.activate(subscription.subscriptionId, CLERK)).status).toBe("active");
  });

  it("separates duties: the submitter can't approve their own PO, and only staff can decide", async () => {
    const { service, po } = await submitted();
    await expect(service.approvePurchaseOrder(po.purchaseOrderId, CLERK)).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.approvePurchaseOrder(po.purchaseOrderId, PROCESSOR)).rejects.toMatchObject({ code: "forbidden" });
    const system: FinanceActor = { kind: "system", ref: "clock" };
    await expect(service.approvePurchaseOrder(po.purchaseOrderId, system)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("a rejected PO stays rejected and can't fund the subscription", async () => {
    const { service, po, subscription, accountId } = await submitted();
    const rejected = await service.rejectPurchaseOrder(po.purchaseOrderId, "amount-mismatch", CONTROLLER);
    expect(rejected).toMatchObject({ state: "rejected", rejectionCode: "amount-mismatch" });
    await expect(service.approvePurchaseOrder(po.purchaseOrderId, CONTROLLER)).rejects.toMatchObject({ code: "conflict" });
    await expect(service.activate(subscription.subscriptionId, CLERK)).rejects.toMatchObject({ code: "policy-violation" });
    await expect(
      service.issueInvoice({ accountId, purchaseOrderId: po.purchaseOrderId, lines: fee(100), dueAt: DUE_AT }, CLERK),
    ).rejects.toMatchObject({ code: "policy-violation" });
  });

  it("rejects a rejection reason that isn't a code, so no free text reaches the record", async () => {
    const { service, po } = await submitted();
    await expect(service.rejectPurchaseOrder(po.purchaseOrderId, "Call Jane at 555-0100", CONTROLLER)).rejects.toMatchObject({
      code: "validation-failed",
    });
  });

  it("invoices against a PO may not exceed what it authorizes", async () => {
    const { service, po, subscription, accountId } = await submitted();
    await service.approvePurchaseOrder(po.purchaseOrderId, CONTROLLER);
    await service.activate(subscription.subscriptionId, CLERK);
    const first = await service.issueInvoice({ accountId, subscriptionId: subscription.subscriptionId, lines: fee(250_000), dueAt: DUE_AT }, CLERK);
    expect(first.purchaseOrderId).toBe(po.purchaseOrderId);
    await expect(
      service.issueInvoice({ accountId, subscriptionId: subscription.subscriptionId, lines: fee(50_001), dueAt: DUE_AT }, CLERK),
    ).rejects.toMatchObject({ code: "conflict" });
    const last = await service.issueInvoice({ accountId, subscriptionId: subscription.subscriptionId, lines: fee(50_000), dueAt: DUE_AT }, CLERK);
    expect(last.totalCents).toBe(50_000);
  });

  it("PO remittances are recorded by code and settle the invoice", async () => {
    const { service, po, subscription, accountId } = await submitted();
    await service.approvePurchaseOrder(po.purchaseOrderId, CONTROLLER);
    await service.activate(subscription.subscriptionId, CLERK);
    const invoice = await service.issueInvoice({ accountId, subscriptionId: subscription.subscriptionId, lines: fee(250_000), dueAt: DUE_AT }, CLERK);
    await expect(service.recordManualPayment(invoice.invoiceId, 250_001, "ach-77310", CLERK)).rejects.toMatchObject({ code: "conflict" });
    await service.recordManualPayment(invoice.invoiceId, 100_000, "ach-77310", CLERK);
    expect((await service.invoice(invoice.invoiceId)).status).toBe("open");
    expect((await service.recordManualPayment(invoice.invoiceId, 150_000, "ach-77311", CLERK)).status).toBe("paid");
  });

  it("the same PO number can't be recorded twice, and another district's PO can't be used", async () => {
    const { service, accountId, po } = await submitted();
    await expect(
      service.submitPurchaseOrder({ accountId, poNumber: "NF-2026-118", amountCents: 1, documentRef: DOCUMENT }, CLERK),
    ).rejects.toMatchObject({ code: "conflict" });

    const riverbend = idsFor(RIVERBEND).accountId;
    await service.openAccount({ accountId: riverbend, districtLabel: RIVERBEND.district.name }, CLERK);
    // Northfield's PO means nothing on Riverbend's account.
    await expect(
      service.startSubscription(
        { accountId: riverbend, planId: PILOT, paymentMethod: "purchase-order", purchaseOrderId: po.purchaseOrderId, termStart: TERM_START, termEnd: TERM_END },
        CLERK,
      ),
    ).rejects.toMatchObject({ code: "not-found" });
    await expect(
      service.issueInvoice({ accountId: riverbend, purchaseOrderId: po.purchaseOrderId, lines: fee(1), dueAt: DUE_AT }, CLERK),
    ).rejects.toMatchObject({ code: "not-found" });
  });

  it("audits every step of the PO flow with before and after states", async () => {
    const { service, po, accountId } = await submitted();
    await service.approvePurchaseOrder(po.purchaseOrderId, CONTROLLER);
    const steps = (await service.auditTrail(accountId)).filter((event) => event.subject.kind === "purchase-order");
    expect(steps.map((event) => [event.action, event.actor.ref, event.before?.state, event.after?.state, event.after?.amountCents])).toEqual([
      ["purchase-order.submitted", CLERK.ref, undefined, "submitted", 300_000],
      ["purchase-order.approved", CONTROLLER.ref, "submitted", "approved", 300_000],
    ]);
  });
});
