// A read-only client for the Clever Data API v3.1, built from Clever's docs on paging
// (https://dev.clever.com/docs/paging-and-limits), events (https://dev.clever.com/docs/events-api)
// and errors and rate limits (https://dev.clever.com/docs/error-messages). New for EducateOS; it
// follows the OneRoster REST client's rules: HTTPS only, no redirects, a size cap on every
// response, retries by policy, and error messages that name the collection and status only.
import { CleverRosterConnection, type SyncErrorCode } from "@educateos/contracts";
import { z } from "zod";
import { discard, readJson } from "../http.ts";
import { DEFAULT_RETRY_POLICY, fetchWithRetry, realSleep, retryAfterHint } from "../oneroster/rest/retry.ts";
import type { RetryPolicy, Sleep, WaitHint } from "../oneroster/rest/retry.ts";
import { RosterSyncError } from "../sync-run.ts";
import { CLEVER_COLLECTIONS, CleverEvent, CleverPage } from "./schemas.ts";
import type { CleverCollection } from "./schemas.ts";

/** The Data API every request goes to. It is fixed: a connection can name a district, never a host. */
export const CLEVER_API_BASE = "https://api.clever.com/v3.1";

/** The page size asked for when the connection names none. */
export const DEFAULT_CLEVER_PAGE_SIZE = 1000;

/** Limits on what a sync reads. Going over one fails the request. */
export interface CleverLimits {
  /** The largest response body accepted, in bytes. */
  maxResponseBytes: number;
  /** The most records accepted in one collection, or events in one delta. */
  maxRecordsPerCollection: number;
  /** How long one request may take before it is abandoned and retried. */
  requestTimeoutMs: number;
}

/** Limits generous enough for a large district, matching the OneRoster REST client's. */
export const DEFAULT_CLEVER_LIMITS: CleverLimits = {
  maxResponseBytes: 16 * 1024 * 1024,
  maxRecordsPerCollection: 500_000,
  requestTimeoutMs: 30_000,
};

/** Everything a {@link CleverDataClient} needs. */
export interface CleverDataClientOptions {
  /** Which district to read. */
  connection: CleverRosterConnection;
  /**
   * The district-app bearer token Clever issued for the district. A Worker secret; it is kept out
   * of every message and record.
   */
  token: string;
  /** The fetch every request goes through. */
  fetch: typeof fetch;
  /** The retry policy, when not {@link DEFAULT_RETRY_POLICY}. */
  retry?: RetryPolicy;
  /** The limits, when not {@link DEFAULT_CLEVER_LIMITS}. */
  limits?: CleverLimits;
  /** How to wait between attempts. Tests inject one that returns at once. */
  sleep?: Sleep;
  /** The time in milliseconds, for `Retry-After` dates and `X-RateLimit-Reset`. */
  clock?: () => number;
}

/** What a list or events read returned: every item's raw `data`, in the order Clever served them. */
export interface CleverRead {
  /** Each item's `data`, unvalidated: the caller validates it against its collection's schema. */
  items: unknown[];
}

/**
 * How long a Clever 429 asks to wait. Clever documents `X-RateLimit-Reset` (when the bucket refills,
 * in epoch seconds) rather than `Retry-After`; either is honoured, `Retry-After` first.
 */
export const cleverWaitHint: WaitHint = (response, now) => {
  const retryAfter = retryAfterHint(response, now);
  if (retryAfter !== undefined) return retryAfter;
  const reset = response.headers.get("x-ratelimit-reset")?.trim();
  if (reset === undefined || !/^\d{1,12}$/.test(reset)) return undefined;
  return Math.max(0, Number(reset) * 1000 - now);
};

/**
 * A read-only client for one district's Clever data, authorized by its district-app token. It
 * reads only {@link CLEVER_COLLECTIONS} and `/events`.
 *
 * Paging follows each page's `links` `next` entry, which must stay on the same collection; a page
 * served twice, or a record listed twice, means the collection changed under the read and fails
 * it, since a complete sync that silently missed a record would deactivate it.
 */
export class CleverDataClient {
  readonly #connection: CleverRosterConnection;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #retry: RetryPolicy;
  readonly #limits: CleverLimits;
  readonly #sleep: Sleep;
  readonly #clock: () => number;

  constructor(options: CleverDataClientOptions) {
    const parsed = CleverRosterConnection.safeParse(options.connection);
    if (!parsed.success) {
      throw new RosterSyncError("internal-error", `Clever connection is invalid: ${z.prettifyError(parsed.error)}`);
    }
    if (options.token === "") throw new RosterSyncError("auth-failed", "no Clever district token is configured");
    this.#connection = parsed.data;
    this.#token = options.token;
    this.#fetch = options.fetch;
    this.#retry = options.retry ?? DEFAULT_RETRY_POLICY;
    this.#limits = options.limits ?? DEFAULT_CLEVER_LIMITS;
    this.#sleep = options.sleep ?? realSleep;
    this.#clock = options.clock ?? Date.now;
  }

  /** The Clever district this client reads. */
  get districtId(): string {
    return this.#connection.districtId;
  }

