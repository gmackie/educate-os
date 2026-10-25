import { z } from "zod";

/**
 * A non-negative amount of US nanodollars (10^-9 USD), the unit every amount in this package is
 * held, charged and reported in. Whole cents cannot represent AI spend: one moderation check costs
 * about $0.000038, which rounds to zero cents, so cent-based spend disappears.
 *
 * The wire and storage form is a decimal integer string, as in Hall Monitor's `UsdNano`
 * (`@gmacko/hall-monitor-contracts`), so amounts cross JSON and storage without float rounding.
 * Arithmetic is done in `bigint` through the helpers below; no amount ever passes through a float.
 * The form is canonical (no leading zeros), so two equal amounts are always the same string.
 */
export const UsdNano = z.string().regex(/^(0|[1-9]\d{0,29})$/, "expected a non-negative integer amount of nanodollars");
/** An amount of US nanodollars, as a canonical decimal integer string. */
export type UsdNano = z.infer<typeof UsdNano>;

/** A positive {@link UsdNano}. */
export const PositiveUsdNano = z.string().regex(/^[1-9]\d{0,29}$/, "expected a positive integer amount of nanodollars");

/** A signed amount of US nanodollars, for corrections and balances that may go negative. */
export const SignedUsdNano = z.string().regex(/^(0|-?[1-9]\d{0,29})$/, "expected an integer amount of nanodollars");
/** A signed amount of US nanodollars, as a canonical decimal integer string. */
export type SignedUsdNano = z.infer<typeof SignedUsdNano>;

/** Nanodollars in one US cent. */
export const USD_NANO_PER_CENT = 10_000_000n;
/** Nanodollars in one US dollar. */
export const USD_NANO_PER_USD = 1_000_000_000n;

/** The `bigint` value of an amount. Throws on anything that is not a canonical amount string. */
export function usdNanoValue(amount: SignedUsdNano): bigint {
  if (!SignedUsdNano.safeParse(amount).success) throw new RangeError("not a nanodollar amount");
  return BigInt(amount);
}

/** A signed amount from its `bigint` value. */
export function signedUsdNano(value: bigint): SignedUsdNano {
  return value.toString();
}

/** A non-negative amount from its `bigint` value. Throws if the value is negative. */
export function usdNano(value: bigint): UsdNano {
  if (value < 0n) throw new RangeError("a nanodollar amount here cannot be negative");
  return value.toString();
}

/** The sum of some amounts. */
export function sumUsdNano(amounts: Iterable<SignedUsdNano>): SignedUsdNano {
  let total = 0n;
  for (const amount of amounts) total += usdNanoValue(amount);
  return signedUsdNano(total);
}

/** `a + b`. */
export function addUsdNano(a: SignedUsdNano, b: SignedUsdNano): SignedUsdNano {
  return signedUsdNano(usdNanoValue(a) + usdNanoValue(b));
}

/** `a - b`, which may be negative. */
export function subUsdNano(a: SignedUsdNano, b: SignedUsdNano): SignedUsdNano {
  return signedUsdNano(usdNanoValue(a) - usdNanoValue(b));
}

/** `-1`, `0` or `1` as `a` is less than, equal to or greater than `b`. */
export function compareUsdNano(a: SignedUsdNano, b: SignedUsdNano): -1 | 0 | 1 {
  const difference = usdNanoValue(a) - usdNanoValue(b);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

/** An amount of whole cents, as admin-facing settings (such as the principal cap) hold them. */
export function usdNanoFromCents(cents: number): UsdNano {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new RangeError("expected a non-negative whole number of cents");
  return usdNano(BigInt(cents) * USD_NANO_PER_CENT);
}

/**
 * Whole cents for display, rounding up (toward positive infinity), so a non-zero spend never shows
 * as nothing: 38,000,000 nanodollars (3.8¢) shows as 4¢.
 */
export function ceilUsdNanoToCents(amount: SignedUsdNano): number {
  const value = usdNanoValue(amount);
  const quotient = value / USD_NANO_PER_CENT;
  return Number(value % USD_NANO_PER_CENT > 0n ? quotient + 1n : quotient);
}

/**
 * `numerator / denominator` nanodollars, rounded up to a whole nanodollar, for a price that is a
 * ratio (nanodollars per million tokens times a token count, say). Both must be non-negative and
 * the denominator positive. Rounding up means a fraction of a nanodollar is charged, never dropped.
 */
export function usdNanoFromRational(numerator: bigint, denominator: bigint): UsdNano {
  if (numerator < 0n || denominator <= 0n) throw new RangeError("expected a non-negative numerator and a positive denominator");
  return usdNano((numerator + denominator - 1n) / denominator);
}

/** A decimal US dollar string (`"0.000038"`, at most nine decimal places) as nanodollars, exactly. */
export function usdNanoFromDecimalUsd(dollars: string): UsdNano {
  const match = /^(\d{1,20})(?:\.(\d{1,9}))?$/.exec(dollars);
  if (match === null) throw new RangeError("expected a decimal dollar amount with at most nine decimal places");
  return usdNano(BigInt(match[1]!) * USD_NANO_PER_USD + BigInt((match[2] ?? "").padEnd(9, "0")));
}

/** An amount as a decimal US dollar string with exactly nine decimal places (`"-0.000038000"`). */
export function formatUsdNanoAsDecimalUsd(amount: SignedUsdNano): string {
  const value = usdNanoValue(amount);
  const magnitude = value < 0n ? -value : value;
  const fraction = (magnitude % USD_NANO_PER_USD).toString().padStart(9, "0");
  return `${value < 0n ? "-" : ""}${magnitude / USD_NANO_PER_USD}.${fraction}`;
}
