// A stand-in for the parts of Stripe's API billing calls (SCHO-208), answering as the documented
// endpoints do. It runs as the test Worker's outbound service, so the real Stripe adapter is driven
// through workerd's own fetch. A suite plays the customer through two test-only routes on the same
// host: `GET /test/checkout/<session>` gives the address Stripe would send the customer back to,
// `POST /test/checkout/<session>/complete` saves a card on that setup page, and
// `GET /test/payment_intents` lists the charges made, so the suite can sign their webhooks.
// `POST /test/next-charge/<mode>` sets how the next charge request goes: `unreachable` fails it
// before anything is made; `decline` makes a declined PaymentIntent, answered 402 as Stripe does;
// `lose-reply` makes a `processing` PaymentIntent and then answers 500, as a lost reply would.
// Charges otherwise succeed at once, as Stripe's 4242 test card does.

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
interface Intent {
  id: string;
  customer: string;
  amount: number;
  paymentMethod: string;
  status: "succeeded" | "processing" | "requires_payment_method" | "canceled";
  invoice: string;
  idempotencyKey: string;
}
const intents: Intent[] = [];
const byIdempotencyKey = new Map<string, Intent>();
let counter = 0;
let nextCharge: "unreachable" | "decline" | "lose-reply" | undefined;
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
  if (request.method === "POST" && (match = /^\/test\/next-charge\/(unreachable|decline|lose-reply)$/.exec(path)) !== null) {
    nextCharge = match[1] as typeof nextCharge;
    return Response.json({ armed: nextCharge });
  }
  if (request.method === "GET" && path === "/v1/payment_intents") {
    const customer = url.searchParams.get("customer");
    return Response.json({ object: "list", data: intents.filter((intent) => intent.customer === customer).toReversed().map(wire) });
  }
  if (request.method === "POST" && (match = /^\/v1\/payment_intents\/(pi_[a-z0-9]+)\/cancel$/.exec(path)) !== null) {
    const intent = intents.find((candidate) => candidate.id === match![1]);
    if (intent === undefined) return error(404, "No such payment_intent");
    if (intent.status === "succeeded" || intent.status === "canceled") {
      return Response.json({ error: { code: "payment_intent_unexpected_state", payment_intent: wire(intent) } }, { status: 400 });
    }
    intent.status = "canceled";
    return Response.json(wire(intent));
  }
  if (request.method === "POST" && path === "/v1/payment_intents") {
    const key = request.headers.get("idempotency-key") ?? "";
    const replayed = byIdempotencyKey.get(key);
    if (replayed !== undefined) return Response.json(wire(replayed));
    const mode = nextCharge;
    nextCharge = undefined;
    if (mode === "unreachable") return error(500, "An unknown error occurred");
    const customer = customers.get(form.get("customer") ?? "");
    const paymentMethod = form.get("payment_method") ?? "";
    if (customer === undefined || customer.defaultPaymentMethod !== paymentMethod || form.get("off_session") !== "true") {
      return error(400, "unexpected charge");
    }
    const intent: Intent = {
      id: next("pi"), customer: form.get("customer")!, amount: Number(form.get("amount")), paymentMethod,
      status: mode === "decline" ? "requires_payment_method" : mode === "lose-reply" ? "processing" : "succeeded",
      invoice: form.get("metadata[educateos_invoice]") ?? "", idempotencyKey: key,
    };
    intents.push(intent);
    byIdempotencyKey.set(key, intent);
    if (mode === "lose-reply") return error(500, "An unknown error occurred");
    if (mode === "decline") return Response.json({ error: { type: "card_error", code: "card_declined", payment_intent: wire(intent) } }, { status: 402 });
    return Response.json(wire(intent));
  }
  if (request.method === "GET" && path === "/test/payment_intents") return Response.json(intents);
  if (request.method === "POST" && (match = /^\/test\/payment_intents\/(pi_[a-z0-9]+)\/succeed$/.exec(path)) !== null) {
    const intent = intents.find((candidate) => candidate.id === match![1]);
    if (intent === undefined) return error(404, "No such payment_intent");
    intent.status = "succeeded";
    return Response.json(wire(intent));
  }
  if (request.method === "POST" && path === "/v1/billing_portal/sessions") {
    const customer = form.get("customer") ?? "";
    if (!customers.has(customer) || !form.get("return_url")) return error(400, "unexpected portal request");
    return Response.json({ id: next("bps"), object: "billing_portal.session", url: `https://billing.stripe.com/p/session/test_${customer}` });
  }
  return error(404, `no fake for ${request.method} ${path}`);
}

function wire(intent: Intent) {
  return {
    id: intent.id, object: "payment_intent", status: intent.status, amount: intent.amount,
    amount_received: intent.status === "succeeded" ? intent.amount : 0, currency: "usd", customer: intent.customer,
    metadata: { educateos_invoice: intent.invoice },
  };
}
