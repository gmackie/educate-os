// Billing on educateos.io (SCHO-208) in workerd, end to end through the site Worker: an operator
// subscribes, saves a card on Stripe's setup page, comes back to an active subscription whose first
// invoice is charged, Stripe's signed webhook pays it, and the operator cancels. The real Stripe
// adapter runs against the fake Stripe the test Worker's outbound service answers with.
import { env, SELF } from "cloudflare:test";
import { importJWK, SignJWT, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { handleRequest } from "../src/app.ts";
import { MANAGED_PLANS, PLACEHOLDER_PRICE_NOTE, UNCONFIGURED_BILLING_REPLY } from "../src/billing.ts";
import { configuredBilling } from "../src/worker.ts";
import { ACCESS_AUD, ACCESS_ISSUER } from "./fixtures.ts";

const ORIGIN = "https://educateos.io";

let people = 0;

async function signIn(): Promise<string> {
  return new SignJWT({ sub: `billing-operator-${people++}`, email: "operator@example.org" })
    .setProtectedHeader({ alg: "RS256", kid: "test-access-key" })
    .setIssuer(ACCESS_ISSUER)
    .setAudience(ACCESS_AUD)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(await importJWK(JSON.parse(env.TEST_ACCESS_PRIVATE_JWK) as JWK, "RS256"));
}

async function get(path: string, token: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, { headers: { "cf-access-jwt-assertion": token }, redirect: "manual" });
}

async function post(path: string, token: string, fields: Record<string, string> = {}, origin = ORIGIN): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "cf-access-jwt-assertion": token, origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  });
}

/** Plays the customer on Stripe's setup page: saves a card. */
async function saveCard(checkoutUrl: string): Promise<string> {
  const session = /\/c\/pay\/(cs_test_[a-z0-9]+)$/.exec(checkoutUrl)![1]!;
  expect((await fetch(`https://api.stripe.com/test/checkout/${session}/complete`, { method: "POST" })).status).toBe(200);
  return session;
}

