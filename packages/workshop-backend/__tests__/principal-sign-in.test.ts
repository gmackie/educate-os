import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { newHttpBatchRpcSession } from "capnweb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAuthErrorCode, type PublicApi } from "@gadgets/workshop-shared/api";
import type {
  AccessSignIn, PrincipalResolution,
} from "@gadgets/workshop-shared/principal-resolver";
import { getAuthGatekeeperAllowlist, isPasswordAuthEnabled } from "../src/auth/config";
import server from "../src/server";

// Stand in for Access's signature check: a test "JWT" is its base64url-encoded payload. What is
// under test is what the backend does with claims once they are verified.
vi.mock("jose", () => ({
  createRemoteJWKSet: () => () => undefined,
  jwtVerify: async (token: string) => ({
    payload: JSON.parse(new TextDecoder().decode(Uint8Array.fromBase64(token, { alphabet: "base64url" }))),
  }),
}));

const ORIGIN = "https://workshop.example";
const ISS = "https://team.cloudflareaccess.example";

function jwt(claims: Record<string, unknown>): string {
  return new TextEncoder().encode(JSON.stringify({ iss: ISS, aud: "audience", ...claims }))
      .toBase64({ alphabet: "base64url", omitPadding: true });
}

/** A resolver that links each Access subject in `links` to a principal. */
function resolverFor(links: Record<string, PrincipalResolution>) {
  return {
    resolveAccessSignIn: vi.fn(async (signIn: AccessSignIn): Promise<PrincipalResolution> =>
      links[signIn.subject] ?? { outcome: "unauthenticated" }),
  };
}

const LINKS: Record<string, PrincipalResolution> = {
  "sub-alice": { outcome: "resolved", principalId: "prn_alice", displayName: "Alice" },
  "sub-mallory": { outcome: "resolved", principalId: "prn_mallory", displayName: "Mallory" },
  "sub-adopting": { outcome: "adoption-pending" },
  "sub-malformed": { outcome: "resolved", principalId: "prn:alice", displayName: "Not Alice" },
};

function accessEnv(resolver?: ReturnType<typeof resolverFor>): Cloudflare.Env {
  return {
    ...env,
    CF_ACCESS_AUD: "audience",
    CF_ACCESS_ISS: ISS,
    BLUEPRINTS: { get: async () => null } as unknown as KVNamespace,
    ...(resolver ? { PRINCIPAL_RESOLVER: resolver as unknown as Cloudflare.Env["PRINCIPAL_RESOLVER"] } : {}),
  };
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

// Route the batch RPC client's request to the Worker, with `testEnv`.
function routeApiTo(testEnv: Cloudflare.Env) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) =>
    server.fetch(new Request(input, init), testEnv, executionContext()));
}

function api(token?: string) {
  return newHttpBatchRpcSession<PublicApi>(new Request(`${ORIGIN}/api`, {
    headers: { Origin: ORIGIN, ...(token ? { "cf-access-jwt-assertion": token } : {}) },
  }));
}

async function signInAs(token: string) {
  return await api(token).authenticateFromCfAccess().whoami();
}

