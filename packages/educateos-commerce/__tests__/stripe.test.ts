import { CommercialAccountId } from "@educateos/contracts";
import { NORTHFIELD } from "@educateos/fixtures";
import { SigningIdentity } from "@educateos/fleet";
import { describe, expect, it } from "vitest";
import { CommerceService, InMemoryCommerceStore, STRIPE_API_VERSION, StripePaymentProcessor } from "../src/index.ts";
import { CLERK, DAY, idsFor, manualClock, PLANS } from "./support.ts";

// Fixed vectors, computed outside this code with
//   printf '%s.%s' "$T" "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET"
// so a mistake in the adapter's signing scheme can't also be in what it is checked against.
const SECRET = "whsec_educateos_fixture_not_a_real_secret";
const T = 1792497600; // 2026-10-20T12:00:00Z
const PAYLOAD =
  '{"id":"evt_fixture_1","object":"event","type":"payment_intent.succeeded","created":1792497600,"data":{"object":{"id":"pi_fixture_1","object":"payment_intent","amount":250000,"amount_received":250000,"currency":"usd","status":"succeeded"}}}';
const V1 = "842677e8377843748df73da6ac45cd1cbf839f35b1bde5f292aa9970a25507e5";
/** The same timestamp and payload signed with a different secret. */
const V1_OTHER_SECRET = "fef9fcc3443a1f356b3477f425c45183b57dd1b59050dd11e226ed174839b859";

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: URLSearchParams | undefined;
}

