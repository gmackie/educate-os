// The signed ops protocol (SCHO-263): a request an admin edition signs verifies at the district,
// and any change to it, a replay, a stale or future timestamp, an unregistered key or a key without
// the route's scope is refused.
import { describe, expect, it } from "vitest";
import {
  createOpsVerifier,
  InMemoryNonceStore,
  OPS_HEADERS,
  OPS_MAX_BODY_BYTES,
  type OpsKey,
  type OpsScope,
  OpsScope as OpsScopeSchema,
  signOpsRequest,
  SigningIdentity,
} from "../src/ops/index.ts";
import { manualClock } from "./support.ts";

const ORIGIN = "https://northfield.educateos.io";
const OPERATOR = "operator@educateos.io";
const ALL_SCOPES: readonly OpsScope[] = OpsScopeSchema.options;

async function setup(scopes: readonly OpsScope[] = ALL_SCOPES) {
  const clock = manualClock();
  const admin = await SigningIdentity.generate();
  const keys = new Map<string, OpsKey>([[admin.keyId, { keyId: admin.keyId, publicKey: admin.publicKey, scopes }]]);
  const nonces = new InMemoryNonceStore(clock.now);
  const verifier = createOpsVerifier({ keys: { find: (id) => keys.get(id) }, nonces, now: clock.now });
  return { clock, admin, keys, nonces, verifier };
}

interface Send {
  method?: string;
  path?: string;
  body?: string;
  identity: SigningIdentity;
  now: Date;
  nonce?: string;
  operator?: string;
}

async function signed({ method = "GET", path = "/api/ops/health", body, identity, now, nonce, operator = OPERATOR }: Send) {
  const url = `${ORIGIN}${path}`;
  const headers = await signOpsRequest(identity, { method, url, now, operator, ...(body === undefined ? {} : { body }), ...(nonce === undefined ? {} : { nonce }) });
  return { url, headers, init: { method, headers, ...(body === undefined ? {} : { body }) } };
}

