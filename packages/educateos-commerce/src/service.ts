import { CommercialAccountId, InstanceId, OpaqueCode, EducateOsError, UtcTimestamp } from "@educateos/contracts";
import {
  type CommercialAccountVerifier,
  Entitlement,
  Heartbeat,
  parseWire,
  type RegistrationVerification,
  type RegistrationVerificationRequest,
  type SignedEnvelope,
  signEnvelope,
  type SigningIdentity,
} from "@educateos/fleet";
import { z } from "zod";
import {
  type AuditChainVerification,
  chainFinanceAuditEvent,
  FinanceActor,
  type FinanceAction,
  type FinanceAuditEvent,
  type FinanceStateSummary,
  type FinanceSubject,
  SYSTEM_CLOCK,
  verifyFinanceAuditChain,
} from "./audit.ts";
import { entitlementWindow, timedTransitions } from "./grace.ts";
import {
  type CommerceIdGenerator,
  ContactRef,
  DocumentRef,
  FinanceAuditEventId,
  InvoiceId,
  PaymentId,
  PlanId,
  type ProcessorRef,
  PurchaseOrderId,
  randomCommerceId,
  SubscriptionId,
} from "./ids.ts";
import {
  CommercialAccount,
  CreditEntry,
  Grant,
  GrantFunder,
  Invoice,
  InvoiceLine,
  InvoiceLineKind,
  Payment,
  PaymentMethodKind,
  Plan,
  PoNumber,
  PurchaseOrder,
  Subscription,
} from "./model.ts";
import { Cents, multiplyCents, subtractCents, sumCents } from "./money.ts";
import type { CardSetup, PaymentProcessor, ProcessorEvent } from "./processor.ts";
import { reconcile, type ReconciliationReport } from "./reconciliation.ts";
import type { CommerceRecords, CommerceStore } from "./store.ts";

/** A request to open a commercial account. */
export const OpenAccountRequest = z.strictObject({
  accountId: CommercialAccountId,
  districtLabel: CommercialAccount.shape.districtLabel,
  contactRefs: z.array(ContactRef).max(16).default([]),
  aiUsageSharing: CommercialAccount.shape.aiUsageSharing.default("opted-out"),
});
/** An open-account request. */
export type OpenAccountRequest = z.input<typeof OpenAccountRequest>;

/** A request to start a subscription. It starts `trialing` and is activated separately. */
export const StartSubscriptionRequest = z.strictObject({
  accountId: CommercialAccountId,
  planId: PlanId,
  paymentMethod: PaymentMethodKind,
  purchaseOrderId: PurchaseOrderId.optional(),
  termStart: UtcTimestamp,
  termEnd: UtcTimestamp,
});
/** A start-subscription request. */
export type StartSubscriptionRequest = z.input<typeof StartSubscriptionRequest>;

/** A request to record a district purchase order. */
export const SubmitPurchaseOrderRequest = z.strictObject({
  accountId: CommercialAccountId,
  poNumber: PoNumber,
  amountCents: Cents.min(1),
  documentRef: DocumentRef,
});
/** A submit-purchase-order request. */
export type SubmitPurchaseOrderRequest = z.input<typeof SubmitPurchaseOrderRequest>;

/**
 * One line to invoice. `amountCents` is computed, never supplied. The AI usage report can't be
 * entered by hand: it is derived from an opted-in heartbeat (see {@link IssueInvoiceRequest}).
 */
export const InvoiceLineRequest = z.strictObject({
  kind: InvoiceLineKind.exclude(["ai-usage-report"]),
  code: OpaqueCode,
  quantity: InvoiceLine.shape.quantity,
  unitAmountCents: Cents,
});
/** An invoice line request. */
export type InvoiceLineRequest = z.input<typeof InvoiceLineRequest>;

/**
 * A request to issue an invoice. It names EducateOS fees only and has no field for the district's
 * Cloudflare costs. `aiUsageHeartbeat` is a heartbeat the fleet registry accepted; if the account
 * has opted in, its aggregate AI spend (the district's own) is shown on an `ai-usage-report` line
 * that charges nothing.
 */
export const IssueInvoiceRequest = z.strictObject({
  accountId: CommercialAccountId,
  subscriptionId: SubscriptionId.optional(),
  purchaseOrderId: PurchaseOrderId.optional(),
  lines: z.array(InvoiceLineRequest).max(199),
  aiUsageHeartbeat: Heartbeat.optional(),
  dueAt: UtcTimestamp,
});
/** An issue-invoice request. */
export type IssueInvoiceRequest = z.input<typeof IssueInvoiceRequest>;

/** A request to award grant credits to an account. */
export const AwardGrantRequest = z.strictObject({
  accountId: CommercialAccountId,
  funder: GrantFunder,
  programCode: OpaqueCode,
  awardedCents: Cents.min(1),
  expiresAt: UtcTimestamp,
  documentRef: DocumentRef,
});
/** An award-grant request. */
export type AwardGrantRequest = z.input<typeof AwardGrantRequest>;

/**
 * A verified processor event about a charge or refund commerce has no record of: `not-found`,
 * naming the processor's IDs (never anything personal) so the caller can log what went unmatched.
 */
export class UnmatchedProcessorEventError extends EducateOsError {
  readonly eventId: ProcessorRef;
  readonly operationRef: ProcessorRef;
  constructor(eventId: ProcessorRef, operationRef: ProcessorRef) {
    super("not-found", "processor operation not found");
    this.eventId = eventId;
    this.operationRef = operationRef;
  }
}

/**
 * Where an invoice's charge stands: `paid`; `pending` while a charge is requested and its outcome
 * hasn't arrived, or has succeeded and the invoice is settling; `declined` once every charge
 * requested has failed; `uncharged` if no charge was ever requested.
 */
export type InvoiceChargeState = "paid" | "pending" | "declined" | "uncharged";

/** The outcome of {@link CommerceService.handleProcessorDelivery}. */
export interface ProcessorDeliveryOutcome {
  /** `applied` the first time an event is seen, `duplicate` on any redelivery, `ignored` for event types commerce doesn't act on. */
  outcome: "applied" | "duplicate" | "ignored";
  eventId?: ProcessorRef;
}