/** A `fetch` that answers from a route table and records every request. No network. */
function fakeStripe(routes: Record<string, () => { status?: number; body: unknown }>) {
  const requests: RecordedRequest[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({
      method,
      url,
      headers: init?.headers as Record<string, string>,
      body: typeof init?.body === "string" ? new URLSearchParams(init.body) : undefined,
    });
    const route = routes[`${method} ${new URL(url).pathname}`];
    if (route === undefined) return new Response(JSON.stringify({ error: { message: "no route" } }), { status: 404 });
    const { status = 200, body } = route();
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  return { fetch, requests };
}

function processorAt(unixSeconds: number, routes: Parameters<typeof fakeStripe>[0] = {}) {
  const stripe = fakeStripe(routes);
  const processor = new StripePaymentProcessor({
    apiKey: "rk_test_fixture",
    webhookSecret: SECRET,
    fetch: stripe.fetch,
    now: () => new Date(unixSeconds * 1000),
  });
  return { processor, requests: stripe.requests };
}

/** Signs a payload the way Stripe does; the fixed vectors above pin that this is Stripe's scheme. */
async function stripeSignature(payload: string, timestamp: number, secret = SECRET): Promise<string> {
  const hmac = { name: "HMAC", hash: "SHA-256" } as const;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), hmac, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign(hmac, key, new TextEncoder().encode(`${timestamp}.${payload}`)));
  return `t=${timestamp},v1=${[...mac].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function eventPayload(id: string, type: string, object: Record<string, unknown>, created = T): string {
  return JSON.stringify({ id, object: "event", type, created, data: { object } });
}

describe("Stripe webhook signature verification (fixed vectors)", () => {
  it("accepts the reference vector and maps it", async () => {
    const { processor } = processorAt(T);
    await expect(processor.mapWebhookEvent({ payload: PAYLOAD, signature: `t=${T},v1=${V1}` })).resolves.toEqual({
      eventId: "evt_fixture_1",
      type: "charge.succeeded",
      operationRef: "pi_fixture_1",
      amountCents: 250_000,
      occurredAt: "2026-10-20T12:00:00.000Z",
    });
  });

  it("accepts a header listing several signatures while a secret rolls, and ignores v0", async () => {
    const { processor } = processorAt(T);
    const header = `t=${T},v0=${"a".repeat(64)},v1=${V1_OTHER_SECRET},v1=${V1}`;
    await expect(processor.mapWebhookEvent({ payload: PAYLOAD, signature: header })).resolves.toMatchObject({ eventId: "evt_fixture_1" });
  });

  for (const [what, payload, signature] of [
    ["a signature under another secret", PAYLOAD, `t=${T},v1=${V1_OTHER_SECRET}`],
    ["a payload changed by one byte", PAYLOAD.replace("250000,", "250001,"), `t=${T},v1=${V1}`],
    ["a timestamp the signature doesn't cover", PAYLOAD, `t=${T + 1},v1=${V1}`],
    ["a v0 signature only", PAYLOAD, `t=${T},v0=${V1}`],
    ["no timestamp", PAYLOAD, `v1=${V1}`],
    ["an empty header", PAYLOAD, ""],
    ["a truncated signature", PAYLOAD, `t=${T},v1=${V1.slice(0, 62)}`],
  ] as const) {
    it(`refuses ${what}`, async () => {
      const { processor } = processorAt(T);
      await expect(processor.mapWebhookEvent({ payload, signature })).rejects.toMatchObject({ code: "unauthenticated" });
    });
  }

  it("refuses the reference vector more than five minutes from the clock, either way", async () => {
    for (const now of [T + 301, T - 301]) {
      const { processor } = processorAt(now);
      await expect(processor.mapWebhookEvent({ payload: PAYLOAD, signature: `t=${T},v1=${V1}` })).rejects.toMatchObject({ code: "unauthenticated" });
    }
    const { processor } = processorAt(T + 299);
    await expect(processor.mapWebhookEvent({ payload: PAYLOAD, signature: `t=${T},v1=${V1}` })).resolves.toBeDefined();
  });

  it("reads nothing from an unverified payload: a malformed one is still just unauthenticated", async () => {
    const { processor } = processorAt(T);
    await expect(processor.mapWebhookEvent({ payload: "{not json", signature: `t=${T},v1=${V1}` })).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(processor.mapWebhookEvent({ payload: PAYLOAD, signature: `t=${T},v1=${V1}`, extra: 1 })).rejects.toMatchObject({ code: "validation-failed" });
  });
});

async function mapped(type: string, object: Record<string, unknown>) {
  const { processor } = processorAt(T);
  const payload = eventPayload("evt_map", type, object);
  return processor.mapWebhookEvent({ payload, signature: await stripeSignature(payload, T) });
}

describe("Stripe webhook mapping", () => {
  const intent = { id: "pi_1", amount: 9_000, amount_received: 0, currency: "usd", status: "requires_payment_method", client_secret: "pi_1_secret_x" };

  it("maps a failed PaymentIntent to a failed charge for its full amount", async () => {
    await expect(mapped("payment_intent.payment_failed", intent)).resolves.toMatchObject({ type: "charge.failed", operationRef: "pi_1", amountCents: 9_000 });
  });

  it("maps a refund once it has succeeded, from either refund event, and ignores a pending one", async () => {
    const refund = { id: "re_1", amount: 5_000, currency: "usd", status: "succeeded", payment_intent: "pi_1" };
    for (const type of ["refund.created", "refund.updated"]) {
      await expect(mapped(type, refund)).resolves.toMatchObject({ type: "refund.succeeded", operationRef: "re_1", amountCents: 5_000 });
    }
    await expect(mapped("refund.created", { ...refund, status: "pending" })).resolves.toBeUndefined();
  });

  it("ignores event types commerce doesn't act on, and refuses any currency but USD", async () => {
    await expect(mapped("customer.updated", { id: "cus_1" })).resolves.toBeUndefined();
    await expect(mapped("payment_intent.succeeded", { ...intent, amount_received: 9_000, currency: "eur" })).rejects.toMatchObject({ code: "validation-failed" });
  });
});

describe("Stripe REST calls", () => {
  const accountId = CommercialAccountId.parse("acct_northfield");

  it("creates a customer carrying only the opaque account ID, idempotently, on the pinned API version", async () => {
    const { processor, requests } = processorAt(T, { "POST /v1/customers": () => ({ body: { id: "cus_nf", object: "customer", email: null } }) });
    expect(await processor.createCustomer(accountId)).toBe("cus_nf");
    const [request] = requests;
    expect(request).toMatchObject({ method: "POST", url: "https://api.stripe.com/v1/customers" });
    expect(request!.headers).toEqual({
      Authorization: "Bearer rk_test_fixture",
      "Stripe-Version": STRIPE_API_VERSION,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": "educateos:customer:acct_northfield",
    });
    expect([...request!.body!.entries()]).toEqual([["metadata[commercial_account_id]", "acct_northfield"]]);
  });

  it("charges the default payment method off-session, keyed by the caller's idempotency key", async () => {
    const { processor, requests } = processorAt(T, {
      "GET /v1/customers/cus_nf": () => ({ body: { id: "cus_nf", invoice_settings: { default_payment_method: "pm_card" } } }),
      "POST /v1/payment_intents": () => ({ body: { id: "pi_nf", status: "processing", amount: 250_000, amount_received: 0, currency: "usd" } }),
    });
    expect(await processor.charge({ customerRef: "cus_nf", amountCents: 250_000, idempotencyKey: "inv_1:0", invoiceRef: "inv_1" }))
      .toEqual({ chargeRef: "pi_nf", status: "pending", amountCents: 250_000 });
    const charge = requests[1]!;
    expect(Object.fromEntries(charge.body!)).toEqual({
      amount: "250000",
      currency: "usd",
      customer: "cus_nf",
      payment_method: "pm_card",
      confirm: "true",
      off_session: "true",
      "metadata[educateos_invoice]": "inv_1",
    });
    expect(charge.headers["Idempotency-Key"]).toBe("educateos:charge:inv_1:0");
  });

  it("returns a declined charge's PaymentIntent, whose webhook reports the failure", async () => {
    const { processor } = processorAt(T, {
      "GET /v1/customers/cus_nf": () => ({ body: { id: "cus_nf", invoice_settings: { default_payment_method: "pm_card" } } }),
      "POST /v1/payment_intents": () => ({ status: 402, body: { error: { type: "card_error", code: "card_declined",
        payment_intent: { id: "pi_declined", status: "requires_payment_method", amount: 1, amount_received: 0, currency: "usd" } } } }),
    });
    expect(await processor.charge({ customerRef: "cus_nf", amountCents: 1, idempotencyKey: "k", invoiceRef: "inv_1" }))
      .toEqual({ chargeRef: "pi_declined", status: "failed", amountCents: 1 });
  });

  it("reports a replayed PaymentIntent's outcome as Stripe answers it", async () => {
    const { processor } = processorAt(T, {
      "GET /v1/customers/cus_nf": () => ({ body: { id: "cus_nf", invoice_settings: { default_payment_method: "pm_card" } } }),
      "POST /v1/payment_intents": () => ({ body: { id: "pi_nf", status: "succeeded", amount: 500, amount_received: 500, currency: "usd" } }),
    });
    expect(await processor.charge({ customerRef: "cus_nf", amountCents: 500, idempotencyKey: "inv_1:0", invoiceRef: "inv_1" }))
      .toEqual({ chargeRef: "pi_nf", status: "succeeded", amountCents: 500 });
  });

  it("finds the customer's PaymentIntents for an invoice by their metadata, page by page from its issue", async () => {
    const intent = (id: string, status: string, invoice: string) => ({ id, status, amount: 500, amount_received: status === "succeeded" ? 500 : 0, currency: "usd", metadata: { educateos_invoice: invoice } });
    let pages = 0;
    const { processor, requests } = processorAt(T, {
      "GET /v1/payment_intents": () => (pages++ === 0
        ? { body: { has_more: true, data: [intent("pi_a", "succeeded", "inv_1"), intent("pi_b", "requires_payment_method", "inv_1"), intent("pi_c", "succeeded", "inv_2")] } }
        : { body: { has_more: false, data: [intent("pi_d", "processing", "inv_1")] } }),
    });
    expect(await processor.chargesFor("cus_nf", "inv_1", "2026-10-20T12:00:00.000Z")).toEqual([
      { chargeRef: "pi_a", status: "succeeded", amountCents: 500 },
      { chargeRef: "pi_b", status: "failed", amountCents: 500 },
      { chargeRef: "pi_d", status: "pending", amountCents: 500 },
    ]);
    const since = String(T - 3600); // The invoice's issue, less an hour.
    expect(requests.map((r) => r.url)).toEqual([
      `https://api.stripe.com/v1/payment_intents?customer=cus_nf&limit=100&created%5Bgte%5D=${since}`,
      `https://api.stripe.com/v1/payment_intents?customer=cus_nf&limit=100&created%5Bgte%5D=${since}&starting_after=pi_c`,
    ]);
  });

  it("reads the invoice a PaymentIntent names, and none for one that names none or doesn't exist", async () => {
    const { processor } = processorAt(T, {
      "GET /v1/payment_intents/pi_ours": () => ({ body: { id: "pi_ours", status: "succeeded", amount: 1, amount_received: 1, currency: "usd", metadata: { educateos_invoice: "inv_1" } } }),
      "GET /v1/payment_intents/pi_link": () => ({ body: { id: "pi_link", status: "succeeded", amount: 1, amount_received: 1, currency: "usd", metadata: {} } }),
    });
    await expect(processor.chargeInvoiceRef("pi_ours")).resolves.toBe("inv_1");
    await expect(processor.chargeInvoiceRef("pi_link")).resolves.toBeUndefined();
    await expect(processor.chargeInvoiceRef("pi_gone")).resolves.toBeUndefined(); // The fake answers 404.
  });

  it("cancels a declined PaymentIntent, and reports one that succeeded first", async () => {
    const cancelled = processorAt(T, { "POST /v1/payment_intents/pi_b/cancel": () => ({ body: { id: "pi_b", status: "canceled", amount: 500, amount_received: 0, currency: "usd" } }) });
    expect(await cancelled.processor.cancelCharge("pi_b")).toBe("failed");
    expect(cancelled.requests[0]!.headers["Idempotency-Key"]).toBe("educateos:cancel-charge:pi_b");
    const succeeded = processorAt(T, { "POST /v1/payment_intents/pi_a/cancel": () => ({ status: 400, body: { error: { code: "payment_intent_unexpected_state",
      payment_intent: { id: "pi_a", status: "succeeded", amount: 500, amount_received: 500, currency: "usd" } } } }) });
    expect(await succeeded.processor.cancelCharge("pi_a")).toBe("succeeded");
  });

  it("refuses to charge without a default payment method, and reports Stripe errors by status only", async () => {
    const noMethod = processorAt(T, { "GET /v1/customers/cus_nf": () => ({ body: { id: "cus_nf", invoice_settings: { default_payment_method: null } } }) });
    await expect(noMethod.processor.charge({ customerRef: "cus_nf", amountCents: 1, idempotencyKey: "k", invoiceRef: "inv_1" })).rejects.toMatchObject({ code: "policy-violation" });
    expect(noMethod.requests).toHaveLength(1);

    const failing = processorAt(T, { "POST /v1/refunds": () => ({ status: 400, body: { error: { message: "No such payment_intent: 'pi_secret_detail'" } } }) });
    const error = await failing.processor.refund({ chargeRef: "pi_x", amountCents: 1, idempotencyKey: "k" }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "unavailable", message: "the payment processor refused the request (HTTP 400)" });
  });

  it("turns an unreachable Stripe into `unavailable`", async () => {
    const processor = new StripePaymentProcessor({ apiKey: "rk", webhookSecret: SECRET, fetch: () => Promise.reject(new TypeError("fetch failed")) });
    await expect(processor.createCustomer(accountId)).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("Stripe card setup (SCHO-208)", () => {
  const session = (overrides: Record<string, unknown> = {}) => ({
    id: "cs_test_nf",
    object: "checkout.session",
    mode: "setup",
    status: "complete",
    customer: "cus_nf",
    metadata: { educateos_reference: "sbn_1" },
    setup_intent: { id: "seti_nf", object: "setup_intent", status: "succeeded", payment_method: "pm_saved" },
    ...overrides,
  });

  it("opens Checkout in setup mode for cards, naming the session in the return URL, idempotently", async () => {
    const { processor, requests } = processorAt(T, {
      "POST /v1/checkout/sessions": () => ({ body: { id: "cs_test_nf", object: "checkout.session", url: "https://checkout.stripe.com/c/pay/cs_test_nf" } }),
    });
    await expect(processor.startCardSetup({
      customerRef: "cus_nf",
      returnUrl: "https://educateos.io/app/billing/return?subscription=sbn_1&setup={SETUP_REF}",
      cancelUrl: "https://educateos.io/app/billing",
      idempotencyKey: "sbn_1:0",
      reference: "sbn_1",
    })).resolves.toEqual({ setupRef: "cs_test_nf", url: "https://checkout.stripe.com/c/pay/cs_test_nf" });
    const [request] = requests;
    expect(Object.fromEntries(request!.body!)).toEqual({
      "mode": "setup",
      "customer": "cus_nf",
      "payment_method_types[0]": "card",
      "success_url": "https://educateos.io/app/billing/return?subscription=sbn_1&setup={CHECKOUT_SESSION_ID}",
      "cancel_url": "https://educateos.io/app/billing",
      "metadata[educateos_reference]": "sbn_1",
    });
    expect(request!.headers["Idempotency-Key"]).toBe("educateos:card-setup:sbn_1:0");
  });

  it("makes the saved card the customer's default once the session is complete", async () => {
    const { processor, requests } = processorAt(T, {
      "GET /v1/checkout/sessions/cs_test_nf": () => ({ body: session() }),
      "POST /v1/customers/cus_nf": () => ({ body: { id: "cus_nf", object: "customer" } }),
    });
    await expect(processor.completeCardSetup("cus_nf", "cs_test_nf", "sbn_1")).resolves.toBe(true);
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      "GET https://api.stripe.com/v1/checkout/sessions/cs_test_nf?expand%5B%5D=setup_intent",
      "POST https://api.stripe.com/v1/customers/cus_nf",
    ]);
    expect(Object.fromEntries(requests[1]!.body!)).toEqual({ "invoice_settings[default_payment_method]": "pm_saved" });
    expect(requests[1]!.headers["Idempotency-Key"]).toBe("educateos:default-payment-method:cs_test_nf");
  });

  for (const [what, overrides] of [
    ["an open session", { status: "open", setup_intent: { status: "requires_payment_method", payment_method: null } }],
    ["a session whose SetupIntent hasn't succeeded", { setup_intent: { status: "requires_action", payment_method: "pm_saved" } }],
  ] as const) {
    it(`saves nothing for ${what}`, async () => {
      const { processor, requests } = processorAt(T, { "GET /v1/checkout/sessions/cs_test_nf": () => ({ body: session(overrides) }) });
      await expect(processor.completeCardSetup("cus_nf", "cs_test_nf", "sbn_1")).resolves.toBe(false);
      expect(requests).toHaveLength(1);
    });
  }

  for (const [what, overrides] of [
    ["another customer's session", { customer: "cus_other" }],
    ["a payment-mode session", { mode: "payment" }],
    ["a session made for another subscription", { metadata: { educateos_reference: "sbn_earlier" } }],
    ["a session with no reference", { metadata: {} }],
  ] as const) {
    it(`refuses ${what} as not found`, async () => {
      const { processor, requests } = processorAt(T, { "GET /v1/checkout/sessions/cs_test_nf": () => ({ body: session(overrides) }) });
      await expect(processor.completeCardSetup("cus_nf", "cs_test_nf", "sbn_1")).rejects.toMatchObject({ code: "not-found" });
      expect(requests).toHaveLength(1);
    });
  }

  it("opens the Customer Portal for the customer, with the configured portal configuration", async () => {
    const stripe = fakeStripe({ "POST /v1/billing_portal/sessions": () => ({ body: { id: "bps_1", url: "https://billing.stripe.com/p/session/test_1" } }) });
    const processor = new StripePaymentProcessor({ apiKey: "rk_test_fixture", webhookSecret: SECRET, portalConfiguration: "bpc_educateos", fetch: stripe.fetch });
    await expect(processor.openPaymentMethodPortal("cus_nf", "https://educateos.io/app/billing")).resolves.toBe("https://billing.stripe.com/p/session/test_1");
    expect(Object.fromEntries(stripe.requests[0]!.body!)).toEqual({
      customer: "cus_nf",
      return_url: "https://educateos.io/app/billing",
      configuration: "bpc_educateos",
    });
  });
});

