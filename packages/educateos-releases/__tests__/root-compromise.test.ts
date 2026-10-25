import { SigningIdentity, signEnvelope } from "@educateos/fleet";
import { describe, expect, it } from "vitest";
import { RootReleaseSigner, verifySignedReleaseManifest } from "../src/index.ts";
import {
  baseline,
  DAY,
  digestOf,
  driftFor,
  instanceIdFor,
  makeManager,
  makeSigner,
  manualClock,
  RIVERBEND,
  rejection,
  signedOffer,
  statementFor,
} from "./support.ts";

// Threat model T12: whatever a compromised root (or anyone holding a release key) sends, the
// district verifies locally and installs nothing it did not approve.

describe("R03 root compromise: a manifest the district doesn't trust is rejected", () => {
  it("rejects a manifest signed by a key the district never pinned", async () => {
    const clock = manualClock();
    const { trust } = await makeSigner();
    const attacker = new RootReleaseSigner(await SigningIdentity.generate());
    const signed = await attacker.signManifest(statementFor(clock, "r2-evil", "0.2.0"));

    const error = await rejection(verifySignedReleaseManifest(signed, trust, { now: clock.now() }));
    expect(error.code).toBe("unauthenticated");
  });

  it("rejects an offer signed by an unknown key, and a trusted offer carrying an unknown key's manifest", async () => {
    const clock = manualClock();
    const { signer, trust } = await makeSigner();
    const attacker = new RootReleaseSigner(await SigningIdentity.generate());
    const statement = statementFor(clock, "r2-evil", "0.2.0");

    const { manager } = makeManager(clock, trust);
    expect((await rejection(manager.receiveOffer(await signedOffer(attacker, clock, statement)))).code).toBe("unauthenticated");
    const smuggled = await signedOffer(signer, clock, statement, { signedManifest: await attacker.signManifest(statement) });
    expect((await rejection(manager.receiveOffer(smuggled))).code).toBe("unauthenticated");
    expect((await manager.state()).offers).toEqual([]);
  });

  it("rejects a valid signature over a tampered manifest statement or offer", async () => {
    const clock = manualClock();
    const { signer, trust } = await makeSigner();
    const statement = statementFor(clock, "r2-fixture", "0.2.0");
    const signed = await signer.signManifest(statement);

    const tampered = structuredClone(signed);
    (tampered.payload as { manifestSha256: string }).manifestSha256 = "f".repeat(64);
    expect((await rejection(verifySignedReleaseManifest(tampered, trust, { now: clock.now() }))).code).toBe("unauthenticated");

    const { manager } = makeManager(clock, trust);
    const offer = await signedOffer(signer, clock, statement, { signedManifest: signed });
    const retargeted = structuredClone(offer);
    (retargeted.payload as { releaseVersion: string }).releaseVersion = "9.0.0";
    expect((await rejection(manager.receiveOffer(retargeted))).code).toBe("unauthenticated");
  });

  it("rejects an offer whose fields disagree with the signed manifest it carries", async () => {
    const clock = manualClock();
    const { signer, trust } = await makeSigner();
    const statement = statementFor(clock, "r2-fixture", "0.2.0");
    const { manager } = makeManager(clock, trust);

    const swapped = await signedOffer(signer, clock, statement, { manifestSha256: "e".repeat(64) });
    expect(await rejection(manager.receiveOffer(swapped))).toMatchObject({
      code: "unauthenticated",
      message: "release offer does not match its signed manifest",
    });
  });

  it("does not accept a release-manifest signature as an offer, or a fleet-context signature as a manifest", async () => {
    const clock = manualClock();
    const { signer, trust } = await makeSigner();
    const statement = statementFor(clock, "r2-fixture", "0.2.0");
    const offer = await signedOffer(signer, clock, statement);
    // The offer's own signature is over the fleet context; presented as a manifest it fails.
    const asManifest = { payload: statement, signature: offer.signature, keyId: offer.keyId };
    expect((await rejection(verifySignedReleaseManifest(asManifest, trust, { now: clock.now() }))).code).toBe("unauthenticated");
    // A statement signed as a fleet `release-offer` message is not a release manifest either.
    const fleetSigned = await signEnvelope(signer.identity, "release-offer", statement);
    expect((await rejection(verifySignedReleaseManifest(fleetSigned, trust, { now: clock.now() }))).code).toBe("unauthenticated");
  });
});