/** What a {@link CommerceService} needs. */
export interface CommerceServiceOptions {
  store: CommerceStore;
  processor: PaymentProcessor;
  /** The plan catalog. Plans are configuration, versioned with the service, not runtime state. */
  plans: Plan[];
  /** The root's entitlement signing key. Districts pin its public key as the entitlement cache's `rootPublicKey`. */
  entitlementSigner: SigningIdentity;
  /** The clock. Defaults to the system clock. */
  now?: () => Date;
  /** Generates record IDs. Defaults to {@link randomCommerceId}. */
  newId?: CommerceIdGenerator;
}

const DELINQUENT = new Set<Subscription["status"]>(["past-due", "grace", "lapsed"]);

/**
 * The root's commercial layer (roadmap R04): accounts, subscriptions with explicit grace rules,
 * purchase orders, invoices, grant credits and payments, the signed entitlements the district's
 * entitlement cache consumes, and an append-only finance audit of every state change.
 *
 * It holds no personal data and nothing from a district's Cloudflare bill: accounts are
 * organizations, contacts are references, invoice lines are catalog codes for EducateOS fees.
 * Cancelling or lapsing a subscription changes only what the root will do next; the district keeps
 * running its installed release and keeps its data (ADR-0001).
 */
export class CommerceService implements CommercialAccountVerifier {
  readonly #store: CommerceStore;
  readonly #processor: PaymentProcessor;
  readonly #plans: ReadonlyMap<string, Plan>;
  readonly #signer: SigningIdentity;
  readonly #now: () => Date;
  readonly #newId: CommerceIdGenerator;

  constructor(options: CommerceServiceOptions) {
    this.#store = options.store;
    this.#processor = options.processor;
    this.#plans = new Map(options.plans.map((plan) => [plan.planId, Plan.parse(plan)]));
    this.#signer = options.entitlementSigner;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? randomCommerceId;
  }

  // Accounts

