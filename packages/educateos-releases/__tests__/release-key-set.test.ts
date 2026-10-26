import { SigningIdentity, canonicalJson } from "@educateos/fleet";
import { describe, expect, it } from "vitest";
import {
  acceptReleaseKeySet,
  type ReleaseKeySet,
  type ReleaseTrust,
  RootReleaseSigner,
  signReleaseKeySet,
  signReleaseMessage,
  verifySignedReleaseManifest,
} from "../src/index.ts";
import { DAY, makeManager, makeSigner, manualClock, rejection, signedOffer, statementFor } from "./support.ts";

// Threat model T12 and SCHO-84: release keys change only through a key set signed by a threshold
// of offline root keys, so a stolen release key can't announce a successor, and a key set that
// leaves a key out revokes it at once.

function keySet(version: number, keys: { identity: SigningIdentity; retiresAt?: Date }[], issuedAt: Date): ReleaseKeySet {
  return {
    version,
    keys: keys.map(({ identity, retiresAt }) => ({
      keyId: identity.keyId,
      publicKey: identity.publicKey,
      ...(retiresAt === undefined ? {} : { retiresAt: retiresAt.toISOString() }),
    })),
    issuedAt: issuedAt.toISOString(),
  };
}

const keyIds = (trust: ReleaseTrust) => trust.keys.map((key) => key.keyId);

describe("release messages signed before the EducateOS rename (SCHO-232)", () => {
  it("still verify, in the legacy signing context", async () => {
    const clock = manualClock();
    const { rootKeys, trust } = await makeSigner();
    const next = await SigningIdentity.generate();
    const payload = keySet(1, [{ identity: next }], clock.now());
    const bytes = new TextEncoder().encode(`schoolos-releases/v1\0release-key-set\0${canonicalJson(payload)}`); // rename-educateos: keep
    const signatures = await Promise.all(rootKeys.slice(0, 2).map(async (key) => ({ keyId: key.keyId, signature: await key.sign(bytes) })));
    const legacy = { payload: JSON.parse(canonicalJson(payload)), signatures };
    expect(keyIds(await acceptReleaseKeySet(trust, legacy, clock.now()))).toEqual([next.keyId]);
    // The legacy context is still bound to the message: a changed payload is refused.
    const tampered = { ...legacy, payload: { ...legacy.payload, version: 2 } };
    expect((await rejection(acceptReleaseKeySet(trust, tampered, clock.now()))).code).toBe("unauthenticated");
  });
});

describe("SCHO-84 release key rotation through the offline root keys", () => {
  it("rotates with overlap: both keys verify until the old one retires, then only the new one", async () => {
    const clock = manualClock();
    const { signer, rootKeys, trust } = await makeSigner();
    const oldKey = signer.identity;
    const signedByOld = await signer.signManifest(statementFor(clock, "r2-fixture", "0.2.0"));
    const next = await SigningIdentity.generate();
    const set = await signReleaseKeySet(keySet(1, [{ identity: oldKey, retiresAt: new Date(clock.now().getTime() + 14 * DAY) }, { identity: next }], clock.now()), rootKeys.slice(0, 2));
    signer.useKey(next);
    const signedByNew = await signer.signManifest(statementFor(clock, "r3-fixture", "0.3.0"));

    // Before the district takes the key set, the new key means nothing to it.
    expect((await rejection(verifySignedReleaseManifest(signedByNew, trust, { now: clock.now() }))).code).toBe("unauthenticated");

    const rotated = await acceptReleaseKeySet(trust, set, clock.now());
    expect(rotated).toMatchObject({ keySetVersion: 1, root: trust.root });
    expect(keyIds(rotated)).toEqual([oldKey.keyId, next.keyId]);
    await expect(verifySignedReleaseManifest(signedByOld, rotated, { now: clock.now() })).resolves.toMatchObject({ releaseId: "r2-fixture" });
    await expect(verifySignedReleaseManifest(signedByNew, rotated, { now: clock.now() })).resolves.toMatchObject({ releaseId: "r3-fixture" });

    clock.advance(14 * DAY);
    expect((await rejection(verifySignedReleaseManifest(signedByOld, rotated, { now: clock.now(), graceMs: 30 * DAY }))).code).toBe("unauthenticated");
    await expect(verifySignedReleaseManifest(signedByNew, rotated, { now: clock.now() })).resolves.toBeDefined();
  });

  it("lets the district manager take a key set and then accept offers signed by the new key", async () => {
    const clock = manualClock();
    const { signer, rootKeys, trust } = await makeSigner();
    const { manager } = makeManager(clock, trust);
    const next = await SigningIdentity.generate();
    await manager.acceptReleaseKeySet(await signReleaseKeySet(keySet(1, [{ identity: next }], clock.now()), [rootKeys[0]!, rootKeys[2]!]));
    signer.useKey(next);

    const record = await manager.receiveOffer(await signedOffer(signer, clock, statementFor(clock, "r2-fixture", "0.2.0")));
    expect(record.status).toBe("pending");
  });
});

