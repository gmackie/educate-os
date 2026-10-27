// ControlPlaneBilling on its own (SCHO-208), where the suite controls the interleaving: the return
// from Stripe and a cancel run one at a time in either order; an unmatched webhook is logged by
// Stripe's IDs; a failed billing build is retried; and what a refund reopens can be paid again.
import { CommercialAccountId } from "@educateos/contracts";
import { CommerceService, FakePaymentProcessor, InMemoryCommerceStore, StripePaymentProcessor } from "@educateos/commerce";
import { SigningIdentity } from "@educateos/fleet";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneBilling, keepUnlessRejected, MANAGED_PLANS } from "../src/billing.ts";
import type { Operator } from "../src/store.ts";

const ORIGIN = "https://educateos.io";
const OPERATOR: Operator = {
  subject: "billing-service-operator",
  accountId: CommercialAccountId.parse(`acct_${"b".repeat(32)}`),
  email: "operator@example.org",
  firstSeenAt: "2026-10-27T00:00:00.000Z",
  lastSeenAt: "2026-10-27T00:00:00.000Z",
};
const STAFF = { kind: "staff", ref: "staff-controller" } as const;

/** A fake processor whose card setup completion waits at a gate the suite opens. */
class GatedProcessor extends FakePaymentProcessor {
  #gate: Promise<void> = Promise.resolve();
  #open: () => void = () => undefined;
  /** Whether a completion is waiting at the gate. */
  waiting = false;

  hold(): void {
    this.#gate = new Promise((resolve) => (this.#open = resolve));
  }

  release(): void {
    this.#open();
  }

  override async completeCardSetup(customerRef: string, setupRef: string, reference: string): Promise<boolean> {
    this.waiting = true;
    await this.#gate;
    this.waiting = false;
    return super.completeCardSetup(customerRef, setupRef, reference);
  }
}

async function billingWith(processor: FakePaymentProcessor) {
  const store = new InMemoryCommerceStore();
  const signer = await SigningIdentity.generate();
  const billing = new ControlPlaneBilling({ store, processor, signer });
  // Finance staff over the same records, for what the console can't do: refunds, the audit.
  const staff = new CommerceService({ store, processor, plans: MANAGED_PLANS.map(({ plan }) => plan), entitlementSigner: signer });
  return { billing, staff };
}

/** Subscribes the operator and saves a card on the fake's setup page. */
async function subscribedWithCard(billing: ControlPlaneBilling, processor: FakePaymentProcessor) {
  const started = await billing.subscribe(OPERATOR, MANAGED_PLANS[0]!.plan.planId, "Riverbend", ORIGIN);
  if (!started.ok) throw new Error(started.message);
  const setupRef = /\/setup\/(cs_fake\d+)$/.exec(started.value.url)![1]!;
  processor.saveCard(setupRef);
  const overview = await billing.overview(OPERATOR);
  if (!overview.ok) throw new Error(overview.message);
  return { setupRef, subscriptionId: overview.value.subscription!.subscriptionId };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the return from Stripe and a cancel", () => {
  it("run one at a time: a cancel during the return waits for it, and stops only later charges", async () => {
    const processor = new GatedProcessor();
    const { billing, staff } = await billingWith(processor);
    const { setupRef, subscriptionId } = await subscribedWithCard(billing, processor);

    processor.hold();
    const back = billing.completeCardSetup(OPERATOR, subscriptionId, setupRef);
    while (!processor.waiting) await tick();
    let cancelled = false;
    const cancel = billing.cancelSubscription(OPERATOR).then((reply) => {
      cancelled = true;
      return reply;
    });
    await tick();
    await tick();
    expect(cancelled).toBe(false); // Queued behind the return, which is mid-flight.

    processor.release();
    await expect(back).resolves.toMatchObject({ ok: true, value: { subscription: { status: "active" }, charge: "pending" } });
    await expect(cancel).resolves.toMatchObject({ ok: true, value: { status: "cancelled" } });
    const actions = (await staff.auditTrail(OPERATOR.accountId)).map((event) => event.action);
    expect(actions.indexOf("invoice.charge-requested")).toBeLessThan(actions.indexOf("subscription.cancelled"));
    expect(actions.filter((action) => action === "invoice.issued")).toHaveLength(1);
  });

  it("when the cancel lands first, the return starts nothing and charges nothing", async () => {
    const processor = new GatedProcessor();
    const { billing, staff } = await billingWith(processor);
    const { setupRef, subscriptionId } = await subscribedWithCard(billing, processor);

    await expect(billing.cancelSubscription(OPERATOR)).resolves.toMatchObject({ ok: true });
    await expect(billing.completeCardSetup(OPERATOR, subscriptionId, setupRef)).resolves.toMatchObject({
      ok: true, value: { subscription: { status: "cancelled" } },
    });
    expect(processor.takeDeliveries()).toHaveLength(0);
    const actions = (await staff.auditTrail(OPERATOR.accountId)).map((event) => event.action);
    expect(actions).not.toContain("invoice.issued");
    expect(actions).not.toContain("subscription.activated");
  });
});

