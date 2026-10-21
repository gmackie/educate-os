import { type CommercialAccountId, SchoolOsError } from "@schoolos/contracts";
import { parseWire } from "@schoolos/fleet";
import { z } from "zod";
import { ProcessorRef } from "./ids.ts";
import { Cents } from "./money.ts";
import type { ChargeRequest, PaymentProcessor, ProcessorEvent, RefundRequest } from "./processor.ts";

// The Stripe adapter for the payment processor port (SCHO-99). It speaks Stripe's REST API with
// `fetch` and no SDK, so it runs unchanged in a Worker. Charges are off-session PaymentIntents on
// the customer's default payment method; their outcomes, and refunds', arrive as webhooks, which
// are verified against the endpoint's signing secret before anything is read from them.

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
  /** A Stripe secret key, ideally restricted to customers, PaymentIntents and refunds. */
  apiKey: string;
  /** The webhook endpoint's signing secret (`whsec_…`). */
  webhookSecret: string;
  /** Defaults to the global `fetch`. Tests pass a fake; the adapter makes no other network calls. */
  fetch?: typeof fetch;
  /** The clock webhook timestamps are checked against. Defaults to the system clock. */
  now?: () => Date;
}

// Stripe's objects carry many more fields than these and gain new ones without notice, so unlike
// SchoolOS's own wire shapes they are read with `z.object`, which drops unknown fields instead of
// rejecting them. Only the fields named here are ever read.
const StripeId = z.object({ id: ProcessorRef });
const StripeCustomer = z.object({
  id: ProcessorRef,
  invoice_settings: z.object({ default_payment_method: ProcessorRef.nullable() }),
});
const StripeCardError = z.object({ error: z.object({ payment_intent: StripeId }) });
const StripeEvent = z.object({
  id: ProcessorRef,
  type: z.string(),
  created: z.number().int().min(0),
  data: z.object({ object: z.unknown() }),
});
const StripePaymentIntent = z.object({ id: ProcessorRef, amount: Cents, amount_received: Cents, currency: z.string() });
const StripeRefund = z.object({ id: ProcessorRef, amount: Cents, currency: z.string(), status: z.string() });

/**
 * A {@link PaymentProcessor} over Stripe. Every request carries an `Idempotency-Key` derived from
 * the caller's, so a retried charge or refund is the same one at Stripe too. Only the opaque
 * commercial account ID is sent to Stripe, as customer metadata; no contact details.
 */
export class StripePaymentProcessor implements PaymentProcessor {
  readonly #apiKey: string;
  readonly #webhookSecret: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;

  constructor(options: StripePaymentProcessorOptions) {
    this.#apiKey = options.apiKey;
    this.#webhookSecret = options.webhookSecret;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? (() => new Date());
  }

  async createCustomer(accountId: CommercialAccountId): Promise<ProcessorRef> {
    const customer = await this.#request("POST", "/v1/customers", StripeId, {
      body: { "metadata[commercial_account_id]": accountId },
      idempotencyKey: `schoolos:customer:${accountId}`,
    });
    return customer.id;
  }

  /**
   * Charges the customer's default payment method off-session. A decline is not an error here:
   * Stripe answers with the failed PaymentIntent, whose reference is returned, and its
   * `payment_intent.payment_failed` webhook reports the outcome as for any other charge.
   */
  async charge(request: ChargeRequest): Promise<ProcessorRef> {
    const customer = await this.#request("GET", `/v1/customers/${encodeURIComponent(request.customerRef)}`, StripeCustomer, {});
    const paymentMethod = customer.invoice_settings.default_payment_method;
    if (paymentMethod === null) throw new SchoolOsError("policy-violation", "the processor customer has no default payment method");
    const intent = await this.#request("POST", "/v1/payment_intents", StripeId, {
      body: {
        amount: String(request.amountCents),
        currency: "usd",
        customer: customer.id,
        payment_method: paymentMethod,
        confirm: "true",
        off_session: "true",
      },
      idempotencyKey: `schoolos:charge:${request.idempotencyKey}`,
      declineCarries: true,
    });
    return intent.id;
  }

  async refund(request: RefundRequest): Promise<ProcessorRef> {
    const refund = await this.#request("POST", "/v1/refunds", StripeId, {
      body: { payment_intent: request.chargeRef, amount: String(request.amountCents) },
      idempotencyKey: `schoolos:refund:${request.idempotencyKey}`,
    });
    return refund.id;
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
    if (!(await this.#signedBySecret(delivery))) throw new SchoolOsError("unauthenticated", "webhook delivery failed verification");
    let json: unknown;
    try {
      json = JSON.parse(delivery.payload);
    } catch {
      throw new SchoolOsError("validation-failed", "malformed webhook payload");
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
    options: { body?: Record<string, string>; idempotencyKey?: string; declineCarries?: boolean },
  ): Promise<z.infer<T>> {
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
      throw new SchoolOsError("unavailable", "the payment processor could not be reached");
    }
    const json: unknown = await response.json().catch(() => undefined);
    if (response.ok) return parseWire(schema, json, "payment processor response");
    // A declined off-session charge: Stripe returns 402 with the PaymentIntent it created.
    if (options.declineCarries === true && response.status === 402) {
      const declined = StripeCardError.safeParse(json);
      if (declined.success) return parseWire(schema, declined.data.error.payment_intent, "payment processor response");
    }
    // The status only: an error body can quote back request fields.
    throw new SchoolOsError("unavailable", `the payment processor refused the request (HTTP ${response.status})`);
  }
}

function usd<T extends { currency: string }>(object: T): T {
  if (object.currency !== "usd") throw new SchoolOsError("validation-failed", "SchoolOS bills in USD only");
  return object;
}

function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
