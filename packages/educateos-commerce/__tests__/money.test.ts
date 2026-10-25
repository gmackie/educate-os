import { describe, expect, it } from "vitest";
import { Cents, Invoice, InvoiceLine, type InvoiceLineRequest, multiplyCents, sumCents } from "../src/index.ts";
import { CLERK, DAY, seededRandom, setup, TERM_START } from "./support.ts";

const DUE_AT = new Date(Date.parse(TERM_START) + 30 * DAY).toISOString();
const KINDS = ["plan-fee", "capability-pack", "support", "adjustment"] as const;

function randomLines(random: ReturnType<typeof seededRandom>): InvoiceLineRequest[] {
  return Array.from({ length: random.int(1, 40) }, (_, i) => ({
    kind: KINDS[random.int(0, KINDS.length - 1)],
    code: `line-${i}`,
    quantity: random.int(1, 5_000),
    unitAmountCents: random.int(0, 2_000_000),
  }));
}

describe("money is integer cents, never floats", () => {
  it("rejects fractional, non-finite and unsafe amounts at every boundary", () => {
    for (const bad of [0.5, 19.99, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(Cents.safeParse(bad).success, String(bad)).toBe(false);
    }
    expect(() => sumCents([0.1, 0.2])).toThrow();
    expect(() => multiplyCents(Number.MAX_SAFE_INTEGER, 2)).toThrow();
    expect(() => sumCents([Number.MAX_SAFE_INTEGER, 1])).toThrow();
    const line = { kind: "plan-fee", code: "x", quantity: 3, unitAmountCents: 333 };
    expect(InvoiceLine.safeParse({ ...line, amountCents: 999 }).success).toBe(true);
    expect(InvoiceLine.safeParse({ ...line, amountCents: 1000 }).success).toBe(false);
    expect(InvoiceLine.safeParse({ ...line, unitAmountCents: 333.33, amountCents: 999.99 }).success).toBe(false);
  });

  it("refuses a fractional amount in an invoice request rather than rounding it", async () => {
    const { service, accountId } = await setup();
    await expect(
      service.issueInvoice({ accountId, lines: [{ kind: "support", code: "hours", quantity: 1, unitAmountCents: 12_345.6 }], dueAt: DUE_AT }, CLERK),
    ).rejects.toMatchObject({ code: "validation-failed" });
  });

  it("for random line items, totals are exact integer sums, independent of order, after credits and payments", async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const random = seededRandom(seed);
      const { service, accountId } = await setup();
      const lines = randomLines(random);
      const expected = lines.reduce((total, line) => total + BigInt(line.quantity) * BigInt(line.unitAmountCents), 0n);

      const invoice = await service.issueInvoice({ accountId, lines, dueAt: DUE_AT }, CLERK);
      const reversed = await service.issueInvoice({ accountId, lines: lines.toReversed(), dueAt: DUE_AT }, CLERK);
      expect(BigInt(invoice.subtotalCents), `seed ${seed}`).toBe(expected);
      expect(reversed.subtotalCents).toBe(invoice.subtotalCents);
      for (const line of invoice.lines) expect(Number.isInteger(line.amountCents)).toBe(true);
      expect(Invoice.safeParse(invoice).success).toBe(true);
      if (invoice.subtotalCents === 0) continue;

      // Split the total into a random grant credit and random partial payments; the books close
      // to the cent and every figure stays an integer.
      const credit = random.int(1, invoice.subtotalCents);
      await service.awardGrant(
        { accountId, funder: "foundation", programCode: "random", awardedCents: credit, expiresAt: "2030-01-01T00:00:00.000Z", documentRef: "doc_random" },
        CLERK,
      );
      await service.applyGrantCredits(invoice.invoiceId, CLERK);
      let owed = invoice.subtotalCents - credit;
      let n = 0;
      while (owed > 0) {
        const part = random.int(1, owed);
        await service.recordManualPayment(invoice.invoiceId, part, `remit-${n++}`, CLERK);
        owed -= part;
      }
      const report = await service.reconciliationReport(accountId);
      const row = report.invoices.find((i) => i.invoiceId === invoice.invoiceId);
      expect(row).toMatchObject({ status: "paid", balanceCents: 0, creditsAppliedCents: credit, totalCents: invoice.subtotalCents - credit });
      expect(row && row.paidCents + row.creditsAppliedCents).toBe(invoice.subtotalCents);
      expect(report.discrepancies).toEqual([]);
      for (const value of Object.values(report.totals)) expect(Number.isSafeInteger(value)).toBe(true);
    }
  });

  it("fails an invoice whose total would overflow safe integers instead of rounding it", async () => {
    const { service, accountId } = await setup();
    // Each figure is a valid amount; only their product is too large to represent exactly.
    const huge = { kind: "adjustment" as const, code: "huge", quantity: 1_000_000, unitAmountCents: 9_007_199_255 };
    await expect(
      service.issueInvoice({ accountId, lines: [huge], dueAt: DUE_AT }, CLERK),
    ).rejects.toMatchObject({ code: "validation-failed" });
  });
});
