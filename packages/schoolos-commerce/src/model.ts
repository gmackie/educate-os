import { CapabilityId } from "@schoolos/contracts";
import { CommercialAccountId, InstanceId, OpaqueCode, UtcTimestamp } from "@schoolos/fleet";
import { z } from "zod";
import {
  ContactRef,
  CreditEntryId,
  DocumentRef,
  GrantId,
  InvoiceId,
  PaymentId,
  PlanId,
  ProcessorRef,
  PurchaseOrderId,
  SubscriptionId,
} from "./ids.ts";
import { Cents, SignedCents } from "./money.ts";

// Every commerce record is a strict allow-list, as the fleet protocol's messages are (ADR-0001):
// an unknown field fails to parse, and `__tests__/no-pii.test.ts` rejects any field whose name
// suggests personal data. Records describe an organization's contract and money, never a person,
// a roster or a district's Cloudflare costs.

/**
 * A district's account in the commercial system: an opaque ID and the district's display label.
 * Contact people are held in the private contact system and referenced by {@link ContactRef}.
 */
export const CommercialAccount = z.strictObject({
  accountId: CommercialAccountId,
  /** The district's display label, e.g. "Northfield Public Schools". An organization, not a person. */
  districtLabel: z.string().min(1).max(120),
  contactRefs: z.array(ContactRef).max(16),
  /** The district instances this account pays for. Entitlements are issued only to these. */
  instanceIds: z.array(InstanceId).max(16),
  /**
   * Whether the district opted in to sharing its aggregate AI spend with the root. Only then may
   * that figure inform an invoice's usage line.
   */
  aiUsageSharing: z.enum(["opted-in", "opted-out"]),
  /** The account's customer at the payment processor, once created. */
  processorCustomerRef: ProcessorRef.optional(),
  openedAt: UtcTimestamp,
});
/** A commercial account. */
export type CommercialAccount = z.infer<typeof CommercialAccount>;

/** A plan tier. */
export const PlanTier = z.enum(["pilot", "standard", "enterprise"]);
/** A plan tier. */
export type PlanTier = z.infer<typeof PlanTier>;

/**
 * What happens when a subscription stops being paid for. It is `past-due` for `pastDueDays`
 * (entitlement still valid), then in `grace` for `graceDays` (the district's entitlement cache
 * reports grace, root-managed changes still allowed), then `lapsed` (root-managed changes blocked,
 * classroom features untouched). Both periods are explicit so no tier lapses by a hidden default.
 */
export const GraceRules = z.strictObject({
  pastDueDays: z.number().int().min(0).max(365),
  graceDays: z.number().int().min(0).max(365),
});
/** Grace rules. */
export type GraceRules = z.infer<typeof GraceRules>;

/** A plan: a tier, the capability packs it entitles, its enrollment band, AI credit allowance and price. */
export const Plan = z
  .strictObject({
    planId: PlanId,
    tier: PlanTier,
    capabilityIds: z.array(CapabilityId).min(1).max(64),
    /**
     * The district's total enrolled-learner count the plan is priced for, as an inclusive band.
     * An aggregate count only; no list of learners ever reaches commerce. Open-ended above when
     * `maxEnrollment` is absent.
     */
    enrollmentBand: z.strictObject({
      minEnrollment: z.number().int().min(0),
      maxEnrollment: z.number().int().min(1).optional(),
    }),
    /** SchoolOS-funded AI credit included per term, in cents. */
    aiCreditAllowanceCents: Cents,
    /** The plan's fee per term, in cents. */
    termFeeCents: Cents,
    graceRules: GraceRules,
  })
  .refine((p) => p.enrollmentBand.maxEnrollment === undefined || p.enrollmentBand.minEnrollment <= p.enrollmentBand.maxEnrollment, {
    message: "expected minEnrollment <= maxEnrollment",
  });
/** A plan. */
export type Plan = z.infer<typeof Plan>;

/** A subscription's status. Only the root's commercial view; the district sees its entitlement. */
export const SubscriptionStatus = z.enum(["trialing", "active", "past-due", "grace", "lapsed", "cancelled"]);
/** A subscription status. */
export type SubscriptionStatus = z.infer<typeof SubscriptionStatus>;

