// Extracted from PlayTrek packages/edtech/src/shared/retry.ts (`fetchWithRetry`) at commit
// 7258e4347. PlayTrek waited however long a `Retry-After` header asked, called the global `fetch`,
// left the bodies of retried responses unread, and could only resend the same `RequestInit`. Here
// the wait is capped, the caller supplies each attempt, and a discarded response is cancelled.

/** How a request is retried after a transient failure. */
export interface RetryPolicy {
  /** The most attempts made, counting the first. */
  maxAttempts: number;
  /** The wait before the second attempt. Each later wait doubles, up to `maxDelayMs`. */
  baseDelayMs: number;
  /** The longest wait between attempts the backoff reaches. */
  maxDelayMs: number;
  /** The longest wait a `Retry-After` header can ask for; a longer one is cut to this. */
  maxRetryAfterMs: number;
}

/** A policy for a sync that runs in the background: four attempts within about a minute. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  maxRetryAfterMs: 30_000,
};

/** HTTP statuses worth another attempt: timeouts, rate limits and server errors. */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

/** Waits a number of milliseconds. Injected so tests run without real delays. */
export type Sleep = (ms: number) => Promise<void>;

/** Waits with a timer. */
export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Makes `attempt` until it returns a response that is not {@link RETRYABLE_STATUSES retryable} or
 * the policy runs out, and returns the last response. A thrown error (a network failure or a
 * timeout) is retried the same way and rethrown on the last attempt.
 *
 * `attempt` is called afresh each time, so each request gets its own body and timeout signal.
 */
export async function fetchWithRetry(
  attempt: () => Promise<Response>,
  policy: RetryPolicy,
  sleep: Sleep,
  now: () => number = Date.now,
): Promise<Response> {
  for (let n = 1; ; n++) {
    const backoff = Math.min(policy.baseDelayMs * 2 ** (n - 1), policy.maxDelayMs);
    let response: Response;
    try {
      response = await attempt();
    } catch (error) {
      if (n >= policy.maxAttempts) throw error;
      await sleep(backoff);
      continue;
    }
    if (!RETRYABLE_STATUSES.has(response.status) || n >= policy.maxAttempts) return response;
    const retryAfter = parseRetryAfter(response.headers.get("retry-after"), now());
    // The body is never read; cancelling it frees the connection.
    await response.body?.cancel().catch(() => {});
    await sleep(retryAfter === undefined ? backoff : Math.min(retryAfter, policy.maxRetryAfterMs));
  }
}

/**
 * Reads a `Retry-After` header (RFC 9110 section 10.2.3) as a wait in milliseconds: a whole number
 * of seconds, or an HTTP date, which counts from `now`. Returns undefined when the header is absent
 * or malformed, so that the caller falls back to its backoff.
 */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (value === null) return undefined;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  // An HTTP date always names its weekday, which keeps bare numbers such as `-1` or `1.5` out.
  if (!/^[A-Za-z]{3},/.test(text)) return undefined;
  const date = Date.parse(text);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
