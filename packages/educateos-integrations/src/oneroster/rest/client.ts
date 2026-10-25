// Extracted from PlayTrek packages/edtech/src/oneroster/client.ts (`OneRosterClient`) at commit
// 7258e4347: OAuth 2.0 client-credentials authentication with an in-memory token cache, and
// `limit`/`offset`/`filter` queries against the rostering collections. Changed from PlayTrek: the
// token endpoint, scopes and fetch are configuration; credentials go in HTTP Basic rather than the
// form body; a rejected token is refreshed once; every collection is read to its last page; every
// response is size-capped and validated; error messages never include a response body; and the
// base path is the 1.2 rostering service's (`/ims/oneroster/rostering/v1p2`, not `/ims/oneroster/v1p2`).
import type { SyncErrorCode } from "@educateos/contracts";
import { z } from "zod";
import { RosterSyncError } from "../../sync-run.ts";
import type { OneRosterIssue } from "../feed.ts";
import { DEFAULT_RETRY_POLICY, fetchWithRetry, realSleep } from "./retry.ts";
import type { RetryPolicy, Sleep } from "./retry.ts";
import { RECORD_SCHEMAS, ROSTER_COLLECTIONS, TokenResponse, pageSchema } from "./schemas.ts";
import type { RosterCollection, RosterRecord } from "./schemas.ts";

/** The path of the OneRoster 1.2 rostering service below a server's base URL. */
export const ROSTERING_PATH = "/ims/oneroster/rostering/v1p2";

/** The scope that grants read access to the core rostering collections. */
export const ROSTER_CORE_READONLY_SCOPE = "https://purl.imsglobal.org/spec/or/v1p2/scope/roster-core.readonly";

// An RFC 6749 section 3.3 scope token: printable ASCII except space, `"` and `\`.
const ScopeToken = z.string().regex(/^[\x21\x23-\x5B\x5D-\x7E]+$/, "is not an OAuth scope token");

/** Where a district's OneRoster server is and how to authenticate to it. Holds no secret. */
export const OneRosterRestConfig = z.strictObject({
  /** The server's base URL, below which the rostering service is at {@link ROSTERING_PATH}. */
  baseUrl: z.url({ protocol: /^https$/ }),
  /** The OAuth 2.0 token endpoint. */
  tokenUrl: z.url({ protocol: /^https$/ }),
  /** The scopes to request, such as {@link ROSTER_CORE_READONLY_SCOPE}. */
  scopes: z.array(ScopeToken).min(1).max(20),
  /** Records asked for per page. The server may return fewer. */
  pageSize: z.number().int().min(1).max(10_000).default(500),
});
/** A OneRoster REST configuration, as given. */
export type OneRosterRestConfigInput = z.input<typeof OneRosterRestConfig>;
/** A OneRoster REST configuration. */
export type OneRosterRestConfig = z.infer<typeof OneRosterRestConfig>;

/** The OAuth client the district registered for EducateOS. Kept out of every message and record. */
export interface OneRosterClientCredentials {
  /** The client ID. */
  clientId: string;
  /** The client secret. */
  clientSecret: string;
}

/** Limits on what a sync reads. Going over one fails the request. */
export interface OneRosterRestLimits {
  /** The largest response body accepted, in bytes. */
  maxResponseBytes: number;
  /** The most records accepted in one collection. */
  maxRecordsPerCollection: number;
  /** How long one request may take before it is abandoned and retried. */
  requestTimeoutMs: number;
}

/** Limits generous enough for a large district, matching the CSV path's row limit. */
export const DEFAULT_REST_LIMITS: OneRosterRestLimits = {
  maxResponseBytes: 16 * 1024 * 1024,
  maxRecordsPerCollection: 500_000,
  requestTimeoutMs: 30_000,
};

