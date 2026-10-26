// What every fake shares: request recording, the fault engine, and the adapters that turn a
// handler into a `fetch` or route one `fetch` across several fakes.
import type { ActiveFault, Clock, FaultMatch, FaultSpec, FakeHandler, ProviderFake, RecordedRequest } from "./types.ts";

/** Whether `request` is one `match` names. */
export function matches(match: FaultMatch | undefined, request: Request): boolean {
  if (match === undefined) return true;
  if (match.method !== undefined && match.method.toUpperCase() !== request.method.toUpperCase()) return false;
  if (match.path !== undefined) {
    const path = new URL(request.url).pathname;
    if (typeof match.path === "string") {
      if (!path.includes(match.path)) return false;
    } else {
      // A `g` or `y` pattern remembers where it last matched; start each test afresh.
      match.path.lastIndex = 0;
      if (!match.path.test(path)) return false;
    }
  }
  return true;
}

/** A `fetch` that serves `handle`, building the `Request` the way the platform's `fetch` would. */
export function toFetch(handle: FakeHandler): typeof globalThis.fetch {
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => handle(new Request(input, init));
  return fake as typeof globalThis.fetch;
}

/** A `fetch` that sends each request to the fake serving its origin. Others fail as unreachable. */
export function routeFetch(routes: Readonly<Record<string, ProviderFake | FakeHandler>>): typeof globalThis.fetch {
  const byOrigin = new Map<string, FakeHandler>();
  for (const [key, fake] of Object.entries(routes)) {
    const origin = new URL(key).origin;
    // Two fakes on one origin (Clever's SSO userinfo and its Data API share api.clever.com) need a
    // handler that routes by path; silently keeping one would misroute the other's requests.
    if (byOrigin.has(origin)) throw new Error(`routeFetch: two fakes serve ${origin}; route that origin by path in one handler`);
    byOrigin.set(origin, typeof fake === "function" ? fake : fake.handle);
  }
  return toFetch(async (request) => {
    const handle = byOrigin.get(new URL(request.url).origin);
    if (handle === undefined) throw new TypeError(`fetch failed: no fake serves ${new URL(request.url).origin}`);
    return handle(request);
  });
}

/** Options every fake takes. */
export interface FakeOptions {
  /** The clock for token expiry, timestamps and `Retry-After`. Defaults to `Date.now`. */
  readonly now?: Clock;
  /**
   * The most requests {@link Fake.requests} keeps; older ones are dropped. Defaults to 10,000,
   * which bounds a long-running fake (a demo Worker). Bodies and headers, client secrets
   * included, are held in memory, so never expose `requests` from a deployed fake.
   */
  readonly maxRecordedRequests?: number;
}

/**
 * The base of every fake. A subclass serves requests in {@link serve}, renders its vendor's error
 * bodies in {@link errorResponse}, and honours the data faults: it calls {@link takeMalformed} when
 * building a list response, and applies `large-removal` in {@link removeLargeShare}.
 */
export abstract class Fake implements ProviderFake {
  readonly requests: RecordedRequest[] = [];
  readonly now: Clock;
  readonly #faults: ActiveFault[] = [];
  readonly #maxRecorded: number;

  constructor(options: FakeOptions = {}) {
    this.now = options.now ?? Date.now;
    this.#maxRecorded = options.maxRecordedRequests ?? 10_000;
  }

