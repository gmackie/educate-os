import { z } from "zod";
import { DistrictId, PrincipalId } from "@schoolos/contracts";
import { AiAttempts, AiRequestId, AiWorkspaceContext, FundingPurpose, ModelRef, PriceBookId, TokenUsage } from "./model.ts";
import { PositiveUsdNano, SignedUsdNano, UsdNano, USD_NANO_PER_CENT, signedUsdNano, usdNanoFromCents, usdNanoValue } from "./money.ts";
import { FundingPoolId } from "./pools.ts";

/**
 * The entry format this package writes. Version 1 held whole cents (`heldCents`, `actualCents`,
 * `deltaCents`) and one usage per settlement; version 2 holds {@link UsdNano} and per-attempt
 * usage. Stored version 1 entries are still read: {@link LedgerEntry} upgrades them on parse.
 */
export const ENTRY_SCHEMA_VERSION = 2;
const version = { entrySchemaVersion: z.literal(ENTRY_SCHEMA_VERSION) };

/** A UTC calendar month, `YYYY-MM`. Pool allocations and principal caps renew each month. */
export const BillingPeriod = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "expected YYYY-MM");
/** A billing period. */
export type BillingPeriod = z.infer<typeof BillingPeriod>;

/** The billing period an instant falls in. */
export function billingPeriodOf(instant: string): BillingPeriod {
  return instant.slice(0, 7) as BillingPeriod;
}

/** Funds held for one request before it ran. Its period is the month it was reserved in. */
export const ReservationEntry = z.strictObject({
  type: z.literal("reservation"),
  ...version,
  requestId: AiRequestId,
  districtId: DistrictId,
  principalId: PrincipalId,
  workspace: AiWorkspaceContext,
  /** Whether the spend is generative or safety; safety spend is outside every principal cap. */
  fundingPurpose: FundingPurpose,
  poolId: FundingPoolId,
  model: ModelRef,
  /** The most the request may cost, held against the pool until it settles or is voided. */
  heldUsdNano: PositiveUsdNano,
  period: BillingPeriod,
  reservedAt: z.iso.datetime(),
});
/** A reservation entry. */
export type ReservationEntry = z.infer<typeof ReservationEntry>;

/**
 * The actual charge for a reserved request, which replaces the hold whatever the two amounts are.
 * It records every provider attempt the request made. `chargedUsdNano` is the sum of the attempts'
 * costs, with each attempt of `unknown` cost charged at the reservation's hold, so a cost that
 * never came back is a liability rather than $0. `hasUnknownCost` marks such a settlement until
 * reconciliation corrects it against the provider's bill.
 */
export const SettlementEntry = z.strictObject({
  type: z.literal("settlement"),
  ...version,
  requestId: AiRequestId,
  attempts: AiAttempts,
  /** The price book the gateway estimated costs from, when it did. */
  priceBookId: PriceBookId.optional(),
  chargedUsdNano: UsdNano,
  hasUnknownCost: z.boolean(),
  settledAt: z.iso.datetime(),
}).refine((entry) => entry.hasUnknownCost === entry.attempts.some((attempt) => attempt.state === "unknown"), {
  message: "hasUnknownCost must say whether any attempt's cost is unknown",
  path: ["hasUnknownCost"],
});
/** A settlement entry. */
export type SettlementEntry = z.infer<typeof SettlementEntry>;

/** Releases a reservation whose request failed. Nothing is charged. */
export const VoidEntry = z.strictObject({
  type: z.literal("void"),
  ...version,
  requestId: AiRequestId,
  voidedAt: z.iso.datetime(),
});
/** A void entry. */
export type VoidEntry = z.infer<typeof VoidEntry>;

/**
 * What a reconciliation adjustment corrects: one request matched by ID in the provider's bill, or
 * one model's spend on one UTC day when the bill carries no request IDs.
 */
export const AdjustmentBasis = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("request"), requestId: AiRequestId }),
  z.strictObject({ kind: z.literal("aggregate"), model: ModelRef, day: z.iso.date() }),
]);
/** An adjustment basis. */
export type AdjustmentBasis = z.infer<typeof AdjustmentBasis>;

/**
 * A correction to a pool's charges, written by bill reconciliation. History is never edited: a
 * difference between the gateway estimate and the provider's bill is recorded as one of these.
 * A positive delta charges the pool more; a negative one credits it.
 */