describe("R03 root compromise: downgrade, expiry and replay", () => {
  it("rejects a downgrade below the minimum compatible version unless the district approves it explicitly as a rollback", async () => {
    const clock = manualClock();
    const { signer, trust } = await makeSigner();
    const { manager } = makeManager(clock, trust, { installed: baseline(clock, { releaseId: "r1-old", manifestSha256: digestOf("r1-old") }) });
    const r2 = statementFor(clock, "r2-fixture", "0.2.0");
    // r3 says nothing older than 0.2.0 is compatible with its data, so 0.1.0 is below its floor.
    const r3 = statementFor(clock, "r3-current", "0.3.0", { minimumCompatibleVersion: "0.2.0" });
    for (const [sequence, statement] of [[1, r2], [2, r3]] as const) {
      await manager.receiveOffer(await signedOffer(signer, clock, statement, { offerSequence: sequence }));
      await manager.approve(sequence, { drift: driftFor(statement) });
      await manager.recordInstalled(sequence);
    }

    const back = statementFor(clock, "r1-old", "0.1.0");
    // Offered as an upgrade, the downgrade is refused outright.
    const asUpgrade = await rejection(manager.receiveOffer(await signedOffer(signer, clock, back, { offerSequence: 3 })));
    expect(asUpgrade.code).toBe("policy-violation");

    // Offered as a rollback it waits for the district, which must say it is a rollback.
    const rollback = await manager.receiveOffer(await signedOffer(signer, clock, back, { offerSequence: 4, purpose: "rollback" }));
    expect(rollback.status).toBe("pending");
    expect((await rejection(manager.authorizeApply(4, driftFor(back)))).code).toBe("forbidden");
    expect((await rejection(manager.approve(4, { drift: driftFor(back) }))).code).toBe("policy-violation");

    await manager.approve(4, { drift: driftFor(back), asRollback: true });
    const authorized = await manager.authorizeApply(4, driftFor(back));
    expect(authorized).toMatchObject({ purpose: "rollback", statement: { releaseId: "r1-old", version: "0.1.0" } });
  });

  it("refuses a rollback to an old release the district never ran", async () => {
    const clock = manualClock();
    const { signer, trust } = await makeSigner();
    const { manager } = makeManager(clock, trust, { installed: baseline(clock, { releaseId: "r5-current", version: "0.5.0" }) });
    const vulnerable = statementFor(clock, "r2-vulnerable", "0.2.0");

    const error = await rejection(manager.receiveOffer(await signedOffer(signer, clock, vulnerable, { purpose: "rollback" })));
    expect(error.code).toBe("policy-violation");
  });

  it("rejects an expired offer, and an offer carrying an expired manifest statement", async () => {
    const clock = manualClock();
    const { signer, trust } = await makeSigner();
    const { manager } = makeManager(clock, trust);
    const statement = statementFor(clock, "r2-fixture", "0.2.0");
    const offer = await signedOffer(signer, clock, statement);
    clock.advance(8 * DAY);
    expect(await rejection(manager.receiveOffer(offer))).toMatchObject({ code: "unauthenticated", message: "release offer has expired" });

    const stale = await signedOffer(signer, clock, statementFor(manualClock("2026-09-01T00:00:00Z"), "r2-fixture", "0.2.0"), { offerSequence: 2 });
    expect(await rejection(manager.receiveOffer(stale))).toMatchObject({
      code: "unauthenticated",
      message: "release manifest statement has expired",
    });
  });

  it("rejects a replayed offer and an older offer arriving after a newer one", async () => {
    const clock = manualClock();
    const { signer, trust } = await makeSigner();
    const { manager } = makeManager(clock, trust);
    const older = await signedOffer(signer, clock, statementFor(clock, "r2-fixture", "0.2.0"), { offerSequence: 4 });
    const newer = await signedOffer(signer, clock, statementFor(clock, "r3-fixture", "0.3.0"), { offerSequence: 5 });

    await manager.receiveOffer(newer);
    expect((await rejection(manager.receiveOffer(newer))).code).toBe("conflict");
    expect((await rejection(manager.receiveOffer(older))).code).toBe("conflict");
  });

  it("rejects an offer addressed to another instance or another channel", async () => {
    const clock = manualClock();
    const { signer, trust } = await makeSigner();
    const { manager } = makeManager(clock, trust);
    const statement = statementFor(clock, "r2-fixture", "0.2.0");
    const forRiverbend = await signedOffer(signer, clock, statement, { instanceId: instanceIdFor(RIVERBEND) });
    expect((await rejection(manager.receiveOffer(forRiverbend))).code).toBe("forbidden");

    const canary = statementFor(clock, "r2-canary", "0.2.0", { channel: "canary" });
    expect((await rejection(manager.receiveOffer(await signedOffer(signer, clock, canary, { offerSequence: 2 })))).code).toBe("forbidden");
  });
});

