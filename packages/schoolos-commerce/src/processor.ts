import { SchoolOsError, UtcTimestamp } from "@schoolos/contracts";
import { type CommercialAccountId, parseWire } from "@schoolos/fleet";
import { z } from "zod";
import { ProcessorRef } from "./ids.ts";
import { Cents } from "./money.ts";

// The payment processor is a port. A real adapter (Stripe or another processor) lives in the
// private root service, which owns the credentials and the network; this library only defines the
// contract and ships a fake for tests. Full procurement automation is deferred (roadmap §12).

/**
 * A processor webhook event, normalized. A real adapter verifies the processor's webhook
 * signature before producing one; commerce then applies it idempotently by `eventId`.
 */
export const ProcessorEvent = z.strictObject({
  eventId: ProcessorRef,
  type: z.enum(["charge.succeeded", "charge.failed", "refund.succeeded"]),
  /** The charge or refund the event is about, as returned by {@link PaymentProcessor.charge} or {@link PaymentProcessor.refund}. */
  operationRef: ProcessorRef,
  amountCents: Cents,
  occurredAt: UtcTimestamp,
});
/** A processor event. */
export type ProcessorEvent = z.infer<typeof ProcessorEvent>;

/** A charge request. The processor must treat a repeated `idempotencyKey` as the same charge. */
export interface ChargeRequest {
  customerRef: ProcessorRef;
  amountCents: number;
  idempotencyKey: string;
}

/** A refund request. The processor must treat a repeated `idempotencyKey` as the same refund. */
export interface RefundRequest {
  chargeRef: ProcessorRef;
  amountCents: number;
  idempotencyKey: string;
}

/**
 * What commerce needs from a payment processor. Charges and refunds are asynchronous: the call
 * returns the processor's reference, and the outcome arrives later as a webhook event.
 */
export interface PaymentProcessor {
  /** Creates a processor customer for an account. Only the opaque account ID is passed; no contact details. */
  createCustomer(accountId: CommercialAccountId): Promise<ProcessorRef>;
  /** Requests a charge. Returns the charge's reference. */
  charge(request: ChargeRequest): Promise<ProcessorRef>;
  /** Requests a refund of (part of) a charge. Returns the refund's reference. */
  refund(request: RefundRequest): Promise<ProcessorRef>;
  /**
   * Maps a raw webhook delivery to a {@link ProcessorEvent}, or `undefined` for event types
   * commerce doesn't act on. Throws `unauthenticated` if the delivery fails verification.
   */
  mapWebhookEvent(delivery: unknown): ProcessorEvent | undefined;
}

/** The raw delivery the {@link FakePaymentProcessor} emits: a normalized event plus a shared-secret tag. */
const FakeDelivery = z.strictObject({ tag: z.literal("fake-processor"), event: z.unknown() });

/**
 * A {@link PaymentProcessor} in memory, for tests and the local harness. It records every call,
 * honours idempotency keys, and queues the webhook deliveries a real processor would send, which
 * the test delivers (or redelivers) itself.
 */
export class FakePaymentProcessor implements PaymentProcessor {
  /** Every account ID a customer was created for, in order. */
  readonly customersCreated: CommercialAccountId[] = [];
  readonly #operations = new Map<string, ProcessorRef>();
  readonly #deliveries: unknown[] = [];
  readonly #now: () => Date;
  #counter = 0;
  #failNextCharge = false;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  /** Makes the next new charge fail, as a declined card would. */
  failNextCharge(): void {
    this.#failNextCharge = true;
  }

  /** Takes the queued webhook deliveries. */
  takeDeliveries(): unknown[] {
    return this.#deliveries.splice(0);
  }

  async createCustomer(accountId: CommercialAccountId): Promise<ProcessorRef> {
    this.customersCreated.push(accountId);
    return this.#ref("cus");
  }

  async charge(request: ChargeRequest): Promise<ProcessorRef> {
    return this.#once(`charge:${request.idempotencyKey}`, "ch", (ref) => {
      const failed = this.#failNextCharge;
      this.#failNextCharge = false;
      this.#emit(failed ? "charge.failed" : "charge.succeeded", ref, request.amountCents);
    });
  }

  async refund(request: RefundRequest): Promise<ProcessorRef> {
    return this.#once(`refund:${request.idempotencyKey}`, "re", (ref) => this.#emit("refund.succeeded", ref, request.amountCents));
  }

  mapWebhookEvent(delivery: unknown): ProcessorEvent | undefined {
    const parsed = FakeDelivery.safeParse(delivery);
    if (!parsed.success) throw new SchoolOsError("unauthenticated", "webhook delivery failed verification");
    return parseWire(ProcessorEvent, parsed.data.event, "processor event");
  }

  #once(key: string, prefix: string, onCreate: (ref: ProcessorRef) => void): ProcessorRef {
    const existing = this.#operations.get(key);
    if (existing !== undefined) return existing;
    const ref = this.#ref(prefix);
    this.#operations.set(key, ref);
    onCreate(ref);
    return ref;
  }

  #emit(type: ProcessorEvent["type"], operationRef: ProcessorRef, amountCents: number): void {
    const event: ProcessorEvent = { eventId: this.#ref("evt"), type, operationRef, amountCents, occurredAt: this.#now().toISOString() };
    this.#deliveries.push({ tag: "fake-processor", event });
  }

  #ref(prefix: string): ProcessorRef {
    this.#counter += 1;
    return `${prefix}_fake${this.#counter}`;
  }
}