export const AdjustmentEntry = z.strictObject({
  type: z.literal("adjustment"),
  ...version,
  /** Unique per reconciliation, basis and pool, so re-running one reconciliation appends nothing. */
  adjustmentId: z.string().min(1).max(400),
  reconciliationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  basis: AdjustmentBasis,
  poolId: FundingPoolId,
  model: ModelRef,
  period: BillingPeriod,
  /** Who and which workspace the correction belongs to, when it corrects one known request. */
  attribution: z.strictObject({ principalId: PrincipalId, workspace: AiWorkspaceContext }).optional(),
  /** The correction: positive charges the pool more, negative credits it, zero confirms the charge. */
  deltaUsdNano: SignedUsdNano,
  recordedAt: z.iso.datetime(),
});
/** An adjustment entry. */
export type AdjustmentEntry = z.infer<typeof AdjustmentEntry>;

/** A ledger entry in the current format, as this package writes it. */
export const CurrentLedgerEntry = z.discriminatedUnion("type", [ReservationEntry, SettlementEntry, VoidEntry, AdjustmentEntry]);

const v1Common = { requestId: AiRequestId };

/**
 * A ledger entry in the version 1 format (whole cents, one usage per settlement, no version field),
 * as entries written before {@link ENTRY_SCHEMA_VERSION} 2 are stored. It is only ever read.
 */
export const LegacyLedgerEntryV1 = z.discriminatedUnion("type", [
  z.strictObject({
    ...ReservationEntry.omit({ entrySchemaVersion: true, fundingPurpose: true, heldUsdNano: true }).shape,
    heldCents: z.int().positive(),
  }),
  z.strictObject({
    type: z.literal("settlement"),
    ...v1Common,
    usage: TokenUsage,
    actualCents: z.int().nonnegative(),
    settledAt: z.iso.datetime(),
  }),
  z.strictObject({ type: z.literal("void"), ...v1Common, voidedAt: z.iso.datetime() }),
  z.strictObject({
    ...AdjustmentEntry.omit({ entrySchemaVersion: true, deltaUsdNano: true }).shape,
    deltaCents: z.int(),
  }),
]);
/** A version 1 ledger entry. */
export type LegacyLedgerEntryV1 = z.infer<typeof LegacyLedgerEntryV1>;

/**
 * Reads a version 1 entry as the current format: every cent becomes 10^7 nanodollars, a
 * settlement's one usage becomes a single `estimated` attempt (version 1 settled the gateway's
 * cost estimate), and a reservation is `generative` (version 1 had no safety funding). Nothing
 * else changes, so the upgrade is exact and charges stay the same.
 */
export function upgradeLedgerEntryV1(entry: LegacyLedgerEntryV1): z.infer<typeof CurrentLedgerEntry> {
  switch (entry.type) {
    case "reservation": {
      const { heldCents, ...rest } = entry;
      return { ...rest, entrySchemaVersion: ENTRY_SCHEMA_VERSION, fundingPurpose: "generative", heldUsdNano: usdNanoFromCents(heldCents) };
    }
    case "settlement": {
      const actualUsdNano = usdNanoFromCents(entry.actualCents);
      return {
        type: "settlement",
        entrySchemaVersion: ENTRY_SCHEMA_VERSION,
        requestId: entry.requestId,
        attempts: [{ attemptIndex: 0, state: "estimated", usage: entry.usage, actualUsdNano }],
        chargedUsdNano: actualUsdNano,
        hasUnknownCost: false,
        settledAt: entry.settledAt,
      };
    }
    case "void":
      return { ...entry, entrySchemaVersion: ENTRY_SCHEMA_VERSION };
    case "adjustment": {
      const { deltaCents, ...rest } = entry;
      return { ...rest, entrySchemaVersion: ENTRY_SCHEMA_VERSION, deltaUsdNano: signedUsdNano(BigInt(deltaCents) * USD_NANO_PER_CENT) };
    }
  }
}

/**
 * One append-only ledger entry. Entries hold identifiers, token counts and nanodollar amounts
 * only: there is no field a prompt, response or tool argument could be written to, and strict
 * parsing rejects any extra field. Parsing accepts the current format and the version 1 format,
 * which it upgrades (see {@link upgradeLedgerEntryV1}), so a store can hold entries of both.
 */
export const LedgerEntry = z.union([CurrentLedgerEntry, LegacyLedgerEntryV1.transform(upgradeLedgerEntryV1)]);
/** A ledger entry, always in the current format. */
export type LedgerEntry = z.output<typeof LedgerEntry>;

