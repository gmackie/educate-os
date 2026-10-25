// AI spend is counted in nanodollars (ADR-0008). The unit and its helpers live in
// `@educateos/contracts`, because packages outside governance hold AI cost too (assessment
// reports, the fleet heartbeat) and the contracts are the vocabulary they all share (ADR-0002).
// They are re-exported here so governance's own API is unchanged.
export {
  PositiveUsdNano,
  SignedUsdNano,
  USD_NANO_PER_CENT,
  USD_NANO_PER_USD,
  UsdNano,
  addUsdNano,
  ceilUsdNanoToCents,
  compareUsdNano,
  formatUsdNanoAsDecimalUsd,
  signedUsdNano,
  subUsdNano,
  sumUsdNano,
  usdNano,
  usdNanoFromCents,
  usdNanoFromDecimalUsd,
  usdNanoFromRational,
  usdNanoValue,
} from "@educateos/contracts";
