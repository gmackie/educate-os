// Clever, faked at the `fetch` boundary with the wire-faithful fakes of @educateos/provider-fakes:
// `OidcFake` with the `clever` preset for sign-in, and `CleverDataFake` for the Data API and LMS
// Connect, both over the sample district. Installed with `vi.stubGlobal`, which reaches the
// gatekeeper because the whole suite -- test file, TestHooks, and the Durable Objects -- runs in
// one isolate. Clever's userinfo and its Data API share api.clever.com, so that origin is routed by
// path, as the fakes' README says a caller must.
//
// One fake per test file: the LMS Connect gradebook numbers assignments from one in each fake, and
// the assignment registry outlives a test, so a fresh fake per test would reuse IDs.

import { env, runInDurableObject } from "cloudflare:test";
import { vi } from "vitest";
import { CleverDataFake, OidcFake, SAMPLE_DISTRICT, cleverDistrictId } from "@educateos/provider-fakes";
import type { CleverIdentity } from "../../src/clever-access";
import type { GatekeeperProps, Outcome, TestHooks } from "./worker";

/** The district token `vitest.worker.config.ts` gives the gatekeeper. */
export const DISTRICT_TOKEN = "test-district-token";
export const DISTRICT_ID = cleverDistrictId(SAMPLE_DISTRICT);
export const CALLBACK = "http://localhost:8787/gatekeeper/clever/oauth";
export const BASE = "http://localhost:8787/gatekeeper/clever";

export class FakeClever {
  readonly data: CleverDataFake;
  readonly oidc: OidcFake;

  constructor() {
    this.data = new CleverDataFake({ seed: SAMPLE_DISTRICT, districtTokens: [DISTRICT_TOKEN] });
    this.oidc = new OidcFake({
      seed: SAMPLE_DISTRICT,
      preset: "clever",
      clients: [{ clientId: "test-client-id", clientSecret: "test-client-secret", redirectUris: [CALLBACK] }],
    });
    if (cleverDistrictId(SAMPLE_DISTRICT) !== "be36e9f30702df9abe36eaf3") {
      throw new Error("The sample district's Clever ID changed: update CLEVER_DISTRICT_TOKENS in vitest.worker.config.ts.");
    }
  }

  install(): this {
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      if (request.redirect !== "manual" && !(url.origin === "https://clever.com" && url.pathname === "/oauth/authorize")) {
        throw new Error(`fake Clever: ${request.method} ${url.pathname} would follow redirects`);
      }
      if (url.origin === "https://api.clever.com" && /^\/v3\.[01]\//.test(url.pathname)) return this.data.handle(request);
      if (url.origin === "https://api.clever.com" || url.origin === "https://clever.com") return this.oidc.handle(request);
      throw new Error(`fake Clever: ${request.method} ${url} was not sent to Clever`);
    });
    return this;
  }

  /** The Clever user ID of a sample person. */
  user(personId: string): string {
    return this.data.userId(personId);
  }

  section(seedId: string): string {
    return this.data.idOf("sections", seedId);
  }

  school(seedId: string): string {
    return this.data.idOf("schools", seedId);
  }

  /** Requests to the Data API whose path matches. */
  count(method: string, pattern: RegExp): number {
    return this.data.requests.filter(r => r.method === method && pattern.test(r.url.pathname)).length;
  }
}

export function hooks(): DurableObjectStub<TestHooks> {
  return env.TEST_HOOKS.get(env.TEST_HOOKS.idFromName("hooks"));
}

export function accountStub(userObjectId: string) {
  return env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(userObjectId));
}

/** A connected account for a sample person, written as a completed sign-in leaves it. */
export async function seedAccount(fake: FakeClever, personId: string): Promise<string> {
  const id = env.USER_ACCOUNT.newUniqueId();
  const identity: CleverIdentity = { userId: fake.user(personId), districtId: DISTRICT_ID };
  await runInDurableObject(env.USER_ACCOUNT.get(id), async (_instance, state) => {
    state.storage.kv.put("identity", identity);
  });
  return id.toString();
}

export function unwrap<T>(result: Outcome<T>): T {
  if ("error" in result) throw new Error(`expected success, got: ${result.error}`);
  return result.ok;
}

export function failure(result: Outcome<unknown>): string {
  if (!("error" in result)) throw new Error(`expected a failure, got: ${JSON.stringify(result.ok)}`);
  return result.error;
}

/** A fresh binding of `target` for the account of `personId`. */
export async function binding(fake: FakeClever, personId: string, target: GatekeeperProps["target"]):
    Promise<{ name: string; props: GatekeeperProps }> {
  return { name: crypto.randomUUID(), props: { userObjectId: await seedAccount(fake, personId), target } };
}

/** The district ledger's audit log, newest first. */
export async function auditLog() {
  return env.CLEVER_LEDGER.getByName(DISTRICT_ID).listAudit({ limit: 500 });
}