async function webhook(payload: string, secret = env.STRIPE_WEBHOOK_SECRET!, timestamp = Math.floor(Date.now() / 1000)): Promise<Response> {
  const hmac = { name: "HMAC", hash: "SHA-256" } as const;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), hmac, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign(hmac, key, new TextEncoder().encode(`${timestamp}.${payload}`)));
  const signature = `t=${timestamp},v1=${[...mac].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  return SELF.fetch(`${ORIGIN}/stripe/webhook`, { method: "POST", headers: { "stripe-signature": signature }, body: payload });
}

function succeeded(eventId: string, intent: { id: string; amount: number }): string {
  return JSON.stringify({
    id: eventId, object: "event", type: "payment_intent.succeeded", created: Math.floor(Date.now() / 1000),
    data: { object: { id: intent.id, object: "payment_intent", amount: intent.amount, amount_received: intent.amount, currency: "usd" } },
  });
}

interface FakeIntent { id: string; amount: number; status: string; invoice: string; idempotencyKey: string }

async function chargesFor(): Promise<FakeIntent[]> {
  return await (await fetch("https://api.stripe.com/test/payment_intents")).json();
}

/** Subscribes a new operator to a plan and returns where it sent them, with their token. */
async function subscribed(planId = MANAGED_PLANS[0]!.plan.planId) {
  const token = await signIn();
  const response = await post("/app/billing/subscribe", token, { plan: planId, organization: "Riverbend <USD>" });
  expect(response.status).toBe(303);
  return { token, checkout: response.headers.get("location")! };
}

describe("the billing page", () => {
  it("offers the managed services plans, every price marked as a placeholder, with Stripe admitted as a form target", async () => {
    const response = await get("/app/billing", await signIn());
    expect(response.status).toBe(200);
    const page = await response.text();
    for (const { name, plan } of MANAGED_PLANS) {
      expect(page).toContain(name);
      expect(page).toContain(`value="${plan.planId}"`);
    }
    // Escaped as every page value is.
    expect(page.split(PLACEHOLDER_PRICE_NOTE.replaceAll("'", "&#39;"))).toHaveLength(MANAGED_PLANS.length + 1);
    expect(response.headers.get("content-security-policy")).toContain("form-action 'self' https://checkout.stripe.com https://billing.stripe.com");
  });

  it("is linked from the dashboard, and the dashboard keeps its own stricter policy", async () => {
    const response = await get("/app/", await signIn());
    expect(await response.text()).toContain('href="/app/billing"');
    expect(response.headers.get("content-security-policy")).toContain("form-action 'self';");
  });
});

describe("subscribing", () => {
  it("runs subscribe, card setup, first invoice paid at once, its webhook, the portal and cancellation", async () => {
    const { token, checkout } = await subscribed();
    expect(checkout).toMatch(/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/);

    const waiting = await (await get("/app/billing", token)).text();
    expect(waiting).toContain("Waiting for a card");
    expect(waiting).toContain("Riverbend &lt;USD&gt;");
    // Coming back before saving a card leaves it waiting.
    const returnUrl = await returnAddress(checkout);
    expect((await get(returnUrl, token)).headers.get("location")).toBe("/app/billing?card=pending");

    await saveCard(checkout);
    const back = await get(returnUrl, token);
    expect(back.status).toBe(303);
    expect(back.headers.get("location")).toBe("/app/billing?card=saved");
    // Coming back again charges nothing more.
    await get(returnUrl, token);

    // Stripe answered the charge as succeeded, as it does for the 4242 test card: the invoice is
    // paid from that reply, and the webhook that follows changes nothing.
    const active = await (await get("/app/billing?card=saved", token)).text();
    expect(active).toContain("Your card is saved");
    expect(active).toContain(">Active<");
    expect(active).toContain("$1.00");
    expect(active).toContain('<span class="status avail">Paid</span>');
    const charge = (await chargesFor()).at(-1)!;
    expect(charge).toMatchObject({ amount: MANAGED_PLANS[0]!.plan.termFeeCents, status: "succeeded" });
    const hook = await webhook(succeeded(`evt_paid_${charge.id}`, charge));
    expect(hook.status).toBe(200);
    expect(await hook.json()).toEqual({ outcome: "duplicate" });

    const portal = await post("/app/billing/portal", token);
    expect(portal.status).toBe(303);
    expect(portal.headers.get("location")).toMatch(/^https:\/\/billing\.stripe\.com\/p\/session\/test_cus_/);

    // Subscribing again while one runs is refused.
    expect((await post("/app/billing/subscribe", token, { plan: MANAGED_PLANS[1]!.plan.planId, organization: "Riverbend" })).status).toBe(409);

    const cancelled = await post("/app/billing/cancel", token);
    expect(cancelled.headers.get("location")).toBe("/app/billing?card=cancelled");
    const after = await (await get("/app/billing?card=cancelled", token)).text();
    expect(after).toContain("Your subscription is cancelled");
    expect(after).toContain("Continue to add a card");
  });

  it("reopens Stripe's setup page for a subscription left waiting for a card", async () => {
    const { token } = await subscribed();
    const resumed = await post("/app/billing/card", token);
    expect(resumed.status).toBe(303);
    expect(resumed.headers.get("location")).toMatch(/^https:\/\/checkout\.stripe\.com\/c\/pay\//);
  });

  it("refuses an unknown plan, a missing organization, and a post from another site", async () => {
    const token = await signIn();
    expect((await post("/app/billing/subscribe", token, { plan: "pln_free-lunch", organization: "Riverbend" })).status).toBe(400);
    expect((await post("/app/billing/subscribe", token, { plan: MANAGED_PLANS[0]!.plan.planId, organization: " " })).status).toBe(400);
    expect((await post("/app/billing/subscribe", token, { plan: MANAGED_PLANS[0]!.plan.planId, organization: "x" }, "https://evil.example")).status).toBe(403);
    expect((await post("/app/billing/cancel", token)).status).toBe(404);
    expect((await post("/app/billing/portal", token)).status).toBe(409);
  });

  it("won't finish another operator's setup", async () => {
    const owner = await subscribed();
    await saveCard(owner.checkout);
    const returnUrl = await returnAddress(owner.checkout);
    const stranger = await signIn();
    expect((await get(returnUrl, stranger)).status).toBe(404);
    const malformed = returnUrl.replace(/setup=[^&]+/, "setup=%3Cscript%3E");
    expect((await get(malformed, owner.token)).status).toBe(400);
  });
});

describe("charging the first invoice", () => {
  it("leaves the invoice uncharged when Stripe can't be reached, and charges it on the next return", async () => {
    const { token, checkout } = await subscribed();
    await saveCard(checkout);
    const returnUrl = await returnAddress(checkout);
    const before = (await chargesFor()).length;
    await nextCharge("unreachable");
    expect((await get(returnUrl, token)).headers.get("location")).toBe("/app/billing?card=uncharged");
    const page = await (await get("/app/billing?card=uncharged", token)).text();
    expect(page).toContain("couldn&#39;t be charged just now");
    expect(page).toContain("not charged yet");
    expect(page).toContain('action="/app/billing/pay"');
    expect(await chargesFor()).toHaveLength(before);

    expect((await get(returnUrl, token)).headers.get("location")).toBe("/app/billing?card=saved");
    expect(await chargesFor()).toHaveLength(before + 1);
    // And a further return charges nothing more.
    await get(returnUrl, token);
    expect(await chargesFor()).toHaveLength(before + 1);
  });

  it("pays the invoice from the webhook alone when a succeeded charge's reply was lost", async () => {
    const { token, checkout } = await subscribed();
    await saveCard(checkout);
    const returnUrl = await returnAddress(checkout);
    const before = (await chargesFor()).length;
    await nextCharge("lose-reply");
    expect((await get(returnUrl, token)).headers.get("location")).toBe("/app/billing?card=uncharged");
    const charges = await chargesFor();
    expect(charges).toHaveLength(before + 1);
    const lost = charges.at(-1)!;
    expect(lost.status).toBe("processing");

    // Stripe finishes the charge and sends its webhook. Nobody returns or pays: the webhook finds
    // the PaymentIntent's invoice, reconciles it, and the invoice is paid with a 200.
    await succeed(lost.id);
    const event = succeeded(`evt_lost_${lost.id}`, lost);
    const hook = await webhook(event);
    expect(hook.status).toBe(200);
    expect(await hook.json()).toEqual({ outcome: "duplicate" }); // Reconciling recorded the success.
    const page = await (await get("/app/billing", token)).text();
    expect(page).toContain('<span class="status avail">Paid</span>');
    expect(page).toContain(">Active<");

    // A return afterwards charges nothing more.
    expect((await get(returnUrl, token)).headers.get("location")).toBe("/app/billing?card=saved");
    expect(await chargesFor()).toHaveLength(before + 1);
  });

  it("applies the webhook of a lost charge still processing, after Pay now refused to charge again", async () => {
    const { token, checkout } = await subscribed();
    await saveCard(checkout);
    await nextCharge("lose-reply");
    await get(await returnAddress(checkout), token);
    const lost = (await chargesFor()).at(-1)!;

    // Pay now reconciles first: the charge is on its way, so it makes no other.
    const before = (await chargesFor()).length;
    expect((await post("/app/billing/pay", token)).status).toBe(409);
    expect(await chargesFor()).toHaveLength(before);
    expect(await (await get("/app/billing", token)).text()).toContain("charge on its way");

    const hook = await webhook(succeeded(`evt_processing_${lost.id}`, lost));
    expect(hook.status).toBe(200);
    expect(await hook.json()).toEqual({ outcome: "applied" });
    expect(await (await get("/app/billing", token)).text()).toContain('<span class="status avail">Paid</span>');
  });

  it("asks Stripe to redeliver an event for one of its invoices that reconciling can't match yet", async () => {
    const { token, checkout } = await subscribed();
    await saveCard(checkout);
    await nextCharge("unreachable");
    await get(await returnAddress(checkout), token);
    const invoiceId = /<code>(inv_[a-z0-9-]+)<\/code>/.exec(await (await get("/app/billing", token)).text())![1]!;
    // A PaymentIntent naming this invoice that its customer's charges don't include.
    const stray: FakeIntent = await (await fetch("https://api.stripe.com/test/payment_intents", {
      method: "POST", body: new URLSearchParams({ customer: "cus_elsewhere", invoice: invoiceId }),
    })).json();
    const hook = await webhook(succeeded(`evt_stray_${stray.id}`, stray));
    expect(hook.status).toBe(503);
    expect(await hook.json()).toEqual({ outcome: "unmatched" });
  });

  it("retries a declined charge with Pay now as a new attempt, cancelling the declined one first", async () => {
    const { token, checkout } = await subscribed();
    await saveCard(checkout);
    const returnUrl = await returnAddress(checkout);
    await nextCharge("decline");
    expect((await get(returnUrl, token)).headers.get("location")).toBe("/app/billing?card=declined");
    const page = await (await get("/app/billing?card=declined", token)).text();
    expect(page).toContain("Your card was declined");
    expect(page).toContain("Payment due");
    expect(page).toContain('<span class="badge warn">Declined</span>');
    // Reloading the old return address says what is true now: a payment is due.
    expect((await get(returnUrl, token)).headers.get("location")).toBe("/app/billing?card=due");

    const declined = (await chargesFor()).at(-1)!;
    const paid = await post("/app/billing/pay", token);
    expect(paid.headers.get("location")).toBe("/app/billing?card=saved");
    const charges = await chargesFor();
    const retry = charges.at(-1)!;
    expect(retry.id).not.toBe(declined.id);
    expect(retry.idempotencyKey).not.toBe(declined.idempotencyKey);
    expect(retry.status).toBe("succeeded");
    expect(charges.find((charge) => charge.id === declined.id)!.status).toBe("canceled");
    const after = await (await get("/app/billing", token)).text();
    expect(after).toContain('<span class="status avail">Paid</span>');
    expect(after).toContain(">Active<");
    expect((await post("/app/billing/pay", token)).status).toBe(404);
  });

  it("won't let a setup page from an earlier subscription start a later one", async () => {
    const first = await subscribed();
    await saveCard(first.checkout);
    const oldReturn = await returnAddress(first.checkout);
    await get(oldReturn, first.token);
    await post("/app/billing/cancel", first.token);
    const again = await post("/app/billing/subscribe", first.token, { plan: MANAGED_PLANS[1]!.plan.planId, organization: "Riverbend" });
    const later = new URL(await returnAddress(again.headers.get("location")!), ORIGIN).searchParams.get("subscription")!;
    const before = (await chargesFor()).length;
    const reused = oldReturn.replace(/subscription=[^&]+/, `subscription=${later}`);
    expect((await get(reused, first.token)).status).toBe(404);
    expect(await chargesFor()).toHaveLength(before);
    expect(await (await get("/app/billing", first.token)).text()).toContain("Waiting for a card");
  });
});

describe("the Stripe webhook", () => {
  it("refuses a delivery signed more than five minutes ago", async () => {
    const payload = succeeded("evt_stale", { id: "pi_stale", amount: 100 });
    expect((await webhook(payload, env.STRIPE_WEBHOOK_SECRET!, Math.floor(Date.now() / 1000) - 600)).status).toBe(400);
  });

  it("refuses a delivery larger than its cap without reading it all", async () => {
    const response = await SELF.fetch(`${ORIGIN}/stripe/webhook`, {
      method: "POST", headers: { "stripe-signature": "t=1,v1=" + "0".repeat(64) }, body: "x".repeat(300 * 1024),
    });
    expect(response.status).toBe(413);
  });

  it("is outside the console's sign-in, and accepts only POSTs signed with the endpoint's secret", async () => {
    expect((await SELF.fetch(`${ORIGIN}/stripe/webhook`)).status).toBe(405);
    const payload = succeeded("evt_forged", { id: "pi_forged", amount: 100 });
    expect((await SELF.fetch(`${ORIGIN}/stripe/webhook`, { method: "POST", body: payload })).status).toBe(400);
    expect((await webhook(payload, "whsec_someone_else")).status).toBe(400);
  });

  it("answers 200 unmatched for what EducateOS will never record, so Stripe doesn't retry it for days", async () => {
    // A PaymentIntent Stripe doesn't know, one that names no invoice (a Payment Link, the
    // Dashboard), one naming an invoice this store doesn't hold, and a refund made outside billing.
    const link: FakeIntent = await (await fetch("https://api.stripe.com/test/payment_intents", { method: "POST", body: new URLSearchParams({}) })).json();
    const other: FakeIntent = await (await fetch("https://api.stripe.com/test/payment_intents", {
      method: "POST", body: new URLSearchParams({ invoice: "inv_from-a-preview-deploy" }),
    })).json();
    const refund = JSON.stringify({
      id: "evt_dashboard_refund", object: "event", type: "refund.updated", created: Math.floor(Date.now() / 1000),
      data: { object: { id: "re_dashboard", object: "refund", amount: 100, currency: "usd", status: "succeeded" } },
    });
    for (const payload of [
      succeeded("evt_stranger", { id: "pi_not_ours", amount: 100 }),
      succeeded(`evt_link_${link.id}`, link),
      succeeded(`evt_other_${other.id}`, other),
      refund,
    ]) {
      const response = await webhook(payload);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ outcome: "unmatched" });
    }
  });

  it("ignores event types billing doesn't act on", async () => {
    const payload = JSON.stringify({ id: "evt_other", object: "event", type: "customer.updated", created: Math.floor(Date.now() / 1000), data: { object: {} } });
    expect(await (await webhook(payload)).json()).toEqual({ outcome: "ignored" });
  });
});

describe("a deploy without billing's secrets", () => {
  it("builds no billing unless every secret is set", async () => {
    const storage = {} as DurableObjectStorage; // Never reached: a missing secret returns first.
    const all = { STRIPE_SECRET_KEY: "sk", STRIPE_WEBHOOK_SECRET: "whsec", COMMERCE_SIGNING_KEY: env.COMMERCE_SIGNING_KEY };
    for (const missing of Object.keys(all)) {
      await expect(configuredBilling(storage, { ...env, ...all, [missing]: undefined })).resolves.toBeUndefined();
    }
    await expect(configuredBilling(storage, { ...env, ...all, COMMERCE_SIGNING_KEY: "{not a key" })).resolves.toBeUndefined();
  });

  it("answers the billing page and the webhook with 503, and leaves the rest of the console alone", async () => {
    const operator = { subject: "s", accountId: "acct_" + "0".repeat(32), email: "operator@example.org", firstSeenAt: "", lastSeenAt: "" };
    const unconfigured = async () => UNCONFIGURED_BILLING_REPLY;
    const store = {
      signIn: () => operator, ping: () => true as const, installations: () => [], dashboard: async () => [],
      billingOverview: unconfigured, subscribe: unconfigured, resumeCardSetup: unconfigured, completeCardSetup: unconfigured,
      payInvoice: unconfigured, paymentMethodPortal: unconfigured, cancelSubscription: unconfigured, receiveStripeWebhook: unconfigured,
    } as unknown as Parameters<typeof handleRequest>[1]["store"] extends () => infer S ? S : never;
    const deps = {
      shell: { header: "", footer: "" },
      verifyOperator: async () => ({ issuer: ACCESS_ISSUER, subject: "s", email: "operator@example.org" }),
      store: () => store,
      assets: async () => new Response("static"),
    };
    const page = await handleRequest(new Request(`${ORIGIN}/app/billing`), deps);
    expect(page.status).toBe(503);
    expect(await page.text()).toContain("Billing is unavailable");
    const hook = await handleRequest(new Request(`${ORIGIN}/stripe/webhook`, { method: "POST", headers: { "stripe-signature": "t=1,v1=x" }, body: "{}" }), deps);
    expect(hook.status).toBe(503);
    expect((await handleRequest(new Request(`${ORIGIN}/app/`), deps)).status).toBe(200);
  });
});

async function nextCharge(mode: "unreachable" | "decline" | "lose-reply"): Promise<void> {
  expect((await fetch(`https://api.stripe.com/test/next-charge/${mode}`, { method: "POST" })).status).toBe(200);
}

/** Has Stripe finish a processing charge. */
async function succeed(intentId: string): Promise<void> {
  expect((await fetch(`https://api.stripe.com/test/payment_intents/${intentId}/succeed`, { method: "POST" })).status).toBe(200);
}

// The address Stripe sends the operator back to, as the session was created with it, relative to
// the console.
async function returnAddress(checkoutUrl: string): Promise<string> {
  const session = /\/c\/pay\/(cs_test_[a-z0-9]+)$/.exec(checkoutUrl)![1]!;
  const { returnUrl }: { returnUrl: string } = await (await fetch(`https://api.stripe.com/test/checkout/${session}`)).json();
  expect(returnUrl.startsWith(`${ORIGIN}/app/billing/return?subscription=sbn_`)).toBe(true);
  return returnUrl.slice(ORIGIN.length);
}