describe("paying what a refund reopened", () => {
  it("charges the remainder with Pay now, not reporting it as pending", async () => {
    const processor = new FakePaymentProcessor();
    const { billing, staff } = await billingWith(processor);
    const { setupRef, subscriptionId } = await subscribedWithCard(billing, processor);
    await billing.completeCardSetup(OPERATOR, subscriptionId, setupRef);
    for (const delivery of processor.takeDeliveries()) await staff.handleProcessorDelivery(delivery);

    const [payment] = await staff.payments(OPERATOR.accountId);
    await staff.refundPayment(payment!.paymentId, 40, STAFF);
    for (const delivery of processor.takeDeliveries()) await staff.handleProcessorDelivery(delivery);
    expect(await billing.overview(OPERATOR)).toMatchObject({ ok: true, value: { invoices: [{ invoice: { status: "open" }, charge: "uncharged" }] } });

    await expect(billing.payInvoice(OPERATOR)).resolves.toMatchObject({ ok: true, value: "pending" });
    for (const delivery of processor.takeDeliveries()) await staff.handleProcessorDelivery(delivery);
    expect(await billing.overview(OPERATOR)).toMatchObject({ ok: true, value: { invoices: [{ invoice: { status: "paid" }, charge: "paid" }] } });
    expect((await staff.payments(OPERATOR.accountId)).map((p) => [p.kind, p.amountCents])).toEqual([["charge", 100], ["refund", 40], ["charge", 40]]);
  });
});

describe("an unmatched webhook", () => {
  it("is logged by Stripe's event and PaymentIntent IDs, and reported unmatched", async () => {
    const secret = "whsec_billing_service_test";
    const processor = new StripePaymentProcessor({ apiKey: "sk_test_unused", webhookSecret: secret, fetch: () => Promise.reject(new Error("no network")) });
    const billing = new ControlPlaneBilling({ store: new InMemoryCommerceStore(), processor, signer: await SigningIdentity.generate() });
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({
      id: "evt_unmatched", object: "event", type: "payment_intent.succeeded", created: timestamp,
      data: { object: { id: "pi_unmatched", object: "payment_intent", amount: 100, amount_received: 100, currency: "usd" } },
    });
    const hmac = { name: "HMAC", hash: "SHA-256" } as const;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), hmac, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign(hmac, key, new TextEncoder().encode(`${timestamp}.${payload}`)));
    const signature = `t=${timestamp},v1=${[...mac].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;

    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(billing.receiveStripeWebhook(payload, signature)).resolves.toEqual({ ok: true, value: { outcome: "unmatched" } });
    expect(log).toHaveBeenCalledWith("stripe webhook unmatched", { eventId: "evt_unmatched", operationRef: "pi_unmatched" });
  });
});

describe("keepUnlessRejected, which the Durable Object builds billing with", () => {
  it("keeps a build that resolved, and builds again after one that rejected", async () => {
    let builds = 0;
    const build = keepUnlessRejected(async () => {
      builds += 1;
      if (builds === 1) throw new Error("first build fails");
      return builds;
    });
    await expect(build()).rejects.toThrow("first build fails");
    await expect(build()).resolves.toBe(2);
    await expect(build()).resolves.toBe(2);
    expect(builds).toBe(2);
  });
});