describe("R03 root compromise: the root cannot force an install", () => {
  it("leaves every offer pending, with no apply path until the district approves", async () => {
    const clock = manualClock();
    const { signer, trust } = await makeSigner();
    const { manager } = makeManager(clock, trust);
    const statement = statementFor(clock, "r2-fixture", "0.2.0");

    const record = await manager.receiveOffer(await signedOffer(signer, clock, statement));
    expect(record.status).toBe("pending");
    expect((await rejection(manager.authorizeApply(record.offerSequence, driftFor(statement)))).code).toBe("forbidden");
    expect((await rejection(manager.recordInstalled(record.offerSequence))).code).toBe("forbidden");
  });

  it("keeps a district's decline in force whatever the root re-offers, even under an auto-apply policy", async () => {
    const clock = manualClock();
    const { signer, trust } = await makeSigner();
    const { manager } = makeManager(clock, trust, { policy: { channel: "stable", autoApply: true } });
    const statement = statementFor(clock, "r2-fixture", "0.2.0");

    const first = await manager.receiveOffer(await signedOffer(signer, clock, statement, { offerSequence: 1 }));
    expect(first).toMatchObject({ status: "approved", decidedBy: "policy" });
    await manager.decline(1, "district-testing-window");

    // The root re-signs and re-offers the same release, with a fresh statement and sequence.
    clock.advance(DAY);
    const again = await manager.receiveOffer(await signedOffer(signer, clock, statementFor(clock, "r2-fixture", "0.2.0"), { offerSequence: 2 }));
    expect(again).toMatchObject({ status: "declined", decidedBy: "district", declineReason: "district-testing-window" });
    expect((await rejection(manager.authorizeApply(2, driftFor(statement)))).code).toBe("forbidden");
    expect((await manager.state()).declined).toEqual([
      { releaseId: "r2-fixture", reason: "district-testing-window", declinedAt: "2026-10-20T12:00:00.000Z" },
    ]);
  });

  it("refuses a decline reason that is free text rather than a code", async () => {
    const clock = manualClock();
    const { signer, trust } = await makeSigner();
    const { manager } = makeManager(clock, trust);
    await manager.receiveOffer(await signedOffer(signer, clock, statementFor(clock, "r2-fixture", "0.2.0")));
    expect((await rejection(manager.decline(1, "not now, try again in spring"))).code).toBe("validation-failed");
  });
});
