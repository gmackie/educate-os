// Deregistration (SCHO-368, district offboarding): the operator who installed an installation
// through educateos.io removes what educateos.io holds about it, confirming with its instance ID:
// the registry record, its Clever district mapping, the dashboard row and the slug's reservation.
// Nobody else can, a key it used is never accepted again, and its slug is free for a new install.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { DistrictAgent, InMemorySequenceCounter, SigningIdentity } from "@educateos/fleet";
import { importJWK, SignJWT, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { DEREGISTER_PATH, STAYS_ON_CONSOLE } from "../src/app.ts";
import { DurableObjectRegistryStorage, REGISTRY_TABLES } from "../src/registry-store.ts";
import { CONTROL_PLANE_OBJECT } from "../src/worker.ts";
import { ACCESS_AUD, ACCESS_ISSUER } from "./fixtures.ts";

const ORIGIN = "https://educateos.io";
const ACCOUNT = "c".repeat(32);
let count = 0;
const object = () => env.CONTROL_PLANE.getByName(CONTROL_PLANE_OBJECT);

async function signIn(): Promise<{ token: string; accountId: string; subject: string }> {
  const subject = `deregister-user-${count++}`;
  const token = await new SignJWT({ sub: subject, email: `${subject}@example.org` })
    .setProtectedHeader({ alg: "RS256", kid: "test-access-key" })
    .setIssuer(ACCESS_ISSUER).setAudience(ACCESS_AUD).setIssuedAt().setExpirationTime("5m")
    .sign(await importJWK(JSON.parse(env.TEST_ACCESS_PRIVATE_JWK) as JWK, "RS256"));
  const me = await (await SELF.fetch(`${ORIGIN}/app/api/me`, { headers: { "cf-access-jwt-assertion": token } })).json<{ accountId: string }>();
  return { token, accountId: me.accountId, subject };
}

/** An installation made as the guided install makes one: the slug reserved, then the row recorded. */
async function install(subject: string, slug: string): Promise<`ins_${string}`> {
  const instanceId = `ins_${slug.replaceAll("-", "")}` as const;
  expect(await object().reserveInstall(subject, slug, ACCOUNT, instanceId)).toEqual({ ok: true, instanceId });
  expect(await object().recordInstallation(subject, {
    instanceId, slug, hostname: `${slug}.educateos.io`, accountId: ACCOUNT, releaseVersion: "1.0.0", installedAt: "2026-11-01T00:00:00.000Z",
  })).toBe(true);
  await object().endInstall(subject, slug, false);
  return instanceId;
}

async function registerWithClever(instanceId: `ins_${string}`, accountId: string, identity: SigningIdentity, cleverDistrictId: string) {
  const agent = new DistrictAgent({ identity, instanceId: instanceId as never, sequence: new InMemorySequenceCounter(), sharesAggregateSpend: false });
  const envelope = await agent.register({
    districtLabel: "Leaving district", releaseVersion: "1.0.0", capabilityIds: [], contactRole: "district-technology-admin",
    commercialAccountId: accountId as never,
  });
  expect((await object().receiveRegistryMessage("register", envelope)).ok).toBe(true);
  expect(await object().linkCleverDistrict(instanceId, cleverDistrictId)).toEqual({ ok: true, body: { linked: true } });
  return envelope;
}

function deregister(token: string, fields: Record<string, string>, origin = ORIGIN): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${DEREGISTER_PATH}`, {
    method: "POST",
    headers: { "cf-access-jwt-assertion": token, origin },
    body: new URLSearchParams(fields),
  });
}

async function recordOf(instanceId: `ins_${string}`) {
  return await runInDurableObject(object(), async (_, state) => await new DurableObjectRegistryStorage(state.storage).get(instanceId as never));
}

describe("deregistration", () => {
  it("removes the registry record, the Clever mapping, the dashboard row and the slug, once confirmed with the instance ID", async () => {
    const operator = await signIn();
    const slug = `leaving-${count}`;
    const instanceId = await install(operator.subject, slug);
    const clever = count.toString(16).padStart(24, "a");
    const envelope = await registerWithClever(instanceId, operator.accountId, await SigningIdentity.generate(), clever);
    expect(await object().cleverLaunchHostname(clever)).toBe(`${slug}.educateos.io`);

    const page = await (await SELF.fetch(`${ORIGIN}${DEREGISTER_PATH}`, { headers: { "cf-access-jwt-assertion": operator.token } })).text();
    expect(page).toContain(`${slug}.educateos.io`);
    expect(page).toContain(`Type ${instanceId} to confirm`);
    expect(page).toContain("npx launch-educate-os uninstall");

    // A wrong or missing confirmation changes nothing.
    for (const confirm of ["", slug, "INS_X"]) {
      const refused = await deregister(operator.token, { instanceId, confirm });
      expect(refused.status).toBe(400);
      expect(await refused.text()).toContain("Nothing was changed.");
    }
    expect(await recordOf(instanceId)).toBeDefined();

    const done = await deregister(operator.token, { instanceId, confirm: instanceId });
    expect(done.status).toBe(200);
    const text = await done.text();
    expect(text).toContain("its registry record is deleted");
    expect(text).toContain("Clever portal launches from its district no longer reach it");

    expect(await recordOf(instanceId)).toBeUndefined();
    expect(await object().cleverLaunchHostname(clever)).toBeUndefined();
    expect(await object().installations(operator.subject)).toEqual([]);
    // The key it used stays spent: its old registration is refused.
    expect((await object().receiveRegistryMessage("register", envelope)).ok).toBe(false);
    await runInDurableObject(object(), (_, state) => {
      expect(state.storage.sql.exec(`SELECT 1 FROM ${REGISTRY_TABLES.cleverDistricts} WHERE instance_id = ?`, instanceId).toArray()).toEqual([]);
    });
    // The slug is free: another operator can reserve it.
    const next = await signIn();
    expect(await object().reserveInstall(next.subject, slug, "d".repeat(32), `ins_next${count}`)).toMatchObject({ ok: true });

    // Running it again finds nothing to remove.
    expect((await deregister(operator.token, { instanceId, confirm: instanceId })).status).toBe(404);
  });

  it("deregisters an installation that never registered, and refuses another operator's", async () => {
    const owner = await signIn();
    const stranger = await signIn();
    const instanceId = await install(owner.subject, `quiet-${count}`);

    const theirs = await deregister(stranger.token, { instanceId, confirm: instanceId });
    expect(theirs.status).toBe(404);
    expect(await object().installations(owner.subject)).toHaveLength(1);
    expect(await (await SELF.fetch(`${ORIGIN}${DEREGISTER_PATH}`, { headers: { "cf-access-jwt-assertion": stranger.token } })).text())
      .not.toContain(instanceId);

    const done = await deregister(owner.token, { instanceId, confirm: instanceId });
    expect(done.status).toBe(200);
    expect(await done.text()).not.toContain("registry record");
    expect(await object().installations(owner.subject)).toEqual([]);
  });

  it("takes the form only from the console itself, and stays on educateos.io when the console moves", async () => {
    const operator = await signIn();
    const instanceId = await install(operator.subject, `origin-${count}`);
    expect((await deregister(operator.token, { instanceId, confirm: instanceId }, "https://evil.example")).status).toBe(403);
    expect(await object().installations(operator.subject)).toHaveLength(1);
    expect(STAYS_ON_CONSOLE).toContain(DEREGISTER_PATH);
  });
});
