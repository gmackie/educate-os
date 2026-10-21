import { z } from "zod";
import { DistrictId, PrincipalId } from "@schoolos/contracts";
import { AiRequestId, AiWorkspaceContext, Cents, ModelRef, TokenUsage } from "./model.ts";
import { FundingPoolId } from "./pools.ts";

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
  requestId: AiRequestId,
  districtId: DistrictId,
  principalId: PrincipalId,
  workspace: AiWorkspaceContext,
  poolId: FundingPoolId,
  model: ModelRef,
  heldCents: Cents.positive(),
  period: BillingPeriod,
  reservedAt: z.iso.datetime(),
});
/** A reservation entry. */
export type ReservationEntry = z.infer<typeof ReservationEntry>;

/** The actual charge for a reserved request. It replaces the hold, whatever the two amounts are. */
export const SettlementEntry = z.strictObject({
  type: z.literal("settlement"),
  requestId: AiRequestId,
  usage: TokenUsage,
  actualCents: Cents,
  settledAt: z.iso.datetime(),
});
/** A settlement entry. */
export type SettlementEntry = z.infer<typeof SettlementEntry>;

/** Releases a reservation whose request failed. Nothing is charged. */
export const VoidEntry = z.strictObject({
  type: z.literal("void"),
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
  /** Unique per reconciliation, basis and pool, so re-running one reconciliation appends nothing. */
  adjustmentId: z.string().min(1).max(400),
  reconciliationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  basis: AdjustmentBasis,
  poolId: FundingPoolId,
  model: ModelRef,
  period: BillingPeriod,
  /** Who and which workspace the correction belongs to, when it corrects one known request. */
  attribution: z.strictObject({ principalId: PrincipalId, workspace: AiWorkspaceContext }).optional(),
  deltaCents: z.int(),
  recordedAt: z.iso.datetime(),
});
/** An adjustment entry. */
export type AdjustmentEntry = z.infer<typeof AdjustmentEntry>;

/**
 * One append-only ledger entry. Entries hold identifiers, token counts and cents only: there is no
 * field a prompt, response or tool argument could be written to, and strict parsing rejects any
 * extra field.
 */
export const LedgerEntry = z.discriminatedUnion("type", [ReservationEntry, SettlementEntry, VoidEntry, AdjustmentEntry]);
/** A ledger entry. */
export type LedgerEntry = z.infer<typeof LedgerEntry>;

/** Where one request stands. */
export interface RequestRecord {
  /** The hold. */
  reservation: ReservationEntry;
  /** The settlement, once recorded. */
  settlement?: SettlementEntry;
  /** The void, once recorded. */
  voided?: VoidEntry;
}

/** What a request currently costs its pool: its actual charge once settled, nothing once voided, else its hold. */
export function requestCharge(record: RequestRecord): number {
  if (record.settlement !== undefined) return record.settlement.actualCents;
  if (record.voided !== undefined) return 0;
  return record.reservation.heldCents;
}

/**
 * A read model over the entries, folded as they are appended. Store implementations keep one in
 * step with what they persist and hand it to decisions, so a decision sees every committed entry.
 */
export class LedgerIndex {
  readonly #entries: LedgerEntry[] = [];
  readonly #requests = new Map<string, RequestRecord>();
  readonly #adjustments = new Map<string, AdjustmentEntry>();

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

  /** Whether an adjustment ID is already recorded. */
  hasAdjustment(adjustmentId: string): boolean {
    return this.#adjustments.has(adjustmentId);
  }

  /** Everything charged or held against a pool in a period, adjustments included. */
  poolCharged(poolId: string, period: BillingPeriod): number {
    let total = 0;
    for (const record of this.#requests.values()) {
      if (record.reservation.poolId === poolId && record.reservation.period === period) total += requestCharge(record);
    }
    for (const adjustment of this.#adjustments.values()) {
      if (adjustment.poolId === poolId && adjustment.period === period) total += adjustment.deltaCents;
    }
    return total;
  }

  /** Everything charged or held for a principal in a period, across pools, with their attributed adjustments. */
  principalCharged(principalId: string, period: BillingPeriod): number {
    let total = 0;
    for (const record of this.#requests.values()) {
      if (record.reservation.principalId === principalId && record.reservation.period === period) {
        total += requestCharge(record);
      }
    }
    for (const adjustment of this.#adjustments.values()) {
      if (adjustment.attribution?.principalId === principalId && adjustment.period === period) {
        total += adjustment.deltaCents;
      }
    }
    return total;
  }
}
