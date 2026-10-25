// Internal: not exported from the package index.

/**
 * Splits `amount` across weights in proportion, by largest remainder, so the parts sum exactly.
 * Ties go to the earlier key, which callers keep in a stable order. The weights must not all be
 * zero.
 */
export function apportion<K>(amount: bigint, weights: readonly (readonly [K, bigint])[]): [K, bigint][] {
  const total = weights.reduce((sum, [, weight]) => sum + weight, 0n);
  const magnitude = amount < 0n ? -amount : amount;
  const shares = weights.map(([key, weight], index) => ({
    key,
    index,
    whole: (magnitude * weight) / total,
    remainder: (magnitude * weight) % total,
  }));
  let left = magnitude - shares.reduce((sum, share) => sum + share.whole, 0n);
  const order = shares.toSorted((a, b) => (a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1));
  for (const share of order) {
    if (left === 0n) break;
    share.whole += 1n;
    left -= 1n;
  }
  return shares.map((share) => [share.key, amount < 0n ? -share.whole : share.whole]);
}
