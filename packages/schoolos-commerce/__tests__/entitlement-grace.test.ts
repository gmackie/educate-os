import { InstanceId, SchoolOsError } from "@schoolos/contracts";
import { RIVERBEND } from "@schoolos/fixtures";
import { type EntitlementEvaluation, type EntitlementState } from "@schoolos/fleet";
import { describe, expect, it } from "vitest";
import type { SubscriptionStatus } from "../src/index.ts";
import { CLERK, DAY, ENTERPRISE, idsFor, setup, TERM_END, TERM_START } from "./support.ts";

const DUE_AT = new Date(Date.parse(TERM_START) + 30 * DAY).toISOString();
const rootUnreachable = () => Promise.reject(new Error("connect ECONNREFUSED"));

// Classroom features never depend on the entitlement: the fleet type allows no other value.
function expectClassroomUnaffected(evaluation: EntitlementEvaluation) {
  const classroom: "unaffected" = evaluation.classroom;
  expect(classroom).toBe("unaffected");
}

/** An active pilot subscription (past-due 7 days, then grace 14 days) with one open invoice due at `DUE_AT`. */
async function activeWithOpenInvoice() {
  const context = await setup();
  const subscription = await context.subscribe();
  await context.service.activate(subscription.subscriptionId, CLERK);
  const invoice = await context.service.issueInvoice(
    {
      accountId: context.accountId,
      subscriptionId: subscription.subscriptionId,
      lines: [{ kind: "plan-fee", code: "pilot-term", quantity: 1, unitAmountCents: 250_000 }],
      dueAt: DUE_AT,
    },
    CLERK,
  );
  return { ...context, subscription, invoice };
}

describe("entitlement issuance from subscription state", () => {
  it("issues a valid entitlement for an active subscription that the district's cache accepts", async () => {
    const { service, cache, subscription, instanceId } = await activeWithOpenInvoice();
    const envelope = await service.issueEntitlement(subscription.subscriptionId, instanceId, CLERK);
    const evaluation = await cache.accept(envelope);
    expect(evaluation).toMatchObject({ state: "valid", rootManagedChanges: "allowed", capabilityIds: ["core-learning"] });
    // An unpaid term end would start the same grace rules: past-due 7 days, then grace 14 days.
    expect(envelope.payload).toMatchObject({
      validUntil: new Date(Date.parse(TERM_END) + 7 * DAY).toISOString(),
      graceUntil: new Date(Date.parse(TERM_END) + 21 * DAY).toISOString(),
    });
  });

  it("issues each instance increasing revisions, so the cache always takes the newest", async () => {
    const { service, cache, subscription, instanceId } = await activeWithOpenInvoice();
    const first = await service.issueEntitlement(subscription.subscriptionId, instanceId, CLERK);
    const second = await service.issueEntitlement(subscription.subscriptionId, instanceId, CLERK);
    await cache.accept(second);
    await expect(cache.accept(first)).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses an instance the account doesn't pay for", async () => {
    const { service, subscription } = await activeWithOpenInvoice();
    const other = idsFor(RIVERBEND).instanceId;
    await expect(service.issueEntitlement(subscription.subscriptionId, other, CLERK)).rejects.toMatchObject({ code: "not-found" });
    await expect(
      service.issueEntitlement(subscription.subscriptionId, InstanceId.parse("ins_unregistered"), CLERK),
    ).rejects.toBeInstanceOf(SchoolOsError);
  });

  it("an entitlement signed by any key but the pinned root key is rejected", async () => {
    const { cache, instanceId } = await activeWithOpenInvoice();
    // A second root (a different signing key) that also claims this instance.
    const impostor = await setup();
    const own = await impostor.subscribe();
    await impostor.service.activate(own.subscriptionId, CLERK);
    const forged = await impostor.service.issueEntitlement(own.subscriptionId, instanceId, CLERK);
    await expect(cache.accept(forged)).rejects.toMatchObject({ code: "unauthenticated" });
  });
});