describe("signed ops requests", () => {
  it("verifies a signed GET with a query and names the route, scope and operator", async () => {
    const { clock, admin, verifier } = await setup();
    const { url, init } = await signed({ identity: admin, now: clock.now(), path: "/api/ops/analytics?range=7d" });
    const result = await verifier.verify(new Request(url, init));
    expect(result).toMatchObject({ ok: true, keyId: admin.keyId, operator: OPERATOR, match: { route: { name: "analytics", scope: "analytics" } } });
  });

  it("verifies a signed POST and hands back the body it covered", async () => {
    const { clock, admin, verifier } = await setup();
    const body = JSON.stringify({ reason: "lost phone" });
    const { url, init } = await signed({ identity: admin, now: clock.now(), method: "POST", path: "/api/ops/devices/dev_123/revoke", body });
    const result = await verifier.verify(new Request(url, init));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.match.params).toEqual({ id: "dev_123" });
    expect(new TextDecoder().decode(result.body)).toBe(body);
  });

  describe("tampering", () => {
    interface Wire { url: string; method: string; headers: Record<string, string>; body?: string }
    const BODY = JSON.stringify({ reason: "lost phone" });
    const cases: [string, (wire: Wire) => void][] = [
      ["method", (w) => { w.method = "PUT"; }],
      ["path", (w) => { w.url = `${ORIGIN}/api/ops/directory/prn_bea/suspend?role=student`; }],
      ["query", (w) => { w.url = `${ORIGIN}/api/ops/directory/prn_ada/suspend?role=admin`; }],
      ["body", (w) => { w.body = JSON.stringify({ reason: "someone else" }); }],
      ["operator", (w) => { w.headers[OPS_HEADERS.operator] = "intruder@example.org"; }],
      ["timestamp", (w) => { w.headers[OPS_HEADERS.timestamp] = String(Number(w.headers[OPS_HEADERS.timestamp]) + 1); }],
      ["nonce", (w) => { w.headers[OPS_HEADERS.nonce] = "A".repeat(22); }],
      ["signature", (w) => {
        const signature = w.headers[OPS_HEADERS.signature]!;
        w.headers[OPS_HEADERS.signature] = (signature[0] === "A" ? "B" : "A") + signature.slice(1);
      }],
    ];
    for (const [what, tamper] of cases) {
      it(`refuses a request whose ${what} changed after signing`, async () => {
        const { clock, admin, verifier } = await setup();
        const original = await signed({ identity: admin, now: clock.now(), method: "POST", path: "/api/ops/directory/prn_ada/suspend?role=student", body: BODY });
        const wire: Wire = { url: original.url, method: "POST", headers: { ...original.headers }, body: BODY };
        tamper(wire);
        const result = await verifier.verify(new Request(wire.url, { method: wire.method, headers: wire.headers, body: wire.body }));
        expect(result).toMatchObject({ ok: false, status: 401, reason: "bad-signature" });
      });
    }
  });

  it("refuses a replay of a request it accepted, but not the same nonce from another key", async () => {
    const { clock, admin, keys, verifier } = await setup();
    const first = await signed({ identity: admin, now: clock.now(), nonce: "n".repeat(22) });
    expect((await verifier.verify(new Request(first.url, first.init))).ok).toBe(true);
    expect(await verifier.verify(new Request(first.url, first.init))).toMatchObject({ ok: false, status: 401, reason: "replayed" });

    const other = await SigningIdentity.generate();
    keys.set(other.keyId, { keyId: other.keyId, publicKey: other.publicKey, scopes: ["health"] });
    const second = await signed({ identity: other, now: clock.now(), nonce: "n".repeat(22) });
    expect((await verifier.verify(new Request(second.url, second.init))).ok).toBe(true);
  });

  it("lets concurrent copies of one request through once", async () => {
    const { clock, admin, verifier } = await setup();
    const { url, init } = await signed({ identity: admin, now: clock.now() });
    const results = await Promise.all(Array.from({ length: 5 }, () => verifier.verify(new Request(url, init))));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
  });

  it("refuses requests more than 60 seconds old or ahead, and accepts them within", async () => {
    const { clock, admin, verifier } = await setup();
    const at = clock.now();
    const old = await signed({ identity: admin, now: new Date(at.getTime() - 61_000) });
    const ahead = await signed({ identity: admin, now: new Date(at.getTime() + 61_000) });
    const recent = await signed({ identity: admin, now: new Date(at.getTime() - 59_000) });
    expect(await verifier.verify(new Request(old.url, old.init))).toMatchObject({ ok: false, status: 401, reason: "stale" });
    expect(await verifier.verify(new Request(ahead.url, ahead.init))).toMatchObject({ ok: false, status: 401, reason: "stale" });
    expect((await verifier.verify(new Request(recent.url, recent.init))).ok).toBe(true);
  });

  it("keeps refusing a replay after its nonce is forgotten, because by then it is stale", async () => {
    const { clock, admin, nonces, verifier } = await setup();
    const { url, init } = await signed({ identity: admin, now: clock.now() });
    expect((await verifier.verify(new Request(url, init))).ok).toBe(true);
    clock.advance(5 * 60_000);
    // Any claim prunes expired nonces.
    await nonces.claim("other", "x".repeat(22), clock.now().getTime() + 1000);
    expect(nonces.size).toBe(1);
    expect(await verifier.verify(new Request(url, init))).toMatchObject({ ok: false, reason: "stale" });
  });

  it("refuses a route the key has no scope for with 403", async () => {
    const { clock, admin, verifier } = await setup(["health", "analytics"]);
    const read = await signed({ identity: admin, now: clock.now(), path: "/api/ops/directory" });
    expect(await verifier.verify(new Request(read.url, read.init))).toMatchObject({ ok: false, status: 403, reason: "scope-denied" });
    const write = await signed({ identity: admin, now: clock.now(), method: "POST", path: "/api/ops/directory/prn_ada/suspend", body: "{}" });
    expect(await verifier.verify(new Request(write.url, write.init))).toMatchObject({ ok: false, status: 403, reason: "scope-denied" });
  });

  it("does not take directory:read for directory:write", async () => {
    const { clock, admin, verifier } = await setup(["directory:read"]);
    const write = await signed({ identity: admin, now: clock.now(), method: "POST", path: "/api/ops/directory/prn_ada/restore", body: "{}" });
    expect(await verifier.verify(new Request(write.url, write.init))).toMatchObject({ ok: false, reason: "scope-denied" });
  });

  it("refuses a key the district never registered, or has removed", async () => {
    const { clock, admin, keys, verifier } = await setup();
    const stranger = await SigningIdentity.generate();
    const fromStranger = await signed({ identity: stranger, now: clock.now() });
    expect(await verifier.verify(new Request(fromStranger.url, fromStranger.init))).toMatchObject({ ok: false, status: 401, reason: "unknown-key" });

    keys.delete(admin.keyId);
    const removed = await signed({ identity: admin, now: clock.now() });
    expect(await verifier.verify(new Request(removed.url, removed.init))).toMatchObject({ ok: false, reason: "unknown-key" });
  });

  it("refuses a signature by one key presented under another registered key's ID", async () => {
    const { clock, admin, verifier } = await setup();
    const stranger = await SigningIdentity.generate();
    const forged = await signed({ identity: stranger, now: clock.now() });
    forged.headers[OPS_HEADERS.keyId] = admin.keyId;
    expect(await verifier.verify(new Request(forged.url, { headers: forged.headers }))).toMatchObject({ ok: false, reason: "bad-signature" });
  });

  it("refuses a keyring entry whose public key isn't the one its ID names", async () => {
    const { clock, admin, keys, verifier } = await setup();
    const other = await SigningIdentity.generate();
    keys.set(admin.keyId, { keyId: admin.keyId, publicKey: other.publicKey, scopes: ALL_SCOPES });
    const { url, init } = await signed({ identity: other, now: clock.now() });
    init.headers[OPS_HEADERS.keyId] = admin.keyId;
    expect(await verifier.verify(new Request(url, init))).toMatchObject({ ok: false, reason: "unknown-key" });
  });

  it("refuses a request with no signature, or a malformed one, with 401 before anything else", async () => {
    const { clock, admin, verifier } = await setup();
    expect(await verifier.verify(new Request(`${ORIGIN}/api/ops/health`))).toMatchObject({ ok: false, status: 401, reason: "missing-signature" });
    expect(await verifier.verify(new Request(`${ORIGIN}/api/ops/nothing-here`))).toMatchObject({ ok: false, status: 401, reason: "missing-signature" });
    for (const [header, value] of [
      [OPS_HEADERS.signature, "not base64url!"],
      [OPS_HEADERS.keyId, "rsa-123"],
      [OPS_HEADERS.timestamp, "yesterday"],
      [OPS_HEADERS.nonce, "short"],
      [OPS_HEADERS.operator, "has space"],
    ] as const) {
      const { url, init } = await signed({ identity: admin, now: clock.now() });
      init.headers[header] = value;
      expect(await verifier.verify(new Request(url, init))).toMatchObject({ ok: false, status: 401, reason: "malformed-signature" });
    }
  });

  it("answers 404 for a signed request to a path that isn't an ops route", async () => {
    const { clock, admin, verifier } = await setup();
    const { url, init } = await signed({ identity: admin, now: clock.now(), path: "/api/ops/secrets" });
    expect(await verifier.verify(new Request(url, init))).toMatchObject({ ok: false, status: 404, reason: "unknown-route" });
  });

  it("refuses a body over the limit without verifying it", async () => {
    const { clock, admin, verifier } = await setup();
    const body = "x".repeat(OPS_MAX_BODY_BYTES + 1);
    const { url, init } = await signed({ identity: admin, now: clock.now(), method: "POST", path: "/api/ops/devices/revoke-below-version", body });
    expect(await verifier.verify(new Request(url, init))).toMatchObject({ ok: false, status: 413, reason: "body-too-large" });
  });

  it("does not let a request with a bad signature use up the nonce", async () => {
    const { clock, admin, verifier } = await setup();
    const { url, init } = await signed({ identity: admin, now: clock.now() });
    const bad = { ...init.headers, [OPS_HEADERS.operator]: "someone@else.org" };
    expect((await verifier.verify(new Request(url, { headers: bad }))).ok).toBe(false);
    expect((await verifier.verify(new Request(url, init))).ok).toBe(true);
  });

  it("refuses an operator label that would not fit a header", async () => {
    const { clock, admin } = await setup();
    await expect(signed({ identity: admin, now: clock.now(), operator: "two words" })).rejects.toThrow();
  });
});
