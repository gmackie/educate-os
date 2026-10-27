// Charging an invoice against what the processor actually holds (SCHO-208 review): a charge whose
// reply was lost is found rather than made twice, a reply's status is recorded at once, a declined
// attempt is cancelled before it is replaced, and a refund leaves the rest chargeable again.
import { describe, expect, it } from "vitest";
import { UnmatchedProcessorEventError } from "../src/index.ts";
import { CLERK, DAY, setup } from "./support.ts";

async function cardInvoice(amountCents = 100_000) {
  const context = await setup();
  const { service, accountId, subscribe, clock } = context;
  const subscription = await subscribe({ paymentMethod: "card" });
  await service.ensureProcessorCustomer(accountId, CLERK);
  await service.activate(subscription.subscriptionId, CLERK);
  const invoice = await service.issueInvoice({
    accountId, subscriptionId: subscription.subscriptionId, lines: [{ kind: "plan-fee", code: "pilot", quantity: 1, unitAmountCents: amountCents }],
    dueAt: new Date(clock.now().getTime() + 7 * DAY).toISOString(),
  }, CLERK);
  return { ...context, subscription, invoice };
}

describe("charging an invoice", () => {
  it("finds a charge whose reply was lost instead of charging again, and matches its webhook", async () => {
    const { service, processor, invoice, accountId, deliverWebhooks } = await cardInvoice();
    processor.loseNextChargeReply();
    await expect(service.chargeInvoice(invoice.invoiceId, CLERK)).rejects.toMatchObject({ code: "unavailable" });
    await expect(service.chargeState(invoice.invoiceId)).resolves.toBe("uncharged"); // Nothing recorded yet.

    const ref = await service.chargeInvoice(invoice.invoiceId, CLERK);
    expect((await processor.chargesFor((await service.account(accountId))!.processorCustomerRef!, invoice.invoiceId, invoice.issuedAt))).toHaveLength(1);
    expect(ref).toMatch(/^ch_fake/);
    await expect(service.chargeState(invoice.invoiceId)).resolves.toBe("pending");
    await expect(deliverWebhooks()).resolves.toMatchObject([{ outcome: "applied" }]);
    await expect(service.chargeState(invoice.invoiceId)).resolves.toBe("paid");
  });

  it("records an outcome the processor already reached, with no webhook needed", async () => {
    const { service, processor, invoice, accountId } = await cardInvoice();
    processor.loseNextChargeReply();
    await service.chargeInvoice(invoice.invoiceId, CLERK).catch(() => undefined);
    const [delivery] = processor.takeDeliveries(); // The charge has settled at the processor.
    await service.reconcileCharges(invoice.invoiceId);
    await expect(service.invoice(invoice.invoiceId)).resolves.toMatchObject({ status: "paid" });
    // Its webhook, when it comes, changes nothing.
    await expect(service.handleProcessorDelivery(delivery)).resolves.toMatchObject({ outcome: "duplicate" });
    expect(await service.payments(accountId)).toHaveLength(1);
  });

  it("cancels a declined attempt before making a new one, under a new attempt key", async () => {
    const { service, processor, invoice, deliverWebhooks } = await cardInvoice();
    processor.failNextCharge();
    const declined = await service.chargeInvoice(invoice.invoiceId, CLERK);
    await deliverWebhooks();
    await expect(service.chargeState(invoice.invoiceId)).resolves.toBe("declined");
    const retry = await service.chargeInvoice(invoice.invoiceId, CLERK);
    expect(retry).not.toBe(declined);
    expect(processor.cancelledCharges).toEqual([declined]);
    await deliverWebhooks();
    await expect(service.chargeState(invoice.invoiceId)).resolves.toBe("paid");
  });

  it("returns the pending charge rather than making another while one is on its way", async () => {
    const { service, processor, invoice } = await cardInvoice();
    const first = await service.chargeInvoice(invoice.invoiceId, CLERK);
    expect(await service.chargeInvoice(invoice.invoiceId, CLERK)).toBe(first);
    expect(processor.takeDeliveries()).toHaveLength(1);
  });

  it("applies the webhook of a charge whose reply was lost at once, by reconciling the invoice it names", async () => {
    const { service, processor, invoice, subscription } = await cardInvoice();
    processor.loseNextChargeReply();
    await service.chargeInvoice(invoice.invoiceId, CLERK).catch(() => undefined);
    const [delivery] = processor.takeDeliveries();
    // No further charge or return: the webhook alone finds the charge and pays the invoice.
    await expect(service.handleProcessorDelivery(delivery)).resolves.toMatchObject({ eventId: expect.any(String) });
    await expect(service.invoice(invoice.invoiceId)).resolves.toMatchObject({ status: "paid" });
    await expect(service.subscription(subscription.subscriptionId)).resolves.toMatchObject({ status: "active" });
  });

  it("tells a charge for one of its invoices it still can't find (transient) from one it will never record", async () => {
    const { service, processor, invoice } = await cardInvoice();
    const event = (operationRef: string) => ({ tag: "fake-processor", event: { eventId: `evt_${operationRef}`, type: "charge.succeeded", operationRef, amountCents: 1, occurredAt: invoice.issuedAt } });

    const elsewhere = await service.handleProcessorDelivery(event("pi_elsewhere")).catch((caught: unknown) => caught);
    expect(elsewhere).toBeInstanceOf(UnmatchedProcessorEventError);
    expect(elsewhere).toMatchObject({ ours: false });

    // A charge naming this invoice that reconciling doesn't turn up: made for another customer.
    const stray = await processor.charge({ customerRef: "cus_stranger", amountCents: 1, idempotencyKey: "stray", invoiceRef: invoice.invoiceId });
    const transient = await service.handleProcessorDelivery(event(stray.chargeRef)).catch((caught: unknown) => caught);
    expect(transient).toBeInstanceOf(UnmatchedProcessorEventError);
    expect(transient).toMatchObject({ ours: true, operationRef: stray.chargeRef });
    await expect(service.invoice(invoice.invoiceId)).resolves.toMatchObject({ status: "open" });
  });

  it("leaves what a partial refund reopened chargeable, not pending", async () => {
    const { service, invoice, accountId, deliverWebhooks } = await cardInvoice(100_000);
    await service.chargeInvoice(invoice.invoiceId, CLERK);
    await deliverWebhooks();
    const [payment] = await service.payments(accountId);
    await service.refundPayment(payment!.paymentId, 30_000, CLERK);
    await deliverWebhooks();
    await expect(service.invoice(invoice.invoiceId)).resolves.toMatchObject({ status: "open" });
    await expect(service.chargeState(invoice.invoiceId)).resolves.toBe("reopened");
    await service.chargeInvoice(invoice.invoiceId, CLERK);
    await deliverWebhooks();
    await expect(service.chargeState(invoice.invoiceId)).resolves.toBe("paid");
    expect((await service.payments(accountId)).map((p) => [p.kind, p.amountCents])).toEqual([["charge", 100_000], ["refund", 30_000], ["charge", 30_000]]);
  });
});