  readonly handle: FakeHandler = async (request) => {
    const body = await request.clone().text();
    this.requests.push({ method: request.method, url: new URL(request.url), headers: new Headers(request.headers), body });
    if (this.requests.length > this.#maxRecorded) this.requests.splice(0, this.requests.length - this.#maxRecorded);
    for (const fault of this.#faults) {
      if (fault.remaining <= 0 || !matches("match" in fault ? fault.match : undefined, request)) continue;
      if (fault.kind === "network-error") {
        fault.remaining -= 1;
        throw new TypeError("fetch failed");
      }
      if (fault.kind === "outage") {
        fault.remaining -= 1;
        return this.errorResponse(fault.status ?? 503, "outage", request);
      }
      if (fault.kind === "rate-limit") {
        fault.remaining -= 1;
        const response = this.errorResponse(429, "rate-limit", request);
        response.headers.set("retry-after", String(fault.retryAfterSeconds));
        return response;
      }
    }
    return this.serve(request, body);
  };

  readonly fetch: typeof globalThis.fetch = toFetch((request) => this.handle(request));

  inject(fault: FaultSpec): () => void {
    if (fault.kind === "large-removal") {
      this.removeLargeShare(fault.fraction);
      return () => {};
    }
    const active: ActiveFault = { ...fault, remaining: fault.times ?? Number.POSITIVE_INFINITY };
    this.#faults.push(active);
    return () => {
      const index = this.#faults.indexOf(active);
      if (index !== -1) this.#faults.splice(index, 1);
    };
  }

  clearFaults(): void {
    this.#faults.length = 0;
  }

  /** The requests whose path contains `path`. */
  requestsTo(path: string): RecordedRequest[] {
    return this.requests.filter((r) => r.url.pathname.includes(path));
  }

  /** Whether a `malformed-record` fault applies to this list request, consuming one use of it. */
  protected takeMalformed(request: Request): boolean {
    const fault = this.#faults.find((f) => f.kind === "malformed-record" && f.remaining > 0 && matches(f.match, request));
    if (fault === undefined) return false;
    fault.remaining -= 1;
    return true;
  }

  /** Serves a request no transport fault intercepted. `body` is its text, already read. */
  protected abstract serve(request: Request, body: string): Promise<Response>;

  /** The vendor's error response for an outage (5xx) or a rate limit (429). */
  protected abstract errorResponse(status: number, reason: "outage" | "rate-limit", request: Request): Response;

  /** Applies a `large-removal` fault: removes `fraction` of the students and their enrollments. */
  protected abstract removeLargeShare(fraction: number): void;
}

/** The bearer token of a request, if it has one. */
export function bearer(request: Request): string | undefined {
  return /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
}

/** The client ID and secret of an HTTP Basic header, form-decoded as RFC 6749 §2.3.1 requires. */
export function basicCredentials(request: Request): { clientId: string; clientSecret: string } | undefined {
  const encoded = /^Basic\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (encoded === undefined) return undefined;
  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    return undefined;
  }
  const colon = decoded.indexOf(":");
  if (colon === -1) return undefined;
  try {
    return { clientId: decodeURIComponent(decoded.slice(0, colon)), clientSecret: decodeURIComponent(decoded.slice(colon + 1)) };
  } catch {
    return undefined;
  }
}

/** Issues opaque access tokens and remembers what each grants until it expires. */
export class TokenIssuer<Grant> {
  readonly #tokens = new Map<string, { grant: Grant; expiresAt: number }>();
  readonly #prefix: string;
  readonly #now: Clock;
  #issued = 0;

  constructor(prefix: string, now: Clock) {
    this.#prefix = prefix;
    this.#now = now;
  }

  /** How many tokens have been issued. */
  get issued(): number {
    return this.#issued;
  }

  issue(grant: Grant, lifetimeSeconds: number): string {
    this.#issued += 1;
    // Forget expired tokens, so a fake that runs for days holds only live ones.
    for (const [old, { expiresAt }] of this.#tokens) if (expiresAt <= this.#now()) this.#tokens.delete(old);
    const token = `${this.#prefix}${this.#issued}${crypto.randomUUID().replaceAll("-", "")}`;
    this.#tokens.set(token, { grant, expiresAt: this.#now() + lifetimeSeconds * 1000 });
    return token;
  }

  /** The grant of a live token, or undefined for an unknown, revoked or expired one. */
  lookup(token: string | undefined): Grant | undefined {
    if (token === undefined) return undefined;
    const found = this.#tokens.get(token);
    return found === undefined || found.expiresAt <= this.#now() ? undefined : found.grant;
  }

  /** Accepts an existing token, such as one a caller configured, until `expiresAt`. */
  register(token: string, grant: Grant, expiresAt = Number.POSITIVE_INFINITY): void {
    this.#tokens.set(token, { grant, expiresAt });
  }

  revokeAll(): void {
    this.#tokens.clear();
  }
}

/**
 * A path's `/`-separated segments, percent-decoded, or undefined when one is malformed (such as a
 * lone `%E0`), so a fake answers 404 rather than throwing a `URIError` out of its handler.
 */
export function decodeSegments(path: string): string[] | undefined {
  try {
    return path.split("/").map(decodeURIComponent);
  } catch {
    return undefined;
  }
}

/** Reads a form body, as OAuth token endpoints take. */
export function formOf(body: string): URLSearchParams {
  return new URLSearchParams(body);
}