  /** Opens an account. Fails with `conflict` if the account ID is taken. */
  async openAccount(input: OpenAccountRequest, actor: FinanceActor): Promise<CommercialAccount> {
    return this.#store.atomically(async () => {
      const request = parseWire(OpenAccountRequest, input, "account request");
      if (await this.#store.get("account", request.accountId)) throw new EducateOsError("conflict", "account already exists");
      const account = CommercialAccount.parse({ ...request, instanceIds: [], openedAt: this.#timestamp() });
      await this.#store.put("account", account.accountId, account);
      await this.#audit(account.accountId, actor, "account.opened", { kind: "account", id: account.accountId }, undefined, {
        state: account.aiUsageSharing,
      });
      return account;
    });
  }

  /** Links a district instance to the account, so entitlements may be issued to it. */
  async linkInstance(accountId: CommercialAccountId, instanceId: InstanceId, actor: FinanceActor): Promise<void> {
    return this.#store.atomically(async () => {
      const id = parseWire(InstanceId, instanceId, "instance ID");
      const account = await this.#require("account", accountId);
      if (account.instanceIds.includes(id)) return;
      for (const other of await this.#store.list("account")) {
        if (other.instanceIds.includes(id)) throw new EducateOsError("conflict", "instance belongs to another account");
      }
      await this.#store.put("account", accountId, CommercialAccount.parse({ ...account, instanceIds: [...account.instanceIds, id] }));
      await this.#audit(accountId, actor, "account.instance-linked", { kind: "instance", id });
    });
  }

  /** Records the district's choice about sharing aggregate AI spend. */
  async setAiUsageSharing(accountId: CommercialAccountId, sharing: CommercialAccount["aiUsageSharing"], actor: FinanceActor): Promise<void> {
    return this.#store.atomically(async () => {
      const account = await this.#require("account", accountId);
      const next = CommercialAccount.parse({ ...account, aiUsageSharing: sharing });
      await this.#store.put("account", accountId, next);
      await this.#audit(accountId, actor, "account.ai-usage-sharing-changed", { kind: "account", id: accountId },
        { state: account.aiUsageSharing }, { state: next.aiUsageSharing });
    });
  }

  /** Creates the account's processor customer if it has none, passing only the opaque account ID. */
  async ensureProcessorCustomer(accountId: CommercialAccountId, actor: FinanceActor): Promise<ProcessorRef> {
    return this.#store.atomically(() => this.#ensureProcessorCustomer(accountId, actor));
  }

  async #ensureProcessorCustomer(accountId: CommercialAccountId, actor: FinanceActor): Promise<ProcessorRef> {
    const account = await this.#require("account", accountId);
    if (account.processorCustomerRef !== undefined) return account.processorCustomerRef;
    const customerRef = await this.#processor.createCustomer(account.accountId);
    await this.#store.put("account", accountId, CommercialAccount.parse({ ...account, processorCustomerRef: customerRef }));
    await this.#audit(accountId, actor, "account.processor-customer-created", { kind: "account", id: accountId });
    return customerRef;
  }

  // Cards (SCHO-208)

  /**
   * Opens the processor's hosted page where the account saves the card a trialing card
   * subscription will be charged to, creating the processor customer first if need be. Nothing is
   * charged. The customer comes back to `returnUrl`, which names the setup by the processor's
   * `SETUP_REF_PLACEHOLDER`, for {@link CommerceService.completeCardSetup}.
   */
  async startCardSetup(
    subscriptionId: SubscriptionId,
    urls: { returnUrl: string; cancelUrl: string; idempotencyKey: string },
    actor: FinanceActor,
  ): Promise<CardSetup> {
    return this.#store.atomically(async () => {
      const subscription = await this.#cardSubscription(subscriptionId);
      if (subscription.status !== "trialing") throw new EducateOsError("conflict", "only a trialing subscription needs a card set up");
      const customerRef = await this.#ensureProcessorCustomer(subscription.accountId, actor);
      return await this.#processor.startCardSetup({ customerRef, reference: subscription.subscriptionId, ...urls });
    });
  }

  /**
   * Finishes a card setup the customer came back from, and activates the trialing subscription it
   * was for once the card is the customer's default. The term starts then, keeping its length, so
   * time spent before a card was saved isn't billed. A setup the customer hasn't finished leaves the
   * subscription trialing; one made for another subscription is `not-found`. Repeating it, or
   * calling it for a subscription already past trialing, changes nothing.
   */
  async completeCardSetup(subscriptionId: SubscriptionId, setupRef: ProcessorRef, actor: FinanceActor): Promise<Subscription> {
    return this.#store.atomically(async () => {
      const subscription = await this.#cardSubscription(subscriptionId);
      if (subscription.status !== "trialing") return subscription;
      const account = await this.#require("account", subscription.accountId);
      if (account.processorCustomerRef === undefined) throw new EducateOsError("not-found", "card setup not found");
      if (!(await this.#processor.completeCardSetup(account.processorCustomerRef, setupRef, subscription.subscriptionId))) return subscription;
      await this.#audit(account.accountId, actor, "account.payment-method-saved", { kind: "account", id: account.accountId });
      const now = this.#now().getTime();
      const length = Date.parse(subscription.termEnd) - Date.parse(subscription.termStart);
      return await this.#activate(subscription, actor, { termStart: new Date(now).toISOString(), termEnd: new Date(now + length).toISOString() });
    });
  }

  /** Opens the processor's hosted page where the account manages its saved cards. Returns its URL. */
  async paymentMethodPortal(accountId: CommercialAccountId, returnUrl: string): Promise<string> {
    return this.#store.atomically(async () => {
      const account = await this.#require("account", accountId);
      if (account.processorCustomerRef === undefined) throw new EducateOsError("conflict", "the account has no saved payment method");
      return await this.#processor.openPaymentMethodPortal(account.processorCustomerRef, returnUrl);
    });
  }

  async #cardSubscription(subscriptionId: SubscriptionId): Promise<Subscription> {
    const subscription = await this.#reconcileStatus(subscriptionId);
    if (subscription.paymentMethod !== "card") throw new EducateOsError("validation-failed", "only a card subscription is paid by card");
    return subscription;
  }

  /**
   * Answers the fleet registry's question about a registration (SCHO-41), so the root can wire this
   * service in as its `CommercialAccountVerifier`. The account must exist, have at least one
   * contact on record (finance staff add contacts only once the CRM has verified them), and have
   * the instance linked, which staff do once that contact has confirmed it. Commerce keeps no
   * contact roles, so the stated role is the CRM's to check.
   */
  async verifyRegistration(request: RegistrationVerificationRequest): Promise<RegistrationVerification> {
    return this.#store.atomically(async () => {
      const account = await this.#store.get("account", request.commercialAccountId);
      if (account === undefined) return { outcome: "refused", reason: "unknown-account" };
      if (account.contactRefs.length === 0) return { outcome: "refused", reason: "contact-unverified" };
      if (!account.instanceIds.includes(request.instanceId)) return { outcome: "refused", reason: "instance-not-confirmed" };
      return { outcome: "verified" };
    });
  }

  // Subscriptions

  /** Starts a subscription in `trialing`, copying the plan's grace rules. */
  async startSubscription(input: StartSubscriptionRequest, actor: FinanceActor): Promise<Subscription> {
    return this.#store.atomically(async () => {
      const request = parseWire(StartSubscriptionRequest, input, "subscription request");
      await this.#require("account", request.accountId);
      const plan = this.#plan(request.planId);
      if (request.purchaseOrderId !== undefined) {
        if (request.paymentMethod !== "purchase-order") throw new EducateOsError("validation-failed", "only a purchase-order subscription names a PO");
        const po = await this.#require("purchaseOrder", request.purchaseOrderId);
        if (po.accountId !== request.accountId) throw new EducateOsError("not-found", "purchase order not found");
      }
      const subscription = parseWire(Subscription, {
        subscriptionId: this.#newId("subscription"),
        ...request,
        status: "trialing",
        graceRules: plan.graceRules,
      }, "subscription");
      await this.#store.put("subscription", subscription.subscriptionId, subscription);
      await this.#audit(subscription.accountId, actor, "subscription.started", this.#subject(subscription), undefined, { state: "trialing" });
      return subscription;
    });
  }

  /**
   * Activates a trialing subscription. A purchase-order subscription needs an approved PO; a card
   * subscription needs a processor customer.
   */
  async activate(subscriptionId: SubscriptionId, actor: FinanceActor): Promise<Subscription> {
    return this.#store.atomically(async () => this.#activate(await this.#reconcileStatus(subscriptionId), actor));
  }

  async #activate(subscription: Subscription, actor: FinanceActor, term: Partial<Subscription> = {}): Promise<Subscription> {
    if (subscription.status !== "trialing") throw new EducateOsError("conflict", "only a trialing subscription can be activated");
    if (subscription.paymentMethod === "purchase-order") {
      const po = subscription.purchaseOrderId && (await this.#store.get("purchaseOrder", subscription.purchaseOrderId));
      if (!po || po.state !== "approved") throw new EducateOsError("policy-violation", "an approved purchase order is required");
    }
    if (subscription.paymentMethod === "card") {
      const account = await this.#require("account", subscription.accountId);
      if (account.processorCustomerRef === undefined) throw new EducateOsError("policy-violation", "a processor customer is required");
    }
    return await this.#transition(subscription, { status: "active", ...term }, actor, "subscription.activated");
  }

  /** Extends the term. Delinquency from a missed payment stands until an invoice is paid. */
  async renewTerm(subscriptionId: SubscriptionId, termEnd: string, actor: FinanceActor): Promise<Subscription> {
    return this.#store.atomically(async () => {
      const end = parseWire(UtcTimestamp, termEnd, "term end");
      const subscription = await this.#reconcileStatus(subscriptionId);
      if (subscription.status === "cancelled") throw new EducateOsError("conflict", "subscription is cancelled");
      if (Date.parse(end) <= Date.parse(subscription.termEnd)) throw new EducateOsError("validation-failed", "a renewal must extend the term");
      // A delinquency that began only because the old term ended is cured by renewing it.
      const termLapse = subscription.pastDueSince !== undefined && Date.parse(subscription.pastDueSince) === Date.parse(subscription.termEnd);
      const patch: Partial<Subscription> = termLapse ? { termEnd: end, status: "active", pastDueSince: undefined } : { termEnd: end };
      return await this.#transition(subscription, patch, actor, "subscription.renewed");
    });
  }

  /**
   * Cancels a subscription. Entitlements issued afterwards are already lapsed, which blocks new
   * root-managed changes; the district's installed release, classroom features and data are
   * untouched, and commerce holds no district data to delete or return.
   */
  async cancel(subscriptionId: SubscriptionId, actor: FinanceActor): Promise<Subscription> {
    return this.#store.atomically(async () => {
      const subscription = await this.#reconcileStatus(subscriptionId);
      if (subscription.status === "cancelled") return subscription;
      return await this.#transition(subscription, { status: "cancelled", cancelledAt: this.#timestamp() }, actor, "subscription.cancelled");
    });
  }

  /**
   * Applies any clock-driven transitions now due, auditing each as the system clock: an open
   * invoice past its due date makes a paying subscription `past-due` from that date, and the
   * grace rules then move it on to `grace` and `lapsed`.
   */
  async reconcileStatus(subscriptionId: SubscriptionId): Promise<Subscription> {
    return this.#store.atomically(() => this.#reconcileStatus(subscriptionId));
  }

  async #reconcileStatus(subscriptionId: SubscriptionId): Promise<Subscription> {
    let subscription = await this.#require("subscription", subscriptionId);
    if (subscription.status === "trialing" || subscription.status === "active") {
      const now = this.#now().getTime();
      const overdue = (await this.#store.list("invoice", subscription.accountId))
        .filter((i) => i.subscriptionId === subscriptionId && i.status === "open" && Date.parse(i.dueAt) <= now)
        .map((i) => Date.parse(i.dueAt));
      if (overdue.length > 0) {
        const pastDueSince = new Date(Math.min(...overdue)).toISOString();
        subscription = await this.#transition(subscription, { status: "past-due", pastDueSince }, SYSTEM_CLOCK, "subscription.past-due");
      }
    }
    for (const step of timedTransitions(subscription, this.#now())) {
      subscription = await this.#transition(subscription, { status: step.to, pastDueSince: step.pastDueSince }, SYSTEM_CLOCK,
        `subscription.${step.to}`);
    }
    return subscription;
  }

  // Purchase orders

  /** Records a district purchase order, awaiting approval by someone other than the submitter. */
  async submitPurchaseOrder(input: SubmitPurchaseOrderRequest, actor: FinanceActor): Promise<PurchaseOrder> {
    return this.#store.atomically(async () => {
      const request = parseWire(SubmitPurchaseOrderRequest, input, "purchase order request");
      const staff = this.#staff(actor);
      await this.#require("account", request.accountId);
      const existing = await this.#store.list("purchaseOrder", request.accountId);
      if (existing.some((po) => po.poNumber === request.poNumber)) throw new EducateOsError("conflict", "PO number already recorded");
      const po = PurchaseOrder.parse({
        purchaseOrderId: this.#newId("purchaseOrder"),
        ...request,
        state: "submitted",
        submittedAt: this.#timestamp(),
        submittedBy: staff.ref,
      });
      await this.#store.put("purchaseOrder", po.purchaseOrderId, po);
      await this.#audit(po.accountId, actor, "purchase-order.submitted", this.#subject(po), undefined, { state: po.state, amountCents: po.amountCents });
      return po;
    });
  }

  /** Approves a submitted purchase order. The approver must be staff other than the submitter. */
  async approvePurchaseOrder(purchaseOrderId: PurchaseOrderId, actor: FinanceActor): Promise<PurchaseOrder> {
    return this.#store.atomically(async () => {
      return await this.#decide(purchaseOrderId, actor, "approved");
    });
  }

  /** Rejects a submitted purchase order with a reason code. */
  async rejectPurchaseOrder(purchaseOrderId: PurchaseOrderId, rejectionCode: string, actor: FinanceActor): Promise<PurchaseOrder> {
    return this.#store.atomically(async () => {
      return await this.#decide(purchaseOrderId, actor, "rejected", parseWire(OpaqueCode, rejectionCode, "rejection code"));
    });
  }

  async #decide(purchaseOrderId: PurchaseOrderId, actor: FinanceActor, state: "approved" | "rejected", rejectionCode?: string) {
    const staff = this.#staff(actor);
    const po = await this.#require("purchaseOrder", purchaseOrderId);
    if (po.state !== "submitted") throw new EducateOsError("conflict", "purchase order already decided");
    if (po.submittedBy === staff.ref) throw new EducateOsError("forbidden", "the submitter can't decide their own purchase order");
    const next = PurchaseOrder.parse({ ...po, state, decidedAt: this.#timestamp(), decidedBy: staff.ref, rejectionCode });
    await this.#store.put("purchaseOrder", po.purchaseOrderId, next);
    await this.#audit(po.accountId, actor, `purchase-order.${state}`, this.#subject(po), { state: po.state }, { state, amountCents: po.amountCents });
    return next;
  }

  // Invoices

  /**
   * Issues an invoice for EducateOS fees. Invoices against a purchase order (named, or the
   * subscription's) need it approved, and may not total more than it authorizes.
   */
  async issueInvoice(input: IssueInvoiceRequest, actor: FinanceActor): Promise<Invoice> {
    return this.#store.atomically(async () => {
      const request = parseWire(IssueInvoiceRequest, input, "invoice request");
      const account = await this.#require("account", request.accountId);
      const subscription = request.subscriptionId && (await this.#owned("subscription", request.subscriptionId, account.accountId));
      if (subscription && subscription.status === "cancelled") throw new EducateOsError("conflict", "subscription is cancelled");
      const lines: InvoiceLine[] = request.lines.map((line) => ({ ...line, amountCents: multiplyCents(line.unitAmountCents, line.quantity) }));
      if (request.aiUsageHeartbeat !== undefined) {
        const report = this.#aiUsageReportLine(account, subscription || undefined, request.aiUsageHeartbeat);
        if (report !== undefined) lines.push(report);
      }
      const subtotalCents = sumCents(lines.map((line) => line.amountCents));
      const purchaseOrderId = request.purchaseOrderId ?? (subscription ? subscription.purchaseOrderId : undefined);
      if (purchaseOrderId !== undefined) await this.#checkPurchaseOrderHeadroom(account.accountId, purchaseOrderId, subtotalCents);
      const invoice = parseWire(Invoice, {
        invoiceId: this.#newId("invoice"),
        accountId: account.accountId,
        subscriptionId: request.subscriptionId,
        purchaseOrderId,
        lines,
        subtotalCents,
        creditsAppliedCents: 0,
        totalCents: subtotalCents,
        status: subtotalCents === 0 ? "paid" : "open",
        issuedAt: this.#timestamp(),
        dueAt: request.dueAt,
      }, "invoice");
      await this.#store.put("invoice", invoice.invoiceId, invoice);
      await this.#audit(invoice.accountId, actor, "invoice.issued", this.#subject(invoice), undefined, { state: invoice.status, amountCents: invoice.totalCents });
      return invoice;
    });
  }

  // The heartbeat's figure is the district's own AI Gateway spend, already on its Cloudflare bill,
  // so the invoice reports it and charges nothing (SCHO-98). It is the one aggregate number an
  // opted-in heartbeat carries, never anything per person, and it is reported in nanodollars as
  // the heartbeat counts it: nothing is charged, so nothing is rounded to the cent (ADR-0008).
  #aiUsageReportLine(account: CommercialAccount, subscription: Subscription | undefined, heartbeat: Heartbeat): InvoiceLine | undefined {
    if (account.aiUsageSharing !== "opted-in") throw new EducateOsError("policy-violation", "district has not opted in to sharing AI usage");
    if (!account.instanceIds.includes(heartbeat.instanceId)) throw new EducateOsError("not-found", "instance not found");
    if (subscription === undefined) throw new EducateOsError("validation-failed", "AI usage is reported against a subscription");
    if (heartbeat.aggregateAiSpendUsdNano === undefined) return undefined;
    return { kind: "ai-usage-report", code: "ai-gateway-spend", quantity: 1, unitAmountCents: 0, amountCents: 0, reportedUsdNano: heartbeat.aggregateAiSpendUsdNano };
  }

  async #checkPurchaseOrderHeadroom(accountId: CommercialAccountId, purchaseOrderId: PurchaseOrderId, subtotalCents: number) {
    const po = await this.#owned("purchaseOrder", purchaseOrderId, accountId);
    if (po.state !== "approved") throw new EducateOsError("policy-violation", "purchase order is not approved");
    const invoiced = sumCents(
      (await this.#store.list("invoice", accountId)).filter((i) => i.purchaseOrderId === purchaseOrderId).map((i) => i.subtotalCents),
    );
    if (invoiced + subtotalCents > po.amountCents) throw new EducateOsError("conflict", "invoice exceeds the purchase order's remaining amount");
  }

  // Grants and credits

  /** Awards grant credits: a grant record and its `awarded` ledger entry. */
  async awardGrant(input: AwardGrantRequest, actor: FinanceActor): Promise<Grant> {
    return this.#store.atomically(async () => {
      const request = parseWire(AwardGrantRequest, input, "grant request");
      await this.#require("account", request.accountId);
      const grant = parseWire(Grant, { grantId: this.#newId("grant"), ...request, awardedAt: this.#timestamp() }, "grant");
      await this.#store.put("grant", grant.grantId, grant);
      await this.#credit(grant, "awarded", grant.awardedCents);
      await this.#audit(grant.accountId, actor, "grant.awarded", this.#subject(grant), undefined, { amountCents: grant.awardedCents });
      return grant;
    });
  }

  /** Grant credit an account can apply now: the balances of its unexpired grants. */
  async availableCredits(accountId: CommercialAccountId): Promise<number> {
    return this.#store.atomically(async () => {
      const balances = await this.#grantBalances(accountId);
      return sumCents(balances.filter(({ grant }) => this.#unexpired(grant)).map(({ balanceCents }) => balanceCents));
    });
  }

  /** Writes an `expired` entry for the remaining balance of every grant past its expiry. Idempotent. */
  async expireGrants(accountId: CommercialAccountId): Promise<void> {
    return this.#store.atomically(() => this.#expireGrants(accountId));
  }

  async #expireGrants(accountId: CommercialAccountId): Promise<void> {
    for (const { grant, balanceCents } of await this.#grantBalances(accountId)) {
      if (this.#unexpired(grant) || balanceCents <= 0) continue;
      await this.#credit(grant, "expired", -balanceCents);
      await this.#audit(accountId, SYSTEM_CLOCK, "grant.expired", this.#subject(grant), { amountCents: balanceCents }, { amountCents: 0 });
    }
  }

  /**
   * Applies unexpired grant credit to an open invoice, soonest-expiring grant first, up to what is
   * still owed. Expired grants are expired first, so their credit can't be spent late.
   */
  async applyGrantCredits(invoiceId: InvoiceId, actor: FinanceActor): Promise<Invoice> {
    return this.#store.atomically(async () => {
      let invoice = await this.#require("invoice", invoiceId);
      if (invoice.status !== "open") throw new EducateOsError("conflict", "invoice is not open");
      await this.#expireGrants(invoice.accountId);
      let owed = await this.#owed(invoice);
      let applied = 0;
      const grants = (await this.#grantBalances(invoice.accountId))
        .filter(({ grant, balanceCents }) => this.#unexpired(grant) && balanceCents > 0)
        .toSorted((a, b) => Date.parse(a.grant.expiresAt) - Date.parse(b.grant.expiresAt));
      for (const { grant, balanceCents } of grants) {
        if (owed <= 0) break;
        const amount = Math.min(owed, balanceCents);
        await this.#credit(grant, "applied", -amount, invoice.invoiceId);
        owed -= amount;
        applied += amount;
      }
      if (applied === 0) return invoice;
      const before = invoice;
      invoice = Invoice.parse({ ...invoice, creditsAppliedCents: invoice.creditsAppliedCents + applied, totalCents: invoice.totalCents - applied });
      await this.#store.put("invoice", invoice.invoiceId, invoice);
      await this.#audit(invoice.accountId, actor, "invoice.credits-applied", this.#subject(invoice),
        { state: before.status, amountCents: before.totalCents }, { state: invoice.status, amountCents: invoice.totalCents });
      return await this.#settle(invoice, actor);
    });
  }

  // Payments

  /** Asks the processor to charge what is still owed on an invoice. The outcome arrives by webhook. */
  async chargeInvoice(invoiceId: InvoiceId, actor: FinanceActor): Promise<ProcessorRef> {
    return this.#store.atomically(async () => {
      const invoice = await this.#require("invoice", invoiceId);
      const account = await this.#require("account", invoice.accountId);
      if (account.processorCustomerRef === undefined) throw new EducateOsError("policy-violation", "a processor customer is required");
      const owed = await this.#owed(invoice);
      if (invoice.status !== "open" || owed <= 0) throw new EducateOsError("conflict", "nothing is owed on this invoice");
      // Keyed on what has been paid and how many attempts were declined: repeating a request while
      // its charge is pending reuses that charge, but a retry after a decline is a new charge.
      const declined = (await this.#store.list("processorOperation", invoice.accountId)).filter(
        (op) => op.kind === "charge" && op.invoiceId === invoice.invoiceId && op.outcome === "failed",
      ).length;
      const idempotencyKey = `${invoice.invoiceId}:${invoice.totalCents - owed}:${declined}`;
      const chargeRef = await this.#processor.charge({ customerRef: account.processorCustomerRef, amountCents: owed, idempotencyKey });
      await this.#store.put("processorOperation", chargeRef, {
        processorRef: chargeRef, accountId: invoice.accountId, kind: "charge", invoiceId: invoice.invoiceId, amountCents: owed,
      });
      await this.#audit(invoice.accountId, actor, "invoice.charge-requested", this.#subject(invoice), undefined, { state: "requested", amountCents: owed });
      return chargeRef;
    });
  }

  /** Records a payment received outside the processor (a PO remittance, a check), by its remittance code. */
  async recordManualPayment(invoiceId: InvoiceId, amountCents: number, reference: string, actor: FinanceActor): Promise<Invoice> {
    return this.#store.atomically(async () => {
      const amount = parseWire(Cents.min(1), amountCents, "amount");
      const code = parseWire(OpaqueCode, reference, "remittance reference");
      this.#staff(actor);
      const invoice = await this.#require("invoice", invoiceId);
      if (amount > (await this.#owed(invoice))) throw new EducateOsError("conflict", "payment exceeds what is owed");
      await this.#recordPayment(invoice, "manual", amount, code, actor);
      return await this.#settle(invoice, actor);
    });
  }

  /** Asks the processor to refund (part of) a charge. The refund is recorded when its webhook arrives. */
  async refundPayment(paymentId: PaymentId, amountCents: number, actor: FinanceActor): Promise<ProcessorRef> {
    return this.#store.atomically(async () => {
      const amount = parseWire(Cents.min(1), amountCents, "amount");
      this.#staff(actor);
      const payment = await this.#findPayment(paymentId);
      if (payment.kind !== "charge") throw new EducateOsError("conflict", "only processor charges are refunded through the processor");
      const refunded = sumCents(
        (await this.#store.entries("payment", payment.accountId)).filter((p) => p.refundOf === paymentId).map((p) => p.amountCents),
      );
      if (amount > payment.amountCents - refunded) throw new EducateOsError("conflict", "refund exceeds the unrefunded amount");
      const refundRef = await this.#processor.refund({ chargeRef: payment.reference, amountCents: amount, idempotencyKey: `${paymentId}:${refunded}` });
      await this.#store.put("processorOperation", refundRef, {
        processorRef: refundRef, accountId: payment.accountId, kind: "refund", invoiceId: payment.invoiceId, amountCents: amount, refundOf: paymentId,
      });
      await this.#audit(payment.accountId, actor, "payment.refund-requested", { kind: "payment", id: paymentId }, undefined, { state: "requested", amountCents: amount });
      return refundRef;
    });
  }

  /**
   * Applies a processor webhook delivery. Each event is applied once, by event ID: a redelivery
   * returns `duplicate` and changes nothing. A failed charge makes the invoice's subscription
   * `past-due`; a successful one is recorded as a payment and may settle the invoice, reactivating
   * a delinquent subscription.
   */
  async handleProcessorDelivery(delivery: unknown): Promise<ProcessorDeliveryOutcome> {
    const event = await this.#processor.mapWebhookEvent(delivery);
    if (event === undefined) return { outcome: "ignored" };
    return this.#store.atomically(async () => {
      if (await this.#store.hasProcessedEvent(event.eventId)) return { outcome: "duplicate", eventId: event.eventId };
      const applied = await this.#applyEvent(event);
      await this.#store.markEventProcessed(event.eventId);
      return { outcome: applied ? "applied" : "duplicate", eventId: event.eventId };
    });
  }

  // Returns false for an event about an operation whose outcome is already recorded. A processor
  // may report one outcome under several event IDs (Stripe sends refund.created and then
  // refund.updated for one refund), so event IDs alone don't stop money being counted twice. Once
  // an operation succeeded it is settled; a declined charge can still succeed on a later attempt.
  async #applyEvent(event: ProcessorEvent): Promise<boolean> {
    const operation = await this.#store.get("processorOperation", event.operationRef);
    if (operation === undefined || operation.kind !== (event.type === "refund.succeeded" ? "refund" : "charge")) {
      throw new UnmatchedProcessorEventError(event.eventId, event.operationRef);
    }
    const outcome = event.type === "charge.failed" ? "failed" : "succeeded";
    if (operation.outcome === "succeeded" || operation.outcome === outcome) return false;
    const actor: FinanceActor = { kind: "processor", ref: "webhook" };
    await this.#store.put("processorOperation", operation.processorRef, { ...operation, outcome });
    const invoice = await this.#require("invoice", operation.invoiceId);
    switch (event.type) {
      case "charge.succeeded":
        await this.#recordPayment(invoice, "charge", event.amountCents, event.operationRef, actor);
        await this.#settle(invoice, actor);
        return true;
      case "refund.succeeded":
        await this.#recordPayment(invoice, "refund", event.amountCents, event.operationRef, actor, operation.refundOf);
        await this.#settle(invoice, actor);
        return true;
      case "charge.failed": {
        if (invoice.subscriptionId === undefined) return true;
        const subscription = await this.#reconcileStatus(invoice.subscriptionId);
        if (subscription.status === "trialing" || subscription.status === "active") {
          await this.#transition(subscription, { status: "past-due", pastDueSince: this.#timestamp() }, actor, "subscription.past-due");
          // With no past-due days the subscription is in grace at once.
          await this.#reconcileStatus(subscription.subscriptionId);
        }
        return true;
      }
    }
  }

  // Entitlements

  /**
   * Issues the signed entitlement for one of the account's instances from its subscription's
   * current status, after applying any grace transitions now due. The window is chosen so the
   * district's `EntitlementCache` follows the grace rules on its own clock: valid while paid or
   * past-due, grace during the grace period, lapsed after; lapsed and cancelled subscriptions get a
   * window that has already closed. The plan's capability packs stay listed either way, because
   * lapsing stops new root-managed changes, not what the district already runs.
   */
  async issueEntitlement(subscriptionId: SubscriptionId, instanceId: InstanceId, actor: FinanceActor): Promise<SignedEnvelope> {
    return this.#store.atomically(async () => {
      const subscription = await this.#reconcileStatus(subscriptionId);
      const account = await this.#require("account", subscription.accountId);
      if (!account.instanceIds.includes(instanceId)) throw new EducateOsError("not-found", "instance not found");
      const now = this.#now();
      const revision = await this.#store.nextEntitlementRevision(instanceId);
      const entitlement = Entitlement.parse({
        instanceId,
        revision,
        capabilityIds: this.#plan(subscription.planId).capabilityIds,
        issuedAt: now.toISOString(),
        ...entitlementWindow(subscription, now),
      });
      const envelope = await signEnvelope(this.#signer, "entitlement", entitlement);
      await this.#audit(account.accountId, actor, "entitlement.issued", { kind: "instance", id: instanceId }, undefined, {
        state: subscription.status,
        revision,
      });
      return envelope;
    });
  }

  // Reading

  /** The account's finance audit trail, oldest first. */
  async auditTrail(accountId: CommercialAccountId): Promise<FinanceAuditEvent[]> {
    return this.#store.atomically(async () => {
      return await this.#store.entries("audit", accountId);
    });
  }

  /** Verifies the account's audit hash chain (see {@link verifyFinanceAuditChain}). Changes nothing. */
  async verifyAuditTrail(accountId: CommercialAccountId): Promise<AuditChainVerification> {
    return verifyFinanceAuditChain(await this.auditTrail(accountId));
  }

  /** A subscription, as stored. */
  async subscription(subscriptionId: SubscriptionId): Promise<Subscription> {
    return this.#store.atomically(async () => {
      return await this.#require("subscription", subscriptionId);
    });
  }

  /** The account's subscriptions, as stored, after applying any clock-driven transitions now due. */
  async subscriptions(accountId: CommercialAccountId): Promise<Subscription[]> {
    return this.#store.atomically(async () => {
      const stored = await this.#store.list("subscription", accountId);
      return Promise.all(stored.map((subscription) => this.#reconcileStatus(subscription.subscriptionId)));
    });
  }

  /** The account, if it has been opened. */
  async account(accountId: CommercialAccountId): Promise<CommercialAccount | undefined> {
    return this.#store.atomically(async () => {
      return await this.#store.get("account", accountId);
    });
  }

  /** The account's invoices, as stored. */
  async invoices(accountId: CommercialAccountId): Promise<Invoice[]> {
    return this.#store.atomically(async () => {
      return await this.#store.list("invoice", accountId);
    });
  }

  /** Where the invoice's charge stands (see {@link InvoiceChargeState}). */
  async chargeState(invoiceId: InvoiceId): Promise<InvoiceChargeState> {
    return this.#store.atomically(async () => {
      const invoice = await this.#require("invoice", invoiceId);
      if (invoice.status === "paid") return "paid";
      const charges = (await this.#store.list("processorOperation", invoice.accountId)).filter(
        (op) => op.kind === "charge" && op.invoiceId === invoice.invoiceId,
      );
      if (charges.some((op) => op.outcome !== "failed")) return "pending";
      return charges.length > 0 ? "declined" : "uncharged";
    });
  }

  /** An invoice, as stored. */
  async invoice(invoiceId: InvoiceId): Promise<Invoice> {
    return this.#store.atomically(async () => {
      return await this.#require("invoice", invoiceId);
    });
  }

  /** The account's payment records, oldest first. */
  async payments(accountId: CommercialAccountId): Promise<Payment[]> {
    return this.#store.atomically(async () => {
      return await this.#store.entries("payment", accountId);
    });
  }

  /** The account's grant credit ledger, oldest first. */
  async creditLedger(accountId: CommercialAccountId): Promise<CreditEntry[]> {
    return this.#store.atomically(async () => {
      return await this.#store.entries("credit", accountId);
    });
  }

  /** Reconciles the account's invoices against its payments and grant credits. Changes nothing. */
  async reconciliationReport(accountId: CommercialAccountId): Promise<ReconciliationReport> {
    return this.#store.atomically(async () => {
      await this.#require("account", accountId);
      return reconcile({
        accountId,
        invoices: await this.#store.list("invoice", accountId),
        payments: await this.#store.entries("payment", accountId),
        credits: await this.#store.entries("credit", accountId),
        grants: await this.#store.list("grant", accountId),
      });
    });
  }

  // Internals

  async #recordPayment(invoice: Invoice, kind: Payment["kind"], amountCents: number, reference: string, actor: FinanceActor, refundOf?: PaymentId) {
    const payment = Payment.parse({
      paymentId: this.#newId("payment"), accountId: invoice.accountId, invoiceId: invoice.invoiceId, kind, amountCents, reference, refundOf,
      recordedAt: this.#timestamp(),
    });
    await this.#store.append("payment", payment);
    await this.#audit(invoice.accountId, actor, kind === "refund" ? "payment.refunded" : "payment.recorded", { kind: "payment", id: payment.paymentId },
      undefined, { state: kind, amountCents: kind === "refund" ? -amountCents : amountCents });
  }

  // Brings an invoice's status in line with its balance, and reactivates its subscription when a
  // payment clears a delinquency.
  async #settle(stale: Invoice, actor: FinanceActor): Promise<Invoice> {
    const invoice = await this.#require("invoice", stale.invoiceId);
    const status = (await this.#owed(invoice)) <= 0 ? "paid" : "open";
    if (status === invoice.status) return invoice;
    const next = Invoice.parse({ ...invoice, status });
    await this.#store.put("invoice", next.invoiceId, next);
    if (status === "paid") {
      await this.#audit(next.accountId, actor, "invoice.paid", this.#subject(next), { state: invoice.status }, { state: status });
      if (next.subscriptionId !== undefined) {
        const subscription = await this.#reconcileStatus(next.subscriptionId);
        if (DELINQUENT.has(subscription.status)) {
          await this.#transition(subscription, { status: "active", pastDueSince: undefined }, actor, "subscription.reactivated");
        }
      }
    } else {
      await this.#audit(next.accountId, actor, "invoice.reopened", this.#subject(next), { state: invoice.status }, { state: status });
    }
    return next;
  }

  // What is still owed: the invoice total less net payments.
  async #owed(invoice: Invoice): Promise<number> {
    const payments = (await this.#store.entries("payment", invoice.accountId)).filter((p) => p.invoiceId === invoice.invoiceId);
    const net = sumCents(payments.map((p) => (p.kind === "refund" ? -p.amountCents : p.amountCents)));
    return subtractCents(invoice.totalCents, net);
  }

  async #findPayment(paymentId: PaymentId): Promise<Payment> {
    const id = parseWire(PaymentId, paymentId, "payment ID");
    for (const account of await this.#store.list("account")) {
      const payment = (await this.#store.entries("payment", account.accountId)).find((p) => p.paymentId === id);
      if (payment) return payment;
    }
    throw new EducateOsError("not-found", "payment not found");
  }

  async #grantBalances(accountId: CommercialAccountId): Promise<{ grant: Grant; balanceCents: number }[]> {
    const entries = await this.#store.entries("credit", accountId);
    return (await this.#store.list("grant", accountId)).map((grant) => ({
      grant,
      balanceCents: sumCents(entries.filter((e) => e.grantId === grant.grantId).map((e) => e.amountCents)),
    }));
  }

  #unexpired(grant: Grant): boolean {
    return this.#now().getTime() < Date.parse(grant.expiresAt);
  }

  async #credit(grant: Grant, kind: CreditEntry["kind"], amountCents: number, invoiceId?: InvoiceId): Promise<void> {
    await this.#store.append("credit", CreditEntry.parse({
      entryId: this.#newId("creditEntry"), accountId: grant.accountId, grantId: grant.grantId, kind, amountCents, invoiceId, recordedAt: this.#timestamp(),
    }));
  }

  async #transition(subscription: Subscription, patch: Partial<Subscription>, actor: FinanceActor, action: FinanceAction): Promise<Subscription> {
    const next = Subscription.parse({ ...subscription, ...patch });
    await this.#store.put("subscription", next.subscriptionId, next);
    await this.#audit(next.accountId, actor, action, this.#subject(next), { state: subscription.status }, { state: next.status });
    return next;
  }

  async #audit(
    accountId: CommercialAccountId,
    actor: FinanceActor,
    action: FinanceAction,
    subject: FinanceSubject,
    before?: FinanceStateSummary,
    after?: FinanceStateSummary,
  ): Promise<void> {
    // Chained onto the account's newest event. The step is atomic and serialized, so no two events
    // can claim the same predecessor.
    const event = await chainFinanceAuditEvent({
      eventId: FinanceAuditEventId.parse(this.#newId("auditEvent")),
      accountId,
      actor: parseWire(FinanceActor, actor, "finance actor"),
      action,
      subject,
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
      at: this.#timestamp(),
    }, await this.#store.lastEntry("audit", accountId));
    await this.#store.append("audit", event);
  }

  #subject(record: Subscription | PurchaseOrder | Invoice | Grant): FinanceSubject {
    if ("invoiceId" in record) return { kind: "invoice", id: record.invoiceId };
    if ("subscriptionId" in record) return { kind: "subscription", id: record.subscriptionId };
    if ("grantId" in record) return { kind: "grant", id: record.grantId };
    return { kind: "purchase-order", id: record.purchaseOrderId };
  }

  #staff(actor: FinanceActor): FinanceActor {
    const parsed = parseWire(FinanceActor, actor, "finance actor");
    if (parsed.kind !== "staff") throw new EducateOsError("forbidden", "only finance staff may do this");
    return parsed;
  }

  #plan(planId: PlanId): Plan {
    const plan = this.#plans.get(planId);
    if (plan === undefined) throw new EducateOsError("not-found", "plan not found");
    return plan;
  }

  async #require<K extends keyof CommerceRecords>(kind: K, id: string): Promise<CommerceRecords[K]> {
    const record = await this.#store.get(kind, id);
    if (record === undefined) throw new EducateOsError("not-found", `${kind} not found`);
    return record;
  }

  // A record of another account is reported as missing, so one account can't probe another's IDs.
  async #owned<K extends "subscription" | "purchaseOrder">(kind: K, id: string, accountId: CommercialAccountId): Promise<CommerceRecords[K]> {
    const record = await this.#require(kind, id);
    if (record.accountId !== accountId) throw new EducateOsError("not-found", `${kind} not found`);
    return record;
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }
}
