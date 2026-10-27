// Billing on educateos.io for managed services (SCHO-208). An operator subscribes their account to a
// plan; Stripe Checkout, in setup mode, saves their card and charges nothing; coming back from it
// activates the subscription and charges its first invoice to that card. Commerce
// (`@educateos/commerce`) keeps the subscriptions, invoices and the finance audit; Stripe only holds
// the card, which the operator manages in Stripe's Customer Portal. Cancelling is the operator's
// own button here: the portal can cancel only subscriptions Stripe runs, and Stripe runs none.
//
// Billing pays for what educateos.io itself does: the managed hostname, guided updates, support.
// An installation never checks it (ADR-0013): one that stops paying keeps running and keeps its data.
import { CommercialAccountId, EducateOsError, type ErrorCode } from "@educateos/contracts";
import {
  CommerceService,
  type CommerceStore,
  type FinanceActor,
  type Invoice,
  type InvoiceChargeState,
  type PaymentProcessor,
  type Plan,
  PlanId,
  SETUP_REF_PLACEHOLDER,
  type Subscription,
  UnmatchedProcessorEventError,
} from "@educateos/commerce";
import { SerialQueue, type SigningIdentity } from "@educateos/fleet";
import type { Operator } from "./store.ts";

/** A plan as the billing page offers it. */
export interface ManagedPlan {
  plan: Plan;
  name: string;
  summary: string;
}

/** How long one term runs. A plan's fee is per term. */
export const TERM_DAYS = 30;

/** How long after it is issued an invoice falls due. Until then a declined charge can be retried without the subscription going past due. */
export const INVOICE_DUE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The plans. Every price here is a placeholder, shown as one on the page: pricing is the owner's
 * decision before billing goes live (SCHO-208), and until then Stripe runs in test mode only.
 */
export const MANAGED_PLANS: readonly ManagedPlan[] = [
  {
    name: "Managed hostname",
    summary: "Your installation at <slug>.educateos.io, with its certificate and sign-in destination kept up by educateos.io.",
    plan: managedPlan("pln_managed-hostname", "pilot", ["managed-hostname"], 100),
  },
  {
    name: "Guided updates",
    summary: "The managed hostname, plus each signed release applied for you from the console.",
    plan: managedPlan("pln_guided-updates", "standard", ["managed-hostname", "guided-updates"], 200),
  },
  {
    name: "Supported",
    summary: "Guided updates, plus support from the EducateOS team.",
    plan: managedPlan("pln_supported", "enterprise", ["managed-hostname", "guided-updates", "support"], 300),
  },
];

/** The words every price on the billing page carries until pricing is decided. */
export const PLACEHOLDER_PRICE_NOTE = "Placeholder price: pricing isn't decided yet";

function managedPlan(planId: string, tier: Plan["tier"], capabilityIds: string[], termFeeCents: number): Plan {
  return {
    planId: PlanId.parse(planId),
    tier,
    capabilityIds: capabilityIds as Plan["capabilityIds"],
    enrollmentBand: { minEnrollment: 0 },
    termFeeCents,
    graceRules: { pastDueDays: 14, graceDays: 30 },
  };
}

/** What a billing operation gave: its value, or why it was refused. */
export type BillingReply<T> = { ok: true; value: T } | { ok: false; code: ErrorCode; message: string };

/** What the billing page shows an operator. */
export interface BillingOverview {
  /** The organization the account is billed as, once it has subscribed. */
  organization?: string;
  /** Whether a card is on file, so the portal can be opened. */
  hasCustomer: boolean;
  /** The newest subscription that isn't cancelled, if any. */
  subscription?: Subscription;
  /** Every invoice, newest first, with where its charge stands. */
  invoices: BilledInvoice[];
}

/** An invoice and where its charge stands. */
export interface BilledInvoice {
  invoice: Invoice;
  charge: InvoiceChargeState;
}

/**
 * What coming back from Stripe's card setup gave: the subscription, and once it is active, where
 * its first invoice's charge stands.
 */
export interface CardSetupOutcome {
  subscription: Subscription;
  charge?: InvoiceChargeState;
}

