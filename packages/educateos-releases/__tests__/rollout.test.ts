import type { ReleaseChannel } from "@educateos/fleet";
import { describe, expect, it } from "vitest";
import { InMemoryRolloutStore, RolloutController } from "../src/index.ts";
import {
  baseline,
  type Clock,
  driftFor,
  FAILING,
  HEALTHY,
  makeRegistry,
  makeSigner,
  manualClock,
  MINUTE,
  NORTHFIELD,
  registeredDistrict,
  rejection,
  RIVERBEND,
  statementFor,
} from "./support.ts";

async function fleetOn(channel: ReleaseChannel, maxFailingFraction = 0.4) {
  const clock = manualClock();
  const { signer, trust } = await makeSigner();
  const registry = makeRegistry(clock);
  const controller = new RolloutController({
    registry,
    signer,
    store: new InMemoryRolloutStore(),
    haltPolicy: { maxFailingFraction },
    now: clock.now,
  });
  const northfield = await registeredDistrict(registry, NORTHFIELD, clock, trust, channel);
  const riverbend = await registeredDistrict(registry, RIVERBEND, clock, trust, channel);

  // Establish r1 as the channel's release everyone already runs, so a later halt has a rollback target.
  const r1 = statementFor(clock, "r1-baseline", "0.1.0", { channel, manifestSha256: baseline(clock).manifestSha256 });
  await controller.publish(await signer.signManifest(r1));
  await controller.startRollout(channel, "r1-baseline", { kind: "percentage", percent: 100 });
  return { clock, signer, registry, controller, northfield, riverbend };
}

type District = Awaited<ReturnType<typeof registeredDistrict>>;

// The district's side of taking an offer: verify, approve after the dry run, apply, report health.
async function takeOffer(controller: RolloutController, district: District, channel: ReleaseChannel, clock: Clock, asRollback = false) {
  const envelope = await controller.offerFor(district.instanceId, channel);
  if (envelope === undefined) return undefined;
  const record = await district.manager.receiveOffer(envelope);
  const drift = driftFor(record.statement);
  await district.manager.approve(record.offerSequence, { drift, asRollback });
  const authorized = await district.manager.authorizeApply(record.offerSequence, drift);
  await district.manager.recordInstalled(record.offerSequence);
  clock.advance(MINUTE);
  return authorized;
}

async function heartbeat(controller: RolloutController, district: District, version: string, healthy: boolean) {
  await controller.acceptHeartbeat(await district.heartbeat(version, healthy ? HEALTHY : FAILING));
}

describe("R03 acceptance: an update canary passes", () => {
  it("offers the release to the canary instances first, stays active while they are healthy, then widens", async () => {
    const { clock, signer, controller, northfield, riverbend } = await fleetOn("canary");
    const r2 = statementFor(clock, "r2-fixture", "0.2.0", { channel: "canary" });
    await controller.publish(await signer.signManifest(r2));
    await controller.startRollout("canary", "r2-fixture", { kind: "instances", instanceIds: [northfield.instanceId] });

    expect(await controller.offerFor(riverbend.instanceId, "canary")).toBeUndefined();
    const authorized = await takeOffer(controller, northfield, "canary", clock);
    expect(authorized).toMatchObject({ purpose: "upgrade", statement: { releaseId: "r2-fixture" } });
    await heartbeat(controller, northfield, "0.2.0", true);
    expect(await controller.rollout("canary")).toMatchObject({ status: "active" });
    // Northfield runs the release now, so it is offered nothing more.
    expect(await controller.offerFor(northfield.instanceId, "canary")).toBeUndefined();

    await controller.widen("canary", { kind: "percentage", percent: 100 });
    await takeOffer(controller, riverbend, "canary", clock);
    await heartbeat(controller, riverbend, "0.2.0", true);
    expect(await controller.rollout("canary")).toMatchObject({ status: "active", releaseId: "r2-fixture" });
    expect((await riverbend.manager.state()).installed.at(-1)).toMatchObject({ releaseId: "r2-fixture", version: "0.2.0" });
  });

  it("samples a percentage rollout by a stable hash, so the same instances are chosen every time", async () => {
    const { clock, signer, controller, northfield, riverbend } = await fleetOn("stable");
    await controller.publish(await signer.signManifest(statementFor(clock, "r2-fixture", "0.2.0")));
    await controller.startRollout("stable", "r2-fixture", { kind: "percentage", percent: 0 });
    expect(await controller.offerFor(northfield.instanceId, "stable")).toBeUndefined();

    await controller.widen("stable", { kind: "percentage", percent: 50 });
    const chosen = async () => [
      (await controller.offerFor(northfield.instanceId, "stable")) !== undefined,
      (await controller.offerFor(riverbend.instanceId, "stable")) !== undefined,
    ];
    expect(await chosen()).toEqual(await chosen());
  });
});