/** How a subscription is paid. */
export const PaymentMethodKind = z.enum(["card", "invoice", "purchase-order"]);
/** A payment method kind. */
export type PaymentMethodKind = z.infer<typeof PaymentMethodKind>;

/** An account's subscription to a plan for a term. */
export const Subscription = z
  .strictObject({
    subscriptionId: SubscriptionId,
    accountId: CommercialAccountId,
    planId: PlanId,
    status: SubscriptionStatus,
    paymentMethod: PaymentMethodKind,
    /** The approved purchase order paying for it. Required to activate when `paymentMethod` is `purchase-order`. */
    purchaseOrderId: PurchaseOrderId.optional(),
    termStart: UtcTimestamp,
    termEnd: UtcTimestamp,
    /** The plan's grace rules, copied at start so a later plan change can't alter a running contract. */
    graceRules: GraceRules,
    /** When the subscription stopped being paid for. Set while `past-due`, `grace` or `lapsed`. */
    pastDueSince: UtcTimestamp.optional(),
    cancelledAt: UtcTimestamp.optional(),
  })
  .refine((s) => Date.parse(s.termStart) < Date.parse(s.termEnd), { message: "expected termStart < termEnd" });
/** A subscription. */
export type Subscription = z.infer<typeof Subscription>;

/** Where a purchase order is in its approval. */
export const PurchaseOrderState = z.enum(["submitted", "approved", "rejected"]);
/** A purchase order state. */
export type PurchaseOrderState = z.infer<typeof PurchaseOrderState>;

/** The district's own purchase order number, as printed on its PO. */
export const PoNumber = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$/, "expected a PO number");

/** A district purchase order, which must be approved before it can pay for a subscription. */
export const PurchaseOrder = z.strictObject({
  purchaseOrderId: PurchaseOrderId,
  accountId: CommercialAccountId,
  poNumber: PoNumber,
  /** The amount the PO authorizes, in cents. Invoices against it may not exceed it in total. */
  amountCents: Cents.min(1),
  state: PurchaseOrderState,
  /** The signed PO in the private document store. */
  documentRef: DocumentRef,
  submittedAt: UtcTimestamp,
  /** The staff member who recorded it, as an opaque code. The approver must be someone else. */
  submittedBy: OpaqueCode,
  decidedAt: UtcTimestamp.optional(),
  decidedBy: OpaqueCode.optional(),
  /** Why it was rejected, as a code (`amount-mismatch`, `unsigned`), never free text. */
  rejectionCode: OpaqueCode.optional(),
});
/** A purchase order. */
export type PurchaseOrder = z.infer<typeof PurchaseOrder>;

/**
 * What an invoice line charges for. Every kind is a SchoolOS fee: there is deliberately no kind
 * for the district's Cloudflare bill, which Cloudflare invoices to the district directly and which
 * SchoolOS never passes through, marks up or collects (roadmap R04).
 */
export const InvoiceLineKind = z.enum(["plan-fee", "capability-pack", "support", "ai-credit-overage", "adjustment"]);
/** An invoice line kind. */
export type InvoiceLineKind = z.infer<typeof InvoiceLineKind>;

/**
 * One invoice line: a catalog code, never free text, so nothing personal can be written into an
 * invoice. `amountCents` is always `quantity * unitAmountCents`.
 */
export const InvoiceLine = z
  .strictObject({
    kind: InvoiceLineKind,
    code: OpaqueCode,
    quantity: z.number().int().min(1).max(1_000_000),
    unitAmountCents: Cents,
    amountCents: Cents,
  })
  .refine((l) => l.amountCents === l.quantity * l.unitAmountCents, { message: "expected amountCents = quantity * unitAmountCents" });
/** An invoice line. */
export type InvoiceLine = z.infer<typeof InvoiceLine>;

/** An invoice's status. */
export const InvoiceStatus = z.enum(["open", "paid"]);
/** An invoice status. */
export type InvoiceStatus = z.infer<typeof InvoiceStatus>;