describe("grace rules: past-due becomes grace for N days, then lapsed", () => {
  it("moves an overdue subscription through past-due, grace and lapsed, each audited as the clock", async () => {
    const { service, clock, subscription, accountId } = await activeWithOpenInvoice();
    clock.set(DUE_AT);
    clock.advance(1);
    expect((await service.reconcileStatus(subscription.subscriptionId)).status).toBe("past-due");
    clock.advance(7 * DAY);
    expect((await service.reconcileStatus(subscription.subscriptionId)).status).toBe("grace");
    clock.advance(14 * DAY);
    expect((await service.reconcileStatus(subscription.subscriptionId)).status).toBe("lapsed");

    const clockSteps = (await service.auditTrail(accountId)).filter((event) => event.actor.kind === "system");
    expect(clockSteps.map((event) => [event.action, event.before?.state, event.after?.state])).toEqual([
      ["subscription.past-due", "active", "past-due"],
      ["subscription.grace", "past-due", "grace"],
      ["subscription.lapsed", "grace", "lapsed"],
    ]);
  });

  it("records every step when nobody looked for weeks", async () => {
    const { service, clock, subscription } = await activeWithOpenInvoice();
    clock.set(DUE_AT);
    clock.advance(60 * DAY);
    expect((await service.reconcileStatus(subscription.subscriptionId)).status).toBe("lapsed");
    const steps = (await service.auditTrail(subscription.accountId)).map((event) => event.action).filter((a) => a.startsWith("subscription."));
    expect(steps).toEqual(["subscription.started", "subscription.activated", "subscription.past-due", "subscription.grace", "subscription.lapsed"]);
  });

  it("keeps the district's cache in step with the root's status on the district's own clock", async () => {
    const { service, cache, clock, subscription, instanceId } = await activeWithOpenInvoice();
    clock.set(DUE_AT);
    clock.advance(1);
    // Issued once, at the start of delinquency; the root is unreachable from then on.
    await cache.accept(await service.issueEntitlement(subscription.subscriptionId, instanceId, CLERK));
    const expected: Record<SubscriptionStatus, EntitlementState | undefined> = {
      "past-due": "valid",
      grace: "grace",
      lapsed: "lapsed",
      trialing: undefined,
      active: undefined,
      cancelled: undefined,
    };
    const seen = new Set<string>();
    for (let hour = 0; hour < 30 * 24; hour += 5) {
      const root = await service.reconcileStatus(subscription.subscriptionId);
      const district = (await cache.refresh(rootUnreachable)).evaluation;
      expect(district.state, `hour ${hour}: root is ${root.status}`).toBe(expected[root.status]);
      expectClassroomUnaffected(district);
      seen.add(root.status);
      clock.advance(5 * 60 * 60 * 1000);
    }
    expect([...seen]).toEqual(["past-due", "grace", "lapsed"]);
  });

  it("with no past-due days, a failed charge puts the subscription straight into grace", async () => {
    const context = await setup();
    const { service, processor, accountId, instanceId, cache } = context;
    await service.ensureProcessorCustomer(accountId, CLERK);
    const subscription = await context.subscribe({ planId: ENTERPRISE, paymentMethod: "card" });
    await service.activate(subscription.subscriptionId, CLERK);
    const invoice = await service.issueInvoice(
      { accountId, subscriptionId: subscription.subscriptionId, lines: [{ kind: "plan-fee", code: "enterprise-term", quantity: 1, unitAmountCents: 9_000_000 }], dueAt: DUE_AT },
      CLERK,
    );
    processor.failNextCharge();
    await service.chargeInvoice(invoice.invoiceId, CLERK);
    await context.deliverWebhooks();
    expect((await service.subscription(subscription.subscriptionId)).status).toBe("grace");
    const evaluation = await cache.accept(await service.issueEntitlement(subscription.subscriptionId, instanceId, CLERK));
    expect(evaluation).toMatchObject({ state: "grace", rootManagedChanges: "allowed" });
  });

  it("paying a lapsed subscription's invoice reactivates it and the next entitlement is valid", async () => {
    const { service, cache, clock, subscription, invoice, instanceId } = await activeWithOpenInvoice();
    clock.set(DUE_AT);
    clock.advance(30 * DAY);
    await cache.accept(await service.issueEntitlement(subscription.subscriptionId, instanceId, CLERK));
    expect((await cache.evaluate()).state).toBe("lapsed");

    await service.recordManualPayment(invoice.invoiceId, 250_000, "check-10442", CLERK);
    expect((await service.subscription(subscription.subscriptionId)).status).toBe("active");
    const evaluation = await cache.accept(await service.issueEntitlement(subscription.subscriptionId, instanceId, CLERK));
    expect(evaluation).toMatchObject({ state: "valid", rootManagedChanges: "allowed" });
  });

  it("renewing a term that ran out cures the delinquency the term end caused", async () => {
    const { service, clock, subscription, invoice } = await activeWithOpenInvoice();
    await service.recordManualPayment(invoice.invoiceId, 250_000, "check-10443", CLERK);
    clock.set(TERM_END);
    clock.advance(10 * DAY);
    expect((await service.reconcileStatus(subscription.subscriptionId)).status).toBe("grace");
    const renewed = await service.renewTerm(subscription.subscriptionId, "2028-06-30T12:00:00.000Z", CLERK);
    expect(renewed).toMatchObject({ status: "active", termEnd: "2028-06-30T12:00:00.000Z" });
    expect(renewed.pastDueSince).toBeUndefined();
  });
});

