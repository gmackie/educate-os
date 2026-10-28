// The signed ops protocol in workerd (SCHO-263): Web Crypto's Ed25519 there signs and verifies the
// same bytes as in Node, and a request signed in one runtime verifies in the other's code path.
import { describe, expect, it } from "vitest";
import { createOpsVerifier, InMemoryNonceStore, signOpsRequest, SigningIdentity } from "../../src/ops/index.ts";

describe("ops signing in workerd", () => {
  it("signs, verifies, refuses a replay and refuses a changed body", async () => {
    const admin = await SigningIdentity.generate();
    const restored = await SigningIdentity.fromJwk(await admin.exportJwk());
    const verifier = createOpsVerifier({
      keys: { find: (id) => (id === admin.keyId ? { keyId: admin.keyId, publicKey: admin.publicKey, scopes: ["devices"] } : undefined) },
      nonces: new InMemoryNonceStore(),
    });
    const url = "https://northfield.educateos.io/api/ops/devices/revoke-below-version";
    const body = JSON.stringify({ minimumVersion: "1.2.0" });
    const headers = await signOpsRequest(restored, { method: "POST", url, body, operator: "ops@educateos.io" });

    expect(await verifier.verify(new Request(url, { method: "POST", headers, body }))).toMatchObject({ ok: true });
    expect(await verifier.verify(new Request(url, { method: "POST", headers, body }))).toMatchObject({ ok: false, reason: "replayed" });

    const again = await signOpsRequest(admin, { method: "POST", url, body, operator: "ops@educateos.io" });
    expect(await verifier.verify(new Request(url, { method: "POST", headers: again, body: body.replace("1.2.0", "9.9.9") })))
      .toMatchObject({ ok: false, reason: "bad-signature" });
  });
});
