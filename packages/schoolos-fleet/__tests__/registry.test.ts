import { InstanceId, SchoolOsError } from "@schoolos/contracts";
import { NORTHFIELD, RIVERBEND } from "@schoolos/fixtures";
import { describe, expect, it } from "vitest";
import {
  type HealthProbe,
  Heartbeat,
  KeyId,
  OwnershipToken,
  type SignedEnvelope,
  signEnvelope,
  SupportSessionId,
} from "../src/index.ts";
import { makeDistrict, makeRegistry, manualClock, MINUTE, personalStrings } from "./support.ts";

const HEALTHY: HealthProbe[] = [
  { probeId: "d1", status: "ok" },
  { probeId: "ai-gateway", status: "degraded", code: "latency.high" },
];

async function rejection(promise: Promise<unknown>): Promise<SchoolOsError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SchoolOsError);
  return error as SchoolOsError;
}

/** Re-sends an envelope through JSON, as the network would. */
function overTheWire(envelope: SignedEnvelope): unknown {
  return JSON.parse(JSON.stringify(envelope));
}

async function registered() {
  const clock = manualClock();
  const { registry, storage } = makeRegistry(clock);
  const northfield = await makeDistrict(NORTHFIELD, clock);
  const riverbend = await makeDistrict(RIVERBEND, clock);
  const receipt = await registry.register(await northfield.registration());
  await registry.register(await riverbend.registration());
  return { clock, registry, storage, northfield, riverbend, receipt };
}

const offer = (instanceId: InstanceId) => ({
  instanceId,
  releaseId: "r2-fixture",
  releaseVersion: "0.2.0",
  channel: "stable" as const,
  purpose: "upgrade" as const,
  offerSequence: 1,
  manifestSha256: "a".repeat(64),
  signedManifest: { payload: {}, signature: "A".repeat(86), keyId: KeyId.parse(`ed25519-${"A".repeat(43)}`) },
  expiresAt: "2026-10-27T12:00:00Z",
});

describe("R01 acceptance: two districts register and heartbeat without uploading PII", () => {
  it("registers NORTHFIELD and RIVERBEND, accepts their heartbeats and shows only version and health", async () => {
    const clock = manualClock();
    const { registry, storage } = makeRegistry(clock);
    const northfield = await makeDistrict(NORTHFIELD, clock, { sharesAggregateSpend: true });
    const riverbend = await makeDistrict(RIVERBEND, clock);

    const sent: SignedEnvelope[] = [];
    for (const district of [northfield, riverbend]) {
      const registration = await district.registration();
      sent.push(registration);
      const receipt = await registry.register(overTheWire(registration));
      expect(receipt.instanceId).toBe(district.instanceId);
      expect(receipt.keyId).toBe(district.identity.keyId);
    }

    clock.advance(MINUTE);
    const northfieldBeat = await northfield.agent.heartbeat({
      releaseVersion: "0.1.1",
      probes: HEALTHY,
      aggregateAiSpendUsdNano: "123450038000",
    });
    const riverbendBeat = await riverbend.agent.heartbeat({ releaseVersion: "0.1.0", probes: HEALTHY });
    sent.push(northfieldBeat, riverbendBeat);
    await registry.acceptHeartbeat(overTheWire(northfieldBeat));
    await registry.acceptHeartbeat(overTheWire(riverbendBeat));

    const view = await registry.fleetView();
    expect(view).toEqual([
      { instanceId: northfield.instanceId, releaseVersion: "0.1.1", lastHeartbeatAt: clock.now().toISOString(), probes: HEALTHY },
      { instanceId: riverbend.instanceId, releaseVersion: "0.1.0", lastHeartbeatAt: clock.now().toISOString(), probes: HEALTHY },
    ]);

    // Nothing that names or identifies a person reached the root, on the wire or in storage.
    const wire = JSON.stringify(sent);
    const stored = JSON.stringify(await storage.list());
    for (const value of [...personalStrings(NORTHFIELD), ...personalStrings(RIVERBEND)]) {
      expect(wire).not.toContain(value);
      expect(stored).not.toContain(value);
    }
    expect(wire).not.toMatch(/@/);
    expect(stored).not.toMatch(/@/);
  });

  it("keeps the instances apart: NORTHFIELD's heartbeat never changes RIVERBEND's record", async () => {
    const clock = manualClock();
    const { registry } = makeRegistry(clock);
    const northfield = await makeDistrict(NORTHFIELD, clock);
    const riverbend = await makeDistrict(RIVERBEND, clock);
    await registry.register(await northfield.registration());
    await registry.register(await riverbend.registration());

    await registry.acceptHeartbeat(await northfield.agent.heartbeat({ releaseVersion: "0.2.0", probes: HEALTHY }));

    const view = await registry.fleetView();
    expect(view.find((entry) => entry.instanceId === riverbend.instanceId)).toEqual({
      instanceId: riverbend.instanceId,
      releaseVersion: "0.1.0",
      probes: [],
    });
  });
});

