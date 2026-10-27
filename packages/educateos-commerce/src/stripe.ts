import { type CommercialAccountId, EducateOsError } from "@educateos/contracts";
import { parseWire } from "@educateos/fleet";
import { z } from "zod";
import { ProcessorRef } from "./ids.ts";
import { Cents } from "./money.ts";
import {
  type CardSetup,
  type CardSetupRequest,
  type ChargeRequest,
  type ChargeResult,
  type ChargeStatus,
  type PaymentProcessor,
  type ProcessorEvent,
  type RefundRequest,
  SETUP_REF_PLACEHOLDER,
} from "./processor.ts";

// The Stripe adapter for the payment processor port (SCHO-99). It speaks Stripe's REST API with
// `fetch` and no SDK, so it runs unchanged in a Worker. Charges are off-session PaymentIntents on
// the customer's default payment method; their outcomes, and refunds', arrive as webhooks, which
// are verified against the endpoint's signing secret before anything is read from them. Cards are
// saved through Checkout in setup mode, which charges nothing, and managed in the Customer Portal
// (SCHO-208): EducateOS keeps the subscriptions and invoices, Stripe only holds the card.

const API_BASE = "https://api.stripe.com";
/** The Stripe API version every request pins, so a dashboard upgrade can't change response shapes. */
export const STRIPE_API_VERSION = "2024-06-20";
/** How far a webhook's signed timestamp may be from the clock: Stripe's own default tolerance. */
export const STRIPE_WEBHOOK_TOLERANCE_MS = 5 * 60_000;

/**
 * What the root's webhook endpoint hands the adapter: the request body exactly as received (the
 * signature covers those bytes, so it must not be parsed and re-serialized first) and the value of
 * its `Stripe-Signature` header.
 */
export const StripeWebhookDelivery = z.strictObject({
  payload: z.string().max(1_000_000),
  signature: z.string().max(4_096),
});
/** A Stripe webhook delivery. */
export type StripeWebhookDelivery = z.infer<typeof StripeWebhookDelivery>;

/** What a {@link StripePaymentProcessor} needs. */
export interface StripePaymentProcessorOptions {
  /**
   * A Stripe secret key, ideally restricted to customers, PaymentIntents, refunds, SetupIntents,
   * Checkout Sessions and Customer Portal sessions.
   */
  apiKey: string;
  /** The webhook endpoint's signing secret (`whsec_…`). */
  webhookSecret: string;
  /** The Customer Portal configuration (`bpc_…`) to open. Defaults to the account's default configuration. */
  portalConfiguration?: string;
  /** Defaults to the global `fetch`. Tests pass a fake; the adapter makes no other network calls. */
  fetch?: typeof fetch;
  /** The clock webhook timestamps are checked against. Defaults to the system clock. */
  now?: () => Date;
}

// Stripe's objects carry many more fields than these and gain new ones without notice, so unlike
// EducateOS's own wire shapes they are read with `z.object`, which drops unknown fields instead of
// rejecting them. Only the fields named here are ever read.
const StripeId = z.object({ id: ProcessorRef });
const StripeCustomer = z.object({
  id: ProcessorRef,
  invoice_settings: z.object({ default_payment_method: ProcessorRef.nullable() }),
});
// A PaymentIntent as a charge: its status, amounts and the invoice it was made for.
const StripeCharge = z.object({
  id: ProcessorRef,
  status: z.string(),
  amount: Cents,
  amount_received: Cents,
  currency: z.string(),
  metadata: z.record(z.string(), z.string()).nullable().optional(),
});
const StripeCharges = z.object({ data: z.array(StripeCharge), has_more: z.boolean() });
/** How many pages of 100 PaymentIntents one reconciliation reads at most. */
const MAX_CHARGE_PAGES = 20;
// A refused PaymentIntent request whose error carries the PaymentIntent: an off-session decline
// (402), or a cancel of one that already succeeded or was cancelled (400).
const StripeCardError = z.object({ error: z.object({ payment_intent: StripeCharge }) });
const StripeEvent = z.object({
  id: ProcessorRef,
  type: z.string(),
  created: z.number().int().min(0),
  data: z.object({ object: z.unknown() }),
});
const StripePaymentIntent = z.object({ id: ProcessorRef, amount: Cents, amount_received: Cents, currency: z.string() });
const StripeCheckoutSession = z.object({ id: ProcessorRef, url: z.string().url() });
const StripeSetupSession = z.object({
  id: ProcessorRef,
  mode: z.string(),
  status: z.string().nullable(),
  customer: ProcessorRef.nullable(),
  metadata: z.record(z.string(), z.string()).nullable(),
  setup_intent: z.object({ status: z.string(), payment_method: ProcessorRef.nullable() }).nullable(),
});
const StripePortalSession = z.object({ url: z.string().url() });
const StripeRefund = z.object({ id: ProcessorRef, amount: Cents, currency: z.string(), status: z.string() });

