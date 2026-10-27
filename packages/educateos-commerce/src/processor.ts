import { type CommercialAccountId, EducateOsError, UtcTimestamp } from "@educateos/contracts";
import { parseWire } from "@educateos/fleet";
import { z } from "zod";
import { ProcessorRef } from "./ids.ts";
import { Cents } from "./money.ts";

// The payment processor is a port. `StripePaymentProcessor` (`stripe.ts`) is the adapter the
// private root service runs with its own credentials; `FakePaymentProcessor` stands in for tests
// and the local harness. Full procurement automation is deferred (roadmap §12).

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
  /**
   * The invoice the charge pays. The processor keeps it on the charge, so
   * {@link PaymentProcessor.chargesFor} finds a charge whose creation reply was lost.
   */
  invoiceRef: string;
}

/**
 * Where a charge stands at the processor: `succeeded`; `failed` once it can no longer succeed
 * (declined, needing an action an off-session charge can't take, or cancelled); `pending` while
 * the processor is still working on it.
 */
export type ChargeStatus = "succeeded" | "failed" | "pending";

/** A charge as the processor reports it. */
export interface ChargeResult {
  chargeRef: ProcessorRef;
  status: ChargeStatus;
  /** What it charged, or would: the amount received once it succeeded. */
  amountCents: number;
}

/** A refund request. The processor must treat a repeated `idempotencyKey` as the same refund. */
export interface RefundRequest {
  chargeRef: ProcessorRef;
  amountCents: number;
  idempotencyKey: string;
}

/**
 * Where a {@link CardSetupRequest}'s `returnUrl` names the setup's own reference. The processor
 * fills it in, so the page the customer comes back to can finish that setup and no other.
 */
export const SETUP_REF_PLACEHOLDER = "{SETUP_REF}";

/** A request to open the processor's hosted page where a customer saves a card for later charges. */
export interface CardSetupRequest {
  customerRef: ProcessorRef;
  /**
   * What the setup is for: commerce's subscription ID. The processor keeps it on the setup, and
   * {@link PaymentProcessor.completeCardSetup} refuses a setup made for anything else, so a page
   * left from an earlier subscription can't finish a later one.
   */
  reference: string;
  /** Where the customer is sent once the card is saved. {@link SETUP_REF_PLACEHOLDER} is replaced by the setup's reference. */
  returnUrl: string;
  /** Where the customer is sent if they leave without saving a card. */
  cancelUrl: string;
  /** The processor must treat a repeated key as the same setup page. */
  idempotencyKey: string;
}

/** The hosted card setup page the processor opened. */
export interface CardSetup {
  /** The setup's reference, which {@link PaymentProcessor.completeCardSetup} is later given. */
  setupRef: ProcessorRef;
  /** The page to send the customer to. */
  url: string;
}

/**
 * What commerce needs from a payment processor. Charges and refunds are asynchronous: the call
 * returns the processor's reference, and the outcome arrives later as a webhook event. Cards are
 * saved on the processor's own hosted pages, so no card number ever reaches EducateOS.
 */
export interface PaymentProcessor {
  /** Creates a processor customer for an account. Only the opaque account ID is passed; no contact details. */
  createCustomer(accountId: CommercialAccountId): Promise<ProcessorRef>;
  /**
   * Requests a charge. Returns it with the status the processor answered with, which may already be
   * final; a pending one's outcome arrives as a webhook event.
   */
  charge(request: ChargeRequest): Promise<ChargeResult>;
  /** Every charge the processor holds for the customer and invoice, as it stands now. */
  chargesFor(customerRef: ProcessorRef, invoiceRef: string): Promise<ChargeResult[]>;
  /**
   * Cancels a charge that hasn't succeeded, so it can never succeed after a replacement is made.
   * Returns where it then stands: `failed` once cancelled, or `succeeded` (or `pending`) if it got
   * there first and so can't be cancelled.
   */
  cancelCharge(chargeRef: ProcessorRef): Promise<ChargeStatus>;
  /** Requests a refund of (part of) a charge. Returns the refund's reference. */
  refund(request: RefundRequest): Promise<ProcessorRef>;
  /**
   * Verifies a raw webhook delivery and maps it to a {@link ProcessorEvent}, or `undefined` for
   * event types commerce doesn't act on. Throws `unauthenticated` if the delivery fails
   * verification.
   */
  mapWebhookEvent(delivery: unknown): Promise<ProcessorEvent | undefined>;
  /** Opens a hosted page where the customer saves a card, without charging it. */
  startCardSetup(request: CardSetupRequest): Promise<CardSetup>;
  /**
   * Finishes a card setup the customer came back from: makes the saved card the customer's default
   * payment method, which {@link PaymentProcessor.charge} uses. Returns false if the customer hasn't
   * saved a card on that page. A setup belonging to another customer, or made for another
   * `reference`, is `not-found`.
   */
  completeCardSetup(customerRef: ProcessorRef, setupRef: ProcessorRef, reference: string): Promise<boolean>;
  /** Opens the processor's hosted page where the customer manages their saved payment methods. Returns its URL. */
  openPaymentMethodPortal(customerRef: ProcessorRef, returnUrl: string): Promise<string>;
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
  /** Each customer's default payment method, once a card setup made one. */
  readonly defaultPaymentMethods = new Map<ProcessorRef, ProcessorRef>();
  readonly #setups = new Map<ProcessorRef, { customerRef: ProcessorRef; reference: string; saved: boolean }>();
  readonly #operations = new Map<string, ProcessorRef>();
  // Each charge's outcome, decided when it is made and reported as pending until the test takes
  // its webhook delivery, as a real processor reports it until it has finished.
  readonly #charges = new Map<ProcessorRef, { customerRef: ProcessorRef; invoiceRef: string; amountCents: number; outcome: "succeeded" | "failed"; settled: boolean }>();
  readonly #deliveries: unknown[] = [];
  readonly #now: () => Date;
  /** Every charge cancelled, in order. */
  readonly cancelledCharges: ProcessorRef[] = [];
  #counter = 0;
  #failNextCharge = false;
  #loseNextChargeReply = false;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  /** Makes the next new charge fail, as a declined card would. */
  failNextCharge(): void {
    this.#failNextCharge = true;
  }