describe("registration", () => {
  it("is first-come: a second district can't claim a registered instance ID, and a replay is refused", async () => {
    const clock = manualClock();
    const { registry } = makeRegistry(clock);
    const northfield = await makeDistrict(NORTHFIELD, clock);
    const registration = await northfield.registration();
    await registry.register(registration);

    expect((await rejection(registry.register(registration))).code).toBe("conflict");
    // Under its own account the commercial system never confirmed the instance; under Northfield's
    // account (an ID is not a secret) the instance is already taken.
    const squatter = await makeDistrict(RIVERBEND, clock, { instanceId: northfield.instanceId });
    expect((await rejection(registry.register(await squatter.registration()))).code).toBe("forbidden");
    const impostor = await makeDistrict(NORTHFIELD, clock);
    expect((await rejection(registry.register(await impostor.registration()))).code).toBe("conflict");
  });

  it("refuses a key already registered to another instance", async () => {
    const clock = manualClock();
    const { registry } = makeRegistry(clock);
    const northfield = await makeDistrict(NORTHFIELD, clock);
    await registry.register(await northfield.registration());

    const reuse = await makeDistrict(RIVERBEND, clock, { identity: northfield.identity });
    expect((await rejection(registry.register(await reuse.registration()))).code).toBe("conflict");
  });

  it("requires proof of possession: a registration signed by a different key than it registers is refused", async () => {
    const clock = manualClock();
    const { registry } = makeRegistry(clock);
    const northfield = await makeDistrict(NORTHFIELD, clock);
    const attacker = await makeDistrict(NORTHFIELD, clock);
    const genuine = await northfield.registration();
    // The attacker re-signs Northfield's request (Northfield's public key) with its own key.
    const forged = await signEnvelope(attacker.identity, "registration", genuine.payload);
    expect((await rejection(registry.register(forged))).code).toBe("unauthenticated");
    // And can't pass Northfield's key ID off as its own signature.
    expect((await rejection(registry.register({ ...forged, keyId: genuine.keyId }))).code).toBe("unauthenticated");
  });

  it("rejects a registration carrying a field outside the allow-list, even when validly signed", async () => {
    const clock = manualClock();
    const { registry, storage } = makeRegistry(clock);
    const northfield = await makeDistrict(NORTHFIELD, clock);
    const genuine = await northfield.registration();
    const smuggled = await signEnvelope(northfield.identity, "registration", {
      ...(genuine.payload as object),
      contactEmail: "it-director@northfield.example",
    });
    expect((await rejection(registry.register(smuggled))).code).toBe("validation-failed");
    expect(await storage.list()).toEqual([]);
  });

  it("rejects a registration whose timestamp is outside the skew window", async () => {
    const clock = manualClock();
    const { registry } = makeRegistry(clock);
    const northfield = await makeDistrict(NORTHFIELD, clock);
    const registration = await northfield.registration();
    clock.advance(10 * MINUTE);
    expect((await rejection(registry.register(registration))).code).toBe("unauthenticated");
  });
});