/** Where one request stands. */
export interface RequestRecord {
  /** The hold. */
  reservation: ReservationEntry;
  /** The settlement, once recorded. */
  settlement?: SettlementEntry;
  /** The void, once recorded. */
  voided?: VoidEntry;
}

/** What a request currently costs its pool: its settled charge, nothing once voided, else its hold. */
export function requestCharge(record: RequestRecord): UsdNano {
  if (record.settlement !== undefined) return record.settlement.chargedUsdNano;
  if (record.voided !== undefined) return "0";
  return record.reservation.heldUsdNano;
}

/**
 * A read model over the entries, folded as they are appended. Store implementations keep one in
 * step with what they persist and hand it to decisions, so a decision sees every committed entry.
 */
export class LedgerIndex {
  readonly #entries: LedgerEntry[] = [];
  readonly #requests = new Map<string, RequestRecord>();
  readonly #adjustments = new Map<string, AdjustmentEntry>();
  readonly #reconciledRequests = new Set<string>();

  constructor(entries: Iterable<LedgerEntry> = []) {
    for (const entry of entries) this.apply(entry);
  }

  /** Folds one entry in. It assumes the entry was already checked against the current state. */
  apply(entry: LedgerEntry): void {
    this.#entries.push(entry);
    switch (entry.type) {
      case "reservation":
        this.#requests.set(entry.requestId, { reservation: entry });
        break;
      case "settlement":
        this.#requests.get(entry.requestId)!.settlement = entry;
        break;
      case "void":
        this.#requests.get(entry.requestId)!.voided = entry;
        break;
      case "adjustment":
        this.#adjustments.set(entry.adjustmentId, entry);
        if (entry.basis.kind === "request") this.#reconciledRequests.add(entry.basis.requestId);
        break;
    }
  }

  /** Every entry, in append order. */
  get entries(): readonly LedgerEntry[] {
    return this.#entries;
  }

  /** Every request, in reservation order. */
  get requests(): Iterable<RequestRecord> {
    return this.#requests.values();
  }

  /** Every adjustment, in append order. */
  get adjustments(): Iterable<AdjustmentEntry> {
    return this.#adjustments.values();
  }

  /** One request, if it was ever reserved. */
  request(requestId: string): RequestRecord | undefined {
    return this.#requests.get(requestId);
  }

  /**
   * Whether a settled request still carries an unknown cost: some attempt's cost never came back,
   * and no reconciliation has yet corrected the request against the provider's bill.
   */
  hasOutstandingUnknownCost(requestId: string): boolean {
    const settlement = this.#requests.get(requestId)?.settlement;
    return settlement?.hasUnknownCost === true && !this.#reconciledRequests.has(requestId);
  }

  /** Whether an adjustment ID is already recorded. */
  hasAdjustment(adjustmentId: string): boolean {
    return this.#adjustments.has(adjustmentId);
  }

  /** Everything charged or held against a pool in a period, adjustments included. */
  poolCharged(poolId: string, period: BillingPeriod): SignedUsdNano {
    let total = 0n;
    for (const record of this.#requests.values()) {
      if (record.reservation.poolId === poolId && record.reservation.period === period) total += usdNanoValue(requestCharge(record));
    }
    for (const adjustment of this.#adjustments.values()) {
      if (adjustment.poolId === poolId && adjustment.period === period) total += usdNanoValue(adjustment.deltaUsdNano);
    }
    return signedUsdNano(total);
  }

  /**
   * Everything charged or held for a principal's generative requests in a period, across pools,
   * with their attributed adjustments: what counts against the principal's cap. Safety spend is
   * organizational and is left out.
   */
  principalCharged(principalId: string, period: BillingPeriod): SignedUsdNano {
    let total = 0n;
    for (const record of this.#requests.values()) {
      const { reservation } = record;
      if (reservation.principalId === principalId && reservation.period === period && reservation.fundingPurpose === "generative") {
        total += usdNanoValue(requestCharge(record));
      }
    }
    for (const adjustment of this.#adjustments.values()) {
      if (adjustment.attribution?.principalId !== principalId || adjustment.period !== period) continue;
      const corrected = adjustment.basis.kind === "request" ? this.#requests.get(adjustment.basis.requestId) : undefined;
      if (corrected?.reservation.fundingPurpose === "safety") continue;
      total += usdNanoValue(adjustment.deltaUsdNano);
    }
    return signedUsdNano(total);
  }
}