  /** Makes the next new charge go through but its reply be lost, as a timeout would. */
  loseNextChargeReply(): void {
    this.#loseNextChargeReply = true;
  }

  /** Saves a card on an open setup page, as the customer would. */
  saveCard(setupRef: ProcessorRef): void {
    const setup = this.#setups.get(setupRef);
    if (setup === undefined) throw new EducateOsError("not-found", "card setup not found");
    setup.saved = true;
  }

  /** Takes the queued webhook deliveries. The charges they report are then settled at the processor. */
  takeDeliveries(): unknown[] {
    for (const charge of this.#charges.values()) charge.settled = true;
    return this.#deliveries.splice(0);
  }

  async createCustomer(accountId: CommercialAccountId): Promise<ProcessorRef> {
    this.customersCreated.push(accountId);
    return this.#ref("cus");
  }

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    const chargeRef = this.#once(`charge:${request.idempotencyKey}`, "ch", (ref) => {
      const failed = this.#failNextCharge;
      this.#failNextCharge = false;
      this.#charges.set(ref, { customerRef: request.customerRef, invoiceRef: request.invoiceRef, amountCents: request.amountCents, outcome: failed ? "failed" : "succeeded", settled: false });
      this.#emit(failed ? "charge.failed" : "charge.succeeded", ref, request.amountCents);
    });
    if (this.#loseNextChargeReply) {
      this.#loseNextChargeReply = false;
      throw new EducateOsError("unavailable", "the payment processor could not be reached");
    }
    return this.#result(chargeRef);
  }

  async chargesFor(customerRef: ProcessorRef, invoiceRef: string): Promise<ChargeResult[]> {
    return [...this.#charges.entries()]
      .filter(([, charge]) => charge.customerRef === customerRef && charge.invoiceRef === invoiceRef)
      .map(([ref]) => this.#result(ref));
  }

  async cancelCharge(chargeRef: ProcessorRef): Promise<ChargeStatus> {
    const charge = this.#charges.get(chargeRef);
    if (charge === undefined) throw new EducateOsError("not-found", "charge not found");
    charge.settled = true;
    if (charge.outcome === "failed") this.cancelledCharges.push(chargeRef);
    return charge.outcome;
  }

  #result(chargeRef: ProcessorRef): ChargeResult {
    const charge = this.#charges.get(chargeRef)!;
    return { chargeRef, status: charge.settled ? charge.outcome : "pending", amountCents: charge.amountCents };
  }

  async refund(request: RefundRequest): Promise<ProcessorRef> {
    return this.#once(`refund:${request.idempotencyKey}`, "re", (ref) => this.#emit("refund.succeeded", ref, request.amountCents));
  }

  async mapWebhookEvent(delivery: unknown): Promise<ProcessorEvent | undefined> {
    const parsed = FakeDelivery.safeParse(delivery);
    if (!parsed.success) throw new EducateOsError("unauthenticated", "webhook delivery failed verification");
    return parseWire(ProcessorEvent, parsed.data.event, "processor event");
  }

  async startCardSetup(request: CardSetupRequest): Promise<CardSetup> {
    const setupRef = this.#once(`setup:${request.idempotencyKey}`, "cs", (ref) => this.#setups.set(ref, { customerRef: request.customerRef, reference: request.reference, saved: false }));
    return { setupRef, url: `https://fake-processor.invalid/setup/${setupRef}` };
  }

  async completeCardSetup(customerRef: ProcessorRef, setupRef: ProcessorRef, reference: string): Promise<boolean> {
    const setup = this.#setups.get(setupRef);
    if (setup === undefined || setup.customerRef !== customerRef || setup.reference !== reference) throw new EducateOsError("not-found", "card setup not found");
    if (!setup.saved) return false;
    if (!this.defaultPaymentMethods.has(customerRef)) this.defaultPaymentMethods.set(customerRef, this.#ref("pm"));
    return true;
  }

  async openPaymentMethodPortal(customerRef: ProcessorRef, returnUrl: string): Promise<string> {
    return `https://fake-processor.invalid/portal/${customerRef}?return=${encodeURIComponent(returnUrl)}`;
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
