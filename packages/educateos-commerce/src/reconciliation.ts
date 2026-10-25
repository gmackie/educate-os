import type { CommercialAccountId } from "@educateos/contracts";
import type { InvoiceId } from "./ids.ts";
import type { CreditEntry, Grant, Invoice, Payment } from "./model.ts";
import { subtractCents, sumCents } from "./money.ts";

/** Something in an account's books that doesn't add up. */
export type ReconciliationDiscrepancy =
  /** The credits an invoice says were applied differ from the ledger's `applied` entries for it. */
  | { code: "credits-mismatch"; invoiceId: InvoiceId; invoiceCents: number; ledgerCents: number }
  /** More was paid against an invoice than it totals. */
  | { code: "overpaid"; invoiceId: InvoiceId; overpaidCents: number }
  /** An invoice's status disagrees with its balance. */
  | { code: "status-mismatch"; invoiceId: InvoiceId; status: Invoice["status"]; balanceCents: number }
  /** A grant's ledger balance went below zero. */
  | { code: "grant-overdrawn"; grantId: Grant["grantId"]; balanceCents: number };

/** One invoice reconciled against its payments and credits. */
export interface InvoiceReconciliation {
  invoiceId: InvoiceId;
  status: Invoice["status"];
  subtotalCents: number;
  creditsAppliedCents: number;
  totalCents: number;
  /** Charges and manual payments. */
  paidCents: number;
  refundedCents: number;
  /** `totalCents - (paidCents - refundedCents)`. Negative when overpaid. */
  balanceCents: number;
}

/**
 * An account's invoices reconciled against payments and grant credits. `balanced` is true when
 * there are no discrepancies; the totals are always integer cents.
 */
export interface ReconciliationReport {
  accountId: CommercialAccountId;
  invoices: InvoiceReconciliation[];
  totals: {
    invoicedCents: number;
    creditsAppliedCents: number;
    paidCents: number;
    refundedCents: number;
    outstandingCents: number;
    grantsAwardedCents: number;
    grantsExpiredCents: number;
    grantsRemainingCents: number;
  };
  discrepancies: ReconciliationDiscrepancy[];
  balanced: boolean;
}

/** What {@link reconcile} reads: one account's books. */
export interface AccountBooks {
  accountId: CommercialAccountId;
  invoices: Invoice[];
  payments: Payment[];
  credits: CreditEntry[];
  grants: Grant[];
}

/** Reconciles an account's invoices against its payments and its grant credit ledger. */
export function reconcile(books: AccountBooks): ReconciliationReport {
  const discrepancies: ReconciliationDiscrepancy[] = [];
  const invoices = books.invoices.map((invoice): InvoiceReconciliation => {
    const payments = books.payments.filter((payment) => payment.invoiceId === invoice.invoiceId);
    const paidCents = sumCents(payments.filter((p) => p.kind !== "refund").map((p) => p.amountCents));
    const refundedCents = sumCents(payments.filter((p) => p.kind === "refund").map((p) => p.amountCents));
    const balanceCents = subtractCents(invoice.totalCents, subtractCents(paidCents, refundedCents));
    // `0 - x` rather than `-x`, which would turn an empty sum into -0.
    const ledgerCents = subtractCents(0, sumCents(
      books.credits.filter((e) => e.kind === "applied" && e.invoiceId === invoice.invoiceId).map((e) => e.amountCents),
    ));
    if (ledgerCents !== invoice.creditsAppliedCents) {
      discrepancies.push({ code: "credits-mismatch", invoiceId: invoice.invoiceId, invoiceCents: invoice.creditsAppliedCents, ledgerCents });
    }
    if (balanceCents < 0) discrepancies.push({ code: "overpaid", invoiceId: invoice.invoiceId, overpaidCents: subtractCents(0, balanceCents) });
    if ((invoice.status === "paid") !== balanceCents <= 0) {
      discrepancies.push({ code: "status-mismatch", invoiceId: invoice.invoiceId, status: invoice.status, balanceCents });
    }
    return {
      invoiceId: invoice.invoiceId,
      status: invoice.status,
      subtotalCents: invoice.subtotalCents,
      creditsAppliedCents: invoice.creditsAppliedCents,
      totalCents: invoice.totalCents,
      paidCents,
      refundedCents,
      balanceCents,
    };
  });
  for (const grant of books.grants) {
    const balanceCents = sumCents(books.credits.filter((e) => e.grantId === grant.grantId).map((e) => e.amountCents));
    if (balanceCents < 0) discrepancies.push({ code: "grant-overdrawn", grantId: grant.grantId, balanceCents });
  }
  const creditTotal = (kind: CreditEntry["kind"]) =>
    sumCents(books.credits.filter((e) => e.kind === kind).map((e) => e.amountCents));
  return {
    accountId: books.accountId,
    invoices,
    totals: {
      invoicedCents: sumCents(invoices.map((i) => i.subtotalCents)),
      creditsAppliedCents: sumCents(invoices.map((i) => i.creditsAppliedCents)),
      paidCents: sumCents(invoices.map((i) => i.paidCents)),
      refundedCents: sumCents(invoices.map((i) => i.refundedCents)),
      outstandingCents: sumCents(invoices.map((i) => Math.max(0, i.balanceCents))),
      grantsAwardedCents: creditTotal("awarded"),
      grantsExpiredCents: subtractCents(0, creditTotal("expired")),
      grantsRemainingCents: sumCents(books.credits.map((e) => e.amountCents)),
    },
    discrepancies,
    balanced: discrepancies.length === 0,
  };
}
