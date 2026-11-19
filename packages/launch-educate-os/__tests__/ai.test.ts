// `ai add | remove | status` (SCHO-446) against an installed Northfield district: the installer's
// Cloudflare fake holds the gateway's provider keys, and a stand-in answers the gateway's provider
// paths the way a provider answers a key check.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ConnectWorld, connectWorld, run } from "./connect-harness.ts";

const GATEWAY = "educateos-northfield";
const GOOD = { anthropic: `sk-ant-api03-${"a".repeat(40)}`, openai: `sk-proj-${"b".repeat(40)}` };

let world: ConnectWorld;
/** Every key check that reached the gateway: the path and the key it carried. */
let checks: { path: string; key: string | null }[];

beforeEach(async () => {
  world = await connectWorld();
  checks = [];
});
afterEach(async () => await world.close());

/** The world's fetch, with the gateway answering a key check: 200 for a good key, 401 otherwise. */
const gatewayFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== "https://gateway.ai.cloudflare.com") return await world.fetch(request);
  const key = request.headers.get("x-api-key") ?? request.headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
  checks.push({ path: url.pathname, key });
  // A provider's refusal can echo part of the key; the launcher must not print it.
  return Object.values(GOOD).includes(key ?? "") ? Response.json({ data: [] }) : new Response(`invalid x-api-key ${key}`, { status: 401 });
}) as typeof fetch;

const ai = (args: string[], answers?: string[], env: Record<string, string> = {}) =>
  run(["ai", ...args, "--config", world.answersPath, "--release-url", world.mirror.base, "--trust", world.trust],
    { cwd: world.dir, env: { ...world.env, ...env }, fetch: gatewayFetch, ...(answers ? { answers } : {}) });

const backendProviders = () => (world.cloudflare.fake.worker("educateos-northfield-workshop-backend")?.bindings
  .find((b) => b.name === "CF_AI_GATEWAY_PROVIDERS") as { text?: string } | undefined)?.text;

describe("ai add", () => {
  it("checks the key through the district's gateway, stores it there, and turns the provider on", async () => {
    expect(backendProviders()).toBe("cloudflare");
    // The notice, the key, applying now, and the install's own plan confirmation.
    const result = await ai(["add", "anthropic"], ["y", GOOD.anthropic, "y", "y"]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(checks).toEqual([{ path: `/v1/${accountId()}/${GATEWAY}/anthropic/v1/models`, key: GOOD.anthropic }]);
    expect(world.cloudflare.fake.storedProviderKey(GATEWAY, "anthropic")).toBe(GOOD.anthropic);
    expect(backendProviders()).toBe("cloudflare,anthropic");
    // The key appears nowhere it shouldn't: not on screen, not in the answers file.
    expect(result.stdout).not.toContain(GOOD.anthropic);
    const saved = readFileSync(world.answersPath, "utf8");
    expect(saved).not.toContain(GOOD.anthropic);
    expect(JSON.parse(saved).install.ai).toMatchObject({ providers: ["anthropic"] });
    expect(result.stdout).toContain("Anthropic accepted the key.");
  });

  it("refuses a key the provider rejects, storing nothing and changing nothing", async () => {
    const bad = `sk-ant-api03-${"z".repeat(40)}`;
    const result = await ai(["add", "anthropic"], ["y", bad]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Anthropic rejected that key; nothing was stored");
    expect(`${result.stdout}${result.stderr}`).not.toContain(bad);
    expect(world.cloudflare.fake.storedProviderKey(GATEWAY, "anthropic")).toBeUndefined();
    expect(backendProviders()).toBe("cloudflare");
  });

  it("catches a paste that isn't a key before sending it anywhere", async () => {
    const result = await ai(["add", "openai"], ["y", "my password"]);
    expect(result.stderr).toContain("doesn't look like a OpenAI API key");
    expect(checks).toEqual([]);
  });

  it("runs without a terminal from the environment, and a second add finds the stored key", async () => {
    const first = await ai(["add", "openai", "--yes"], undefined, { EDUCATEOS_OPENAI_API_KEY: GOOD.openai });
    expect(first.stderr).toBe("");
    expect(checks.map((c) => c.path)).toEqual([`/v1/${accountId()}/${GATEWAY}/openai/models`]);
    expect(backendProviders()).toBe("cloudflare,openai");
    const again = await ai(["add", "openai", "--yes"]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("already holds a OpenAI key");
    expect(again.stdout).toContain("OpenAI is already on.");
    expect(checks).toHaveLength(1);
  });

  it("changes nothing when the administrator declines the notice", async () => {
    const result = await ai(["add", "anthropic"], ["n"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Nothing was changed.");
    expect(checks).toEqual([]);
  });
});

describe("ai remove and status", () => {
  it("turns a provider off and reports what the gateway holds", async () => {
    await ai(["add", "anthropic", "--yes"], undefined, { EDUCATEOS_ANTHROPIC_API_KEY: GOOD.anthropic });
    const status = await ai(["status"]);
    expect(status.stdout).toMatch(/Anthropic\s+on\s+\(key sk-a…aa\)/);
    expect(status.stdout).toMatch(/OpenAI\s+off\s+\(no key stored\)/);

    const removed = await ai(["remove", "anthropic", "--yes"]);
    expect(removed.code).toBe(0);
    expect(removed.stdout).toContain("The key stays in your AI Gateway");
    expect(backendProviders()).toBe("cloudflare");
    expect(JSON.parse(readFileSync(world.answersPath, "utf8")).install.ai.providers).toEqual([]);
  });

  it("refuses an unknown provider", async () => {
    const result = await ai(["add", "google"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("name the provider: anthropic or openai");
  });
});

function accountId(): string {
  return String(JSON.parse(readFileSync(world.answersPath, "utf8")).install.accountId);
}