describe("heartbeats", () => {

  it("rejects a forged signature and a tampered payload", async () => {
    const { registry, northfield } = await registered();
    const beat = await northfield.agent.heartbeat({ releaseVersion: "0.1.0", probes: HEALTHY });

    const flipped = beat.signature.startsWith("A") ? `B${beat.signature.slice(1)}` : `A${beat.signature.slice(1)}`;
    expect((await rejection(registry.acceptHeartbeat({ ...beat, signature: flipped }))).code).toBe("unauthenticated");

    const tampered = { ...beat, payload: { ...(beat.payload as object), releaseVersion: "9.9.9" } };
    expect((await rejection(registry.acceptHeartbeat(tampered))).code).toBe("unauthenticated");
  });

  it("rejects a replayed heartbeat and a stale sequence number", async () => {
    const { registry, northfield } = await registered();
    const first = await northfield.agent.heartbeat({ releaseVersion: "0.1.0", probes: HEALTHY });
    const second = await northfield.agent.heartbeat({ releaseVersion: "0.1.0", probes: HEALTHY });

    await registry.acceptHeartbeat(first);
    expect((await rejection(registry.acceptHeartbeat(first))).code).toBe("conflict");
    await registry.acceptHeartbeat(second);
    expect((await rejection(registry.acceptHeartbeat(first))).code).toBe("conflict");
  });

  it("rejects a heartbeat whose timestamp is outside the skew window", async () => {
    const { clock, registry, northfield } = await registered();
    const beat = await northfield.agent.heartbeat({ releaseVersion: "0.1.0", probes: HEALTHY });
    clock.advance(6 * MINUTE);
    expect((await rejection(registry.acceptHeartbeat(beat))).code).toBe("unauthenticated");
  });

  it("refuses a cross-instance key swap: RIVERBEND's key can't heartbeat as NORTHFIELD", async () => {
    const { registry, northfield, riverbend } = await registered();
    // Riverbend's agent, pointed at Northfield's instance ID and signing with Riverbend's key.
    const impostor = await makeDistrict(RIVERBEND, manualClock(), {
      identity: riverbend.identity,
      instanceId: northfield.instanceId,
    });
    const swapped = await impostor.agent.heartbeat({ releaseVersion: "6.6.6", probes: [] });
    expect((await rejection(registry.acceptHeartbeat(swapped))).code).toBe("unauthenticated");

    // Relabelling the envelope with Northfield's key ID doesn't help: the signature is Riverbend's.
    const relabelled = { ...swapped, keyId: northfield.identity.keyId };
    expect((await rejection(registry.acceptHeartbeat(relabelled))).code).toBe("unauthenticated");

    const view = await registry.fleetView();
    expect(view.find((entry) => entry.instanceId === northfield.instanceId)?.releaseVersion).toBe("0.1.0");
  });

  it("gives an unknown instance the same answer as a bad signature", async () => {
    const { registry } = await registered();
    const stranger = await makeDistrict(NORTHFIELD, manualClock(), { instanceId: InstanceId.parse("ins_unknown") });
    const error = await rejection(registry.acceptHeartbeat(await stranger.agent.heartbeat({ releaseVersion: "0.1.0", probes: [] })));
    expect(error.code).toBe("unauthenticated");
    expect(error.message).toBe("signature not accepted");
  });

  it("rejects health probes with free text instead of an opaque code", async () => {
    const { registry, northfield } = await registered();
    const beat = await northfield.agent.heartbeat({ releaseVersion: "0.1.0", probes: [] });
    const withText = await signEnvelope(northfield.identity, "heartbeat", {
      ...(beat.payload as object),
      sequence: 99,
      probes: [{ probeId: "roster-sync", status: "failing", code: "Sync failed for Dmitri Volkov" }],
    });
    expect((await rejection(registry.acceptHeartbeat(withText))).code).toBe("validation-failed");
  });
});

describe("revocation of management access", () => {
  it("stops release offers and support sessions for the revoking district only", async () => {
    const clock = manualClock();
    const { registry } = makeRegistry(clock);
    const northfield = await makeDistrict(NORTHFIELD, clock);
    const riverbend = await makeDistrict(RIVERBEND, clock);
    const receipt = await registry.register(await northfield.registration());
    await registry.register(await riverbend.registration());

    await expect(registry.createReleaseOffer(offer(northfield.instanceId))).resolves.toMatchObject({ releaseVersion: "0.2.0" });

    await registry.revoke(await northfield.agent.revokeManagement(receipt.ownershipToken));

    expect((await rejection(registry.createReleaseOffer(offer(northfield.instanceId)))).code).toBe("forbidden");
    const support = {
      requestId: SupportSessionId.parse("sup_ticket-1"),
      instanceId: northfield.instanceId,
      reasonCode: "upgrade-assist",
      expiresAt: "2026-10-21T12:00:00Z",
    };
    expect((await rejection(registry.createSupportSessionRequest(support))).code).toBe("forbidden");
    await expect(registry.createReleaseOffer(offer(riverbend.instanceId))).resolves.toMatchObject({
      instanceId: riverbend.instanceId,
    });

    // The district still chooses to report health.
    await registry.acceptHeartbeat(await northfield.agent.heartbeat({ releaseVersion: "0.1.0", probes: HEALTHY }));
  });

  it("requires the ownership token as well as the instance key", async () => {
    const clock = manualClock();
    const { registry } = makeRegistry(clock);
    const northfield = await makeDistrict(NORTHFIELD, clock);
    await registry.register(await northfield.registration());

    const wrongToken = OwnershipToken.parse("A".repeat(43));
    expect((await rejection(registry.revoke(await northfield.agent.revokeManagement(wrongToken)))).code).toBe(
      "unauthenticated",
    );
    await expect(registry.createReleaseOffer(offer(northfield.instanceId))).resolves.toBeDefined();
  });

  it("can't be forged by another district holding its own valid token", async () => {
    const clock = manualClock();
    const { registry } = makeRegistry(clock);
    const northfield = await makeDistrict(NORTHFIELD, clock);
    const riverbend = await makeDistrict(RIVERBEND, clock);
    const northfieldReceipt = await registry.register(await northfield.registration());
    const riverbendReceipt = await registry.register(await riverbend.registration());

    const impostor = await makeDistrict(RIVERBEND, clock, {
      identity: riverbend.identity,
      instanceId: northfield.instanceId,
    });
    for (const token of [riverbendReceipt.ownershipToken, northfieldReceipt.ownershipToken]) {
      expect((await rejection(registry.revoke(await impostor.agent.revokeManagement(token)))).code).toBe(
        "unauthenticated",
      );
    }
    await expect(registry.createReleaseOffer(offer(northfield.instanceId))).resolves.toBeDefined();
  });

  it("refuses a replayed revocation", async () => {
    const clock = manualClock();
    const { registry } = makeRegistry(clock);
    const northfield = await makeDistrict(NORTHFIELD, clock);
    const receipt = await registry.register(await northfield.registration());
    const revocation = await northfield.agent.revokeManagement(receipt.ownershipToken);
    await registry.revoke(revocation);
    expect((await rejection(registry.revoke(revocation))).code).toBe("conflict");
  });
});