/**
 * A {@link PaymentProcessor} over Stripe. Every request carries an `Idempotency-Key` derived from
 * the caller's, so a retried charge or refund is the same one at Stripe too. Only the opaque
 * commercial account ID is sent to Stripe, as customer metadata; no contact details.
 */
export class StripePaymentProcessor implements PaymentProcessor {
  readonly #apiKey: string;
  readonly #webhookSecret: string;
  readonly #portalConfiguration: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;

  constructor(options: StripePaymentProcessorOptions) {
    this.#apiKey = options.apiKey;
    this.#webhookSecret = options.webhookSecret;
    this.#portalConfiguration = options.portalConfiguration;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? (() => new Date());
  }

  async createCustomer(accountId: CommercialAccountId): Promise<ProcessorRef> {
    const customer = await this.#request("POST", "/v1/customers", StripeId, {
      body: { "metadata[commercial_account_id]": accountId },
      idempotencyKey: `educateos:customer:${accountId}`,
    });
    return customer.id;
  }

  /**
   * Charges the customer's default payment method off-session, naming the invoice in the
   * PaymentIntent's metadata (`educateos_invoice`) so {@link chargesFor} can find it if this reply
   * is lost. A decline is not an error here: Stripe answers with the failed PaymentIntent, which is
   * returned as `failed`. The status Stripe answers with is returned as it stands, so a request
   * Stripe replays for a repeated idempotency key reports the charge's outcome at once.
   */
  async charge(request: ChargeRequest): Promise<ChargeResult> {
    const customer = await this.#request("GET", `/v1/customers/${encodeURIComponent(request.customerRef)}`, StripeCustomer, {});
    const paymentMethod = customer.invoice_settings.default_payment_method;
    if (paymentMethod === null) throw new EducateOsError("policy-violation", "the processor customer has no default payment method");
    const intent = await this.#request("POST", "/v1/payment_intents", StripeCharge, {
      body: {
        "amount": String(request.amountCents),
        "currency": "usd",
        "customer": customer.id,
        "payment_method": paymentMethod,
        "confirm": "true",
        "off_session": "true",
        "metadata[educateos_invoice]": request.invoiceRef,
      },
      idempotencyKey: `educateos:charge:${request.idempotencyKey}`,
      carriesIntent: [402],
    });
    return chargeResult(intent);
  }

  /**
   * The customer's PaymentIntents made for the invoice. Read from the list endpoint, which, unlike
   * search, sees a PaymentIntent the moment it exists, page by page from when the invoice was issued
   * (less an hour, for clock skew), so the pages are bounded however many charges the customer has.
   */
  async chargesFor(customerRef: ProcessorRef, invoiceRef: string, since: string): Promise<ChargeResult[]> {
    const from = Math.floor(Date.parse(since) / 1000) - 60 * 60;
    const found: ChargeResult[] = [];
    let after: string | undefined;
    for (let page = 0; page < MAX_CHARGE_PAGES; page++) {
      const query = new URLSearchParams({ "customer": customerRef, "limit": "100", "created[gte]": String(from) });
      if (after !== undefined) query.set("starting_after", after);
      const listed = await this.#request("GET", `/v1/payment_intents?${query}`, StripeCharges, {});
      found.push(...listed.data.filter((intent) => intent.metadata?.educateos_invoice === invoiceRef).map(chargeResult));
      if (!listed.has_more || listed.data.length === 0) return found;
      after = listed.data.at(-1)!.id;
    }
    throw new EducateOsError("unavailable", "too many payment processor charges to reconcile");
  }

  /** The invoice a PaymentIntent names (`educateos_invoice`), or undefined if it names none or Stripe has no such PaymentIntent. */
  async chargeInvoiceRef(chargeRef: ProcessorRef): Promise<string | undefined> {
    const intent = await this.#request("GET", `/v1/payment_intents/${encodeURIComponent(chargeRef)}`, StripeCharge, { missing: true });
    return intent?.metadata?.educateos_invoice;
  }

  /**
   * Cancels a PaymentIntent that hasn't succeeded. One that succeeded, or was already cancelled,
   * can't be: Stripe refuses with the PaymentIntent, whose status is returned.
   */
  async cancelCharge(chargeRef: ProcessorRef): Promise<ChargeStatus> {
    const intent = await this.#request("POST", `/v1/payment_intents/${encodeURIComponent(chargeRef)}/cancel`, StripeCharge, {
      body: {},
      idempotencyKey: `educateos:cancel-charge:${chargeRef}`,
      carriesIntent: [400],
    });
    return chargeResult(intent).status;
  }

  async refund(request: RefundRequest): Promise<ProcessorRef> {
    const refund = await this.#request("POST", "/v1/refunds", StripeId, {
      body: { payment_intent: request.chargeRef, amount: String(request.amountCents) },
      idempotencyKey: `educateos:refund:${request.idempotencyKey}`,
    });
    return refund.id;
  }

  /**
   * Opens a Checkout Session in setup mode for the customer: Stripe's hosted page saves a card for
   * off-session charges and charges nothing. Stripe fills in the session's ID where the return URL
   * names {@link SETUP_REF_PLACEHOLDER}.
   */
  async startCardSetup(request: CardSetupRequest): Promise<CardSetup> {
    const session = await this.#request("POST", "/v1/checkout/sessions", StripeCheckoutSession, {
      body: {
        "mode": "setup",
        "customer": request.customerRef,
        "payment_method_types[0]": "card",
        "success_url": request.returnUrl.replaceAll(SETUP_REF_PLACEHOLDER, "{CHECKOUT_SESSION_ID}"),
        "cancel_url": request.cancelUrl,
        "metadata[educateos_reference]": request.reference,
      },
      idempotencyKey: `educateos:card-setup:${request.idempotencyKey}`,
    });
    return { setupRef: session.id, url: session.url };
  }

  /**
   * Reads the Checkout Session back with its SetupIntent and, once the customer has saved a card on
   * it, makes that card the customer's default payment method, which {@link charge} uses. A session
   * for another customer, not in setup mode, or made for another reference (its
   * `educateos_reference` metadata) is `not-found`.
   */
  async completeCardSetup(customerRef: ProcessorRef, setupRef: ProcessorRef, reference: string): Promise<boolean> {
    const session = await this.#request("GET", `/v1/checkout/sessions/${encodeURIComponent(setupRef)}?expand%5B%5D=setup_intent`, StripeSetupSession, {});
    if (session.customer !== customerRef || session.mode !== "setup" || session.metadata?.educateos_reference !== reference) throw new EducateOsError("not-found", "card setup not found");
    const paymentMethod = session.setup_intent?.status === "succeeded" ? session.setup_intent.payment_method : null;
    if (session.status !== "complete" || paymentMethod === null) return false;
    await this.#request("POST", `/v1/customers/${encodeURIComponent(customerRef)}`, StripeId, {
      body: { "invoice_settings[default_payment_method]": paymentMethod },
      idempotencyKey: `educateos:default-payment-method:${session.id}`,
    });
    return true;
  }

  /** Opens a Customer Portal session, where the customer manages their saved cards. */
  async openPaymentMethodPortal(customerRef: ProcessorRef, returnUrl: string): Promise<string> {
    const session = await this.#request("POST", "/v1/billing_portal/sessions", StripePortalSession, {
      body: {
        customer: customerRef,
        return_url: returnUrl,
        ...(this.#portalConfiguration === undefined ? {} : { configuration: this.#portalConfiguration }),
      },
    });
    return session.url;
  }

  /**
   * Verifies a {@link StripeWebhookDelivery} and maps it. The `Stripe-Signature` header must carry
   * a timestamp within {@link STRIPE_WEBHOOK_TOLERANCE_MS} of the clock and at least one `v1`
   * HMAC-SHA256, under the signing secret, of `<timestamp>.<payload>`; anything else is
   * `unauthenticated`, and nothing in the payload is read before that. Then
   * `payment_intent.succeeded` and `payment_intent.payment_failed` map to charge outcomes, a
   * `refund.created` or `refund.updated` whose refund has succeeded to `refund.succeeded`, and
   * every other event to `undefined`. Amounts in any currency but USD are refused.
   */
  async mapWebhookEvent(input: unknown): Promise<ProcessorEvent | undefined> {
    const delivery = parseWire(StripeWebhookDelivery, input, "webhook delivery");
    if (!(await this.#signedBySecret(delivery))) throw new EducateOsError("unauthenticated", "webhook delivery failed verification");
    let json: unknown;
    try {
      json = JSON.parse(delivery.payload);
    } catch {
      throw new EducateOsError("validation-failed", "malformed webhook payload");
    }
    const event = parseWire(StripeEvent, json, "webhook event");
    const occurredAt = new Date(event.created * 1000).toISOString();
    const base = { eventId: event.id, occurredAt };
    switch (event.type) {
      case "payment_intent.succeeded": {
        const intent = usd(parseWire(StripePaymentIntent, event.data.object, "payment intent"));
        return { ...base, type: "charge.succeeded", operationRef: intent.id, amountCents: intent.amount_received };
      }
      case "payment_intent.payment_failed": {
        const intent = usd(parseWire(StripePaymentIntent, event.data.object, "payment intent"));
        return { ...base, type: "charge.failed", operationRef: intent.id, amountCents: intent.amount };
      }
      case "refund.created":
      case "refund.updated": {
        const refund = usd(parseWire(StripeRefund, event.data.object, "refund"));
        if (refund.status !== "succeeded") return undefined;
        return { ...base, type: "refund.succeeded", operationRef: refund.id, amountCents: refund.amount };
      }
      default:
        return undefined;
    }
  }

  async #signedBySecret(delivery: StripeWebhookDelivery): Promise<boolean> {
    let timestamp: number | undefined;
    const signatures: Uint8Array<ArrayBuffer>[] = [];
    for (const part of delivery.signature.split(",")) {
      const separator = part.indexOf("=");
      const key = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      if (key === "t" && /^\d{1,12}$/.test(value)) timestamp = Number(value);
      if (key === "v1" && /^[0-9a-f]{64}$/.test(value)) signatures.push(hexBytes(value));
    }
    if (timestamp === undefined || signatures.length === 0) return false;
    if (Math.abs(this.#now().getTime() - timestamp * 1000) > STRIPE_WEBHOOK_TOLERANCE_MS) return false;
    const hmac = { name: "HMAC", hash: "SHA-256" } as const;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(this.#webhookSecret).slice(), hmac, false, ["verify"]);
    const signed = new TextEncoder().encode(`${timestamp}.${delivery.payload}`).slice();
    // `verify` compares in constant time. Stripe may list several signatures while a secret rolls.
    for (const signature of signatures) if (await crypto.subtle.verify(hmac, key, signature, signed)) return true;
    return false;
  }

  async #request<T extends z.ZodType>(
    method: "GET" | "POST",
    path: string,
    schema: T,
    options: { body?: Record<string, string>; idempotencyKey?: string; carriesIntent?: number[]; missing: true },
  ): Promise<z.infer<T> | undefined>;
  async #request<T extends z.ZodType>(
    method: "GET" | "POST",
    path: string,
    schema: T,
    options: { body?: Record<string, string>; idempotencyKey?: string; carriesIntent?: number[]; missing?: false },
  ): Promise<z.infer<T>>;
  async #request<T extends z.ZodType>(
    method: "GET" | "POST",
    path: string,
    schema: T,
    options: { body?: Record<string, string>; idempotencyKey?: string; carriesIntent?: number[]; missing?: boolean },
  ): Promise<z.infer<T> | undefined> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.#apiKey}`, "Stripe-Version": STRIPE_API_VERSION };
    if (options.body !== undefined) headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (options.idempotencyKey !== undefined) headers["Idempotency-Key"] = options.idempotencyKey;
    let response: Response;
    try {
      response = await this.#fetch(`${API_BASE}${path}`, {
        method,
        headers,
        ...(options.body === undefined ? {} : { body: new URLSearchParams(options.body).toString() }),
      });
    } catch {
      throw new EducateOsError("unavailable", "the payment processor could not be reached");
    }
    const json: unknown = await response.json().catch(() => undefined);
    if (response.ok) return parseWire(schema, json, "payment processor response");
    // With `missing`, a 404 means there is no such object.
    if (options.missing === true && response.status === 404) return undefined;
    // A declined off-session charge (402), or a refused cancel (400): Stripe returns the error
    // with the PaymentIntent, whose status says where it stands.
    if (options.carriesIntent?.includes(response.status) === true) {
      const refused = StripeCardError.safeParse(json);
      if (refused.success) return parseWire(schema, refused.data.error.payment_intent, "payment processor response");
    }
    // The status only: an error body can quote back request fields.
    throw new EducateOsError("unavailable", `the payment processor refused the request (HTTP ${response.status})`);
  }
}

// Stripe's PaymentIntent statuses, for an off-session charge: `processing` is still going;
// `requires_payment_method` (declined), `requires_action` (needs the customer, who isn't there)
// and `canceled` can no longer succeed without a new attempt.
function chargeResult(intent: z.infer<typeof StripeCharge>): ChargeResult {
  usd(intent);
  const status: ChargeStatus = intent.status === "succeeded" ? "succeeded" : intent.status === "processing" ? "pending" : "failed";
  return { chargeRef: intent.id, status, amountCents: status === "succeeded" ? intent.amount_received : intent.amount };
}

function usd<T extends { currency: string }>(object: T): T {
  if (object.currency !== "usd") throw new EducateOsError("validation-failed", "EducateOS bills in USD only");
  return object;
}

function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