describe("Stripe through the commerce service", () => {
  it("pays an invoice from a signed webhook, and counts a refund Stripe reports twice only once", async () => {
    const clock = manualClock(new Date(T * 1000).toISOString());
    const now = () => Math.floor(clock.now().getTime() / 1000);
    const { fetch } = fakeStripe({
      "POST /v1/customers": () => ({ body: { id: "cus_nf" } }),
      "GET /v1/customers/cus_nf": () => ({ body: { id: "cus_nf", invoice_settings: { default_payment_method: "pm_card" } } }),
      "GET /v1/payment_intents": () => ({ body: { data: [], has_more: false } }),
      "POST /v1/payment_intents": () => ({ body: { id: "pi_nf", status: "processing", amount: 40_000, amount_received: 0, currency: "usd" } }),
      "POST /v1/refunds": () => ({ body: { id: "re_nf" } }),
    });
    const processor = new StripePaymentProcessor({ apiKey: "rk", webhookSecret: SECRET, fetch, now: clock.now });
    const service = new CommerceService({ store: new InMemoryCommerceStore(), processor, plans: PLANS, entitlementSigner: await SigningIdentity.generate(), now: clock.now });
    const { accountId } = idsFor(NORTHFIELD);
    await service.openAccount({ accountId, districtLabel: NORTHFIELD.district.name }, CLERK);
    await service.ensureProcessorCustomer(accountId, CLERK);
    const invoice = await service.issueInvoice(
      { accountId, lines: [{ kind: "support", code: "onboarding", quantity: 1, unitAmountCents: 40_000 }], dueAt: new Date(clock.now().getTime() + 30 * DAY).toISOString() },
      CLERK,
    );
    expect(await service.chargeInvoice(invoice.invoiceId, CLERK)).toBe("pi_nf");

    const deliver = async (id: string, type: string, object: Record<string, unknown>) => {
      const payload = eventPayload(id, type, object, now());
      return service.handleProcessorDelivery({ payload, signature: await stripeSignature(payload, now()) });
    };
    await expect(deliver("evt_paid", "payment_intent.succeeded", { id: "pi_nf", amount: 40_000, amount_received: 40_000, currency: "usd" }))
      .resolves.toEqual({ outcome: "applied", eventId: "evt_paid" });
    expect((await service.invoice(invoice.invoiceId)).status).toBe("paid");

    const [charge] = await service.payments(accountId);
    await service.refundPayment(charge!.paymentId, 10_000, CLERK);
    const refund = { id: "re_nf", amount: 10_000, currency: "usd", status: "succeeded" };
    expect(await deliver("evt_refund_created", "refund.created", refund)).toMatchObject({ outcome: "applied" });
    expect(await deliver("evt_refund_updated", "refund.updated", refund)).toMatchObject({ outcome: "duplicate" });
    expect((await service.payments(accountId)).map((p) => [p.kind, p.amountCents])).toEqual([["charge", 40_000], ["refund", 10_000]]);
    expect((await service.reconciliationReport(accountId)).balanced).toBe(true);
  });
});
