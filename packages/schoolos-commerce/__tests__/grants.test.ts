import { describe, expect, it } from "vitest";
import { CreditEntry, DocumentRef } from "../src/index.ts";
import { CLERK, DAY, setup, TERM_START } from "./support.ts";

const LETTER = DocumentRef.parse("doc_nf-award-letter");
const DUE_AT = new Date(Date.parse(TERM_START) + 60 * DAY).toISOString();
const inDays = (days: number) => new Date(Date.parse(TERM_START) + days * DAY).toISOString();

async function withInvoice(amountCents: number) {
  const context = await setup();
  const subscription = await context.subscribe();
  await context.service.activate(subscription.subscriptionId, CLERK);
  const invoice = await context.service.issueInvoice(
    {
      accountId: context.accountId,
      subscriptionId: subscription.subscriptionId,
      lines: [{ kind: "plan-fee", code: "pilot-term", quantity: 1, unitAmountCents: amountCents }],
      dueAt: DUE_AT,
    },
    CLERK,
  );
  const award = (awardedCents: number, expiresInDays: number, programCode = "erate-fy2027") =>
    context.service.awardGrant(
      { accountId: context.accountId, funder: "e-rate", programCode, awardedCents, expiresAt: inDays(expiresInDays), documentRef: LETTER },
      CLERK,
    );
  return { ...context, subscription, invoice, award };
}

describe("grant credits", () => {
  it("applies grant credit to an invoice, soonest-expiring grant first, as append-only ledger entries", async () => {
    const { service, invoice, award, accountId } = await withInvoice(250_000);
    const later = await award(200_000, 300, "northfield-foundation");
    const sooner = await award(100_000, 90);

    const credited = await service.applyGrantCredits(invoice.invoiceId, CLERK);
    expect(credited).toMatchObject({ subtotalCents: 250_000, creditsAppliedCents: 250_000, totalCents: 0, status: "paid" });

    const applied = (await service.creditLedger(accountId)).filter((entry) => entry.kind === "applied");
    expect(applied.map((entry) => [entry.grantId, entry.amountCents])).toEqual([
      [sooner.grantId, -100_000],
      [later.grantId, -150_000],
    ]);
    expect(await service.availableCredits(accountId)).toBe(50_000);
  });

  it("applies only what is still owed and leaves the rest of the grant", async () => {
    const { service, invoice, award, accountId } = await withInvoice(250_000);
    await service.recordManualPayment(invoice.invoiceId, 200_000, "check-1", CLERK);
    await award(100_000, 90);
    const credited = await service.applyGrantCredits(invoice.invoiceId, CLERK);
    expect(credited).toMatchObject({ creditsAppliedCents: 50_000, totalCents: 200_000, status: "paid" });
    expect(await service.availableCredits(accountId)).toBe(50_000);
  });

  it("expires unspent credit at the grant's expiry, once, so it can't be spent late", async () => {
    const { service, invoice, award, accountId, clock } = await withInvoice(250_000);
    const grant = await award(100_000, 30);
    expect(await service.availableCredits(accountId)).toBe(100_000);

    clock.set(grant.expiresAt);
    expect(await service.availableCredits(accountId)).toBe(0);
    const credited = await service.applyGrantCredits(invoice.invoiceId, CLERK);
    expect(credited).toMatchObject({ creditsAppliedCents: 0, totalCents: 250_000, status: "open" });

    await service.expireGrants(accountId);
    await service.expireGrants(accountId);
    const ledger = await service.creditLedger(accountId);
    expect(ledger.map((entry) => [entry.kind, entry.amountCents])).toEqual([
      ["awarded", 100_000],
      ["expired", -100_000],
    ]);
    const expiries = (await service.auditTrail(accountId)).filter((event) => event.action === "grant.expired");
    expect(expiries).toHaveLength(1);
    expect(expiries[0]).toMatchObject({ actor: { kind: "system" }, before: { amountCents: 100_000 }, after: { amountCents: 0 } });
  });

  it("expires only the part of a grant left unspent", async () => {
    const { service, invoice, award, accountId, clock } = await withInvoice(40_000);
    const grant = await award(100_000, 30);
    await service.applyGrantCredits(invoice.invoiceId, CLERK);
    clock.set(grant.expiresAt);
    await service.expireGrants(accountId);
    const report = await service.reconciliationReport(accountId);
    expect(report.totals).toMatchObject({ grantsAwardedCents: 100_000, creditsAppliedCents: 40_000, grantsExpiredCents: 60_000, grantsRemainingCents: 0 });
    expect(report.balanced).toBe(true);
  });

  it("the ledger schema keeps credit signs honest", () => {
    const base = {
      entryId: "crd_1",
      accountId: "acct_northfield",
      grantId: "gnt_1",
      recordedAt: "2026-10-20T12:00:00.000Z",
    };
    expect(CreditEntry.safeParse({ ...base, kind: "awarded", amountCents: 100 }).success).toBe(true);
    expect(CreditEntry.safeParse({ ...base, kind: "awarded", amountCents: -100 }).success).toBe(false);
    expect(CreditEntry.safeParse({ ...base, kind: "expired", amountCents: 100 }).success).toBe(false);
    expect(CreditEntry.safeParse({ ...base, kind: "applied", amountCents: -100 }).success).toBe(false);
    expect(CreditEntry.safeParse({ ...base, kind: "applied", amountCents: -100, invoiceId: "inv_1" }).success).toBe(true);
  });
});
