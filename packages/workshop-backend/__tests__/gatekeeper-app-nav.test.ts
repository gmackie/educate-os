import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { newHttpBatchRpcSession } from "capnweb";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicApi } from "@gadgets/workshop-shared/api";
import {
  GATEKEEPER_APP_NAV_MAX_ENTRIES,
  isGatekeeperAppPath,
  sanitizeGatekeeperAppNav,
} from "@gadgets/workshop-shared/gatekeeper";
import type { UserDurableObject } from "../src/user.js";
import server from "../src/server";
import type { GatekeeperUserPickerTestHooks } from "./test-worker.js";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    TEST_GATEKEEPER_USER_PICKER: DurableObjectNamespace<GatekeeperUserPickerTestHooks>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

// Stand in for Access's signature check: a test "JWT" is its base64url-encoded payload.
vi.mock("jose", () => ({
  createRemoteJWKSet: () => () => undefined,
  jwtVerify: async (token: string) => ({
    payload: JSON.parse(new TextDecoder().decode(Uint8Array.fromBase64(token, { alphabet: "base64url" }))),
  }),
}));

const ORIGIN = "https://workshop.example";
const ISS = "https://team.cloudflareaccess.example";
const BLUEPRINTS = { get: async () => null } as unknown as KVNamespace;

function jwt(email: string): string {
  return new TextEncoder().encode(JSON.stringify({ iss: ISS, aud: "audience", email }))
      .toBase64({ alphabet: "base64url", omitPadding: true });
}

// The first /api request of an isolate installs the bundled blueprints, into storage these tests
// do not bind; stand a no-op in for the AdminSettings Durable Object that does it.
function executionContext(): ExecutionContext {
  const ctx = createExecutionContext();
  const adminSettings = { getByName: () => ({ ensureBundledBlueprintsInstalled: async () => true }) };
  return {
    waitUntil: (promise: Promise<unknown>) => ctx.waitUntil(promise),
    passThroughOnException: () => {},
    props: ctx.props,
    exports: new Proxy(ctx.exports, {
      get: (target, key) => key === "AdminSettings" ? adminSettings : Reflect.get(target, key),
    }),
  } as unknown as ExecutionContext;
}

// A user signed in through Access, whose Durable Object reads an empty admin config.
async function newUser(): Promise<string> {
  const email = `nav${crypto.randomUUID().replaceAll("-", "")}@district.example`;
  await runInDurableObject(env.TEST_USER.getByName(email), (user: UserDurableObject) => {
    const internals = user as unknown as { env: Cloudflare.Env };
    internals.env = { ...internals.env, BLUEPRINTS };
  });
  await hooks().createUser(email, "Nav Tester");
  return email;
}

function hooks(): DurableObjectStub<GatekeeperUserPickerTestHooks> {
  return env.TEST_GATEKEEPER_USER_PICKER.getByName("");
}

