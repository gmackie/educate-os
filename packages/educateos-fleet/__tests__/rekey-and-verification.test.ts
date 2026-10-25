import { EducateOsError } from "@educateos/contracts";
import { NORTHFIELD, RIVERBEND } from "@educateos/fixtures";
import { describe, expect, it } from "vitest";
import {
  type CommercialAccountVerifier,
  FakeCommercialAccountVerifier,
  InMemoryInstanceRegistryStorage,
  InstanceRegistry,
  signEnvelope,
  SigningIdentity,
} from "../src/index.ts";
import {
  commercialAccountIdFor,
  instanceIdFor,
  makeDistrict,
  makeRegistry,
  manualClock,
  MINUTE,
  personalStrings,
} from "./support.ts";

async function rejection(promise: Promise<unknown>): Promise<EducateOsError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(EducateOsError);
  return error as EducateOsError;
}

describe("SCHO-41: the commercial system vouches for every registration", () => {
  it("asks about the account with identifiers and a role only, then registers", async () => {
    const clock = manualClock();
    const { registry, accountVerifier } = makeRegistry(clock);
    const northfield = await makeDistrict(NORTHFIELD, clock);
    await registry.register(await northfield.registration());

    expect(accountVerifier.requests).toEqual([{
      commercialAccountId: commercialAccountIdFor(NORTHFIELD),
      instanceId: northfield.instanceId,
      contactRole: "district-technology-admin",
    }]);
    const asked = JSON.stringify(accountVerifier.requests);
    for (const personal of personalStrings(NORTHFIELD)) expect(asked).not.toContain(personal);
  });

  it("refuses, and stores nothing, for an unknown account, an unverified contact or an unconfirmed instance", async () => {
    const clock = manualClock();
    const verifier = new FakeCommercialAccountVerifier([
      { commercialAccountId: commercialAccountIdFor(NORTHFIELD), verifiedContactRoles: ["district-billing"], confirmedInstanceIds: [instanceIdFor(NORTHFIELD)] },
      { commercialAccountId: commercialAccountIdFor(RIVERBEND), verifiedContactRoles: ["district-technology-admin"], confirmedInstanceIds: [] },
    ]);
    const { registry, storage } = makeRegistry(clock, verifier);
    const unknown = await makeDistrict(NORTHFIELD, clock);
    const forgedAccount = await unknown.agent.register({
      districtLabel: NORTHFIELD.district.name,
      releaseVersion: "0.1.0",
      capabilityIds: [],
      contactRole: "district-technology-admin",
      commercialAccountId: commercialAccountIdFor(NORTHFIELD).replace("acct_", "acct_x") as never,
    });
    const errors = [
      await rejection(registry.register(forgedAccount)),
      await rejection(registry.register(await unknown.registration())),
      await rejection(registry.register(await (await makeDistrict(RIVERBEND, clock)).registration())),
    ];
    // One answer for every refusal, so the reply can't be used to learn which accounts exist.
    expect(errors.map((error) => [error.code, error.message])).toEqual(
      Array.from({ length: 3 }, () => ["forbidden", "registration not confirmed by the commercial account"]),
    );
    expect(await storage.list()).toEqual([]);
  });

  it("fails closed when the commercial system can't be reached", async () => {
    const clock = manualClock();
    const unreachable: CommercialAccountVerifier = { verifyRegistration: () => Promise.reject(new Error("commercial system unreachable")) };
    const storage = new InMemoryInstanceRegistryStorage();
    const registry = new InstanceRegistry({ storage, accountVerifier: unreachable, now: clock.now });
    const northfield = await makeDistrict(NORTHFIELD, clock);
    await expect(registry.register(await northfield.registration())).rejects.toThrow("unreachable");
    expect(await storage.list()).toEqual([]);
  });

  it("is consulted only after the signature checks out, so an unsigned request can't probe accounts", async () => {
    const clock = manualClock();
    const { registry, accountVerifier } = makeRegistry(clock);
    const northfield = await makeDistrict(NORTHFIELD, clock);
    const forged = await signEnvelope(await SigningIdentity.generate(), "registration", (await northfield.registration()).payload);
    expect((await rejection(registry.register(forged))).code).toBe("unauthenticated");
    expect(accountVerifier.requests).toEqual([]);
  });
});