  /** Reads every page of a collection. */
  async list(collection: CleverCollection): Promise<CleverRead> {
    if (!CLEVER_COLLECTIONS.includes(collection)) {
      throw new RosterSyncError("internal-error", `${String(collection)} is not a Clever collection EducateOS reads`);
    }
    const first = this.#url(collection);
    first.searchParams.set("limit", String(this.#pageSize()));
    return this.#readAll(collection, first, (item) => (item as { id?: unknown } | null)?.id);
  }

  /**
   * Reads every event after `after`, oldest first, or every event Clever still keeps when `after`
   * is undefined. Clever keeps events for a limited time (30 days, per its docs) and refuses a
   * cursor it no longer holds; that is reported as `no-baseline`, because only a complete sync can
   * recover from it.
   */
  async events(after: string | undefined): Promise<CleverRead> {
    const first = this.#url("events");
    first.searchParams.set("limit", String(this.#pageSize()));
    if (after !== undefined) first.searchParams.set("starting_after", after);
    return this.#readAll("events", first, (item) => CleverEvent.safeParse(item).data?.id, after !== undefined);
  }

  /**
   * The ID of the newest event, or undefined when the district has none. A complete sync reads it
   * before anything else, so the next delta starts from there and misses nothing that changed while
   * the collections were being read.
   */
  async latestEventId(): Promise<string | undefined> {
    const url = this.#url("events");
    url.searchParams.set("ending_before", "last");
    url.searchParams.set("limit", "1");
    const page = CleverPage.safeParse(await this.#get("events", url));
    if (!page.success) throw new RosterSyncError("invalid-response", "events page is not a Clever list");
    const [last] = page.data.data;
    if (last === undefined) return undefined;
    const event = CleverEvent.safeParse(last.data);
    if (!event.success) throw new RosterSyncError("invalid-response", "the newest event is not a Clever event");
    return event.data.id;
  }

  #pageSize(): number {
    return this.#connection.pageSize ?? DEFAULT_CLEVER_PAGE_SIZE;
  }

  #url(path: CleverCollection | "events"): URL {
    return new URL(`${CLEVER_API_BASE}/${path}`);
  }

  async #readAll(what: CleverCollection | "events", first: URL, idOf: (item: unknown) => unknown, cursorGiven = false): Promise<CleverRead> {
    const items: unknown[] = [];
    const seenUrls = new Set<string>();
    const seenIds = new Set<string>();
    let url: URL | undefined = first;
    while (url !== undefined) {
      if (seenUrls.has(url.href)) throw new RosterSyncError("inconsistent-paging", `${what} paging repeated a page`);
      seenUrls.add(url.href);
      const body = await this.#get(what, url, cursorGiven && url === first);
      const page = CleverPage.safeParse(body);
      if (!page.success) throw new RosterSyncError("invalid-response", `${what} page is not a Clever list`);
      for (const { data } of page.data.data) {
        const id = idOf(data);
        if (typeof id === "string") {
          if (seenIds.has(id)) throw new RosterSyncError("inconsistent-paging", `${what} listed a record twice while paging`);
          seenIds.add(id);
        }
        items.push(data);
      }
      if (items.length > this.#limits.maxRecordsPerCollection) {
        throw new RosterSyncError("response-too-large", `${what} has more than ${this.#limits.maxRecordsPerCollection} records`);
      }
      const next = page.data.links?.find((link) => link.rel === "next")?.uri;
      // A page with no records ends the read even if it links on, so a looping server cannot stall it.
      url = next === undefined || page.data.data.length === 0 ? undefined : this.#sameResource(what, first, next);
    }
    return { items };
  }

  /** A `next` link, admitted only when it is the same resource on the same origin. */
  #sameResource(what: string, first: URL, target: string): URL {
    let url: URL;
    try {
      url = new URL(target, first);
    } catch {
      throw new RosterSyncError("invalid-response", `${what} sent a malformed next link`);
    }
    if (url.origin !== first.origin || url.pathname !== first.pathname) {
      throw new RosterSyncError("invalid-response", `${what} sent a next link to another resource`);
    }
    return url;
  }

  /** One authenticated GET. `cursorRequest` marks the first page of an events read from a cursor. */
  async #get(what: string, url: URL, cursorRequest = false): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchWithRetry(
        () =>
          this.#fetch(url, {
            method: "GET",
            headers: { authorization: `Bearer ${this.#token}`, accept: "application/json" },
            redirect: "error",
            signal: AbortSignal.timeout(this.#limits.requestTimeoutMs),
          }),
        this.#retry,
        this.#sleep,
        this.#clock,
        cleverWaitHint,
      );
    } catch {
      // The underlying error is dropped: its message is not ours to vouch for.
      throw new RosterSyncError("source-unavailable", `${what} request did not complete`);
    }
    if (!response.ok) {
      await discard(response);
      // Clever's error bodies are undocumented, so only the status is read. A cursor Clever
      // refuses is one it no longer keeps (or never issued).
      if (cursorRequest && (response.status === 400 || response.status === 404)) {
        throw new RosterSyncError("no-baseline", "Clever no longer holds the events since the last sync; run a complete sync");
      }
      throw new RosterSyncError(failureCode(response.status), `GET ${what} failed with HTTP ${response.status}`);
    }
    return readJson(what, response, this.#limits.maxResponseBytes);
  }
}

function failureCode(status: number): SyncErrorCode {
  if (status === 401 || status === 403) return "auth-failed";
  if (status === 429) return "rate-limited";
  if (status >= 500) return "source-unavailable";
  return "invalid-response";
}