describe("R03 canary halt on fleet health", () => {
  it("halts when upgraded instances fail health past the threshold, then offers a rollback to the previous signed release", async () => {
    const { clock, signer, controller, northfield, riverbend } = await fleetOn("canary", 0.4);
    const r2 = statementFor(clock, "r2-broken", "0.2.0", { channel: "canary" });
    await controller.publish(await signer.signManifest(r2));
    await controller.startRollout("canary", "r2-broken", { kind: "instances", instanceIds: [northfield.instanceId, riverbend.instanceId] });

    await takeOffer(controller, northfield, "canary", clock);
    await takeOffer(controller, riverbend, "canary", clock);
    await heartbeat(controller, northfield, "0.2.0", true);
    expect(await controller.rollout("canary")).toMatchObject({ status: "active" });
    // One of two failing is past 40%.
    await heartbeat(controller, riverbend, "0.2.0", false);
    expect(await controller.rollout("canary")).toMatchObject({ status: "halted", haltReason: "health.failing", previousReleaseId: "r1-baseline" });

    const rollback = await takeOffer(controller, riverbend, "canary", clock, true);
    expect(rollback).toMatchObject({ purpose: "rollback", statement: { releaseId: "r1-baseline", version: "0.1.0" } });
    expect((await riverbend.manager.state()).installed.at(-1)).toMatchObject({ releaseId: "r1-baseline" });
  });

  it("ignores failing health from instances not on the rollout's release", async () => {
    const { clock, signer, controller, northfield, riverbend } = await fleetOn("stable", 0);
    await controller.publish(await signer.signManifest(statementFor(clock, "r2-fixture", "0.2.0")));
    await controller.startRollout("stable", "r2-fixture", { kind: "instances", instanceIds: [northfield.instanceId] });
    await takeOffer(controller, northfield, "stable", clock);
    await heartbeat(controller, northfield, "0.2.0", true);

    await heartbeat(controller, riverbend, "0.1.0", false);
    expect(await controller.rollout("stable")).toMatchObject({ status: "active" });
  });

  it("offers nothing new once halted, and refuses to widen a halted rollout", async () => {
    const { clock, signer, controller, northfield, riverbend } = await fleetOn("stable", 0);
    await controller.publish(await signer.signManifest(statementFor(clock, "r2-broken", "0.2.0")));
    await controller.startRollout("stable", "r2-broken", { kind: "instances", instanceIds: [northfield.instanceId] });
    await takeOffer(controller, northfield, "stable", clock);
    await heartbeat(controller, northfield, "0.2.0", false);

    expect(await controller.offerFor(riverbend.instanceId, "stable")).toBeUndefined();
    expect((await rejection(controller.widen("stable", { kind: "percentage", percent: 100 }))).code).toBe("conflict");
  });

  it("re-signs an expired previous release when it offers the rollback", async () => {
    const { clock, signer, controller, northfield } = await fleetOn("stable", 0);
    await controller.publish(await signer.signManifest(statementFor(clock, "r2-broken", "0.2.0")));
    await controller.startRollout("stable", "r2-broken", { kind: "instances", instanceIds: [northfield.instanceId] });
    await takeOffer(controller, northfield, "stable", clock);
    // Long enough for r1's 30-day statement to lapse; the heartbeat that halts arrives after.
    clock.advance(40 * 24 * 60 * MINUTE);
    await heartbeat(controller, northfield, "0.2.0", false);

    const rollback = await takeOffer(controller, northfield, "stable", clock, true);
    expect(rollback).toMatchObject({ purpose: "rollback", statement: { releaseId: "r1-baseline" } });
  });

  it("issues no offer to an instance that revoked the root's management access", async () => {
    const { clock, signer, controller, northfield } = await fleetOn("stable");
    await controller.publish(await signer.signManifest(statementFor(clock, "r2-fixture", "0.2.0")));
    await controller.startRollout("stable", "r2-fixture", { kind: "percentage", percent: 100 });
    await northfield.revokeManagement();

    expect((await rejection(controller.offerFor(northfield.instanceId, "stable"))).code).toBe("forbidden");
  });
});
