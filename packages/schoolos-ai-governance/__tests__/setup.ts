import {
  DistrictId,
  PrincipalId,
  type OfferingId,
  type PolicySettings,
  type Scope,
} from "@schoolos/contracts";
import { NORTHFIELD } from "@schoolos/fixtures";
import {
  AiLedger,
  FundingPoolSet,
  InMemoryLedgerStore,
  type AiGovernanceSource,
  type AiPrincipal,
  type AiWorkspaceContext,
  type FundingPool,
  type GovernedModel,
  type ModelRef,
  type TermClosedEvent,
  type TokenUsage,
  type UsdNano,
  usdNanoFromCents,
} from "../src/index.ts";

export const NF = DistrictId.parse("dst_northfield");

/** A Northfield principal as the gateway seam would pass it. */
export function nf(id: string): AiPrincipal {
  return { principalId: PrincipalId.parse(id), districtId: NF };
}

export const AMARA = nf("prn_nf-student-amara");
export const DMITRI = nf("prn_nf-student-dmitri");
export const ELENA = nf("prn_nf-student-elena");
export const CHIDI = nf("prn_nf-student-chidi");
export const MORGAN = nf("prn_nf-morgan-lee");

/** A course workspace in a Northfield offering. */
export function course(offeringId: string): AiWorkspaceContext {
  return { kind: "course", offeringId: offeringId as OfferingId };
}
export const PERSONAL: AiWorkspaceContext = { kind: "personal" };
export const BIO_FALL = course("off_nf-bio-fall-p2");
export const BIO_SPRING = course("off_nf-bio-spring-p4");
export const ENG9 = course("off_nf-eng9-fall-p3");
export const USHIST = course("off_nf-ushist-fall-p5");
export const MATH7 = course("off_nf-math7-fall-p1");

export const SONNET: ModelRef = { provider: "anthropic", modelId: "claude-sonnet-example" };
export const OPUS: ModelRef = { provider: "anthropic", modelId: "claude-opus-example" };
export const MINI: ModelRef = { provider: "openai", modelId: "gpt-mini-example" };
export const GEMINI: ModelRef = { provider: "google", modelId: "gemini-pro-example" };

export const CATALOG: GovernedModel[] = [
  { ...SONNET, mode: "enabled" },
  { ...OPUS, mode: "enabled" },
  { ...MINI, mode: "hidden" },
  { ...GEMINI, mode: "disabled" },
];

/** Northfield's pools: two class pools, a high-school pool, and a personal pool. Middle school has none. */
export function northfieldPools(overrides: Partial<Record<string, Partial<FundingPool>>> = {}): FundingPool[] {
  const pools = [
    {
      id: "fpl_nf-bio-fall",
      name: "Biology I, Period 2",
      purpose: "course",
      scope: { level: "offering", districtId: NF, schoolId: "sch_nf-high", offeringId: "off_nf-bio-fall-p2" },
      monthlyAllocationUsdNano: c(1000),
      allowedModels: [SONNET, MINI, GEMINI],
    },
    {
      id: "fpl_nf-bio-spring",
      name: "Biology I, Period 4 (spring)",
      purpose: "course",
      scope: { level: "offering", districtId: NF, schoolId: "sch_nf-high", offeringId: "off_nf-bio-spring-p4" },
      monthlyAllocationUsdNano: c(1000),
      allowedModels: [SONNET],
    },
    {
      id: "fpl_nf-high",
      name: "Northfield High classes",
      purpose: "course",
      scope: { level: "school", districtId: NF, schoolId: "sch_nf-high" },
      monthlyAllocationUsdNano: c(500),
      allowedModels: [SONNET],
    },
    {
      id: "fpl_nf-personal",
      name: "Personal workspaces",
      purpose: "personal",
      scope: { level: "district", districtId: NF },
      monthlyAllocationUsdNano: c(300),
      allowedModels: [MINI],
    },
  ].map((pool) => ({ ...pool, ...overrides[pool.id] }));
  return FundingPoolSet.parse(pools);
}

export const FLOOR: PolicySettings = {
  aiSpending: "capped",
  promptsInGatewayLogs: "prohibited",
  studentPersonalConversations: "private",
  teacherObservation: "assigned-work-only",
  automatedSelProfiling: "prohibited",
  aiMonthlyCapCentsPerPrincipal: 400,
};

/** A mutable source over the Northfield fixture, so tests can change state between calls. */
export class FakeSource implements AiGovernanceSource {
  snapshot = NORTHFIELD;
  pools = northfieldPools();
  closures: TermClosedEvent[] = [];
  catalog = CATALOG;
  floor = FLOOR;
  /** Effective policy per offering, standing in for the F03 compiler's narrower layers. */
  offeringPolicy: Record<string, Partial<PolicySettings>> = {};

  async directory() {
    return this.snapshot;
  }
  async fundingPools() {
    return this.pools;
  }
  async termClosures() {
    return this.closures;
  }
  async modelCatalog() {
    return this.catalog;
  }
  async effectivePolicy(scope: Scope) {
    const narrower = scope.level === "offering" ? this.offeringPolicy[scope.offeringId] : undefined;
    return { ...this.floor, ...narrower };
  }
}

/** A controllable clock. */
export class Clock {
  instant = new Date("2026-10-05T15:00:00.000Z");
  now = () => this.instant;
  set(iso: string) {
    this.instant = new Date(iso);
  }
}

/** A ledger over a fresh in-memory store and a fake Northfield source. */
export function harness() {
  const source = new FakeSource();
  const store = new InMemoryLedgerStore();
  const clock = new Clock();
  const ledger = new AiLedger({ districtId: NF, store, source, now: clock.now });
  return { source, store, clock, ledger };
}

/** Whole cents as nanodollars, so tests can state amounts at a readable scale. */
export function c(cents: number): UsdNano {
  return usdNanoFromCents(cents);
}

/** A single-attempt settlement at a gateway-estimated cost. */
export function paid(usage: TokenUsage, actualUsdNano: UsdNano) {
  return { usage, actualUsdNano };
}

/** Token usage for a settlement. */
export function tokens(input: number, output: number, cacheRead = 0, cacheWrite = 0): TokenUsage {
  return { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite };
}