describe("heartbeat AI spend across the SCHO-119 upgrade", () => {
  const base = { instanceId: "ins_northfield", sequence: 1, sentAt: "2026-10-20T14:00:00Z", releaseVersion: "0.1.0", probes: [] };

  it("reads the current form, in nanodollars, unchanged", () => {
    expect(Heartbeat.parse({ ...base, aggregateAiSpendUsdNano: "38000" })).toEqual({ ...base, aggregateAiSpendUsdNano: "38000" });
  });

  it("reads the earlier form, in cents, as nanodollars", () => {
    expect(Heartbeat.parse({ ...base, aggregateAiSpendCents: 12_345 })).toEqual({ ...base, aggregateAiSpendUsdNano: "123450000000" });
  });

  it("refuses a heartbeat that carries both forms, or a malformed amount", () => {
    expect(Heartbeat.safeParse({ ...base, aggregateAiSpendCents: 1, aggregateAiSpendUsdNano: "10000000" }).success).toBe(false);
    for (const amount of ["-1", "01", "1.5", 5]) expect(Heartbeat.safeParse({ ...base, aggregateAiSpendUsdNano: amount }).success).toBe(false);
  });

  it("the root accepts a signed heartbeat from an agent that still sends cents", async () => {
    const clock = manualClock();
    const { registry, storage } = makeRegistry(clock);
    const district = await makeDistrict(NORTHFIELD, clock, { sharesAggregateSpend: true });
    await registry.register(await district.registration());
    clock.advance(MINUTE);
    const legacy = { ...base, instanceId: district.instanceId, sentAt: clock.now().toISOString(), aggregateAiSpendCents: 250 };
    await registry.acceptHeartbeat(overTheWire(await signEnvelope(district.identity, "heartbeat", legacy)));
    const [record] = await storage.list();
    expect(record).toMatchObject({ aggregateAiSpendUsdNano: "2500000000", lastSequence: 1 });
    expect(record).not.toHaveProperty("aggregateAiSpendCents");
  });
});

describe("district agent", () => {
  it("refuses to send aggregate AI spend unless the district opted in", async () => {
    const clock = manualClock();
    const district = await makeDistrict(NORTHFIELD, clock);
    const error = await rejection(
      district.agent.heartbeat({ releaseVersion: "0.1.0", probes: [], aggregateAiSpendUsdNano: "1000000000" }),
    );
    expect(error.code).toBe("policy-violation");
  });

  it("sends AI spend in nanodollars and never the earlier cents field", async () => {
    const clock = manualClock();
    const district = await makeDistrict(NORTHFIELD, clock, { sharesAggregateSpend: true });
    const beat = await district.agent.heartbeat({ releaseVersion: "0.1.0", probes: [], aggregateAiSpendUsdNano: "38000" });
    expect(beat.payload).toMatchObject({ aggregateAiSpendUsdNano: "38000" });
    expect(Object.keys(beat.payload as object)).not.toContain("aggregateAiSpendCents");
  });

  it("drops fields outside the allow-list instead of signing them", async () => {
    const clock = manualClock();
    const district = await makeDistrict(NORTHFIELD, clock);
    const probe = { probeId: "d1", status: "ok", code: "fine", detail: "student roster row 12" } as HealthProbe;
    const beat = await district.agent.heartbeat({ releaseVersion: "0.1.0", probes: [probe] });
    expect(JSON.stringify(beat)).not.toContain("roster");
  });
});
