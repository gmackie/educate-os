import { CommercialAccountId, InstanceId, OpaqueCode, UtcTimestamp } from "@educateos/contracts";
import { canonicalJson } from "@educateos/fleet";
import { z } from "zod";
import { FinanceAuditEventId, GrantId, InvoiceId, PaymentId, PurchaseOrderId, SubscriptionId } from "./ids.ts";
import { SignedCents } from "./money.ts";

/**
 * Who made a finance change: a staff member (by opaque code; the person is in the private staff
 * directory), the customer themselves (by their account's opaque code, from the operator console:
 * never a staff power), the payment processor (through a webhook), or the system clock (a timed
 * grace transition).
 */
export const FinanceActor = z.strictObject({
  kind: z.enum(["staff", "customer", "processor", "system"]),
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
  "account.payment-method-saved",
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

/** A hex-encoded SHA-256, as the audit chain links events with. */
export const AuditHash = z.string().regex(/^[0-9a-f]{64}$/, "expected a hex SHA-256");

/** The `previousHash` of an account's first audit event. */
export const GENESIS_AUDIT_HASH = "0".repeat(64);

/**
 * One append-only finance audit event, linked into its account's hash chain (SCHO-99). `sequence`
 * counts the account's events from 1, `previousHash` is the `hash` of the event before it
 * ({@link GENESIS_AUDIT_HASH} for the first), and `hash` covers every other field, so editing,
 * removing or reordering any event breaks the chain from there on ({@link verifyFinanceAuditChain}).
 */
export const FinanceAuditEvent = z.strictObject({
  eventId: FinanceAuditEventId,
  accountId: CommercialAccountId,
  sequence: z.number().int().min(1),
  actor: FinanceActor,
  action: FinanceAction,
  subject: FinanceSubject,
  before: FinanceStateSummary.optional(),
  after: FinanceStateSummary.optional(),
  at: UtcTimestamp,
  previousHash: AuditHash,
  hash: AuditHash,
});
/** A finance audit event. */
export type FinanceAuditEvent = z.infer<typeof FinanceAuditEvent>;

const AUDIT_CONTEXT = "educateos-finance-audit/v1";
/** SCHO-232: the context events chained before the EducateOS rename were hashed under. */
const LEGACY_AUDIT_CONTEXT = "schoolos-finance-audit/v1"; // rename-educateos: keep

/** The hash of an audit event: SHA-256 over a context string and the canonical JSON of every field but `hash`. */
export async function hashFinanceAuditEvent(event: Omit<FinanceAuditEvent, "hash">): Promise<string> {
  return hashUnder(AUDIT_CONTEXT, event);
}

async function hashUnder(context: string, event: Omit<FinanceAuditEvent, "hash">): Promise<string> {
  const fields: Record<string, unknown> = { ...event };
  delete fields.hash;
  const bytes = new TextEncoder().encode(`${context}\0${canonicalJson(fields)}`).slice();
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Links an event onto the chain after `previous` (undefined for an account's first event): sets
 * its sequence and previous hash and computes its own hash.
 */
export async function chainFinanceAuditEvent(
  event: Omit<FinanceAuditEvent, "sequence" | "previousHash" | "hash">,
  previous: FinanceAuditEvent | undefined,
): Promise<FinanceAuditEvent> {
  const linked = { ...event, sequence: (previous?.sequence ?? 0) + 1, previousHash: previous?.hash ?? GENESIS_AUDIT_HASH };
  return FinanceAuditEvent.parse({ ...linked, hash: await hashFinanceAuditEvent(linked) });
}

/** Where an audit chain first fails to verify, and why. */
export interface AuditChainBreak {
  /** The index, in the events checked, of the first event that fails. */
  index: number;
  reason: "malformed" | "account" | "sequence" | "previous-hash" | "hash";
}

/** The result of {@link verifyFinanceAuditChain}. */
export type AuditChainVerification = { intact: true; length: number; headHash: string } | ({ intact: false } & AuditChainBreak);

/**
 * Verifies one account's audit trail, oldest first: every event parses, belongs to the same
 * account, follows its predecessor in sequence and by hash, and hashes to what it says. An empty
 * trail is intact. The chain proves the trail was not edited, reordered or cut in the middle; that
 * nothing was cut from the end needs the head hash compared with a copy kept elsewhere, which is
 * what `headHash` is for.
 */
export async function verifyFinanceAuditChain(events: readonly unknown[]): Promise<AuditChainVerification> {
  let previous: FinanceAuditEvent | undefined;
  for (const [index, input] of events.entries()) {
    const parsed = FinanceAuditEvent.safeParse(input);
    if (!parsed.success) return { intact: false, index, reason: "malformed" };
    const event = parsed.data;
    if (previous !== undefined && event.accountId !== previous.accountId) return { intact: false, index, reason: "account" };
    if (event.sequence !== (previous?.sequence ?? 0) + 1) return { intact: false, index, reason: "sequence" };
    if (event.previousHash !== (previous?.hash ?? GENESIS_AUDIT_HASH)) return { intact: false, index, reason: "previous-hash" };
    // An event chained before the EducateOS rename was hashed under the legacy context (SCHO-232).
    if (event.hash !== (await hashFinanceAuditEvent(event)) && event.hash !== (await hashUnder(LEGACY_AUDIT_CONTEXT, event))) {
      return { intact: false, index, reason: "hash" };
    }
    previous = event;
  }
  return { intact: true, length: events.length, headHash: previous?.hash ?? GENESIS_AUDIT_HASH };
}
