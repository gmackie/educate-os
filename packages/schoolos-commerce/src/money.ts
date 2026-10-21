import { SchoolOsError } from "@schoolos/contracts";
import { z } from "zod";

// Money is integer cents everywhere: in schemas, in arithmetic and in storage. A fractional value
// fails to parse, and every helper here checks that its result is still a safe integer, so a sum
// can never silently round. There is no currency field because SchoolOS bills in USD only; adding
// a currency is a schema change, not a default.

/** A non-negative amount in integer cents. */
export const Cents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** An amount in cents. */
export type Cents = z.infer<typeof Cents>;

/** A signed amount in integer cents: a ledger movement or a balance that may go below zero. */
export const SignedCents = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
/** A signed amount in cents. */
export type SignedCents = z.infer<typeof SignedCents>;

function checked(value: number): number {
  if (!Number.isSafeInteger(value)) throw new SchoolOsError("validation-failed", "amount is not a safe integer of cents");
  return value;
}

/** Sums amounts in cents, failing rather than rounding if any input or the total is not a safe integer. */
export function sumCents(amounts: Iterable<number>): number {
  let total = 0;
  for (const amount of amounts) total = checked(total + checked(amount));
  return total;
}

/** The amount of `quantity` units at `unitAmountCents` each, failing on overflow. */
export function multiplyCents(unitAmountCents: number, quantity: number): number {
  return checked(checked(unitAmountCents) * checked(quantity));
}

/** `a - b` in cents, failing on overflow. */
export function subtractCents(a: number, b: number): number {
  return checked(checked(a) - checked(b));
}