async function authErrorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    return getAuthErrorCode(err);
  }
  throw new Error("expected the sign-in to be refused");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Access sign-in with a principal resolver", () => {
  it("names the user for the principal its subject resolves to", async () => {
    const resolver = resolverFor(LINKS);
    routeApiTo(accessEnv(resolver));

    const me = await signInAs(jwt({ sub: "sub-alice", email: "alice@district.example" }));

    expect(me).toMatchObject({ id: "principal:prn_alice", name: "Alice" });
    expect(resolver.resolveAccessSignIn).toHaveBeenCalledWith(
        { issuer: ISS, subject: "sub-alice", email: "alice@district.example" });
  });

  it("does not let a forged email reach another user's account", async () => {
    // The victim's account as email-keyed sign-in created it before the resolver was bound.
    await env.TEST_USER.getByName("victim@district.example")
        .authenticateFromCfAccess("victim@district.example", true);
    routeApiTo(accessEnv(resolverFor(LINKS)));

    const linked = await signInAs(jwt({ sub: "sub-mallory", email: "victim@district.example" }));
    expect(linked.id).toBe("principal:prn_mallory");

    const unlinked = jwt({ sub: "sub-unknown", email: "victim@district.example" });
    expect(await authErrorCode(signInAs(unlinked))).toBe("PRINCIPAL_UNRESOLVED");
    // Without a subject there is nothing to resolve, whatever the email says.
    expect(await authErrorCode(signInAs(jwt({ email: "victim@district.example" }))))
        .toBe("PRINCIPAL_UNRESOLVED");
  });

  it("keeps one account per subject across changes of email", async () => {
    routeApiTo(accessEnv(resolverFor(LINKS)));
    const first = await signInAs(jwt({ sub: "sub-alice", email: "alice@district.example" }));
    const renamed = await signInAs(jwt({ sub: "sub-alice", email: "a.smith@district.example" }));
    const noEmail = await signInAs(jwt({ sub: "sub-alice" }));
    expect(renamed.id).toBe(first.id);
    expect(noEmail.id).toBe(first.id);
  });

  it("denies a sign-in whose email-keyed account awaits adoption", async () => {
    routeApiTo(accessEnv(resolverFor(LINKS)));
    expect(await authErrorCode(signInAs(jwt({ sub: "sub-adopting", email: "old@district.example" }))))
        .toBe("PRINCIPAL_ADOPTION_PENDING");
  });

  it("refuses a principal ID that is not a plain name", async () => {
    routeApiTo(accessEnv(resolverFor(LINKS)));
    expect(await authErrorCode(signInAs(jwt({ sub: "sub-malformed" })))).toBe("PRINCIPAL_UNRESOLVED");
  });

  it("refuses the sign-in when the resolver fails", async () => {
    const resolver = resolverFor(LINKS);
    resolver.resolveAccessSignIn.mockRejectedValue(new Error("directory unavailable"));
    routeApiTo(accessEnv(resolver));
    await expect(signInAs(jwt({ sub: "sub-alice" }))).rejects.toThrow("directory unavailable");
  });

  it("refuses session tokens, passwords and gatekeeper sign-in", async () => {
    const token = await env.TEST_USER.getByName("tokenholder")
        .createAccount("tokenholder", "Token Holder", new Uint8Array(32));
    expect(token).not.toBeNull();
    const withResolver = accessEnv(resolverFor(LINKS));

    const access = jwt({ sub: "sub-alice", email: "tokenholder@district.example" });

    routeApiTo(withResolver);
    expect(await authErrorCode(api(access).authenticate(`tokenholder:${token}`).whoami()))
        .toBe("INVALID_SESSION_TOKEN");
    expect(isPasswordAuthEnabled(withResolver)).toBe(false);
    expect(getAuthGatekeeperAllowlist({ ...withResolver, AUTH_GATEKEEPERS: "google" })).toEqual([]);

    // The same token is good without a resolver.
    vi.restoreAllMocks();
    routeApiTo({ ...withResolver, PRINCIPAL_RESOLVER: undefined });
    expect(await api(access).authenticate(`tokenholder:${token}`).whoami())
        .toMatchObject({ id: "tokenholder" });
  });
});

describe("Access sign-in without a principal resolver", () => {
  it("keys the user by email, as before", async () => {
    routeApiTo(accessEnv());
    const me = await signInAs(jwt({ sub: "sub-alice", email: "carol@district.example" }));
    expect(me).toMatchObject({ id: "carol@district.example", name: "carol" });
  });

  it("still requires an email", async () => {
    routeApiTo(accessEnv());
    const response = await fetch(new Request(`${ORIGIN}/api`, {
      method: "POST",
      headers: { Origin: ORIGIN, "cf-access-jwt-assertion": jwt({ sub: "sub-alice" }) },
      body: "",
    }));
    expect(response.status).toBe(403);
  });
});

function callback(token: string, body: URLSearchParams): Request {
  return new Request(`${ORIGIN}/api/device-session/callback`, {
    method: "POST",
    headers: {
      Origin: ORIGIN,
      "Content-Type": "application/x-www-form-urlencoded",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
      "cf-access-jwt-assertion": token,
    },
    body,
  });
}

describe("device session callback with a principal resolver", () => {
  it("delivers a handoff only to the principal that staged it", async () => {
    const state = crypto.randomUUID();
    const user = env.TEST_USER.getByName("principal:prn_alice");
    await user.authenticateFromCfAccess("principal:prn_alice", true, "Alice");
    const key = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey) as ArrayBuffer)
        .toBase64({ alphabet: "base64url", omitPadding: true });
    const start = await user.stageDeviceSessionHandoff(publicKey, state, "access-jwt");
    const body = () => new URLSearchParams({ ...start, state });
    const testEnv = accessEnv(resolverFor(LINKS));
    const post = (token: string) => server.fetch(callback(token, body()), testEnv, executionContext());

    // Mallory signs in with Alice's email; she resolves to her own principal, not Alice's.
    const mismatched = await post(jwt({ sub: "sub-mallory", email: "alice@district.example" }));
    expect(mismatched.status).toBe(403);
    expect(await mismatched.text()).toBe("Invalid device session owner.");
    for (const refused of [jwt({ sub: "sub-unknown" }), jwt({ sub: "sub-adopting" }), jwt({})]) {
      expect((await post(refused)).status).toBe(403);
    }

    // None of those consumed the ticket.
    const delivered = await post(jwt({ sub: "sub-alice" }));
    expect(delivered.status).toBe(303);
  });
});
