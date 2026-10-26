// The opt-in registry as educateos.io serves it, and the dashboard that reads it: an installation
// registers only under the operator who installed it, and only from inside the control plane (the
// guided install); its signed heartbeats reach only that operator's dashboard; replays and malformed
// messages are refused; and the storage keeps fleet's InstanceRegistryStorage contract.

import { env, runInDurableObject, SELF } from "cloudflare:test";
import { DistrictAgent, InMemorySequenceCounter, SigningIdentity } from "@educateos/fleet";
import { importJWK, SignJWT, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { probeInstallation } from "../src/probe.ts";
import { DurableObjectRegistryStorage } from "../src/registry-store.ts";
import { TABLES } from "../src/store.ts";
import { CONTROL_PLANE_OBJECT } from "../src/worker.ts";
import { ACCESS_AUD, ACCESS_ISSUER } from "./fixtures.ts";

const ORIGIN = "https://educateos.io";
let count = 0;

async function signIn(): Promise<{ token: string; accountId: string; subject: string }> {
  const subject = `registry-user-${count++}`;
  const token = await new SignJWT({ sub: subject, email: `${subject}@example.org` })
    .setProtectedHeader({ alg: "RS256", kid: "test-access-key" })
    .setIssuer(ACCESS_ISSUER).setAudience(ACCESS_AUD).setIssuedAt().setExpirationTime("5m")
    .sign(await importJWK(JSON.parse(env.TEST_ACCESS_PRIVATE_JWK) as JWK, "RS256"));
  const me = await (await SELF.fetch(`${ORIGIN}/app/api/me`, { headers: { "cf-access-jwt-assertion": token } })).json<{ accountId: string }>();
  return { token, accountId: me.accountId, subject };
}

async function installFor(subject: string, slug: string): Promise<`ins_${string}`> {
  const instanceId = `ins_${slug.replaceAll("-", "")}` as const;
  await runInDurableObject(env.CONTROL_PLANE.getByName(CONTROL_PLANE_OBJECT), (_, state) => {
    state.storage.sql.exec(`INSERT INTO ${TABLES.installations} (instance_id, operator_subject, slug, record) VALUES (?, ?, ?, ?)`,
      instanceId, subject, slug, JSON.stringify({
        instanceId, slug, hostname: `${slug}.educateos.io`, accountId: "c".repeat(32), releaseVersion: "1.0.0", installedAt: "2026-10-26T00:00:00.000Z",
      }));
  });
  return instanceId;
}

function agentFor(instanceId: `ins_${string}`, identity: SigningIdentity) {
  return new DistrictAgent({ identity, instanceId: instanceId as never, sequence: new InMemorySequenceCounter(), sharesAggregateSpend: false });
}

const details = (accountId: string) => ({
  districtLabel: "Test district", releaseVersion: "1.0.0", capabilityIds: [], contactRole: "district-technology-admin" as const,
  commercialAccountId: accountId as never,
});

/** Registration as the guided install does it: from inside the control plane, never over HTTP. */
async function register(envelope: unknown): Promise<{ ok: boolean; code?: string }> {
  const reply = await env.CONTROL_PLANE.getByName(CONTROL_PLANE_OBJECT).receiveRegistryMessage("register", envelope);
  return reply.ok ? { ok: true } : { ok: false, code: reply.code };
}

function post(kind: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/registry/v1/${kind}`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
}

async function status(response: Promise<Response>): Promise<number> {
  const settled = await response;
  await settled.body?.cancel();
  return settled.status;
}

describe("registration", () => {
  it("accepts an installation its operator installed, once, and shows its reports on that operator's dashboard only", async () => {
    const operator = await signIn();
    const instanceId = await installFor(operator.subject, `reg-${count}`);
    const agent = agentFor(instanceId, await SigningIdentity.generate());
    const registration = await agent.register(details(operator.accountId));

    expect(await register(registration)).toEqual({ ok: true });
    expect(await register(registration)).toEqual({ ok: false, code: "conflict" });

    const heartbeat = await agent.heartbeat({ releaseVersion: "1.1.0", probes: [{ probeId: "router", status: "ok" }] });
    expect(await status(post("heartbeat", heartbeat))).toBe(200);
    expect(await status(post("heartbeat", heartbeat))).toBe(409);

    const entries = await (await SELF.fetch(`${ORIGIN}/app/api/installations`, { headers: { "cf-access-jwt-assertion": operator.token } }))
      .json<{ installation: { instanceId: string }; registration?: { releaseVersion: string; lastHeartbeatAt?: string }; probe: { state: string } }[]>();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ installation: { instanceId }, registration: { releaseVersion: "1.1.0" }, probe: { state: "responding" } });
    expect(entries[0]!.registration!.lastHeartbeatAt).toEqual(expect.any(String));

    const page = await (await SELF.fetch(`${ORIGIN}/app/`, { headers: { "cf-access-jwt-assertion": operator.token } })).text();
    expect(page).toContain("1.1.0");
    expect(page).toContain("Responding");
    expect(page).toContain("1 of 1 probes ok");

    const stranger = await signIn();
    const theirs = await (await SELF.fetch(`${ORIGIN}/app/api/installations`, { headers: { "cf-access-jwt-assertion": stranger.token } })).json();
    expect(theirs).toEqual([]);
  });

  it("refuses an unknown account, and an instance the account's operator didn't install", async () => {
    const operator = await signIn();
    const other = await signIn();
    const instanceId = await installFor(other.subject, `theirs-${count}`);
    const unknown = await agentFor(`ins_unknownacct${count}`, await SigningIdentity.generate()).register(details(`acct_${"0".repeat(32)}`));
    expect(await register(unknown)).toEqual({ ok: false, code: "forbidden" });
    const notTheirs = await agentFor(instanceId, await SigningIdentity.generate()).register(details(operator.accountId));
    expect(await register(notTheirs)).toEqual({ ok: false, code: "forbidden" });
  });

  it("refuses a heartbeat from an instance that never registered, or signed by another key", async () => {
    const operator = await signIn();
    const instanceId = await installFor(operator.subject, `keys-${count}`);
    const unregistered = await agentFor(instanceId, await SigningIdentity.generate()).heartbeat({ releaseVersion: "1.0.0", probes: [] });
    expect(await status(post("heartbeat", unregistered))).toBe(401);
    expect(await register(await agentFor(instanceId, await SigningIdentity.generate()).register(details(operator.accountId)))).toEqual({ ok: true });
    const impostor = await agentFor(instanceId, await SigningIdentity.generate()).heartbeat({ releaseVersion: "9.9.9", probes: [] });
    expect(await status(post("heartbeat", impostor))).toBe(401);
  });

  it("never accepts a registration over HTTP, so nobody who learns an instance's IDs can register it first", async () => {
    const operator = await signIn();
    const instanceId = await installFor(operator.subject, `squat-${count}`);
    const registration = await agentFor(instanceId, await SigningIdentity.generate()).register(details(operator.accountId));
    expect(await status(post("register", registration))).toBe(404);
    expect(await register(await agentFor(instanceId, await SigningIdentity.generate()).register(details(operator.accountId)))).toEqual({ ok: true });
  });

  it("answers malformed requests without reaching the registry", async () => {
    expect(await status(post("heartbeat", "{not json"))).toBe(400);
    expect(await status(post("heartbeat", { payload: "x" }))).toBe(400);
    expect(await status(post("heartbeat", "x".repeat(64 * 1024 + 1)))).toBe(413);
    expect(await status(post("rekey", {}))).toBe(404);
    expect(await status(SELF.fetch(`${ORIGIN}/registry/v1/heartbeat`))).toBe(405);
  });

  it("stops reading a body without a Content-Length once it passes the limit", async () => {
    const chunk = new TextEncoder().encode("x".repeat(16 * 1024));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 64) controller.enqueue(chunk);
        else controller.close();
      },
    });
    expect(await status(SELF.fetch(`${ORIGIN}/registry/v1/heartbeat`, { method: "POST", body }))).toBe(413);
    expect(sent).toBeLessThan(64);
  });
});

function answer(code: number, location?: string) {
  return async () => new Response(null, { status: code, headers: location === undefined ? {} : { location } });
}

describe("the dashboard probe", () => {
  it("reports what /healthz answered", async () => {
    const host = "abc.educateos.io";
    expect(await probeInstallation(host, answer(200))).toEqual({ state: "responding" });
    expect(await probeInstallation(host, answer(302, "https://team.cloudflareaccess.com/cdn-cgi/access/login/a"))).toEqual({ state: "behind-sign-in" });
    expect(await probeInstallation(host, answer(302, "https://evil.example/cloudflareaccess.com"))).toEqual({ state: "failing", status: 302 });
    expect(await probeInstallation(host, answer(302, "https://x.cloudflareaccess.com.evil.example/"))).toEqual({ state: "failing", status: 302 });
    expect(await probeInstallation(host, answer(503))).toEqual({ state: "failing", status: 503 });
    expect(await probeInstallation(host, async () => { throw new TypeError("network"); })).toEqual({ state: "unreachable" });
  });

  it("requests only https://<slug>.educateos.io/healthz, never another host", async () => {
    const asked: string[] = [];
    const record = async (input: RequestInfo | URL) => { asked.push(String(input)); return new Response("ok"); };
    await probeInstallation("abc.educateos.io", record);
    for (const host of ["example.org", "evil.example/x?", "user@abc.educateos.io", "abc.educateos.io.evil.example", "a.b.educateos.io"]) {
      expect(await probeInstallation(host, record)).toEqual({ state: "unreachable" });
    }
    expect(asked).toEqual(["https://abc.educateos.io/healthz"]);
  });
});

function base(instanceId: string, keyId: string) {
  return ({
    instanceId, keyId, publicKey: "p", retiredKeyIds: [], ownershipTokenSha256: "a".repeat(64), districtLabel: "D",
    commercialAccountId: `acct_${"1".repeat(32)}`, contactRole: "district-technology-admin", capabilityIds: [],
    registeredAt: "2026-10-26T00:00:00.000Z", releaseVersion: "1.0.0", lastSequence: 0, probes: [],
  }) as never;
}

describe("DurableObjectRegistryStorage", () => {

  it("keeps fleet's contract: first-come inserts, single-use keys, compare-and-set updates", async () => {
    await runInDurableObject(env.CONTROL_PLANE.getByName(`contract-${count++}`), async (_, state) => {
      const storage = new DurableObjectRegistryStorage(state.storage);
      expect(await storage.insert(base("ins_one", "k1"))).toBe(true);
      expect(await storage.insert(base("ins_one", "k9"))).toBe(false);
      expect(await storage.insert(base("ins_two", "k1"))).toBe(false);

      const expected = { keyId: "k1", ownershipTokenSha256: "a".repeat(64) } as never;
      const next = { keyId: "k2", publicKey: "p2", ownershipTokenSha256: "b".repeat(64) } as never;
      expect(await storage.replaceKey("ins_one" as never, next, { keyId: "k1", ownershipTokenSha256: "c".repeat(64) } as never)).toBeUndefined();
      expect(await storage.replaceKey("ins_one" as never, next, expected)).toMatchObject({ keyId: "k2", retiredKeyIds: ["k1"] });
      // The retired key, and the current one, are never accepted again, by any instance.
      expect(await storage.replaceKey("ins_one" as never, { ...(next as object), keyId: "k1" } as never, { keyId: "k2", ownershipTokenSha256: "b".repeat(64) } as never)).toBeUndefined();
      expect(await storage.insert(base("ins_three", "k1"))).toBe(false);
      expect(await storage.insert(base("ins_three", "k2"))).toBe(false);

      const current = (await storage.get("ins_one" as never))!;
      expect(await storage.update({ ...current, lastSequence: 5 }, 1)).toBe(false);
      expect(await storage.update({ ...current, keyId: "k1", lastSequence: 5 } as never, 0)).toBe(false);
      expect(await storage.update({ ...current, commercialAccountId: `acct_${"2".repeat(32)}`, lastSequence: 5 } as never, 0)).toBe(false);
      expect(await storage.update({ ...current, lastSequence: 5 }, 0)).toBe(true);
      expect(await storage.update({ ...current, lastSequence: 6 }, 0)).toBe(false);
      expect((await storage.list()).map((r) => [r.instanceId, r.lastSequence])).toEqual([["ins_one", 5]]);
      expect(await storage.forAccount(`acct_${"1".repeat(32)}` as never)).toHaveLength(1);
      expect(await storage.forAccount(`acct_${"2".repeat(32)}` as never)).toEqual([]);
    });
  });

  it("accepts exactly one of two concurrent heartbeats with the same sequence", async () => {
    const operator = await signIn();
    const instanceId = await installFor(operator.subject, `race-${count}`);
    const agent = agentFor(instanceId, await SigningIdentity.generate());
    expect(await register(await agent.register(details(operator.accountId)))).toEqual({ ok: true });
    const heartbeat = await agent.heartbeat({ releaseVersion: "1.0.0", probes: [] });
    const statuses = await Promise.all([status(post("heartbeat", heartbeat)), status(post("heartbeat", heartbeat))]);
    expect(statuses.toSorted()).toEqual([200, 409]);
  });
});
