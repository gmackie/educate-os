import { z } from "zod";

// Commerce identifiers follow the SchoolOS `<prefix>_<body>` convention, so a value of one kind
// never parses as another. They are root-side and opaque: nothing derives them from a person or
// from a district-local identifier. Accounts and instances reuse the fleet's `CommercialAccountId`
// and `InstanceId`, because the fleet registry already names accounts that way.

const ID_BODY = "[a-z0-9][a-z0-9-]{0,62}";

function idSchema<B extends string>(prefix: string, label: string) {
  return z
    .string()
    .regex(new RegExp(`^${prefix}_${ID_BODY}$`), `expected a ${label} ID (${prefix}_…)`)
    .brand<B>();
}

/** The prefix each generated commerce ID carries. */
export const COMMERCE_ID_PREFIXES = {
  plan: "pln",
  subscription: "sbn",
  purchaseOrder: "po",
  invoice: "inv",
  payment: "pay",
  grant: "gnt",
  creditEntry: "crd",
  auditEvent: "fae",
} as const;
/** A kind of commerce record that has its own generated identifier. */
export type CommerceIdKind = keyof typeof COMMERCE_ID_PREFIXES;

/** Identifies a plan in the root's catalog. */
export const PlanId = idSchema<"plan">(COMMERCE_ID_PREFIXES.plan, "plan");
/** A plan identifier. */
export type PlanId = z.infer<typeof PlanId>;

/** Identifies a subscription. */
export const SubscriptionId = idSchema<"subscription">(COMMERCE_ID_PREFIXES.subscription, "subscription");
/** A subscription identifier. */
export type SubscriptionId = z.infer<typeof SubscriptionId>;

/** Identifies a purchase order record (not the district's own PO number, which is an attribute). */
export const PurchaseOrderId = idSchema<"purchaseOrder">(COMMERCE_ID_PREFIXES.purchaseOrder, "purchase order");
/** A purchase order identifier. */
export type PurchaseOrderId = z.infer<typeof PurchaseOrderId>;

/** Identifies an invoice. */
export const InvoiceId = idSchema<"invoice">(COMMERCE_ID_PREFIXES.invoice, "invoice");
/** An invoice identifier. */
export type InvoiceId = z.infer<typeof InvoiceId>;

/** Identifies one payment record: a charge, a refund or a manually recorded payment. */
export const PaymentId = idSchema<"payment">(COMMERCE_ID_PREFIXES.payment, "payment");
/** A payment identifier. */
export type PaymentId = z.infer<typeof PaymentId>;

/** Identifies a grant award. */
export const GrantId = idSchema<"grant">(COMMERCE_ID_PREFIXES.grant, "grant");
/** A grant identifier. */
export type GrantId = z.infer<typeof GrantId>;

/** Identifies one credit ledger entry. */
export const CreditEntryId = idSchema<"creditEntry">(COMMERCE_ID_PREFIXES.creditEntry, "credit entry");
/** A credit ledger entry identifier. */
export type CreditEntryId = z.infer<typeof CreditEntryId>;

/** Identifies one finance audit event. */
export const FinanceAuditEventId = idSchema<"financeAuditEvent">(COMMERCE_ID_PREFIXES.auditEvent, "finance audit event");
/** A finance audit event identifier. */
export type FinanceAuditEventId = z.infer<typeof FinanceAuditEventId>;

/**
 * References a contact held in the private contact system (CRM). Names, emails and phone numbers
 * live only there; commerce records carry this reference instead.
 */
export const ContactRef = idSchema<"contact">("cnt", "contact");
/** A contact reference. */
export type ContactRef = z.infer<typeof ContactRef>;

/**
 * References a document (a signed PO, a grant award letter) held in the private document store.
 * Commerce keeps the reference, never the document.
 */
export const DocumentRef = idSchema<"document">("doc", "document");
/** A document reference. */
export type DocumentRef = z.infer<typeof DocumentRef>;

/**
 * A reference the payment processor issued (a customer, charge, refund or event). Opaque to
 * commerce; its format is the processor's.
 */
export const ProcessorRef = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, "expected a processor reference");
/** A processor reference. */
export type ProcessorRef = z.infer<typeof ProcessorRef>;

/**
 * Generates a fresh commerce ID of the given kind. The default uses `crypto.randomUUID`, whose
 * lowercase hex form fits the ID body.
 */
export type CommerceIdGenerator = (kind: CommerceIdKind) => string;

/** The default {@link CommerceIdGenerator}. */
export const randomCommerceId: CommerceIdGenerator = (kind) => `${COMMERCE_ID_PREFIXES[kind]}_${crypto.randomUUID()}`;