/** What the routes need from billing. The Durable Object's RPC stub satisfies it. */
export interface BillingApi {
  billingOverview(operator: Operator): Promise<BillingReply<BillingOverview>>;
  subscribe(operator: Operator, planId: string, organization: string, origin: string): Promise<BillingReply<{ url: string }>>;
  resumeCardSetup(operator: Operator, origin: string): Promise<BillingReply<{ url: string }>>;
  completeCardSetup(operator: Operator, subscriptionId: string, setupRef: string): Promise<BillingReply<CardSetupOutcome>>;
  payInvoice(operator: Operator): Promise<BillingReply<InvoiceChargeState>>;
  paymentMethodPortal(operator: Operator, origin: string): Promise<BillingReply<{ url: string }>>;
  cancelSubscription(operator: Operator): Promise<BillingReply<Subscription>>;
  receiveStripeWebhook(payload: string, signature: string): Promise<BillingReply<{ outcome: string }>>;
}

/** Where the routes are. */
export const BILLING_PATHS = {
  page: "/app/billing",
  subscribe: "/app/billing/subscribe",
  card: "/app/billing/card",
  ret: "/app/billing/return",
  portal: "/app/billing/portal",
  pay: "/app/billing/pay",
  cancel: "/app/billing/cancel",
  webhook: "/stripe/webhook",
} as const;

/** What {@link ControlPlaneBilling} needs. */
export interface ControlPlaneBillingOptions {
  store: CommerceStore;
  processor: PaymentProcessor;
  /** The root's entitlement signing key. Billing issues no entitlements yet; commerce requires one. */
  signer: SigningIdentity;
  now?: () => Date;
}

/**
 * Billing over commerce, for one operator at a time. Each operator's account is their `acct_…`,
 * opened when they first subscribe. They act as a customer, never as finance staff.
 */
export class ControlPlaneBilling {
  readonly #commerce: CommerceService;
  readonly #now: () => Date;
  // An operation spans several commerce steps, so operations run one at a time: two submits of
  // the subscribe form can't both find no subscription and start two.
  readonly #queue = new SerialQueue();