// AuthenticatedApi.listGatekeeperApps as `email`'s browser calls it.
function listApps(email: string) {
  const testEnv = { ...env, CF_ACCESS_AUD: "audience", CF_ACCESS_ISS: ISS, BLUEPRINTS };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) =>
    server.fetch(new Request(input, init), testEnv, executionContext()));
  const api = newHttpBatchRpcSession<PublicApi>(new Request(`${ORIGIN}/api`, {
    headers: { Origin: ORIGIN, "cf-access-jwt-assertion": jwt(email) },
  }));
  return api.authenticateFromCfAccess().listGatekeeperApps();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listGatekeeperApps sidebar entries", () => {
  it("lists the entries an app declares, sanitized", async () => {
    const email = await newUser();
    await hooks().addAccount(email, "school", `${email}-school`, {
      providesUi: true,
      appNav: { entries: [
        { label: "Administration", path: "/admin" },
        { label: "Algebra I", path: "/classes/42", group: "Classes", extra: "dropped" },
        { label: "Elsewhere", path: "https://evil.example/" },
      ] },
    });

    await expect(listApps(email)).resolves.toEqual([{
      id: "school",
      title: `${email}-school`,
      nav: [
        { label: "Administration", path: "/admin" },
        { label: "Algebra I", path: "/classes/42", group: "Classes" },
      ],
    }]);
  });

  it("still lists an app whose entries cannot be read, as a single row", async () => {
    const email = await newUser();
    await hooks().addAccount(email, "school", `${email}-school`, {
      providesUi: true, appNav: { fail: true },
    });

    const apps = await listApps(email);
    expect(apps).toEqual([{ id: "school", title: `${email}-school` }]);
    await expect(hooks().accountCalls(`${email}-school`)).resolves.toContain("getAppNav");
  });

  it("lists an app whose entries don't arrive within 3s as a single row", async () => {
    const email = await newUser();
    await hooks().addAccount(email, "school", `${email}-school`, {
      providesUi: true, appNav: { hang: true },
    });

    const started = Date.now();
    await expect(listApps(email)).resolves.toEqual([{ id: "school", title: `${email}-school` }]);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("never asks an app that does not declare entries", async () => {
    const email = await newUser();
    await hooks().addAccount(email, "context", `${email}-context`, { providesUi: true });
    await hooks().addAccount(email, "github", `${email}-github`);

    await expect(listApps(email)).resolves.toEqual([{ id: "context", title: `${email}-context` }]);
    await expect(hooks().accountCalls(`${email}-context`)).resolves.toEqual(["describe"]);
  });
});

describe("sanitizeGatekeeperAppNav", () => {
  it("keeps well-formed entries, field by field, in order", () => {
    expect(sanitizeGatekeeperAppNav([
      { label: "Home", path: "/" },
      { label: "Week 3 ~ notes", path: "/classes/a-1_b.c/~x%20y", group: "Algebra", icon: "x" },
    ])).toEqual([
      { label: "Home", path: "/" },
      { label: "Week 3 ~ notes", path: "/classes/a-1_b.c/~x%20y", group: "Algebra" },
    ]);
  });

  it("drops malformed entries and anything that is not a list", () => {
    for (const nav of [null, undefined, "nav", { label: "Home", path: "/" }]) {
      expect(sanitizeGatekeeperAppNav(nav)).toEqual([]);
    }
    expect(sanitizeGatekeeperAppNav([
      null, "entry", 7,
      { label: "No path" },
      { path: "/no-label" },
      { label: " ", path: "/blank-label" },
      { label: "x".repeat(81), path: "/long-label" },
      { label: 5, path: "/numeric-label" },
      { label: "Blank group", path: "/g", group: "" },
      { label: "Long group", path: "/g", group: "g".repeat(41) },
      { label: "Null group", path: "/g", group: null },
      { label: "Kept", path: "/kept", group: "g".repeat(40) },
    ])).toEqual([{ label: "Kept", path: "/kept", group: "g".repeat(40) }]);
  });

  it("keeps at most the first 64 well-formed entries", () => {
    const entries = Array.from({ length: 70 }, (_, i) => ({ label: `E${i}`, path: `/${i}` }));
    const nav = sanitizeGatekeeperAppNav([{ label: "Bad", path: "bad" }, ...entries]);
    expect(nav).toHaveLength(GATEKEEPER_APP_NAV_MAX_ENTRIES);
    expect(nav[0]).toEqual({ label: "E0", path: "/0" });
    expect(nav.at(-1)).toEqual({ label: "E63", path: "/63" });
  });
});

describe("isGatekeeperAppPath", () => {
  it("accepts absolute paths of URL-safe characters", () => {
    for (const path of ["/", "/admin", "/classes/42/", "/a.b_c~d-e%2F", `/${"a".repeat(511)}`]) {
      expect(isGatekeeperAppPath(path)).toBe(true);
    }
  });

  it("rejects anything that could leave the app or is not a plain path", () => {
    for (const path of [
      "", "admin", "//evil.example", "/a//b", "https://evil.example/", "/a?b=c", "/a#b",
      "/a b", "/a\\b", "/a\nb", "/é", "javascript:alert(1)", `/${"a".repeat(512)}`, 42, null,
    ]) {
      expect(isGatekeeperAppPath(path)).toBe(false);
    }
  });
});
