import { CommercialAccountId, InstanceId, OpaqueCode, UtcTimestamp } from "@schoolos/fleet";
import { z } from "zod";
import { FinanceAuditEventId, GrantId, InvoiceId, PaymentId, PurchaseOrderId, SubscriptionId } from "./ids.ts";
import { SignedCents } from "./money.ts";

/**
 * Who made a finance change: a staff member (by opaque code; the person is in the private staff
 * directory), the payment processor (through a webhook), or the system clock (a timed grace
 * transition).
 */
export const FinanceActor = z.strictObject({
  kind: z.enum(["staff", "processor", "system"]),
  ref: OpaqueCode,
});
/** A finance actor. */
export type FinanceActor = z.infer<typeof FinanceActor>;

/** The actor for transitions the clock causes (`past-due` to `grace`, `grace` to `lapsed`). */
export const SYSTEM_CLOCK: FinanceActor = { kind: "system", ref: "clock" };

/** Every kind of finance state change. */
export const FinanceAction = z.enum([
  "account.opened",
  "account.instance-linked",
  "account.ai-usage-sharing-changed",
  "account.processor-customer-created",
  "subscription.started",
  "subscription.activated",
  "subscription.past-due",
  "subscription.grace",
  "subscription.lapsed",
  "subscription.reactivated",
  "subscription.renewed",
  "subscription.cancelled",
  "purchase-order.submitted",
  "purchase-order.approved",
  "purchase-order.rejected",
  "invoice.issued",
  "invoice.credits-applied",
  "invoice.charge-requested",
  "invoice.paid",
  "invoice.reopened",
  "payment.recorded",
  "payment.refund-requested",
  "payment.refunded",
  "grant.awarded",
  "grant.expired",
  "entitlement.issued",
]);
/** A finance action. */
export type FinanceAction = z.infer<typeof FinanceAction>;

/** The record a finance change touched. */
export const FinanceSubject = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("account"), id: CommercialAccountId }),
  z.strictObject({ kind: z.literal("subscription"), id: SubscriptionId }),
  z.strictObject({ kind: z.literal("purchase-order"), id: PurchaseOrderId }),
  z.strictObject({ kind: z.literal("invoice"), id: InvoiceId }),
  z.strictObject({ kind: z.literal("payment"), id: PaymentId }),
  z.strictObject({ kind: z.literal("grant"), id: GrantId }),
  z.strictObject({ kind: z.literal("instance"), id: InstanceId }),
]);
/** A finance subject. */
export type FinanceSubject = z.infer<typeof FinanceSubject>;

/**
 * A summary of a record before or after a change: its state and, where money moved, the amount.
 * A fixed allow-list of fields, so an audit event can't become a place to copy a whole record.
 */
export const FinanceStateSummary = z.strictObject({
  state: OpaqueCode.optional(),
  amountCents: SignedCents.optional(),
  revision: z.number().int().min(1).optional(),
});
/** A state summary. */
export type FinanceStateSummary = z.infer<typeof FinanceStateSummary>;

/** One append-only finance audit event. */
export const FinanceAuditEvent = z.strictObject({
  eventId: FinanceAuditEventId,
  accountId: CommercialAccountId,
  actor: FinanceActor,
  action: FinanceAction,
  subject: FinanceSubject,
  before: FinanceStateSummary.optional(),
  after: FinanceStateSummary.optional(),
  at: UtcTimestamp,
});
/** A finance audit event. */
export type FinanceAuditEvent = z.infer<typeof FinanceAuditEvent>;
