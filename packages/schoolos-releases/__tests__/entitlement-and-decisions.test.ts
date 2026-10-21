import { describe, expect, it } from "vitest";
import { InMemoryRolloutStore, releaseDecisionFor, RolloutController } from "../src/index.ts";
import {
  DAY,
  digestOf,
  driftFor,
  makeManager,
  makeRegistry,
  makeSigner,
  manualClock,
  NORTHFIELD,
  registeredDistrict,
  rejection,
  RIVERBEND,
  signedOffer,
  statementFor,
} from "./support.ts";

// SCHO-85: upgrades wait for a live entitlement but rollbacks never do; decisions reach the root
// as signed reason codes; and the manager's read-modify-write cycles can't lose an update.

async function upgradedToR2() {
  const clock = manualClock();
  const { signer, trust } = await makeSigner();
  const { manager, entitlement } = makeManager(clock, trust);
  const r2 = statementFor(clock, "r2-fixture", "0.2.0");
  const record = await manager.receiveOffer(await signedOffer(signer, clock, r2));
  await manager.approve(record.offerSequence, { drift: driftFor(r2) });
  await manager.authorizeApply(record.offerSequence, driftFor(r2));
  await manager.recordInstalled(record.offerSequence);
  return { clock, signer, manager, entitlement };
}

describe("SCHO-85 authorizeApply and the entitlement cache", () => {
  for (const state of ["lapsed", "absent"] as const) {
    it(`refuses an approved upgrade while the entitlement is ${state}, and applies it once renewed`, async () => {
      const { clock, signer, manager, entitlement } = await upgradedToR2();
      const r3 = statementFor(clock, "r3-fixture", "0.3.0");
      const record = await manager.receiveOffer(await signedOffer(signer, clock, r3, { offerSequence: 2 }));
      await manager.approve(record.offerSequence, { drift: driftFor(r3) });

      entitlement.set(state);
      const error = await rejection(manager.authorizeApply(record.offerSequence, driftFor(r3)));
      expect(error).toMatchObject({ code: "policy-violation", message: "the entitlement has lapsed: only a rollback can be applied" });
      // The approval stands; only applying waits.
      expect((await manager.state()).offers.at(-1)?.status).toBe("approved");
      entitlement.set("valid");
      await expect(manager.authorizeApply(record.offerSequence, driftFor(r3))).resolves.toMatchObject({ purpose: "upgrade" });
    });
  }

  it("applies an upgrade during the grace period", async () => {
    const { clock, signer, manager, entitlement } = await upgradedToR2();
    const r3 = statementFor(clock, "r3-fixture", "0.3.0");
    const record = await manager.receiveOffer(await signedOffer(signer, clock, r3, { offerSequence: 2 }));
    await manager.approve(record.offerSequence, { drift: driftFor(r3) });
    entitlement.set("grace");
    await expect(manager.authorizeApply(record.offerSequence, driftFor(r3))).resolves.toMatchObject({ purpose: "upgrade" });
  });

  it("still applies an approved rollback while the entitlement is lapsed", async () => {
    const { clock, signer, manager, entitlement } = await upgradedToR2();
    const r1 = statementFor(clock, "r1-baseline", "0.1.0", { manifestSha256: digestOf("r1-baseline") });
    const record = await manager.receiveOffer(await signedOffer(signer, clock, r1, { offerSequence: 2, purpose: "rollback" }));
    await manager.approve(record.offerSequence, { drift: driftFor(r1), asRollback: true });

    entitlement.set("lapsed");
    await expect(manager.authorizeApply(record.offerSequence, driftFor(r1))).resolves.toMatchObject({
      purpose: "rollback",
      statement: { releaseId: "r1-baseline" },
    });
  });
});

describe("SCHO-85 release decisions reported to the root", () => {
  it("reports each decision as a signed reason code, and the rollout counts the latest per instance", async () => {
    const clock = manualClock();
    const { signer, trust } = await makeSigner();
    const registry = makeRegistry(clock);
    const controller = new RolloutController({ registry, signer, store: new InMemoryRolloutStore(), haltPolicy: { maxFailingFraction: 0.5 }, now: clock.now });
    const northfield = await registeredDistrict(registry, NORTHFIELD, clock, trust, "stable");
    const riverbend = await registeredDistrict(registry, RIVERBEND, clock, trust, "stable");
    const r2 = statementFor(clock, "r2-fixture", "0.2.0");
    await controller.publish(await signer.signManifest(r2));
    await controller.startRollout("stable", "r2-fixture", { kind: "percentage", percent: 100 });

    const report = async (district: typeof northfield, record: Parameters<typeof releaseDecisionFor>[0]) =>
      controller.acceptReleaseDecision(await district.agent.reportReleaseDecision(releaseDecisionFor(record)!));

    const nfOffer = await northfield.manager.receiveOffer((await controller.offerFor(northfield.instanceId, "stable"))!);
    const rbOffer = await riverbend.manager.receiveOffer((await controller.offerFor(riverbend.instanceId, "stable"))!);
    expect(releaseDecisionFor(nfOffer)).toBeUndefined();

    await report(northfield, await northfield.manager.defer(nfOffer.offerSequence, new Date(clock.now().getTime() + 2 * DAY)));
    await report(riverbend, await riverbend.manager.decline(rbOffer.offerSequence, "testing-window"));
    expect((await controller.rollout("stable"))?.decisions).toEqual({ [northfield.instanceId]: "deferred", [riverbend.instanceId]: "declined" });

    await expect(report(northfield, await northfield.manager.approve(nfOffer.offerSequence, { drift: driftFor(r2) }))).resolves.toMatchObject({
      decision: "approved",
      offerSequence: nfOffer.offerSequence,
    });
    expect((await controller.rollout("stable"))?.decisions[northfield.instanceId]).toBe("approved");
  });
});

describe("SCHO-85 serialized district state", () => {
  it("keeps every concurrent decision instead of letting one overwrite another", async () => {
    const clock = manualClock();
    const { signer, trust } = await makeSigner();
    const { manager } = makeManager(clock, trust);
    const r2 = statementFor(clock, "r2-fixture", "0.2.0");
    const record = await manager.receiveOffer(await signedOffer(signer, clock, r2));

    // A rescind and a defer arrive together; both cycles must land in order on the stored state.
    await Promise.all([
      manager.decline(record.offerSequence, "not-now"),
      manager.rescindDecline("r2-fixture"),
      manager.defer(record.offerSequence, new Date(clock.now().getTime() + DAY)),
    ]);
    const state = await manager.state();
    expect(state.declined).toEqual([]);
    expect(state.offers[0]).toMatchObject({ status: "deferred" });
  });

  it("accepts only one of two concurrent offers carrying the same sequence", async () => {
    const clock = manualClock();
    const { signer, trust } = await makeSigner();
    const { manager } = makeManager(clock, trust);
    const offers = await Promise.all(["r2-a", "r2-b"].map(async (id) => signedOffer(signer, clock, statementFor(clock, id, "0.2.0"))));
    const results = await Promise.allSettled(offers.map((offer) => manager.receiveOffer(offer)));
    expect(results.map((result) => result.status).toSorted()).toEqual(["fulfilled", "rejected"]);
    expect((await manager.state()).offers).toHaveLength(1);
  });
});
