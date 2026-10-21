import type { DistrictDirectorySnapshot } from "@schoolos/contracts";
import { NORTHFIELD } from "@schoolos/fixtures";
import {
  CommercialAccountId,
  EntitlementCache,
  InMemoryEntitlementStore,
  InstanceId,
  SigningIdentity,
} from "@schoolos/fleet";
import {
  CommerceService,
  type FinanceActor,
  FakePaymentProcessor,
  InMemoryCommerceStore,
  type Plan,
  PlanId,
  type StartSubscriptionRequest,
} from "../src/index.ts";

/** A clock the test moves by hand. */
export function manualClock(start = "2026-10-20T12:00:00.000Z") {
  let time = Date.parse(start);
  return {
    now: () => new Date(time),
    advance(ms: number) {
      time += ms;
    },
    set(iso: string) {
      time = Date.parse(iso);
    },
  };
}
/** A manual clock. */
export type Clock = ReturnType<typeof manualClock>;

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

export const TERM_START = "2026-10-20T12:00:00.000Z";
export const TERM_END = "2027-06-30T12:00:00.000Z";

/** Two finance staff members, so approval can be separated from submission. */
export const CLERK: FinanceActor = { kind: "staff", ref: "staff-clerk" };
export const CONTROLLER: FinanceActor = { kind: "staff", ref: "staff-controller" };
/** The processor, acting through a webhook. */
export const PROCESSOR: FinanceActor = { kind: "processor", ref: "webhook" };

export const PILOT = PlanId.parse("pln_pilot");
export const STANDARD = PlanId.parse("pln_standard");
export const ENTERPRISE = PlanId.parse("pln_enterprise");

/** The plan catalog the tests use. Each tier has its own explicit grace rules. */
export const PLANS: Plan[] = [
  {
    planId: PILOT,
    tier: "pilot",
    capabilityIds: ["core-learning"] as Plan["capabilityIds"],
    enrollmentBand: { minEnrollment: 0, maxEnrollment: 500 },
    aiCreditAllowanceCents: 50_000,
    termFeeCents: 250_000,
    graceRules: { pastDueDays: 7, graceDays: 14 },
  },
  {
    planId: STANDARD,
    tier: "standard",
    capabilityIds: ["core-learning", "assessment-ci"] as Plan["capabilityIds"],
    enrollmentBand: { minEnrollment: 501, maxEnrollment: 10_000 },
    aiCreditAllowanceCents: 200_000,
    termFeeCents: 1_200_000,
    graceRules: { pastDueDays: 15, graceDays: 30 },
  },
  {
    planId: ENTERPRISE,
    tier: "enterprise",
    capabilityIds: ["core-learning", "assessment-ci", "content-studio"] as Plan["capabilityIds"],
    enrollmentBand: { minEnrollment: 10_001 },
    aiCreditAllowanceCents: 1_000_000,
    termFeeCents: 9_000_000,
    graceRules: { pastDueDays: 0, graceDays: 30 },
  },
];

/** The commercial account and instance a synthetic district has. */
export function idsFor(snapshot: DistrictDirectorySnapshot) {
  const body = snapshot.district.id.slice("dst_".length);
  return { accountId: CommercialAccountId.parse(`acct_${body}`), instanceId: InstanceId.parse(`ins_${body}`) };
}

/** A commerce service with in-memory storage and a fake processor, and one district's open account. */
export async function setup(options: { snapshot?: DistrictDirectorySnapshot; aiUsageSharing?: "opted-in" | "opted-out" } = {}) {
  const snapshot = options.snapshot ?? NORTHFIELD;
  const clock = manualClock(TERM_START);
  const store = new InMemoryCommerceStore();
  const processor = new FakePaymentProcessor(clock.now);
  const signer = await SigningIdentity.generate();
  const service = new CommerceService({ store, processor, plans: PLANS, entitlementSigner: signer, now: clock.now });
  const { accountId, instanceId } = idsFor(snapshot);
  await service.openAccount(
    { accountId, districtLabel: snapshot.district.name, aiUsageSharing: options.aiUsageSharing ?? "opted-out" },
    CLERK,
  );
  await service.linkInstance(accountId, instanceId, CLERK);

  // The district side: its entitlement cache pins the root's entitlement key.
  const cache = new EntitlementCache({ instanceId, rootPublicKey: signer.publicKey, store: new InMemoryEntitlementStore(), now: clock.now });

  const subscribe = async (overrides: Partial<StartSubscriptionRequest> = {}) =>
    await service.startSubscription(
      { accountId, planId: PILOT, paymentMethod: "invoice", termStart: TERM_START, termEnd: TERM_END, ...overrides },
      CLERK,
    );

  /** Delivers every webhook the fake processor has queued, returning the outcomes. */
  const deliverWebhooks = async () => {
    const outcomes = [];
    for (const delivery of processor.takeDeliveries()) outcomes.push(await service.handleProcessorDelivery(delivery));
    return outcomes;
  };

  return { snapshot, clock, store, processor, signer, service, accountId, instanceId, cache, subscribe, deliverWebhooks };
}

/** A seeded pseudo-random generator (mulberry32), so property-style tests are reproducible. */
export function seededRandom(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return { next, int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)) };
}
