// The Cloudflare the launcher drives: the installer's own CloudflareApi port, plus the two reads
// only a wizard needs, which accounts the token can see and which zones an account holds.
//
// Production always talks to api.cloudflare.com through the installer's HTTP client, which never
// follows a redirect, so the token can't leave Cloudflare. The tests instead reach the installer's
// in-memory fake (cloudflare-fake.ts) through a small loopback bridge, named by
// LAUNCH_EDUCATE_OS_TEST_CLOUDFLARE_RPC. The bridge accepts only an http://127.0.0.1 or
// http://localhost URL, so it can't be pointed anywhere a token could leak to.
import { deserialize, serialize } from "node:v8";
import { EducateOsError } from "@educateos/contracts";
import {
  CLOUDFLARE_API_BASE,
  type CloudflareApi,
  CloudflareApiError,
  CloudflareHttpApi,
  providerToken,
  type TokenProvider,
} from "@educateos/installer";
import { z } from "zod";

/** An account the token can see. */
export interface AccountSummary {
  id: string;
  name: string;
}

/** A zone in an account. */
export interface ZoneSummary {
  id: string;
  name: string;
  /** `active` once its nameservers are delegated. */
  status: string;
}

/** What the launcher reads and changes in Cloudflare. */
export interface LaunchCloudflare {
  /** The installer's port: everything preflight, plan, apply and rollback call. */
  api: CloudflareApi;
  /** The accounts the token can see. */
  listAccounts(): Promise<AccountSummary[]>;
  /** The zones in one account. */
  listZones(accountId: string): Promise<ZoneSummary[]>;
}

/** The environment variable naming the test bridge. Never set it outside the test suite. */
export const TEST_CLOUDFLARE_RPC_ENV = "LAUNCH_EDUCATE_OS_TEST_CLOUDFLARE_RPC";

const Envelope = z.object({
  success: z.boolean(),
  errors: z.array(z.object({ code: z.number() })).nullish().transform((errors) => errors ?? []),
  result: z.unknown().optional(),
  result_info: z.object({ page: z.number().optional(), total_pages: z.number().optional() }).nullish(),
});
const AccountWire = z.object({ id: z.string(), name: z.string() });
const ZoneWire = z.object({ id: z.string(), name: z.string(), status: z.string() });

/** Every page of a Cloudflare list, with the token sent only to `base`. Errors carry codes, never text. */
async function listAll<T>(
  tokens: TokenProvider,
  fetchImpl: typeof fetch,
  base: string,
  operation: string,
  path: string,
  item: z.ZodType<T>,
): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page++) {
    const url = new URL(`${base}${path}`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", "50");
    const token = await providerToken(tokens, operation);
    let response: Response;
    try {
      response = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` }, redirect: "manual" });
    } catch {
      throw new CloudflareApiError(operation, 0, []);
    }
    const parsed = Envelope.safeParse(await response.json().catch(() => undefined));
    if (!response.ok || !parsed.success || !parsed.data.success) {
      throw new CloudflareApiError(operation, response.status, parsed.success ? parsed.data.errors.map((e) => e.code) : []);
    }
    items.push(...z.array(item).parse(parsed.data.result ?? []));
    const totalPages = parsed.data.result_info?.total_pages ?? 1;
    if (page >= totalPages) return items;
  }
}

/** The launcher's Cloudflare over api.cloudflare.com. */
export function httpCloudflare(tokens: TokenProvider, fetchImpl: typeof fetch = fetch.bind(globalThis)): LaunchCloudflare {
  return {
    api: new CloudflareHttpApi({ tokens, fetch: fetchImpl }),
    listAccounts: () => listAll(tokens, fetchImpl, CLOUDFLARE_API_BASE, "listAccounts", "/accounts", AccountWire),
    listZones: (accountId) =>
      listAll(tokens, fetchImpl, CLOUDFLARE_API_BASE, "listZones", `/zones?account.id=${encodeURIComponent(accountId)}`, ZoneWire),
  };
}

/** A failure as it crosses the test bridge. */
export interface BridgedError {
  name: string;
  code: string;
  message: string;
  operation?: string;
  status?: number;
  cloudflareCodes?: number[];
}

/** Rebuilds a failure from the bridge, so the installer's credential checks see what they would in production. */
export function unbridgeError(error: BridgedError): Error {
  if (error.name === "CloudflareApiError" && error.operation !== undefined && error.status !== undefined) {
    return new CloudflareApiError(error.operation, error.status, error.cloudflareCodes ?? []);
  }
  return new EducateOsError(error.code as EducateOsError["code"], error.message);
}

/** Flattens a failure for the bridge. */
export function bridgeError(error: unknown): BridgedError {
  if (error instanceof CloudflareApiError) {
    return { name: error.name, code: error.code, message: error.message, operation: error.operation, status: error.status, cloudflareCodes: [...error.cloudflareCodes] };
  }
  if (error instanceof EducateOsError) return { name: error.name, code: error.code, message: error.message };
  return { name: "Error", code: "unavailable", message: "the test bridge failed" };
}

/** The test bridge: each call is one POST of `{ method, args }`, serialized with node:v8. */
export function rpcCloudflare(endpoint: string, tokens: TokenProvider): LaunchCloudflare {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new EducateOsError("validation-failed", `${TEST_CLOUDFLARE_RPC_ENV} must be a loopback http URL`);
  }
  const call = async (method: string, args: unknown[]): Promise<unknown> => {
    const token = await providerToken(tokens, method);
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
      body: serialize({ method, args }),
    });
    const reply = deserialize(Buffer.from(await response.arrayBuffer())) as { ok: true; value: unknown } | { ok: false; error: BridgedError };
    if (!reply.ok) throw unbridgeError(reply.error);
    return reply.value;
  };
  const api = new Proxy({} as CloudflareApi, {
    get(_target, property) {
      // Not a promise: `await api` must not call `then` across the bridge.
      if (typeof property !== "string" || property === "then") return undefined;
      return (...args: unknown[]) => call(property, args);
    },
  });
  return {
    api,
    listAccounts: () => call("listAccounts", []) as Promise<AccountSummary[]>,
    listZones: (accountId) => call("listZones", [accountId]) as Promise<ZoneSummary[]>,
  };
}

/** The launcher's Cloudflare: api.cloudflare.com, or the test bridge when its variable is set. */
export function launchCloudflare(env: Readonly<Record<string, string | undefined>>, tokens: TokenProvider): LaunchCloudflare {
  const bridge = env[TEST_CLOUDFLARE_RPC_ENV];
  return bridge ? rpcCloudflare(bridge, tokens) : httpCloudflare(tokens);
}
