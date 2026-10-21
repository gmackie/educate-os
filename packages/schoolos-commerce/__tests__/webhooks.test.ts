import { describe, expect, it } from "vitest";
import { CLERK, DAY, setup, TERM_START } from "./support.ts";

const DUE_AT = new Date(Date.parse(TERM_START) + 30 * DAY).toISOString();

async function cardSubscription() {
  const context = await setup();
  const { service, accountId } = context;
  await service.ensureProcessorCustomer(accountId, CLERK);
  const subscription = await context.subscribe({ paymentMethod: "card" });
  await service.activate(subscription.subscriptionId, CLERK);
  const invoice = await service.issueInvoice(
    { accountId, subscriptionId: subscription.subscriptionId, lines: [{ kind: "plan-fee", code: "pilot-term", quantity: 1, unitAmountCents: 250_000 }], dueAt: DUE_AT },
    CLERK,
  );
  return { ...context, subscription, invoice };
}

describe("processor port", () => {
  it("creates the processor customer once, passing only the opaque account ID", async () => {
    const { service, processor, accountId } = await setup();
    const first = await service.ensureProcessorCustomer(accountId, CLERK);
    expect(await service.ensureProcessorCustomer(accountId, CLERK)).toBe(first);
    expect(processor.customersCreated).toEqual([accountId]);
  });

  it("a card subscription needs a processor customer to activate", async () => {
    const context = await setup();
    const subscription = await context.subscribe({ paymentMethod: "card" });
    await expect(context.service.activate(subscription.subscriptionId, CLERK)).rejects.toMatchObject({ code: "policy-violation" });
  });

  it("retrying a charge request reuses the processor's charge instead of charging twice", async () => {
    const { service, processor, invoice } = await cardSubscription();
    const first = await service.chargeInvoice(invoice.invoiceId, CLERK);
    expect(await service.chargeInvoice(invoice.invoiceId, CLERK)).toBe(first);
    expect(processor.takeDeliveries()).toHaveLength(1);
  });

  it("rejects a delivery that fails verification", async () => {
    const { service } = await setup();
    await expect(service.handleProcessorDelivery({ tag: "forged", event: {} })).rejects.toMatchObject({ code: "unauthenticated" });
  });
});

describe("webhook events map to subscription transitions idempotently, by event ID", () => {
  it("applies a successful charge once, however often it is redelivered", async () => {
    const { service, processor, invoice, accountId } = await cardSubscription();
    await service.chargeInvoice(invoice.invoiceId, CLERK);
    const [delivery] = processor.takeDeliveries();

    expect(await service.handleProcessorDelivery(delivery)).toMatchObject({ outcome: "applied" });
    for (let i = 0; i < 3; i++) expect(await service.handleProcessorDelivery(delivery)).toMatchObject({ outcome: "duplicate" });

    expect(await service.payments(accountId)).toHaveLength(1);
    expect((await service.invoice(invoice.invoiceId)).status).toBe("paid");
    expect((await service.auditTrail(accountId)).filter((e) => e.action === "payment.recorded")).toHaveLength(1);
    expect((await service.reconciliationReport(accountId)).balanced).toBe(true);
  });

  it("a failed charge makes the subscription past-due once; redelivery changes nothing", async () => {
    const { service, processor, invoice, subscription, accountId } = await cardSubscription();
    processor.failNextCharge();
    await service.chargeInvoice(invoice.invoiceId, CLERK);
    const [failure] = processor.takeDeliveries();
    await service.handleProcessorDelivery(failure);
    const trail = await service.auditTrail(accountId);
    await service.handleProcessorDelivery(failure);

    expect(await service.auditTrail(accountId)).toEqual(trail);
    const after = await service.subscription(subscription.subscriptionId);
    expect(after).toMatchObject({ status: "past-due", pastDueSince: TERM_START });
    expect(trail.at(-1)).toMatchObject({ action: "subscription.past-due", actor: { kind: "processor" }, before: { state: "active" } });
  });

  it("a successful retry after a failure reactivates the subscription", async () => {
    const { service, processor, invoice, subscription, clock, deliverWebhooks } = await cardSubscription();
    processor.failNextCharge();
    await service.chargeInvoice(invoice.invoiceId, CLERK);
    for (const delivery of processor.takeDeliveries()) await service.handleProcessorDelivery(delivery);
    clock.advance(DAY);
    const outcomes = await (async () => {
      await service.chargeInvoice(invoice.invoiceId, CLERK);
      return await deliverWebhooks();
    })();
    expect(outcomes).toMatchObject([{ outcome: "applied" }]);
    expect((await service.invoice(invoice.invoiceId)).status).toBe("paid");
    expect((await service.subscription(subscription.subscriptionId)).status).toBe("active");
    const actions = (await service.auditTrail(subscription.accountId)).map((e) => e.action).filter((a) => a.startsWith("subscription."));
    expect(actions.slice(-2)).toEqual(["subscription.past-due", "subscription.reactivated"]);
  });

  it("refunds are recorded when the processor confirms them, once, and reopen the invoice", async () => {
    const { service, processor, invoice, accountId, deliverWebhooks } = await cardSubscription();
    await service.chargeInvoice(invoice.invoiceId, CLERK);
    await deliverWebhooks();
    const [charge] = await service.payments(accountId);

    await service.refundPayment(charge.paymentId, 50_000, CLERK);
    expect(await service.refundPayment(charge.paymentId, 50_000, CLERK)).toBeTruthy(); // same refund, same key
    const deliveries = processor.takeDeliveries();
    expect(deliveries).toHaveLength(1);
    expect(await service.handleProcessorDelivery(deliveries[0])).toMatchObject({ outcome: "applied" });
    expect(await service.handleProcessorDelivery(deliveries[0])).toMatchObject({ outcome: "duplicate" });

    expect((await service.payments(accountId)).map((p) => [p.kind, p.amountCents])).toEqual([
      ["charge", 250_000],
      ["refund", 50_000],
    ]);
    expect((await service.invoice(invoice.invoiceId)).status).toBe("open");
    await expect(service.refundPayment(charge.paymentId, 200_001, CLERK)).rejects.toMatchObject({ code: "conflict" });
    const report = await service.reconciliationReport(accountId);
    expect(report.invoices[0]).toMatchObject({ paidCents: 250_000, refundedCents: 50_000, balanceCents: 50_000 });
    expect(report.balanced).toBe(true);
  });

  it("an event for a charge commerce never requested is refused and not marked processed", async () => {
    const { service } = await setup();
    const delivery = {
      tag: "fake-processor",
      event: { eventId: "evt_unknown", type: "charge.succeeded", operationRef: "ch_unknown", amountCents: 100, occurredAt: TERM_START },
    };
    await expect(service.handleProcessorDelivery(delivery)).rejects.toMatchObject({ code: "not-found" });
    await expect(service.handleProcessorDelivery(delivery)).rejects.toMatchObject({ code: "not-found" });
  });
});
