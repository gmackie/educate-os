import { SigningIdentity } from "@schoolos/fleet";
import { describe, expect, it } from "vitest";
import { acceptKeyAnnouncement, RootReleaseSigner, verifySignedReleaseManifest } from "../src/index.ts";
import { DAY, makeManager, makeSigner, manualClock, rejection, signedOffer, statementFor } from "./support.ts";

describe("R03 release key rotation with overlap", () => {
  it("trusts both keys during the overlap and only the new key after it", async () => {
    const clock = manualClock();
    const { signer, trust } = await makeSigner();
    const oldKey = signer.identity;
    const signedByOld = await signer.signManifest(statementFor(clock, "r2-fixture", "0.2.0"));

    const next = await SigningIdentity.generate();
    const announcement = await signer.rotate(next, clock.now(), new Date(clock.now().getTime() + 14 * DAY));
    const signedByNew = await signer.signManifest(statementFor(clock, "r3-fixture", "0.3.0"));

    // Before the district sees the announcement, the new key means nothing to it.
    expect((await rejection(verifySignedReleaseManifest(signedByNew, trust, { now: clock.now() }))).code).toBe("unauthenticated");

    const rotated = await acceptKeyAnnouncement(trust, announcement, clock.now());
    expect(rotated.keys.map((k) => k.keyId)).toEqual([oldKey.keyId, next.keyId]);
    await expect(verifySignedReleaseManifest(signedByOld, rotated, { now: clock.now() })).resolves.toMatchObject({ releaseId: "r2-fixture" });
    await expect(verifySignedReleaseManifest(signedByNew, rotated, { now: clock.now() })).resolves.toMatchObject({ releaseId: "r3-fixture" });

    clock.advance(14 * DAY);
    expect((await rejection(verifySignedReleaseManifest(signedByOld, rotated, { now: clock.now(), graceMs: 30 * DAY }))).code)
      .toBe("unauthenticated");
    await expect(verifySignedReleaseManifest(signedByNew, rotated, { now: clock.now() })).resolves.toBeDefined();
  });

  it("drops the retired key at the next rotation, so a stolen retired key can't announce one", async () => {
    const clock = manualClock();
    const { signer, trust } = await makeSigner();
    const retired = new RootReleaseSigner(signer.identity);
    const second = await SigningIdentity.generate();
    let pinned = await acceptKeyAnnouncement(trust, await signer.rotate(second, clock.now(), new Date(clock.now().getTime() + DAY)), clock.now());
    clock.advance(2 * DAY);
    pinned = await acceptKeyAnnouncement(pinned, await signer.rotate(await SigningIdentity.generate(), clock.now(), new Date(clock.now().getTime() + DAY)), clock.now());
    expect(pinned.keys.map((k) => k.keyId)).not.toContain(retired.identity.keyId);

    const thief = await SigningIdentity.generate();
    const forged = await retired.rotate(thief, clock.now(), new Date(clock.now().getTime() + DAY));
    expect((await rejection(acceptKeyAnnouncement(pinned, forged, clock.now()))).code).toBe("unauthenticated");
  });

  it("rejects an announcement signed by an unknown key, or one whose key ID names a different key", async () => {
    const clock = manualClock();
    const { signer, trust } = await makeSigner();
    const stranger = new RootReleaseSigner(await SigningIdentity.generate());
    const unknown = await stranger.rotate(await SigningIdentity.generate(), clock.now(), clock.now());
    expect((await rejection(acceptKeyAnnouncement(trust, unknown, clock.now()))).code).toBe("unauthenticated");

    const genuine = await signer.rotate(await SigningIdentity.generate(), clock.now(), clock.now());
    const relabelled = structuredClone(genuine);
    (relabelled.payload as { publicKey: string }).publicKey = stranger.identity.publicKey;
    expect((await rejection(acceptKeyAnnouncement(trust, relabelled, clock.now()))).code).toBe("unauthenticated");
  });

  it("lets the district manager take the rotation and then accept offers signed by the new key", async () => {
    const clock = manualClock();
    const { signer, trust } = await makeSigner();
    const { manager } = makeManager(clock, trust);
    await manager.acceptKeyAnnouncement(await signer.rotate(await SigningIdentity.generate(), clock.now(), new Date(clock.now().getTime() + DAY)));

    const record = await manager.receiveOffer(await signedOffer(signer, clock, statementFor(clock, "r2-fixture", "0.2.0")));
    expect(record.status).toBe("pending");
  });
});
