// The sign-in: the connect link's redirect to Clever, the code exchange and userinfo against the
// OIDC fake's `clever` preset, the identity confirmed against the Data API with the district's own
// token, a first connect's handoff, and a reconnect staged until the Workshop commits it. The
// sign-in's tokens are never kept.

import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateNonce } from "@gadgets/gatekeeper-kit/connect-nonce";
import worker from "../../src/clever";
import { BASE, DISTRICT_ID, FakeClever, accountStub, failure, hooks, seedAccount, unwrap } from "./fake-clever";

const fake = new FakeClever();

beforeEach(() => {
  fake.install();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function ctx() {
  return { exports: { UserAccount: env.USER_ACCOUNT } } as unknown as ExecutionContext;
}

/** Lets the account mint the decorated account entrypoint, which this pool does not register. */
async function allowFirstConnect(userObjectId: string): Promise<void> {
  await runInDurableObject(accountStub(userObjectId), async (_instance, state) => {
    Object.defineProperty(state.exports, "GatekeeperUserImpl", { value: Reflect.get(state.exports, "TestUser") });
  });
}

/** Follows a connect link through the fake Clever as `loginHint`, returning the final page. */
async function signIn(link: string, loginHint: string): Promise<{ status: number; body: string }> {
  const initiation = await worker.fetch(new Request(`${link}?login_hint=${encodeURIComponent(loginHint)}`), env, ctx());
  await initiation.text();
  expect(initiation.status).toBe(302);
  const authorize = new URL(initiation.headers.get("location")!);
  expect(authorize.origin + authorize.pathname).toBe("https://clever.com/oauth/authorize");
  expect(authorize.searchParams.get("client_id")).toBe("test-client-id");
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  const answer = await fetch(authorize.toString(), { redirect: "manual" });
  await answer.text();
  const callback = answer.headers.get("location")!;
  expect(callback.startsWith(`${BASE}/oauth?`)).toBe(true);
  const page = await worker.fetch(new Request(callback), env, ctx());
  return { status: page.status, body: await page.text() };
}

async function startConnect(): Promise<{ id: string; link: string }> {
  const id = env.USER_ACCOUNT.newUniqueId().toString();
  const nonce = generateNonce();
  await hooks().installCallback(id, nonce);
  return { id, link: `${BASE}/${id}/${nonce}` };
}

async function storedKeys(userObjectId: string): Promise<Record<string, unknown>> {
  return await runInDurableObject(accountStub(userObjectId), async (_instance, state) =>
    Object.fromEntries(state.storage.kv.list()));
}

describe("connecting", () => {
  it("asks the demo's fake Clever who to sign in as, when the deployment says to", async () => {
    const { link } = await startConnect();
    const page = await worker.fetch(new Request(link), env, ctx());
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('name="login_hint"');
  });

  it("signs a teacher in, keeps only who they are, and hands the account to the Workshop once", async () => {
    const { id, link } = await startConnect();
    await allowFirstConnect(id);
    const page = await signIn(link, "mw-t-okafor");
    expect(page.status).toBe(200);
    expect(page.body).toContain("/connect/handoff");
    expect(await hooks().completions(id)).toBe(1);
    expect(unwrap(await hooks().account(id, "getIdentity"))).toEqual({ userId: fake.user("mw-t-okafor"), districtId: DISTRICT_ID });
    // No token of the sign-in is stored anywhere in the account.
    const stored = JSON.stringify(await storedKeys(id));
    for (const grant of fake.oidc.requests.filter(r => r.url.pathname === "/userinfo")) {
      const token = grant.headers.get("authorization")!.slice("Bearer ".length);
      expect(stored).not.toContain(token);
    }
    expect(stored).not.toContain("test-client-secret");
    // The identity was confirmed with the district's token.
    expect(fake.data.requests.some(r => r.url.pathname === `/v3.1/users/${fake.user("mw-t-okafor")}`)).toBe(true);
    expect(unwrap(await hooks().user(id, "describe"))).toMatchObject({ displayName: "Nia Okafor" });
  });

  it("refuses a used connect link", async () => {
    const { id, link } = await startConnect();
    await allowFirstConnect(id);
    expect((await signIn(link, "mw-t-okafor")).status).toBe(200);
    const again = await worker.fetch(new Request(`${link}?login_hint=mw-t-okafor`), env, ctx());
    expect(again.status).toBe(400);
    expect(await again.text()).toContain("expired");
  });
});

describe("reconnecting", () => {
  it("stages a same-user reconnect until the Workshop commits it", async () => {
    const id = await seedAccount(fake, "mw-t-okafor");
    const nonce = generateNonce();
    await hooks().installCallback(id, nonce);
    const { url } = unwrap(await hooks().user(id, "reconnect")) as { url: string };
    expect(url.startsWith(`${BASE}/${id}/`)).toBe(true);
    const page = await signIn(url, "mw-t-okafor");
    expect(page.status).toBe(200);
    const stageId = /var ticket = "([0-9a-f]+)"/.exec(page.body)![1]!;
    unwrap(await hooks().user(id, "commitReconnect", stageId));
    expect(failure(await hooks().user(id, "commitReconnect", stageId))).toMatch(/No reconnect is awaiting/);
    expect(unwrap(await hooks().account(id, "getIdentity"))).toEqual({ userId: fake.user("mw-t-okafor"), districtId: DISTRICT_ID });
  });

  it("refuses a reconnect as another Clever user, leaving the connection as it was", async () => {
    const id = await seedAccount(fake, "mw-t-okafor");
    await hooks().installCallback(id, generateNonce());
    const { url } = unwrap(await hooks().user(id, "reconnect")) as { url: string };
    const page = await signIn(url, "mw-t-quill");
    expect(page.status).toBe(400);
    expect(page.body).toContain("different Clever account");
    expect(unwrap(await hooks().account(id, "getIdentity"))).toEqual({ userId: fake.user("mw-t-okafor"), districtId: DISTRICT_ID });
    expect(await storedKeys(id)).not.toHaveProperty("stagedCredentials");
  });
});

describe("disconnecting", () => {
  it("forgets who the account was", async () => {
    const id = await seedAccount(fake, "mw-s-01");
    unwrap(await hooks().user(id, "revoke"));
    expect(failure(await hooks().account(id, "getIdentity"))).toMatch(/removed/);
  });
});