/** Everything a {@link OneRosterRestClient} needs. */
export interface OneRosterRestClientOptions {
  /** The server. */
  config: OneRosterRestConfigInput;
  /** The OAuth client. */
  credentials: OneRosterClientCredentials;
  /** The fetch every request goes through. */
  fetch: typeof fetch;
  /** The retry policy, when not {@link DEFAULT_RETRY_POLICY}. */
  retry?: RetryPolicy;
  /** The limits, when not {@link DEFAULT_REST_LIMITS}. */
  limits?: OneRosterRestLimits;
  /** How to wait between attempts. Tests inject one that returns at once. */
  sleep?: Sleep;
  /** The time in milliseconds, for token expiry and `Retry-After` dates. */
  clock?: () => number;
}

/** The records of a collection that validated, and an issue for each one that did not. */
export interface CollectionRead<C extends RosterCollection> {
  /** Valid records, in the order the server listed them. */
  records: RosterRecord<C>[];
  /** One error per invalid record. */
  issues: OneRosterIssue[];
}

/** The row-model file each collection's records map to, which issues are reported against. */
export const COLLECTION_FILES = {
  orgs: "orgs.csv",
  academicSessions: "academicSessions.csv",
  courses: "courses.csv",
  classes: "classes.csv",
  users: "users.csv",
  enrollments: "enrollments.csv",
} as const satisfies Record<RosterCollection, string>;

// A token response is a few hundred bytes; this leaves room for long JWTs.
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
// Refresh a token this long before it expires, or halfway through a shorter lifetime.
const TOKEN_REFRESH_MARGIN_MS = 60_000;

/**
 * A read-only client for a OneRoster 1.2 rostering server. It reads only {@link ROSTER_COLLECTIONS}.
 *
 * Every request is HTTPS (the configuration admits nothing else, and a `Link` header pointing
 * anywhere but the same collection is refused), follows no redirects, and is retried by the
 * {@link RetryPolicy}. Failures are thrown as {@link RosterSyncError}s whose messages name the
 * collection and HTTP status only.
 */
export class OneRosterRestClient {
  readonly #config: OneRosterRestConfig;
  readonly #credentials: OneRosterClientCredentials;
  readonly #fetch: typeof fetch;
  readonly #retry: RetryPolicy;
  readonly #limits: OneRosterRestLimits;
  readonly #sleep: Sleep;
  readonly #clock: () => number;
  #token: { value: string; refreshAt: number } | undefined;
  #pendingToken: Promise<string> | undefined;

  constructor(options: OneRosterRestClientOptions) {
    const parsed = OneRosterRestConfig.safeParse(options.config);
    if (!parsed.success) {
      throw new RosterSyncError("internal-error", `OneRoster REST config is invalid: ${z.prettifyError(parsed.error)}`);
    }
    this.#config = parsed.data;
    this.#credentials = options.credentials;
    this.#fetch = options.fetch;
    this.#retry = options.retry ?? DEFAULT_RETRY_POLICY;
    this.#limits = options.limits ?? DEFAULT_REST_LIMITS;
    this.#sleep = options.sleep ?? realSleep;
    this.#clock = options.clock ?? Date.now;
  }