/**
 * An invoice for SchoolOS fees. `subtotalCents` is the sum of the lines; `creditsAppliedCents` is
 * what grant credits covered; `totalCents` is what the district owes after credits.
 */
export const Invoice = z
  .strictObject({
    invoiceId: InvoiceId,
    accountId: CommercialAccountId,
    subscriptionId: SubscriptionId.optional(),
    purchaseOrderId: PurchaseOrderId.optional(),
    lines: z.array(InvoiceLine).min(1).max(200),
    subtotalCents: Cents,
    creditsAppliedCents: Cents,
    totalCents: Cents,
    status: InvoiceStatus,
    issuedAt: UtcTimestamp,
    dueAt: UtcTimestamp,
  })
  .refine((i) => i.totalCents === i.subtotalCents - i.creditsAppliedCents, {
    message: "expected totalCents = subtotalCents - creditsAppliedCents",
  });
/** An invoice. */
export type Invoice = z.infer<typeof Invoice>;

/** What a payment record is: money in through the processor or by hand, or money back out. */
export const PaymentKind = z.enum(["charge", "manual", "refund"]);
/** A payment kind. */
export type PaymentKind = z.infer<typeof PaymentKind>;

/**
 * One movement of money against an invoice. Payment records are append-only; a refund is a new
 * record of kind `refund` (amount positive) that names the payment it reverses.
 */
export const Payment = z.strictObject({
  paymentId: PaymentId,
  accountId: CommercialAccountId,
  invoiceId: InvoiceId,
  kind: PaymentKind,
  amountCents: Cents.min(1),
  /** The processor's charge or refund, or for a manual payment the remittance reference code. */
  reference: z.union([ProcessorRef, OpaqueCode]),
  /** For a refund, the payment it reverses. */
  refundOf: PaymentId.optional(),
  recordedAt: UtcTimestamp,
});
/** A payment record. */
export type Payment = z.infer<typeof Payment>;

/** Who funds a grant. */
export const GrantFunder = z.enum(["e-rate", "foundation", "state", "federal", "other"]);
/** A grant funder kind. */
export type GrantFunder = z.infer<typeof GrantFunder>;

/**
 * A grant that funds SchoolOS credits for a district, such as an E-Rate-like program or a
 * foundation award. Its credits can be applied to invoices until `expiresAt`, then they expire.
 */
export const Grant = z
  .strictObject({
    grantId: GrantId,
    accountId: CommercialAccountId,
    funder: GrantFunder,
    /** The funding program, as a code (`erate-fy2027`, `northfield-foundation`). */
    programCode: OpaqueCode,
    awardedCents: Cents.min(1),
    awardedAt: UtcTimestamp,
    expiresAt: UtcTimestamp,
    /** The award letter in the private document store. */
    documentRef: DocumentRef,
  })
  .refine((g) => Date.parse(g.awardedAt) < Date.parse(g.expiresAt), { message: "expected awardedAt < expiresAt" });
/** A grant. */
export type Grant = z.infer<typeof Grant>;

/** What a credit ledger entry records. */
export const CreditEntryKind = z.enum(["awarded", "applied", "expired"]);
/** A credit entry kind. */
export type CreditEntryKind = z.infer<typeof CreditEntryKind>;

/**
 * One append-only movement of grant credit. `awarded` is positive; `applied` (to an invoice) and
 * `expired` are negative. A grant's balance is the sum of its entries.
 */
export const CreditEntry = z
  .strictObject({
    entryId: CreditEntryId,
    accountId: CommercialAccountId,
    grantId: GrantId,
    kind: CreditEntryKind,
    amountCents: SignedCents,
    invoiceId: InvoiceId.optional(),
    recordedAt: UtcTimestamp,
  })
  .refine((e) => (e.kind === "awarded" ? e.amountCents > 0 : e.amountCents < 0), {
    message: "expected awarded credit positive and applied or expired credit negative",
  })
  .refine((e) => (e.kind === "applied") === (e.invoiceId !== undefined), { message: "expected an invoice on exactly the applied entries" });
/** A credit ledger entry. */
export type CreditEntry = z.infer<typeof CreditEntry>;
