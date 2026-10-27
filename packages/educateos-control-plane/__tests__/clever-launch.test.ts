// Clever portal launches through educateos.io/clever/launch (SCHO-249): the code is exchanged with
// a fake Clever, the user's district is read from /me, and the browser is sent to the registered
// installation for that district. The token is used once and kept nowhere: not in storage, not in
// a log, not in the redirect.

import { env, runInDurableObject, SELF } from "cloudflare:test";
import { DistrictAgent, InMemorySequenceCounter, SigningIdentity } from "@educateos/fleet";
import { importJWK, SignJWT, type JWK } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLEVER_LAUNCH_PATH, cleverLaunch, configuredLaunchDistricts, type CleverLaunchDeps } from "../src/clever-launch.ts";
import { TABLES } from "../src/store.ts";
import { CONTROL_PLANE_OBJECT } from "../src/worker.ts";
import { CLEVER_CLIENT, fakeClever, tokenFor } from "./clever-fake.ts";
import { ACCESS_AUD, ACCESS_ISSUER } from "./fixtures.ts";

const ORIGIN = "https://educateos.io";
/** The educateos-dev Clever app's sandbox district. */
const SANDBOX_DISTRICT = "6ade41569b8cebb96d733c48";
const OTHER_DISTRICT = "5d0a9e5d0958b300014e49d2";
const SHELL = { header: "<header>h</header>", footer: "<footer>f</footer>" };

let count = 0;

afterEach(() => {
  vi.restoreAllMocks();
});

function deps(overrides: Partial<CleverLaunchDeps> = {}): CleverLaunchDeps {
  return {
    shell: SHELL,
    credentials: CLEVER_CLIENT,
    hostnameFor: async (district) => (district === SANDBOX_DISTRICT ? "cedarvalley.educateos.io" : undefined),
    fetch: fakeClever,
    ...overrides,
  };
}

const launch = (code: string | undefined, init: RequestInit = {}) =>
  new Request(`${ORIGIN}${CLEVER_LAUNCH_PATH}${code === undefined ? "" : `?code=${encodeURIComponent(code)}`}`, init);

/** Every console call the handler made, as one string, to search for things it must never log. */
function logged(spies: ReturnType<typeof vi.spyOn>[]): string {
  return JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
}