  /**
   * Reads every page of a collection, optionally filtered (such as
   * `dateLastModified>='2026-10-01T00:00:00.000Z'`), sorted by `sourcedId`.
   *
   * Paging follows the server's `Link: <…>; rel="next"` header when it sends one, else advances
   * `offset` until `X-Total-Count` records have arrived or, with neither header, until a page is
   * empty. A total that changes between pages, a record listed twice, or a final count that differs
   * from the total all mean the collection changed under the read, which fails it: a complete sync
   * that silently missed a record would deactivate it.
   */
  async list<C extends RosterCollection>(collection: C, query: { filter?: string } = {}): Promise<CollectionRead<C>> {
    if (!ROSTER_COLLECTIONS.includes(collection)) {
      throw new RosterSyncError("internal-error", `${String(collection)} is not a rostering collection EducateOS reads`);
    }
    const first = this.#collectionUrl(collection);
    first.searchParams.set("limit", String(this.#config.pageSize));
    first.searchParams.set("offset", "0");
    first.searchParams.set("sort", "sourcedId");
    first.searchParams.set("orderBy", "asc");
    if (query.filter !== undefined) first.searchParams.set("filter", query.filter);

    const items: unknown[] = [];
    const seenUrls = new Set<string>();
    const seenIds = new Set<string>();
    let total: number | undefined;
    let url: URL | undefined = first;
    while (url !== undefined) {
      if (seenUrls.has(url.href)) throw new RosterSyncError("inconsistent-paging", `${collection} paging repeated a page`);
      seenUrls.add(url.href);
      const { body, headers } = await this.#get(collection, url);
      const page = pageSchema(collection).safeParse(body);
      if (!page.success) throw new RosterSyncError("invalid-response", `${collection} page is not a OneRoster ${collection} list`);
      const pageItems = page.data[collection]!;

      const pageTotal = readTotal(collection, headers.get("x-total-count"));
      if (total === undefined) total = pageTotal;
      else if (pageTotal !== undefined && pageTotal !== total) {
        throw new RosterSyncError("inconsistent-paging", `${collection} total changed from ${total} to ${pageTotal} while paging`);
      }
      for (const item of pageItems) {
        const id = (item as { sourcedId?: unknown } | null)?.sourcedId;
        if (typeof id === "string") {
          if (seenIds.has(id)) throw new RosterSyncError("inconsistent-paging", `${collection} listed a record twice while paging`);
          seenIds.add(id);
        }
        items.push(item);
      }
      if (items.length > this.#limits.maxRecordsPerCollection) {
        throw new RosterSyncError("response-too-large", `${collection} has more than ${this.#limits.maxRecordsPerCollection} records`);
      }

      const next = nextLink(headers.get("link"));
      if (next !== undefined) url = this.#sameCollection(collection, next);
      else if (pageItems.length === 0) url = undefined;
      else if (total !== undefined && items.length >= total) url = undefined;
      else {
        url = new URL(first);
        url.searchParams.set("offset", String(items.length));
      }
    }
    if (total !== undefined && items.length !== total) {
      throw new RosterSyncError("inconsistent-paging", `${collection} returned ${items.length} records of the ${total} it reported`);
    }

    const schema: z.ZodType<RosterRecord<C>> = RECORD_SCHEMAS[collection] as never;
    const records: RosterRecord<C>[] = [];
    const issues: OneRosterIssue[] = [];
    items.forEach((item, index) => {
      const result = schema.safeParse(item);
      if (result.success) {
        records.push(result.data);
        return;
      }
      const sourcedId = (item as { sourcedId?: unknown } | null)?.sourcedId;
      for (const issue of result.error.issues.slice(0, 10)) {
        issues.push({
          severity: "error",
          file: COLLECTION_FILES[collection],
          row: index + 1,
          ...(typeof sourcedId === "string" && sourcedId.length <= 255 ? { sourcedId } : {}),
          column: issue.path.join("."),
          message: issue.message,
        });
      }
    });
    return { records, issues };
  }

  #collectionUrl(collection: RosterCollection): URL {
    const url = new URL(this.#config.baseUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}${ROSTERING_PATH}/${collection}`;
    url.search = "";
    url.hash = "";
    return url;
  }

  /** A `Link` target, admitted only when it is the same collection on the same origin. */
  #sameCollection(collection: RosterCollection, target: string): URL {
    const expected = this.#collectionUrl(collection);
    let url: URL;
    try {
      url = new URL(target, expected);
    } catch {
      throw new RosterSyncError("invalid-response", `${collection} sent a malformed Link header`);
    }
    if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
      throw new RosterSyncError("invalid-response", `${collection} sent a Link to another resource`);
    }
    return url;
  }