  constructor(options: ControlPlaneBillingOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#commerce = new CommerceService({
      store: options.store,
      processor: options.processor,
      plans: MANAGED_PLANS.map(({ plan }) => plan),
      entitlementSigner: options.signer,
      now: this.#now,
    });
  }

  overview(operator: Operator): Promise<BillingReply<BillingOverview>> {
    return this.#serial(async () => {
      const account = await this.#commerce.account(operator.accountId);
      if (account === undefined) return { hasCustomer: false, invoices: [] };
      const invoices = await Promise.all((await this.#commerce.invoices(account.accountId))
        .toSorted((a, b) => b.issuedAt.localeCompare(a.issuedAt))
        .map(async (invoice) => ({ invoice, charge: await this.#commerce.chargeState(invoice.invoiceId) })));
      const subscription = await this.#current(account.accountId);
      return {
        organization: account.districtLabel,
        hasCustomer: account.processorCustomerRef !== undefined,
        ...(subscription === undefined ? {} : { subscription }),
        invoices,
      };
    });
  }

  /**
   * Opens the operator's account if need be, starts a trialing card subscription to the plan for
   * one term, and opens Stripe's card setup page for it. Refused while another subscription runs.
   */
  subscribe(operator: Operator, planId: string, organization: string, origin: string): Promise<BillingReply<{ url: string }>> {
    return this.#serial(async () => {
      const plan = PlanId.safeParse(planId);
      if (!plan.success || !MANAGED_PLANS.some(({ plan: offered }) => offered.planId === plan.data)) {
        throw new EducateOsError("validation-failed", "choose one of the plans");
      }
      const label = organization.trim();
      if (label.length === 0 || label.length > 120) throw new EducateOsError("validation-failed", "name the organization billed, in at most 120 characters");
      const actor = customer(operator);
      if ((await this.#commerce.account(operator.accountId)) === undefined) {
        await this.#commerce.openAccount({ accountId: operator.accountId, districtLabel: label }, actor);
      }
      if ((await this.#current(operator.accountId)) !== undefined) throw new EducateOsError("conflict", "the account already has a subscription");
      const start = this.#now();
      const subscription = await this.#commerce.startSubscription({
        accountId: operator.accountId,
        planId: plan.data,
        paymentMethod: "card",
        termStart: start.toISOString(),
        termEnd: new Date(start.getTime() + TERM_DAYS * DAY_MS).toISOString(),
      }, actor);
      return await this.#cardSetup(subscription, origin, actor);
    });
  }

  /** Opens a new card setup page for the operator's trialing subscription: one left before a card was saved. */
  resumeCardSetup(operator: Operator, origin: string): Promise<BillingReply<{ url: string }>> {
    return this.#serial(async () => {
      const subscription = await this.#current(operator.accountId);
      if (subscription?.status !== "trialing") throw new EducateOsError("conflict", "no subscription is waiting for a card");
      return await this.#cardSetup(subscription, origin, customer(operator));
    });
  }

  /**
   * Finishes the card setup the operator came back from. Once the subscription is active, its
   * term's invoice is issued if it hasn't been and charged to the saved card unless a charge is
   * already paid, on its way, or was declined (which the operator retries with Pay now). Coming
   * back again therefore issues no second invoice, and finishes a charge an earlier visit couldn't
   * make: Stripe unreachable, or the object restarted between the steps. The charge's outcome
   * arrives by webhook.
   */
  completeCardSetup(operator: Operator, subscriptionId: string, setupRef: string): Promise<BillingReply<CardSetupOutcome>> {
    return this.#serial(async () => {
      const subscription = await this.#owned(operator, subscriptionId);
      const actor = customer(operator);
      const after = await this.#commerce.completeCardSetup(subscription.subscriptionId, setupRef, actor);
      if (after.status !== "active") return { subscription: after };
      const invoice = await this.#firstInvoice(operator, after, actor);
      let charge = await this.#commerce.chargeState(invoice.invoiceId);
      if (charge === "uncharged") charge = await this.#charge(invoice, actor, { retryLater: true });
      return { subscription: after, charge };
    });
  }

  /**
   * Charges the current subscription's open invoice to the saved card: one never charged, or whose
   * charges were all declined (a new charge, after the operator updated their card). Refused while
   * a charge is on its way.
   */
  payInvoice(operator: Operator): Promise<BillingReply<InvoiceChargeState>> {
    return this.#serial(async () => {
      const subscription = await this.#current(operator.accountId);
      const open = subscription === undefined
        ? undefined
        : (await this.#commerce.invoices(operator.accountId))
          .filter((invoice) => invoice.subscriptionId === subscription.subscriptionId && invoice.status === "open")
          .toSorted((a, b) => b.issuedAt.localeCompare(a.issuedAt))[0];
      if (open === undefined) throw new EducateOsError("not-found", "there is no open invoice to pay");
      // What Stripe holds first: a charge made but never answered is pending, or already settled.
      await this.#commerce.reconcileCharges(open.invoiceId);
      const state = await this.#commerce.chargeState(open.invoiceId);
      if (state === "pending") throw new EducateOsError("conflict", "a charge for this invoice is already on its way");
      if (state === "paid") return state;
      return await this.#charge(open, customer(operator), { retryLater: false });
    });
  }

  /** Opens Stripe's Customer Portal, where the operator manages their saved cards. */
  paymentMethodPortal(operator: Operator, origin: string): Promise<BillingReply<{ url: string }>> {
    return this.#serial(async () => {
      if ((await this.#commerce.account(operator.accountId)) === undefined) throw new EducateOsError("conflict", "the account has no saved payment method");
      return { url: await this.#commerce.paymentMethodPortal(operator.accountId, `${origin}${BILLING_PATHS.page}`) };
    });
  }

  /**
   * Cancels the operator's subscription. Nothing more is charged for it; their installations keep
   * running and keep their data (ADR-0013). Serialized with the return from Stripe, so a cancel
   * can't land between activation and the first invoice, and commerce refuses to invoice a
   * cancelled subscription anyway.
   */
  cancelSubscription(operator: Operator): Promise<BillingReply<Subscription>> {
    return this.#serial(async () => {
      const subscription = await this.#current(operator.accountId);
      if (subscription === undefined) throw new EducateOsError("not-found", "the account has no subscription to cancel");
      return await this.#commerce.cancel(subscription.subscriptionId, customer(operator));
    });
  }

  /**
   * Applies a Stripe webhook delivery, verified against the endpoint's signing secret first. Each
   * event is applied once, by its ID. An event about a charge commerce has no record of yet is
   * `unmatched`, logged by Stripe's IDs, and answered with a 503 by the route, so Stripe keeps
   * redelivering it (for up to three days): a charge whose creation reply was lost is recorded the
   * next time its invoice is charged or reconciled, and the redelivery then matches it.
   */
  receiveStripeWebhook(payload: string, signature: string): Promise<BillingReply<{ outcome: string }>> {
    return reply(async () => {
      try {
        const { outcome } = await this.#commerce.handleProcessorDelivery({ payload, signature });
        return { outcome };
      } catch (error) {
        if (error instanceof UnmatchedProcessorEventError) {
          console.error("stripe webhook unmatched", { eventId: error.eventId, operationRef: error.operationRef });
          return { outcome: "unmatched" };
        }
        throw error;
      }
    });
  }

  // The subscription's invoice, issued now if it has none.
  async #firstInvoice(operator: Operator, subscription: Subscription, actor: FinanceActor): Promise<Invoice> {
    const issued = (await this.#commerce.invoices(operator.accountId))
      .filter((invoice) => invoice.subscriptionId === subscription.subscriptionId)
      .toSorted((a, b) => a.issuedAt.localeCompare(b.issuedAt))[0];
    if (issued !== undefined) return issued;
    const plan = MANAGED_PLANS.find(({ plan: offered }) => offered.planId === subscription.planId)!.plan;
    return await this.#commerce.issueInvoice({
      accountId: operator.accountId,
      subscriptionId: subscription.subscriptionId,
      lines: [{ kind: "plan-fee", code: plan.planId.slice("pln_".length), quantity: 1, unitAmountCents: plan.termFeeCents }],
      dueAt: new Date(this.#now().getTime() + INVOICE_DUE_DAYS * DAY_MS).toISOString(),
    }, actor);
  }

  // Requests the charge and reports where it then stands. With `retryLater`, a Stripe that can't
  // be reached leaves the invoice uncharged, for the next return or Pay now, instead of failing.
  async #charge(invoice: Invoice, actor: FinanceActor, { retryLater }: { retryLater: boolean }): Promise<InvoiceChargeState> {
    if (invoice.status !== "open") return await this.#commerce.chargeState(invoice.invoiceId);
    try {
      // chargeInvoice reconciles with Stripe first: a charge made but never answered is found and
      // recorded, and settles the invoice or stays pending, instead of being made again.
      await this.#commerce.chargeInvoice(invoice.invoiceId, actor);
    } catch (error) {
      if (!retryLater || !(error instanceof EducateOsError) || error.code !== "unavailable") throw error;
      // Stripe may have made the charge and lost only its reply. The next charge or Pay now finds it
      // by its metadata before making another (CommerceService.chargeInvoice).
      console.error("billing charge deferred", { invoiceId: invoice.invoiceId, error: error.code });
    }
    return await this.#commerce.chargeState(invoice.invoiceId);
  }

  #serial<T>(work: () => Promise<T>): Promise<BillingReply<T>> {
    return this.#queue.run(() => reply(work));
  }

  async #cardSetup(subscription: Subscription, origin: string, actor: FinanceActor): Promise<{ url: string }> {
    const returnUrl = `${origin}${BILLING_PATHS.ret}?subscription=${subscription.subscriptionId}&setup=${SETUP_REF_PLACEHOLDER}`;
    // One setup page per subscription per ten minutes, so a double submit opens the same page.
    const window = Math.floor(this.#now().getTime() / (10 * 60 * 1000));
    const setup = await this.#commerce.startCardSetup(subscription.subscriptionId, {
      returnUrl,
      cancelUrl: `${origin}${BILLING_PATHS.page}`,
      idempotencyKey: `${subscription.subscriptionId}:${window}`,
    }, actor);
    return { url: setup.url };
  }

  // The newest subscription that isn't cancelled.
  async #current(accountId: CommercialAccountId): Promise<Subscription | undefined> {
    return (await this.#commerce.subscriptions(accountId))
      .filter((subscription) => subscription.status !== "cancelled")
      .toSorted((a, b) => b.termStart.localeCompare(a.termStart))[0];
  }

  // Another account's subscription is reported as missing.
  async #owned(operator: Operator, subscriptionId: string): Promise<Subscription> {
    const subscription = (await this.#commerce.subscriptions(operator.accountId)).find((s) => s.subscriptionId === subscriptionId);
    if (subscription === undefined) throw new EducateOsError("not-found", "subscription not found");
    return subscription;
  }
}

function customer(operator: Operator): FinanceActor {
  return { kind: "customer", ref: CommercialAccountId.parse(operator.accountId) };
}

async function reply<T>(work: () => Promise<T>): Promise<BillingReply<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    if (error instanceof EducateOsError) return { ok: false, code: error.code, message: error.message };
    throw error;
  }
}

/**
 * A promise-returning build run once and its result kept, unless it rejects: then the next call
 * builds again, rather than every call failing with the first rejection until a restart.
 */
export function keepUnlessRejected<T>(build: () => Promise<T>): () => Promise<T> {
  let kept: Promise<T> | undefined;
  return () => {
    kept ??= build().catch((error: unknown) => {
      kept = undefined;
      throw error;
    });
    return kept;
  };
}

/** A {@link BillingApi} for a deploy without billing configured: every operation is refused as unavailable. */
export const UNCONFIGURED_BILLING_REPLY = { ok: false, code: "unavailable", message: "billing isn't configured on this deploy" } as const;
