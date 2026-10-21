import type { Subscription, SubscriptionStatus } from "./model.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When an unpaid subscription moves through its grace rules. Delinquency starts at the earlier of
 * a recorded payment failure (`pastDueSince`) and the end of the term: a term that ends without
 * renewal is unpaid from that moment. The subscription is `past-due` from `delinquentFrom`, in
 * `grace` from `graceFrom`, and `lapsed` from `lapsesAt`.
 */
export interface GraceSchedule {
  delinquentFrom: number;
  graceFrom: number;
  lapsesAt: number;
}

/** The grace schedule a subscription is on, as epoch milliseconds. */
export function graceSchedule(subscription: Subscription): GraceSchedule {
  const termEnd = Date.parse(subscription.termEnd);
  const delinquentFrom = subscription.pastDueSince === undefined ? termEnd : Math.min(termEnd, Date.parse(subscription.pastDueSince));
  const graceFrom = delinquentFrom + subscription.graceRules.pastDueDays * DAY_MS;
  return { delinquentFrom, graceFrom, lapsesAt: graceFrom + subscription.graceRules.graceDays * DAY_MS };
}

/** One clock-driven status change, and the delinquency start it records. */
export interface TimedTransition {
  to: Extract<SubscriptionStatus, "past-due" | "grace" | "lapsed">;
  pastDueSince: string;
}

const ORDER: SubscriptionStatus[] = ["past-due", "grace", "lapsed"];

/**
 * The clock-driven transitions a subscription is due at `now`, in order. Cancelled and lapsed
 * subscriptions have none. A subscription several steps behind (nobody looked at it for a month)
 * gets every step, so the audit trail shows each one.
 */
export function timedTransitions(subscription: Subscription, now: Date): TimedTransition[] {
  if (subscription.status === "cancelled" || subscription.status === "lapsed") return [];
  const schedule = graceSchedule(subscription);
  const pastDueSince = new Date(schedule.delinquentFrom).toISOString();
  const t = now.getTime();
  const due: TimedTransition["to"][] = [];
  if (t >= schedule.delinquentFrom) due.push("past-due");
  if (t >= schedule.graceFrom) due.push("grace");
  if (t >= schedule.lapsesAt) due.push("lapsed");
  const reached = ORDER.indexOf(subscription.status);
  return due.filter((to) => ORDER.indexOf(to) > reached).map((to) => ({ to, pastDueSince }));
}

/** The validity window of an entitlement issued for a subscription at `now`, as ISO timestamps. */
export interface EntitlementWindow {
  validUntil: string;
  graceUntil: string;
}

/**
 * The entitlement window that makes the district's entitlement cache agree with the root's status
 * at every instant, even if the district never hears from the root again (as far as the root can
 * know at issuance: an invoice that goes overdue later reaches the district with its next
 * entitlement, so an unreachable root errs on the district's side). The cache reports
 * `valid` until the subscription would turn `grace`, `grace` until it would lapse, and `lapsed`
 * after. A lapsed or cancelled subscription gets a window that has already closed, so the cache
 * blocks new root-managed changes at once while the installed release keeps running.
 */
export function entitlementWindow(subscription: Subscription, now: Date): EntitlementWindow {
  const t = now.getTime();
  if (subscription.status === "lapsed" || subscription.status === "cancelled") {
    return { validUntil: now.toISOString(), graceUntil: now.toISOString() };
  }
  const schedule = graceSchedule(subscription);
  const validUntil = Math.max(t, schedule.graceFrom);
  const graceUntil = Math.max(validUntil, schedule.lapsesAt);
  return { validUntil: new Date(validUntil).toISOString(), graceUntil: new Date(graceUntil).toISOString() };
}