function spyOnConsole() {
  return (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
}

describe("the launch handler", () => {
  it("sends a launch to the root of its district's installation, with no cache and no referrer", async () => {
    const consoleSpies = spyOnConsole();
    const code = `launch-${SANDBOX_DISTRICT}`;
    const response = await cleverLaunch(launch(code), deps());

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://cedarvalley.educateos.io/");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await response.text()).toBe("");
    const logs = logged(consoleSpies);
    for (const secret of [code, tokenFor(code), SANDBOX_DISTRICT, CLEVER_CLIENT.clientSecret]) expect(logs).not.toContain(secret);
  });

  it("reads the district from the user's record when a teacher-authorized /me leaves it out", async () => {
    const consoleSpies = spyOnConsole();
    const code = `launch-teacher-${SANDBOX_DISTRICT}`;
    const response = await cleverLaunch(launch(code), deps());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://cedarvalley.educateos.io/");
    const logs = logged(consoleSpies);
    for (const secret of [code, tokenFor(code), SANDBOX_DISTRICT]) expect(logs).not.toContain(secret);
  });

  it("refuses a teacher-authorized launch whose user record Clever won't show", async () => {
    const fetch: CleverLaunchDeps["fetch"] = async (input, init) =>
      input.includes("/users/") ? Response.json({ error: "forbidden" }, { status: 403 }) : fakeClever(input, init);
    const consoleSpies = spyOnConsole();
    const response = await cleverLaunch(launch(`launch-teacher-${SANDBOX_DISTRICT}`), deps({ fetch }));
    expect(response.status).toBe(502);
    await response.body?.cancel();
    expect(consoleSpies[2]!.mock.calls).toEqual([
      ["clever launch refused", { event: "clever.launch.refused", reason: "identity-failed", cleverStatus: 403, cleverError: "forbidden" }],
    ]);
  });

  it("tells a user whose district registered no installation so, without naming the district", async () => {
    const response = await cleverLaunch(launch(`launch-${OTHER_DISTRICT}`), deps());
    expect(response.status).toBe(404);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const page = await response.text();
    expect(page).toContain("isn&#39;t set up for Clever launch");
    expect(page).not.toContain(OTHER_DISTRICT);
  });

  it("answers a code Clever refuses with a page, never Clever's reply", async () => {
    const consoleSpies = spyOnConsole();
    const response = await cleverLaunch(launch("expired-code"), deps());
    expect(response.status).toBe(502);
    const page = await response.text();
    expect(page).toContain("didn&#39;t finish");
    expect(page).not.toContain("invalid_grant");
    expect(page).not.toContain("expired-code");
    expect(logged(consoleSpies)).not.toContain("expired-code");
  });

  it("logs Clever's status and OAuth error code with a refusal, and nothing else of its reply", async () => {
    const consoleSpies = spyOnConsole();
    const fetch: CleverLaunchDeps["fetch"] = async () =>
      Response.json({ error: "invalid_client", error_description: "client secret-ish detail" }, { status: 401 });
    const response = await cleverLaunch(launch(`launch-${SANDBOX_DISTRICT}`), deps({ fetch }));
    expect(response.status).toBe(502);
    await response.body?.cancel();
    expect(consoleSpies[2]!.mock.calls).toEqual([
      ["clever launch refused", { event: "clever.launch.refused", reason: "exchange-failed", cleverStatus: 401, cleverError: "invalid_client" }],
    ]);
    expect(logged(consoleSpies)).not.toContain("secret-ish");
  });

  it("answers Clever being down or redirecting like a refusal", async () => {
    const down = await cleverLaunch(launch(`launch-${SANDBOX_DISTRICT}`), deps({ fetch: async () => { throw new TypeError("network"); } }));
    expect(down.status).toBe(502);
    await down.body?.cancel();
    const moved = await cleverLaunch(launch(`launch-${SANDBOX_DISTRICT}`),
      deps({ fetch: async () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }) }));
    expect(moved.status).toBe(502);
    expect(moved.headers.get("location")).toBeNull();
    await moved.body?.cancel();
  });

  it("refuses an identity without a Clever district ID, logging only its shape", async () => {
    const consoleSpies = spyOnConsole();
    const fetch: CleverLaunchDeps["fetch"] = async (input, init) =>
      input.endsWith("/me") ? Response.json({ data: { id: "x", district: "../../evil" } }) : fakeClever(input, init);
    const response = await cleverLaunch(launch(`launch-${SANDBOX_DISTRICT}`), deps({ fetch, hostnameFor: async () => "evil.educateos.io" }));
    expect(response.status).toBe(502);
    await response.body?.cancel();
    expect(consoleSpies[2]!.mock.calls).toEqual([
      ["clever launch refused", {
        event: "clever.launch.refused", reason: "identity-failed", cleverStatus: 200, cleverShape: "{data:{id:string(1),district:string(10)}}",
      }],
    ]);
    expect(logged(consoleSpies)).not.toContain("evil");
  });

  it("refuses a launch without a code, or with no Clever client configured, before calling Clever", async () => {
    const fetch = vi.fn(fakeClever);
    const missing = await cleverLaunch(launch(undefined), deps({ fetch }));
    expect(missing.status).toBe(400);
    await missing.body?.cancel();
    const unconfigured = await cleverLaunch(launch(`launch-${SANDBOX_DISTRICT}`), deps({ fetch, credentials: undefined }));
    expect(unconfigured.status).toBe(503);
    await unconfigured.body?.cancel();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("answers HEAD without spending the code, and refuses every other method", async () => {
    const fetch = vi.fn(fakeClever);
    const head = await cleverLaunch(launch(`launch-${SANDBOX_DISTRICT}`, { method: "HEAD" }), deps({ fetch }));
    expect(head.status).toBe(200);
    expect(head.headers.get("location")).toBeNull();
    for (const method of ["POST", "PUT", "DELETE"]) {
      const response = await cleverLaunch(launch(`launch-${SANDBOX_DISTRICT}`, { method }), deps({ fetch }));
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD");
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

async function operator(): Promise<{ subject: string; accountId: string }> {
  const subject = `clever-launch-user-${count++}`;
  const token = await new SignJWT({ sub: subject, email: `${subject}@example.org` })
    .setProtectedHeader({ alg: "RS256", kid: "test-access-key" })
    .setIssuer(ACCESS_ISSUER).setAudience(ACCESS_AUD).setIssuedAt().setExpirationTime("5m")
    .sign(await importJWK(JSON.parse(env.TEST_ACCESS_PRIVATE_JWK) as JWK, "RS256"));
  const me = await (await SELF.fetch(`${ORIGIN}/app/api/me`, { headers: { "cf-access-jwt-assertion": token } })).json<{ accountId: string }>();
  return { subject, accountId: me.accountId };
}

/** An installation made through educateos.io, registered (opted in) only when asked. */
async function install(slug: string, registered: boolean): Promise<`ins_${string}`> {
  const { subject, accountId } = await operator();
  const instanceId = `ins_${slug.replaceAll("-", "")}` as const;
  await runInDurableObject(env.CONTROL_PLANE.getByName(CONTROL_PLANE_OBJECT), (_, state) => {
    state.storage.sql.exec(`INSERT INTO ${TABLES.installations} (instance_id, operator_subject, slug, record) VALUES (?, ?, ?, ?)`,
      instanceId, subject, slug, JSON.stringify({
        instanceId, slug, hostname: `${slug}.educateos.io`, accountId: "c".repeat(32), releaseVersion: "1.0.0", installedAt: "2026-10-26T00:00:00.000Z",
      }));
  });
  if (registered) {
    const agent = new DistrictAgent({
      identity: await SigningIdentity.generate(), instanceId: instanceId as never, sequence: new InMemorySequenceCounter(), sharesAggregateSpend: false,
    });
    const envelope = await agent.register({
      districtLabel: slug, releaseVersion: "1.0.0", capabilityIds: [], contactRole: "district-technology-admin", commercialAccountId: accountId as never,
    });
    expect((await env.CONTROL_PLANE.getByName(CONTROL_PLANE_OBJECT).receiveRegistryMessage("register", envelope)).ok).toBe(true);
  }
  return instanceId;
}

const link = (instanceId: string, cleverDistrictId: string) =>
  env.CONTROL_PLANE.getByName(CONTROL_PLANE_OBJECT).linkCleverDistrict(instanceId, cleverDistrictId);

/** Every value in every table of the control plane's storage, as one string. */
async function everythingStored(): Promise<string> {
  return runInDurableObject(env.CONTROL_PLANE.getByName(CONTROL_PLANE_OBJECT), (_, state) => {
    const tables = state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map((row) => String(row.name));
    return JSON.stringify(tables.map((table) => state.storage.sql.exec(`SELECT * FROM "${table}"`).toArray()));
  });
}

describe("/clever/launch on the site Worker", () => {
  it("redirects a launch to the registered installation for the user's Clever district, and stores nothing of it", async () => {
    const instanceId = await install("cedar-valley", true);
    expect(await link(instanceId, SANDBOX_DISTRICT)).toEqual({ ok: true, body: { linked: true } });

    const code = `launch-${SANDBOX_DISTRICT}`;
    const response = await SELF.fetch(`${ORIGIN}${CLEVER_LAUNCH_PATH}?code=${code}&scope=read`, { redirect: "manual" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://cedar-valley.educateos.io/");
    await response.body?.cancel();

    const stored = await everythingStored();
    expect(stored).not.toContain(tokenFor(code));
    expect(stored).not.toContain(code);
  });

  it("can't send a launch to an installation that never opted in to the registry", async () => {
    const instanceId = await install("not-opted-in", false);
    expect(await link(instanceId, OTHER_DISTRICT)).toMatchObject({ ok: false, code: "conflict" });
    const response = await SELF.fetch(`${ORIGIN}${CLEVER_LAUNCH_PATH}?code=launch-${OTHER_DISTRICT}`, { redirect: "manual" });
    expect(response.status).toBe(404);
    await response.body?.cancel();
  });

  it("keeps a Clever district to the installation that named it first", async () => {
    const first = await install("first-claim", true);
    const second = await install("second-claim", true);
    const district = "0123456789abcdef01234567";
    expect((await link(first, district)).ok).toBe(true);
    expect(await link(second, district)).toMatchObject({ ok: false, code: "conflict" });
    expect(await link(first, "nonsense")).toMatchObject({ ok: false, code: "validation-failed" });

    const response = await SELF.fetch(`${ORIGIN}${CLEVER_LAUNCH_PATH}?code=launch-${district}`, { redirect: "manual" });
    expect(response.headers.get("location")).toBe("https://first-claim.educateos.io/");
    await response.body?.cancel();
  });

  it("sends a launch for one of the project's own districts by the configured map, and only to educateos.io", async () => {
    const demo = await SELF.fetch(`${ORIGIN}${CLEVER_LAUNCH_PATH}?code=launch-abcdefabcdefabcdefabcdef`, { redirect: "manual" });
    expect(demo.status).toBe(303);
    expect(demo.headers.get("location")).toBe("https://demo-district.educateos.io/");
    await demo.body?.cancel();
    const foreign = await SELF.fetch(`${ORIGIN}${CLEVER_LAUNCH_PATH}?code=launch-fedcbafedcbafedcbafedcba`, { redirect: "manual" });
    expect(foreign.status).toBe(404);
    await foreign.body?.cancel();
    expect(configuredLaunchDistricts("not json").size).toBe(0);
    expect(configuredLaunchDistricts(undefined).size).toBe(0);
  });

  it("refuses a POST", async () => {
    const response = await SELF.fetch(`${ORIGIN}${CLEVER_LAUNCH_PATH}?code=launch-${SANDBOX_DISTRICT}`, { method: "POST", redirect: "manual" });
    expect(response.status).toBe(405);
    await response.body?.cancel();
  });
});
