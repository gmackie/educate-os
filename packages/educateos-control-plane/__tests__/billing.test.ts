// Billing on educateos.io (SCHO-208) in workerd, end to end through the site Worker: an operator
// subscribes, saves a card on Stripe's setup page, comes back to an active subscription whose first
// invoice is charged, Stripe's signed webhook pays it, and the operator cancels. The real Stripe
// adapter runs against the fake Stripe the test Worker's outbound service answers with.
import { env, SELF } from "cloudflare:test";
import { importJWK, SignJWT, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { MANAGED_PLANS, PLACEHOLDER_PRICE_NOTE } from "../src/billing.ts";
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

async function webhook(payload: string, secret = env.STRIPE_WEBHOOK_SECRET!): Promise<Response> {
  const timestamp = Math.floor(Date.now() / 1000);
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

async function chargesFor(): Promise<{ id: string; amount: number }[]> {
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
  it("runs subscribe, card setup, first invoice, webhook payment and cancellation", async () => {
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

    const active = await (await get("/app/billing?card=saved", token)).text();
    expect(active).toContain("Your card is saved");
    expect(active).toContain(">Active<");
    expect(active).toContain("$1.00");
    expect(active.match(/<span class="status planned">Open<\/span>/g)).toHaveLength(1);

    const charges = (await chargesFor()).filter((charge) => charge.amount === MANAGED_PLANS[0]!.plan.termFeeCents);
    const charge = charges.at(-1)!;
    const first = await webhook(succeeded(`evt_paid_${charge.id}`, charge));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ outcome: "applied" });
    expect(await (await webhook(succeeded(`evt_paid_${charge.id}`, charge))).json()).toEqual({ outcome: "duplicate" });
    expect(await (await get("/app/billing", token)).text()).toContain('<span class="status avail">Paid</span>');

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

describe("the Stripe webhook", () => {
  it("is outside the console's sign-in, and accepts only POSTs signed with the endpoint's secret", async () => {
    expect((await SELF.fetch(`${ORIGIN}/stripe/webhook`)).status).toBe(405);
    const payload = succeeded("evt_forged", { id: "pi_forged", amount: 100 });
    expect((await SELF.fetch(`${ORIGIN}/stripe/webhook`, { method: "POST", body: payload })).status).toBe(400);
    expect((await webhook(payload, "whsec_someone_else")).status).toBe(400);
  });

  it("answers a charge commerce never made as unmatched, so Stripe stops redelivering it", async () => {
    const response = await webhook(succeeded("evt_stranger", { id: "pi_not_ours", amount: 100 }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "unmatched" });
  });

  it("ignores event types billing doesn't act on", async () => {
    const payload = JSON.stringify({ id: "evt_other", object: "event", type: "customer.updated", created: Math.floor(Date.now() / 1000), data: { object: {} } });
    expect(await (await webhook(payload)).json()).toEqual({ outcome: "ignored" });
  });
});

// The address Stripe sends the operator back to, as the session was created with it, relative to
// the console.
async function returnAddress(checkoutUrl: string): Promise<string> {
  const session = /\/c\/pay\/(cs_test_[a-z0-9]+)$/.exec(checkoutUrl)![1]!;
  const { returnUrl }: { returnUrl: string } = await (await fetch(`https://api.stripe.com/test/checkout/${session}`)).json();
  expect(returnUrl.startsWith(`${ORIGIN}/app/billing/return?subscription=sbn_`)).toBe(true);
  return returnUrl.slice(ORIGIN.length);
}