describe("SCHO-84 a stolen key can't announce a successor", () => {
  it("refuses a key set signed by a release key, even one the district trusts", async () => {
    const clock = manualClock();
    const { signer, trust } = await makeSigner();
    const thief = await SigningIdentity.generate();
    const bySigner = await signReleaseKeySet(keySet(1, [{ identity: thief }], clock.now()), [signer.identity]);
    expect((await rejection(acceptReleaseKeySet(trust, bySigner, clock.now()))).code).toBe("unauthenticated");

    // Nor does a release key's ordinary release-context signature over a key set count.
    const asReleaseMessage = await signReleaseMessage(signer.identity, "release-manifest", keySet(1, [{ identity: thief }], clock.now()));
    const relabelled = { payload: asReleaseMessage.payload, signatures: [{ keyId: asReleaseMessage.keyId, signature: asReleaseMessage.signature }] };
    expect((await rejection(acceptReleaseKeySet(trust, relabelled, clock.now()))).code).toBe("unauthenticated");
  });

  it("refuses a key set signed by fewer root keys than the threshold, however often one key signs", async () => {
    const clock = manualClock();
    const { rootKeys, trust } = await makeSigner();
    const thief = await SigningIdentity.generate();
    const stolenRoot = rootKeys[1]!;
    const once = await signReleaseKeySet(keySet(1, [{ identity: thief }], clock.now()), [stolenRoot]);
    expect((await rejection(acceptReleaseKeySet(trust, once, clock.now()))).code).toBe("unauthenticated");
    const repeated = { ...once, signatures: [...once.signatures, ...once.signatures] };
    expect((await rejection(acceptReleaseKeySet(trust, repeated, clock.now()))).code).toBe("unauthenticated");

    // A second signature from a key the district never pinned doesn't make up the threshold.
    const withStranger = await signReleaseKeySet(keySet(1, [{ identity: thief }], clock.now()), [stolenRoot, await SigningIdentity.generate()]);
    expect((await rejection(acceptReleaseKeySet(trust, withStranger, clock.now()))).code).toBe("unauthenticated");
  });

  it("refuses a validly signed key set whose content was changed, or whose key ID names a different key", async () => {
    const clock = manualClock();
    const { rootKeys, trust } = await makeSigner();
    const next = await SigningIdentity.generate();
    const genuine = await signReleaseKeySet(keySet(1, [{ identity: next }], clock.now()), rootKeys);

    const tampered = structuredClone(genuine);
    (tampered.payload as { version: number }).version = 2;
    expect((await rejection(acceptReleaseKeySet(trust, tampered, clock.now()))).code).toBe("unauthenticated");

    const thief = await SigningIdentity.generate();
    const relabelled = await signReleaseKeySet(
      { ...keySet(1, [{ identity: next }], clock.now()), keys: [{ keyId: next.keyId, publicKey: thief.publicKey }] },
      rootKeys,
    );
    expect((await rejection(acceptReleaseKeySet(trust, relabelled, clock.now()))).code).toBe("unauthenticated");
  });
});

describe("SCHO-84 emergency revocation", () => {
  it("revokes a stolen release key at once, and a replay of the older key set can't restore it", async () => {
    const clock = manualClock();
    const { signer, rootKeys, trust } = await makeSigner();
    const stolen = new RootReleaseSigner(signer.identity);
    const replacement = await SigningIdentity.generate();
    const { manager } = makeManager(clock, trust);

    // The root once rotated with an overlap that still lists the soon-to-be-stolen key.
    const overlap = await signReleaseKeySet(
      keySet(1, [{ identity: signer.identity, retiresAt: new Date(clock.now().getTime() + 30 * DAY) }, { identity: replacement }], clock.now()),
      rootKeys.slice(0, 2),
    );
    await manager.acceptReleaseKeySet(overlap);
    // Then the old key is stolen: the root's offline ceremony publishes a set without it.
    const revocation = await signReleaseKeySet(keySet(2, [{ identity: replacement }], clock.now()), rootKeys.slice(1));
    expect(keyIds(await manager.acceptReleaseKeySet(revocation))).toEqual([replacement.keyId]);

    const evil = await signedOffer(stolen, clock, statementFor(clock, "r2-evil", "0.2.0"));
    expect((await rejection(manager.receiveOffer(evil))).code).toBe("unauthenticated");
    expect((await rejection(manager.acceptReleaseKeySet(overlap))).code).toBe("conflict");
    expect(keyIds((await manager.state()).trust)).toEqual([replacement.keyId]);
    expect((await manager.state()).offers).toEqual([]);
  });

  it("refuses a key set that would leave the district with no key it trusts now", async () => {
    const clock = manualClock();
    const { signer, rootKeys, trust } = await makeSigner();
    const expired = await signReleaseKeySet(keySet(1, [{ identity: signer.identity, retiresAt: clock.now() }], clock.now()), rootKeys);
    expect((await rejection(acceptReleaseKeySet(trust, expired, clock.now()))).code).toBe("validation-failed");
  });

  it("a root key can't stand in for a release key", async () => {
    const clock = manualClock();
    const { rootKeys, trust } = await makeSigner();
    const { manager } = makeManager(clock, trust);
    // Even a root key's signature over an offer is refused: root keys sign key sets and nothing else.
    const rootAsSigner = new RootReleaseSigner(rootKeys[0]!);
    expect((await rejection(manager.receiveOffer(await signedOffer(rootAsSigner, clock, statementFor(clock, "r2-x", "0.2.0"))))).code).toBe("unauthenticated");
  });
});
