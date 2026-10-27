// A stand-in for the parts of Stripe's API billing calls (SCHO-208), answering as the documented
// endpoints do. It runs as the test Worker's outbound service, so the real Stripe adapter is driven
// through workerd's own fetch. A suite plays the customer through two test-only routes on the same
// host: `GET /test/checkout/<session>` gives the address Stripe would send the customer back to,
// `POST /test/checkout/<session>/complete` saves a card on that setup page, and
// `GET /test/payment_intents` lists the charges made, so the suite can sign their webhooks, and
// `POST /test/fail-next-charge` makes the next charge request fail as an unreachable Stripe would.

/** The test Stripe secret key and webhook signing secret, as the suite's bindings carry them. */
export const STRIPE_FIXTURE = { secretKey: "sk_test_educateos_fixture", webhookSecret: "whsec_educateos_fixture_not_a_real_secret" };

interface Session {
  id: string;
  customer: string;
  status: "open" | "complete";
  returnUrl: string;
  reference: string;
  paymentMethod?: string;
}

const customers = new Map<string, { defaultPaymentMethod: string | null }>();
const sessions = new Map<string, Session>();
const intents: { id: string; customer: string; amount: number; paymentMethod: string }[] = [];
let counter = 0;
let failNextCharge = false;
const next = (prefix: string) => `${prefix}_fake${++counter}`;

const error = (status: number, message: string) => Response.json({ error: { message } }, { status });

/** Answers one request to api.stripe.com. */
export async function fakeStripe(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const form = new URLSearchParams(request.method === "POST" ? await request.text() : "");
  if (path.startsWith("/v1/") && request.headers.get("authorization") !== `Bearer ${STRIPE_FIXTURE.secretKey}`) {
    return error(401, "Invalid API Key provided");
  }
  let match: RegExpExecArray | null;

  if (request.method === "POST" && path === "/v1/customers") {
    const id = next("cus");
    customers.set(id, { defaultPaymentMethod: null });
    return Response.json({ id, object: "customer" });
  }
  if ((match = /^\/v1\/customers\/(cus_[a-z0-9]+)$/.exec(path)) !== null) {
    const customer = customers.get(match[1]!);
    if (customer === undefined) return error(404, "No such customer");
    const method = form.get("invoice_settings[default_payment_method]");
    if (request.method === "POST" && method !== null) customer.defaultPaymentMethod = method;
    return Response.json({ id: match[1], object: "customer", invoice_settings: { default_payment_method: customer.defaultPaymentMethod } });
  }
  if (request.method === "POST" && path === "/v1/checkout/sessions") {
    const customer = form.get("customer") ?? "";
    if (form.get("mode") !== "setup" || !customers.has(customer) || !form.get("success_url")?.includes("{CHECKOUT_SESSION_ID}")) {
      return error(400, "unexpected session request");
    }
    const id = next("cs_test");
    sessions.set(id, { id, customer, status: "open", reference: form.get("metadata[educateos_reference]") ?? "", returnUrl: form.get("success_url")!.replaceAll("{CHECKOUT_SESSION_ID}", id) });
    return Response.json({ id, object: "checkout.session", url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  if (request.method === "GET" && (match = /^\/v1\/checkout\/sessions\/(cs_test_[a-z0-9]+)$/.exec(path)) !== null) {
    const session = sessions.get(match[1]!);
    if (session === undefined) return error(404, "No such checkout.session");
    const setupIntent = url.searchParams.getAll("expand[]").includes("setup_intent")
      ? { id: `seti_${session.id}`, object: "setup_intent", status: session.paymentMethod ? "succeeded" : "requires_payment_method", payment_method: session.paymentMethod ?? null }
      : `seti_${session.id}`;
    return Response.json({ id: session.id, object: "checkout.session", mode: "setup", status: session.status, customer: session.customer, metadata: { educateos_reference: session.reference }, setup_intent: setupIntent });
  }
  if (request.method === "GET" && (match = /^\/test\/checkout\/(cs_test_[a-z0-9]+)$/.exec(path)) !== null) {
    const session = sessions.get(match[1]!);
    return session === undefined ? error(404, "No such checkout.session") : Response.json({ returnUrl: session.returnUrl });
  }
  if (request.method === "POST" && (match = /^\/test\/checkout\/(cs_test_[a-z0-9]+)\/complete$/.exec(path)) !== null) {
    const session = sessions.get(match[1]!);
    if (session === undefined) return error(404, "No such checkout.session");
    Object.assign(session, { status: "complete", paymentMethod: next("pm") });
    return Response.json({ completed: session.id });
  }
  if (request.method === "POST" && path === "/test/fail-next-charge") {
    failNextCharge = true;
    return Response.json({ armed: true });
  }
  if (request.method === "POST" && path === "/v1/payment_intents") {
    if (failNextCharge) {
      failNextCharge = false;
      return error(500, "An unknown error occurred");
    }
    const customer = customers.get(form.get("customer") ?? "");
    const paymentMethod = form.get("payment_method") ?? "";
    if (customer === undefined || customer.defaultPaymentMethod !== paymentMethod || form.get("off_session") !== "true") {
      return error(400, "unexpected charge");
    }
    const intent = { id: next("pi"), customer: form.get("customer")!, amount: Number(form.get("amount")), paymentMethod };
    intents.push(intent);
    return Response.json({ id: intent.id, object: "payment_intent", status: "succeeded" });
  }
  if (request.method === "GET" && path === "/test/payment_intents") return Response.json(intents);
  if (request.method === "POST" && path === "/v1/billing_portal/sessions") {
    const customer = form.get("customer") ?? "";
    if (!customers.has(customer) || !form.get("return_url")) return error(400, "unexpected portal request");
    return Response.json({ id: next("bps"), object: "billing_portal.session", url: `https://billing.stripe.com/p/session/test_${customer}` });
  }
  return error(404, `no fake for ${request.method} ${path}`);
}