describe("a lapsed entitlement blocks only root-managed changes", () => {
  it("keeps classroom features and the entitled packs while blocking new root-managed changes", async () => {
    const { service, cache, clock, subscription, instanceId } = await activeWithOpenInvoice();
    clock.set(DUE_AT);
    clock.advance(25 * DAY);
    expect((await service.reconcileStatus(subscription.subscriptionId)).status).toBe("lapsed");
    const evaluation = await cache.accept(await service.issueEntitlement(subscription.subscriptionId, instanceId, CLERK));
    expect(evaluation).toMatchObject({
      state: "lapsed",
      rootManagedChanges: "blocked",
      classroom: "unaffected",
      // Lapsing doesn't strip the packs the district already runs.
      capabilityIds: ["core-learning"],
    });
    expectClassroomUnaffected(evaluation);
  });

  it("a lapsed district stays lapsed, not broken, when the root is unreachable", async () => {
    const { service, cache, clock, subscription, instanceId } = await activeWithOpenInvoice();
    clock.set(DUE_AT);
    clock.advance(25 * DAY);
    await cache.accept(await service.issueEntitlement(subscription.subscriptionId, instanceId, CLERK));
    clock.advance(365 * DAY);
    const refreshed = await cache.refresh(rootUnreachable);
    expect(refreshed).toMatchObject({ outcome: "root-unreachable", evaluation: { state: "lapsed", classroom: "unaffected" } });
  });
});

describe("cancellation", () => {
  it("lapses the entitlement at once while the district keeps running its installed release", async () => {
    const { service, cache, subscription, instanceId, store } = await activeWithOpenInvoice();
    await cache.accept(await service.issueEntitlement(subscription.subscriptionId, instanceId, CLERK));
    const before = store.dump().length;

    const cancelled = await service.cancel(subscription.subscriptionId, CLERK);
    expect(cancelled.status).toBe("cancelled");
    const evaluation = await cache.accept(await service.issueEntitlement(subscription.subscriptionId, instanceId, CLERK));
    expect(evaluation).toMatchObject({ state: "lapsed", rootManagedChanges: "blocked", capabilityIds: ["core-learning"] });
    expectClassroomUnaffected(evaluation);

    // Cancelling records a status change and nothing else: commerce holds no district data to
    // delete, export or withhold. The data stays where it always was, in the district's account.
    const actions = (await service.auditTrail(subscription.accountId)).map((event) => event.action);
    expect(actions.slice(-2)).toEqual(["subscription.cancelled", "entitlement.issued"]);
    expect(store.dump().length).toBe(before + 2);
  });

  it("is terminal: a cancelled subscription can't be reactivated or renewed", async () => {
    const { service, subscription } = await activeWithOpenInvoice();
    await service.cancel(subscription.subscriptionId, CLERK);
    await expect(service.activate(subscription.subscriptionId, CLERK)).rejects.toMatchObject({ code: "conflict" });
    await expect(service.renewTerm(subscription.subscriptionId, "2028-06-30T12:00:00.000Z", CLERK)).rejects.toMatchObject({ code: "conflict" });
  });
});
