// Card subscriptions through the processor's hosted pages (SCHO-208): the account saves a card on
// the processor's setup page, which charges nothing; coming back activates the trialing
// subscription; the first invoice is then charged to that card off-session.
import { describe, expect, it } from "vitest";
import { SETUP_REF_PLACEHOLDER, type FinanceActor } from "../src/index.ts";
import { DAY, setup, TERM_START } from "./support.ts";

const CUSTOMER: FinanceActor = { kind: "customer", ref: "acct_northfield" };
const URLS = { returnUrl: `https://educateos.io/app/billing/return?setup=${SETUP_REF_PLACEHOLDER}`, cancelUrl: "https://educateos.io/app/billing", idempotencyKey: "k1" };

describe("card setup", () => {
  it("activates a card subscription once its card is saved, and charges the first invoice to it", async () => {
    const { service, processor, accountId, subscribe, deliverWebhooks, clock } = await setup();
    const subscription = await subscribe({ paymentMethod: "card" });

    const card = await service.startCardSetup(subscription.subscriptionId, URLS, CUSTOMER);
    expect(processor.customersCreated).toEqual([accountId]);
    expect(card.url).toContain(card.setupRef);

    // Back before the card was saved: still trialing, nothing saved.
    await expect(service.completeCardSetup(subscription.subscriptionId, card.setupRef, CUSTOMER)).resolves.toMatchObject({ status: "trialing" });
    processor.saveCard(card.setupRef);
    await expect(service.completeCardSetup(subscription.subscriptionId, card.setupRef, CUSTOMER)).resolves.toMatchObject({ status: "active" });
    // Coming back again changes nothing.
    await expect(service.completeCardSetup(subscription.subscriptionId, card.setupRef, CUSTOMER)).resolves.toMatchObject({ status: "active" });
    expect(processor.defaultPaymentMethods.size).toBe(1);

    const invoice = await service.issueInvoice({
      accountId, subscriptionId: subscription.subscriptionId, lines: [{ kind: "plan-fee", code: "pilot", quantity: 1, unitAmountCents: 250_000 }],
      dueAt: new Date(clock.now().getTime() + 7 * DAY).toISOString(),
    }, CUSTOMER);
    await service.chargeInvoice(invoice.invoiceId, CUSTOMER);
    await deliverWebhooks();
    await expect(service.invoice(invoice.invoiceId)).resolves.toMatchObject({ status: "paid" });
    await expect(service.invoices(accountId)).resolves.toHaveLength(1);

    const actions = (await service.auditTrail(accountId)).map((event) => event.action);
    expect(actions).toEqual(expect.arrayContaining(["account.processor-customer-created", "account.payment-method-saved", "subscription.activated", "invoice.paid"]));
    await expect(service.verifyAuditTrail(accountId)).resolves.toMatchObject({ intact: true });
  });

  it("opens the payment method portal only for an account with a processor customer", async () => {
    const { service, accountId, subscribe } = await setup();
    await expect(service.paymentMethodPortal(accountId, "https://educateos.io/app/billing")).rejects.toMatchObject({ code: "conflict" });
    await service.startCardSetup((await subscribe({ paymentMethod: "card" })).subscriptionId, URLS, CUSTOMER);
    await expect(service.paymentMethodPortal(accountId, "https://educateos.io/app/billing")).resolves.toMatch(/^https:\/\/fake-processor\.invalid\/portal\//);
  });

  it("refuses a card setup for a subscription not paid by card, or past trialing", async () => {
    const { service, subscribe } = await setup();
    const byInvoice = await subscribe({ paymentMethod: "invoice" });
    await expect(service.startCardSetup(byInvoice.subscriptionId, URLS, CUSTOMER)).rejects.toMatchObject({ code: "validation-failed" });
    const byCard = await subscribe({ paymentMethod: "card", termStart: TERM_START });
    await service.cancel(byCard.subscriptionId, CUSTOMER);
    await expect(service.startCardSetup(byCard.subscriptionId, URLS, CUSTOMER)).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses another account's setup as not found", async () => {
    const { service, processor, subscribe } = await setup();
    const subscription = await subscribe({ paymentMethod: "card" });
    await service.startCardSetup(subscription.subscriptionId, URLS, CUSTOMER);
    const stranger = await processor.startCardSetup({ ...URLS, customerRef: "cus_stranger", idempotencyKey: "k2" });
    processor.saveCard(stranger.setupRef);
    await expect(service.completeCardSetup(subscription.subscriptionId, stranger.setupRef, CUSTOMER)).rejects.toMatchObject({ code: "not-found" });
  });

  it("keeps a customer from staff-only operations", async () => {
    const { service, accountId } = await setup();
    await expect(service.submitPurchaseOrder({ accountId, poNumber: "PO-1", amountCents: 100, documentRef: "doc_po1" }, CUSTOMER))
      .rejects.toMatchObject({ code: "forbidden" });
  });
});