  /** One authenticated GET, refreshing the token once if the server rejects it. */
  async #get(collection: RosterCollection, url: URL): Promise<{ body: unknown; headers: Headers }> {
    let token = await this.#accessToken();
    let response = await this.#send(collection, () => this.#request(url, token));
    if (response.status === 401) {
      await discard(response);
      if (this.#token?.value === token) this.#token = undefined;
      token = await this.#accessToken();
      response = await this.#send(collection, () => this.#request(url, token));
    }
    if (!response.ok) {
      await discard(response);
      throw new RosterSyncError(failureCode(response.status), `GET ${collection} failed with HTTP ${response.status}`);
    }
    return { body: await readJson(collection, response, this.#limits.maxResponseBytes), headers: response.headers };
  }

  #request(url: URL, token: string): Promise<Response> {
    return this.#fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(this.#limits.requestTimeoutMs),
    });
  }

  /** Sends with retries, turning a request that never got a response into a sync error. */
  async #send(what: string, attempt: () => Promise<Response>): Promise<Response> {
    try {
      return await fetchWithRetry(attempt, this.#retry, this.#sleep, this.#clock);
    } catch {
      // The underlying error is dropped: its message is not ours to vouch for.
      throw new RosterSyncError("source-unavailable", `${what} request did not complete`);
    }
  }

  /** The cached token, or a new one. Concurrent callers share one token request. */
  #accessToken(): Promise<string> {
    if (this.#token !== undefined && this.#clock() < this.#token.refreshAt) return Promise.resolve(this.#token.value);
    this.#pendingToken ??= this.#requestToken().finally(() => {
      this.#pendingToken = undefined;
    });
    return this.#pendingToken;
  }

  async #requestToken(): Promise<string> {
    const issuedAt = this.#clock();
    // RFC 6749 section 2.3.1: the ID and secret are form-encoded, then sent as HTTP Basic.
    const { clientId, clientSecret } = this.#credentials;
    const basic = btoa(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`);
    const response = await this.#send("token", () =>
      this.#fetch(this.#config.tokenUrl, {
        method: "POST",
        headers: {
          authorization: `Basic ${basic}`,
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams({ grant_type: "client_credentials", scope: this.#config.scopes.join(" ") }).toString(),
        redirect: "error",
        signal: AbortSignal.timeout(this.#limits.requestTimeoutMs),
      })
    );
    if (!response.ok) {
      await discard(response);
      // 400 and 401 are how RFC 6749 section 5.2 reports a bad client or a refused scope.
      const code = response.status === 400 || response.status === 401 ? "auth-failed" : failureCode(response.status);
      throw new RosterSyncError(code, `token request failed with HTTP ${response.status}`);
    }
    const parsed = TokenResponse.safeParse(await readJson("token", response, MAX_TOKEN_RESPONSE_BYTES));
    if (!parsed.success) throw new RosterSyncError("invalid-response", "token response is not an OAuth bearer token");
    const lifetime = parsed.data.expires_in * 1000;
    this.#token = {
      value: parsed.data.access_token,
      refreshAt: issuedAt + lifetime - Math.min(TOKEN_REFRESH_MARGIN_MS, lifetime / 2),
    };
    return this.#token.value;
  }
}

function failureCode(status: number): SyncErrorCode {
  if (status === 401 || status === 403) return "auth-failed";
  if (status === 429) return "rate-limited";
  return "source-unavailable";
}

/** Reads a body as JSON, refusing it once it passes `maxBytes` without buffering the rest. */
async function readJson(what: string, response: Response, maxBytes: number): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await discard(response);
    throw new RosterSyncError("response-too-large", `${what} response is larger than ${maxBytes} bytes`);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body !== null) {
    const reader = response.body.getReader();
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new RosterSyncError("response-too-large", `${what} response is larger than ${maxBytes} bytes`);
      }
      chunks.push(chunk.value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new RosterSyncError("invalid-response", `${what} response is not JSON`);
  }
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

function readTotal(collection: RosterCollection, value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^\d{1,9}$/.test(value.trim())) throw new RosterSyncError("invalid-response", `${collection} sent a malformed X-Total-Count`);
  return Number(value.trim());
}

/** The target of the `rel="next"` entry of a `Link` header (RFC 8288), if there is one. */
export function nextLink(header: string | null): string | undefined {
  if (header === null) return undefined;
  for (const match of header.matchAll(/<([^>]*)>((?:\s*;\s*[^;,]+)*)/g)) {
    const params = match[2]!;
    const rel = /;\s*rel\s*=\s*(?:"([^"]*)"|([^\s;,]+))/i.exec(params);
    const relations = (rel?.[1] ?? rel?.[2] ?? "").toLowerCase().split(/\s+/);
    if (relations.includes("next")) return match[1];
  }
  return undefined;
}
