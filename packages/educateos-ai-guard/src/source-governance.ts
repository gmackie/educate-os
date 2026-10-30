// SCHO-264: source-owned eligibility for the first Hall Monitor pilot. These records are installed
// by the district operator, never supplied by a Workshop caller or inferred from a grade band.
import { z } from "zod";
import { PrincipalId } from "@educateos/contracts";
import { OpaqueId, type EvaluationRequest } from "@gmacko/hall-monitor-contracts";
import type { GuardConfig } from "./config.ts";
import type { GuardContext } from "./context.ts";

const Seconds = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** A bounded, explicitly installed district eligibility record; no DOB or message content. */
export const SourceEligibility = z.strictObject({
  principalId: PrincipalId,
  dataClass: z.enum(["synthetic", "staff", "student"]),
  ageEligibility: z.enum(["synthetic", "adult", "13-plus", "under-13", "unknown", "ineligible"]),
  eligibilityRef: OpaqueId,
  issuedAt: Seconds,
  expiresAt: Seconds,
  revoked: z.boolean(),
}).refine((e) => e.issuedAt < e.expiresAt);

/**
 * Opt-in source configuration. Absence preserves the existing adapter; presence requires
 * eligibility and signed request-bound claims. Installing a record does not supply legal approval.
 */
export const SourceGovernance = z.strictObject({
  institutionId: OpaqueId,
  policyRevision: OpaqueId,
  /** Same or stricter than the receiver's enrollment freshness limit; never renewed by minting. */
  maxEligibilityAgeSeconds: z.int().min(1).max(3600),
  purposes: z.strictObject({ input: OpaqueId, output: OpaqueId }),
  eligibility: z.array(SourceEligibility).max(1000),
}).refine((g) => new Set(g.eligibility.map((e) => e.principalId)).size === g.eligibility.length);

/** The exact hm_governance claim accepted by Hall Monitor's governance v1 contract. */
export interface SourceGovernanceContext {
  schemaVersion: "1.0";
  institutionId: string;
  requestId: string;
  product: "educateos";
  surface: string;
  purpose: string;
  dataClass: "synthetic" | "staff" | "student";
  ageEligibility: "synthetic" | "adult" | "13-plus" | "under-13";
  eligibilityRef: string;
  policyRevision: string;
  issuedAt: number;
  expiresAt: number;
}

/** A fixed local refusal, safe to handle without exposing the eligibility record. */
export class SourceGovernanceError extends Error {
  override readonly name = "SourceGovernanceError";
  constructor() { super("source eligibility is unavailable"); }
}

/** Rechecks current installed eligibility against a district-resolved principal before transfer. */
export function sourceEligibility(config: GuardConfig, context: GuardContext, now: number) {
  const governance = config.moderation.governance;
  if (governance === undefined) return undefined;
  const entry = governance.eligibility.find((e) => e.principalId === context.principal.principalId);
  if (config.contextSource !== "district" || context.principal.districtId !== config.districtId || entry === undefined ||
    entry.revoked || entry.issuedAt > now || now - entry.issuedAt > governance.maxEligibilityAgeSeconds || now >= entry.expiresAt || entry.ageEligibility === "unknown" || entry.ageEligibility === "ineligible" ||
    (entry.dataClass === "synthetic" ? entry.ageEligibility !== "synthetic" :
      entry.dataClass === "staff" ? context.audience !== "educator" || entry.ageEligibility !== "adult" :
        context.audience !== "student" || entry.ageEligibility === "synthetic")) {
    throw new SourceGovernanceError();
  }
  return entry;
}

/**
 * Binds a claim to one check and purpose. Eligibility retains its original checked time; minting
 * a new JWT must not make an old eligibility check look fresh. No principal ID leaves the source.
 */
export function sourceGovernanceContext(config: GuardConfig, context: GuardContext, request: EvaluationRequest, now: number, tokenExpiresAt: number): SourceGovernanceContext {
  const g = config.moderation.governance;
  const entry = sourceEligibility(config, context, now);
  if (g === undefined || entry === undefined || entry.ageEligibility === "unknown" || entry.ageEligibility === "ineligible" ||
    request.source.product !== "educateos" || request.source.tenantId !== config.moderation.tenantId ||
    request.source.surface !== config.moderation.surface || request.context.audience !== context.audience ||
    request.policy.profileId !== context.profile.hallMonitorProfileId || request.policy.revision !== context.profile.revision ||
    (request.evaluationKind !== "interaction.input" && request.evaluationKind !== "interaction.output")) throw new SourceGovernanceError();
  return {
    schemaVersion: "1.0", institutionId: g.institutionId, requestId: request.requestId,
    product: "educateos", surface: config.moderation.surface,
    purpose: request.evaluationKind === "interaction.input" ? g.purposes.input : g.purposes.output,
    dataClass: entry.dataClass, ageEligibility: entry.ageEligibility, eligibilityRef: entry.eligibilityRef,
    policyRevision: g.policyRevision, issuedAt: entry.issuedAt, expiresAt: Math.min(entry.expiresAt, tokenExpiresAt),
  };
}