async function registeredNorthfield() {
  const clock = manualClock();
  const { registry, storage } = makeRegistry(clock);
  const northfield = await makeDistrict(NORTHFIELD, clock);
  const receipt = await registry.register(await northfield.registration());
  await registry.acceptHeartbeat(await northfield.agent.heartbeat({ releaseVersion: "0.1.0", probes: [] }));
  await registry.acceptHeartbeat(await northfield.agent.heartbeat({ releaseVersion: "0.1.0", probes: [] }));
  return { clock, registry, storage, northfield, receipt };
}

describe("SCHO-40: rekeying an instance with its ownership token", () => {
  it("rotates a working key: the new key is accepted, the old key is revoked", async () => {
    const { registry, northfield, receipt } = await registeredNorthfield();
    const oldIdentity = northfield.identity;
    const staleBeat = await northfield.agent.heartbeat({ releaseVersion: "0.1.0", probes: [] });
    const next = await SigningIdentity.generate();

    const rekeyed = await registry.rekey(await northfield.agent.requestRekey(next, receipt.ownershipToken));
    expect(rekeyed).toMatchObject({ instanceId: northfield.instanceId, keyId: next.keyId, retiredKeyId: oldIdentity.keyId, lastSequence: 2 });
    expect(rekeyed.ownershipToken).not.toBe(receipt.ownershipToken);

    // A message the old key signed, even one never sent before, is refused from now on.
    expect((await rejection(registry.acceptHeartbeat(staleBeat))).code).toBe("unauthenticated");
    await northfield.agent.adoptRekey(next, rekeyed);
    await expect(registry.acceptHeartbeat(await northfield.agent.heartbeat({ releaseVersion: "0.1.0", probes: [] }))).resolves.toBeUndefined();
  });

  it("recovers a lost key and a lost counter: the receipt's last sequence puts the new agent above it", async () => {
    const { clock, registry, northfield, receipt } = await registeredNorthfield();
    // The district's Worker was rebuilt: no old key, and its counter starts again at 0.
    const rebuilt = await makeDistrict(NORTHFIELD, clock);
    const rekeyed = await registry.rekey(await rebuilt.agent.requestRekey(rebuilt.identity, receipt.ownershipToken));
    await rebuilt.agent.adoptRekey(rebuilt.identity, rekeyed);

    const beat = await rebuilt.agent.heartbeat({ releaseVersion: "0.1.0", probes: [] });
    expect(beat.payload).toMatchObject({ sequence: 3 });
    await expect(registry.acceptHeartbeat(beat)).resolves.toBeUndefined();
    expect(northfield.instanceId).toBe(rebuilt.instanceId);
  });

  it("uses each ownership token once, so a replayed or delayed rekey is refused", async () => {
    const { registry, northfield, receipt } = await registeredNorthfield();
    const next = await SigningIdentity.generate();
    const first = await northfield.agent.requestRekey(next, receipt.ownershipToken);
    const second = await northfield.agent.requestRekey(await SigningIdentity.generate(), receipt.ownershipToken);
    const rekeyed = await registry.rekey(first);
    expect((await rejection(registry.rekey(first))).code).toBe("unauthenticated");
    expect((await rejection(registry.rekey(second))).code).toBe("unauthenticated");

    // A revocation with the old token no longer works; one with the new token does.
    await northfield.agent.adoptRekey(next, rekeyed);
    expect((await rejection(registry.revoke(await northfield.agent.revokeManagement(receipt.ownershipToken)))).code).toBe("unauthenticated");
    await expect(registry.revoke(await northfield.agent.revokeManagement(rekeyed.ownershipToken))).resolves.toBeUndefined();
  });

  it("refuses a stolen key without the token, and a thief's own key with a guessed token", async () => {
    const { registry, northfield, receipt } = await registeredNorthfield();
    const thief = await SigningIdentity.generate();
    const guessed = receipt.ownershipToken.replace(/^./, (c) => (c === "A" ? "B" : "A")) as typeof receipt.ownershipToken;
    expect((await rejection(registry.rekey(await northfield.agent.requestRekey(thief, guessed)))).code).toBe("unauthenticated");

    // Possession of the new key is proved by its signature: a request signed by any other key fails.
    const unsigned = await northfield.agent.requestRekey(thief, receipt.ownershipToken);
    const resigned = await signEnvelope(northfield.identity, "rekey", unsigned.payload);
    expect((await rejection(registry.rekey(resigned))).code).toBe("unauthenticated");
  });

  it("never lets a retired key back in, as this instance's key or another's", async () => {
    const { clock, registry, northfield, receipt } = await registeredNorthfield();
    const next = await SigningIdentity.generate();
    const rekeyed = await registry.rekey(await northfield.agent.requestRekey(next, receipt.ownershipToken));
    await northfield.agent.adoptRekey(next, rekeyed);

    const back = await northfield.agent.requestRekey(northfield.identity, rekeyed.ownershipToken);
    expect((await rejection(registry.rekey(back))).code).toBe("conflict");
    const riverbend = await makeDistrict(RIVERBEND, clock, { identity: northfield.identity });
    expect((await rejection(registry.register(await riverbend.registration()))).code).toBe("conflict");
  });

  it("refuses a rekey whose timestamp is outside the skew window", async () => {
    const { clock, registry, northfield, receipt } = await registeredNorthfield();
    const request = await northfield.agent.requestRekey(await SigningIdentity.generate(), receipt.ownershipToken);
    clock.advance(10 * MINUTE);
    expect((await rejection(registry.rekey(request))).code).toBe("unauthenticated");
  });

  it("lets one of two concurrent rekeys with the same token win", async () => {
    const { registry, northfield, receipt } = await registeredNorthfield();
    const requests = await Promise.all([1, 2].map(async () => northfield.agent.requestRekey(await SigningIdentity.generate(), receipt.ownershipToken)));
    const results = await Promise.allSettled(requests.map((request) => registry.rekey(request)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });

  it("an agent refuses a receipt for another key", async () => {
    const { registry, northfield, receipt } = await registeredNorthfield();
    const next = await SigningIdentity.generate();
    const rekeyed = await registry.rekey(await northfield.agent.requestRekey(next, receipt.ownershipToken));
    await expect(northfield.agent.adoptRekey(await SigningIdentity.generate(), rekeyed)).rejects.toMatchObject({ code: "validation-failed" });
  });
});

describe("SCHO-85: release decision reports", () => {
  it("records the district's decision with a reason code, and refuses a replay", async () => {
    const { registry, storage, northfield } = await registeredNorthfield();
    const report = await northfield.agent.reportReleaseDecision({
      offerSequence: 4,
      releaseId: "r2-fixture",
      decision: "declined",
      reasonCode: "testing-window",
    });
    await expect(registry.acceptReleaseDecision(report)).resolves.toMatchObject({ decision: "declined", reasonCode: "testing-window" });
    expect((await storage.get(northfield.instanceId))?.lastReleaseDecision).toEqual({
      offerSequence: 4,
      releaseId: "r2-fixture",
      decision: "declined",
      reasonCode: "testing-window",
      reportedAt: "2026-10-20T12:00:00.000Z",
    });
    expect((await rejection(registry.acceptReleaseDecision(report))).code).toBe("conflict");
  });

  it("carries reason codes only: free text, a decline without a reason, or an approval with one is refused", async () => {
    const { northfield } = await registeredNorthfield();
    for (const details of [
      { offerSequence: 1, releaseId: "r2-fixture", decision: "declined" as const, reasonCode: "The teacher said no" },
      { offerSequence: 1, releaseId: "r2-fixture", decision: "declined" as const },
      { offerSequence: 1, releaseId: "r2-fixture", decision: "approved" as const, reasonCode: "looks-good" },
      { offerSequence: 1, releaseId: "r2-fixture", decision: "deferred" as const },
    ]) {
      await expect(northfield.agent.reportReleaseDecision(details)).rejects.toThrow();
    }
  });

  it("can't be signed in another message kind's name", async () => {
    const { registry, northfield } = await registeredNorthfield();
    const report = await northfield.agent.reportReleaseDecision({ offerSequence: 1, releaseId: "r2-fixture", decision: "approved" });
    const asHeartbeat = await signEnvelope(northfield.identity, "heartbeat", report.payload);
    expect((await rejection(registry.acceptReleaseDecision(asHeartbeat))).code).toBe("unauthenticated");
  });
});
