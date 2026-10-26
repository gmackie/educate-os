import { describe, expect, it } from "vitest";
import { canonicalJson, signEnvelope, SigningIdentity, verifyEnvelope } from "../src/index.ts";

describe("canonical JSON", () => {
  it("is independent of key order and whitespace", () => {
    const a = JSON.parse('{ "b": 1, "a": { "y": [1, 2], "x": null } }');
    const b = { a: { x: null, y: [1, 2] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(b)).toBe('{"a":{"x":null,"y":[1,2]},"b":1}');
  });

  it("refuses values JSON can't carry exactly, rather than coercing them", () => {
    expect(() => canonicalJson({ at: new Date(0) })).toThrow();
    expect(() => canonicalJson({ n: Number.NaN })).toThrow();
    expect(() => canonicalJson([undefined])).toThrow();
  });
});

describe("signed envelopes", () => {
  it("verify after a round trip through JSON with reordered keys", async () => {
    const identity = await SigningIdentity.generate();
    const envelope = await signEnvelope(identity, "heartbeat", { sequence: 1, instanceId: "ins_northfield" });
    const reordered = { keyId: envelope.keyId, signature: envelope.signature, payload: { instanceId: "ins_northfield", sequence: 1 } };
    expect(await verifyEnvelope(JSON.parse(JSON.stringify(reordered)), "heartbeat", identity.publicKey)).toBe(true);
  });

  it("verify when signed before the EducateOS rename, in its legacy context (SCHO-232)", async () => {
    const identity = await SigningIdentity.generate();
    const payload = { instanceId: "ins_northfield", sequence: 1 };
    const legacyBytes = (kind: string) => new TextEncoder().encode(`schoolos-fleet/v1\0${kind}\0${canonicalJson(payload)}`);
    const envelope = { payload, signature: await identity.sign(legacyBytes("heartbeat")), keyId: identity.keyId };
    expect(await verifyEnvelope(envelope, "heartbeat", identity.publicKey)).toBe(true);
    expect(await verifyEnvelope(envelope, "entitlement", identity.publicKey)).toBe(false);
    expect(await verifyEnvelope({ ...envelope, payload: { ...payload, sequence: 2 } }, "heartbeat", identity.publicKey)).toBe(false);
    // New envelopes are signed in the new context only.
    const signed = await signEnvelope(identity, "heartbeat", payload);
    expect(signed.signature).not.toBe(envelope.signature);
  });

  it("bind the message kind, so a signature for one kind never verifies as another", async () => {
    const identity = await SigningIdentity.generate();
    const envelope = await signEnvelope(identity, "heartbeat", { instanceId: "ins_northfield", sequence: 1 });
    expect(await verifyEnvelope(envelope, "heartbeat", identity.publicKey)).toBe(true);
    expect(await verifyEnvelope(envelope, "management-revocation", identity.publicKey)).toBe(false);
    expect(await verifyEnvelope(envelope, "entitlement", identity.publicKey)).toBe(false);
  });

  it("don't verify under another key, even when relabelled with that key's ID", async () => {
    const signer = await SigningIdentity.generate();
    const other = await SigningIdentity.generate();
    const envelope = await signEnvelope(signer, "heartbeat", { sequence: 1 });
    expect(await verifyEnvelope(envelope, "heartbeat", other.publicKey)).toBe(false);
    expect(await verifyEnvelope({ ...envelope, keyId: other.keyId }, "heartbeat", other.publicKey)).toBe(false);
  });

  it("survive persisting and restoring the identity", async () => {
    const original = await SigningIdentity.generate();
    const restored = await SigningIdentity.fromJwk(JSON.parse(JSON.stringify(await original.exportJwk())));
    expect(restored.keyId).toBe(original.keyId);
    const envelope = await signEnvelope(restored, "heartbeat", { sequence: 2 });
    expect(await verifyEnvelope(envelope, "heartbeat", original.publicKey)).toBe(true);
  });
});
