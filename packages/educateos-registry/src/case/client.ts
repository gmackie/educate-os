// Extracted from PlayTrek `packages/edtech/src/case/client.ts` and
// `packages/edtech/src/shared/retry.ts` at commit 7258e4347. Changes from the source:
// - The fetch function is injected, and there is no default base URL; both come from the caller.
// - The base URL must be https with no credentials, query or fragment. Redirects are refused, so a
//   response can never move the request (and its bearer token) to another origin or to http.
// - One deadline covers every attempt and every backoff, response bodies are read under a size
//   cap, and `Retry-After` can no longer delay a retry indefinitely.
// - Responses are validated against the CASE 1.1 schemas instead of cast, and error messages no
//   longer echo the remote response body.
// - Paths follow the CASE 1.1 REST binding: `/CFDocuments/{id}` and `/CFItems/{id}` return bare
//   objects, and an item's associations come from `/CFItemAssociations/{id}`.
// - Identifiers must be UUIDs, so an identifier such as `..` cannot change the request path.
import { EducateOsError } from "@educateos/contracts";
import type { z } from "zod";
import { RegistryIdentifier } from "../framework.ts";
import { type Adapted, adaptCaseDocumentSet, adaptCasePackage, type CaseAdapter } from "./adapter.ts";
import {
  CaseAssociationSet,
  CaseDocument,
  CaseDocumentSet,
  CaseItem,
  CasePackage,
} from "./wire.ts";

/** The fetch function the client sends requests through: the Workers `fetch`, or a test double. */
export type CaseFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Configuration for a {@link CaseClient}. */
export interface CaseClientOptions {
  /** The CASE service root, such as `https://case.example/ims/case/v1p1`. Must be https. */
  baseUrl: string;
  /** Sends each HTTP request. */
  fetch: CaseFetch;
  /** Sent as a bearer token when the CASE service requires authentication. */
  apiKey?: string;
  /** Deadline for one call, covering every attempt and backoff. Defaults to 30 seconds. */
  timeoutMs?: number;
  /** Largest response body accepted, in bytes. Defaults to 16 MiB. */
  maxResponseBytes?: number;
  /** Retry behavior for transient failures (408, 429, 5xx and network errors). */
  retry?: {
    /** Attempts in total, including the first. Defaults to 3. */
    maxAttempts?: number;
    /** Backoff before the second attempt, doubled each time after. Defaults to 1 second. */
    baseDelayMs?: number;
  };
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_RETRY_DELAY_MS = 30_000;
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Validates and normalizes a CASE service root: https only, no credentials, query or fragment, and
 * no trailing slash.
 *
 * @throws EducateOsError `validation-failed` if the URL is not acceptable.
 */
export function caseBaseUrl(raw: string): string {
  const url = URL.parse(raw);
  if (url === null || url.protocol !== "https:") {
    throw new EducateOsError("validation-failed", "CASE base URL must be an absolute https URL");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new EducateOsError("validation-failed", "CASE base URL must not contain credentials, a query or a fragment");
  }
  return url.href.replace(/\/+$/, "");
}

/**
 * A read-only client for a CASE 1.1 service (the IMS / 1EdTech Competencies and Academic Standards
 * Exchange). It returns CASE wire objects; `decodeCasePackage` turns a package into registry
 * records. It writes nothing anywhere.
 */
export class CaseClient {
  readonly #baseUrl: string;
  readonly #fetch: CaseFetch;
  readonly #apiKey: string | undefined;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #maxAttempts: number;
  readonly #baseDelayMs: number;

  /** @throws EducateOsError `validation-failed` if the base URL is not acceptable. */
  constructor(options: CaseClientOptions) {
    this.#baseUrl = caseBaseUrl(options.baseUrl);
    this.#fetch = options.fetch;
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.#maxAttempts = Math.max(1, options.retry?.maxAttempts ?? 3);
    this.#baseDelayMs = options.retry?.baseDelayMs ?? 1000;
  }

  /** Lists published frameworks: `GET /CFDocuments`. */
  async listDocuments(page: { limit?: number; offset?: number } = {}): Promise<CaseDocumentSet> {
    return this.#get(`/CFDocuments${pageQuery(page)}`, CaseDocumentSet);
  }

  /**
   * Lists published frameworks from a publisher with known deviations, normalized by `adapter`
   * (ADR-0011). Everything the adapter does not name must still be CASE 1.1.
   */
  async listAdaptedDocuments(adapter: CaseAdapter, page: { limit?: number; offset?: number } = {}): Promise<Adapted<CaseDocumentSet>> {
    return this.#getWith(`/CFDocuments${pageQuery(page)}`, (body) => adaptCaseDocumentSet(body, adapter));
  }

  /** Fetches one framework document: `GET /CFDocuments/{id}`. */
  async getDocument(identifier: string): Promise<CaseDocument> {
    return this.#get(`/CFDocuments/${pathIdentifier(identifier)}`, CaseDocument);
  }

  /**
   * Fetches a package from a publisher with known deviations, normalized by `adapter`. Pass the
   * returned adaptations to `decodeCasePackage`, which records them on each record's provenance.
   */
  async getAdaptedPackage(adapter: CaseAdapter, identifier: string): Promise<Adapted<CasePackage>> {
    return this.#getWith(`/CFPackages/${pathIdentifier(identifier)}`, (body) => adaptCasePackage(body, adapter));
  }

  /** Fetches a framework's full package: `GET /CFPackages/{id}`. */
  async getPackage(identifier: string): Promise<CasePackage> {
    return this.#get(`/CFPackages/${pathIdentifier(identifier)}`, CasePackage);
  }

  /** Fetches one item: `GET /CFItems/{id}`. */
  async getItem(identifier: string): Promise<CaseItem> {
    return this.#get(`/CFItems/${pathIdentifier(identifier)}`, CaseItem);
  }

  /** Fetches an item and every association it takes part in: `GET /CFItemAssociations/{id}`. */
  async getItemAssociations(identifier: string): Promise<CaseAssociationSet> {
    return this.#get(`/CFItemAssociations/${pathIdentifier(identifier)}`, CaseAssociationSet);
  }

  async #get<T extends z.ZodType>(path: string, schema: T): Promise<z.infer<T>> {
    return this.#getWith(path, (body) => {
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        const paths = parsed.error.issues.slice(0, 5).map((issue) => issue.path.join(".") || "(root)");
        throw new EducateOsError("validation-failed", `CASE response does not match CASE 1.1 at ${paths.join(", ")}`);
      }
      return parsed.data;
    });
  }

  /** Fetches `path` and hands its JSON body to `read`, which validates it. */
  async #getWith<T>(path: string, read: (body: unknown) => T): Promise<T> {
    const url = `${this.#baseUrl}${path}`;
    const signal = AbortSignal.timeout(this.#timeoutMs);
    let text: string;
    try {
      const response = await this.#send(url, signal);
      if (response.status === 404) {
        await response.body?.cancel();
        throw new EducateOsError("not-found", `CASE service has no resource at ${path}`);
      }
      if (!response.ok) {
        await response.body?.cancel();
        const detail = response.status >= 300 && response.status < 400 ? " (redirects are not followed)" : "";
        throw new EducateOsError("unavailable", `CASE service returned HTTP ${response.status}${detail}`);
      }
      text = await readCapped(response, this.#maxResponseBytes);
    } catch (error) {
      if (error instanceof EducateOsError) throw error;
      if (signal.aborted) {
        throw new EducateOsError("unavailable", `CASE request timed out after ${this.#timeoutMs} ms`);
      }
      throw new EducateOsError("unavailable", "CASE request failed");
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new EducateOsError("validation-failed", "CASE response is not JSON");
    }
    return read(body);
  }

  /** Sends the request, retrying transient failures until the attempts or the deadline run out. */
  async #send(url: string, signal: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.#apiKey !== undefined) headers["Authorization"] = `Bearer ${this.#apiKey}`;

    for (let attempt = 1; ; attempt++) {
      const lastAttempt = attempt >= this.#maxAttempts;
      let response: Response;
      try {
        response = await this.#fetch(url, { method: "GET", headers, redirect: "manual", signal });
      } catch (error) {
        if (lastAttempt || signal.aborted) throw error;
        await sleep(this.#backoff(attempt), signal);
        continue;
      }
      if (response.ok || !RETRYABLE_STATUSES.has(response.status) || lastAttempt) return response;

      const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
      await response.body?.cancel();
      await sleep(Math.min(retryAfter ?? this.#backoff(attempt), MAX_RETRY_DELAY_MS), signal);
    }
  }

  #backoff(attempt: number): number {
    return Math.min(this.#baseDelayMs * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
  }
}

function pageQuery(page: { limit?: number; offset?: number }): string {
  const params = new URLSearchParams();
  if (page.limit !== undefined) params.set("limit", String(page.limit));
  if (page.offset !== undefined) params.set("offset", String(page.offset));
  return params.size > 0 ? `?${params}` : "";
}

/** Encodes an identifier for a request path, refusing anything that is not a UUID. */
function pathIdentifier(identifier: string): string {
  if (!RegistryIdentifier.safeParse(identifier).success) {
    throw new EducateOsError("validation-failed", "CASE identifiers must be UUIDs");
  }
  return encodeURIComponent(identifier);
}

/** Reads a body as UTF-8, failing as soon as it exceeds `maxBytes`, whatever `Content-Length` says. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const tooLarge = () => new EducateOsError("validation-failed", `CASE response exceeds ${maxBytes} bytes`);
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (declared > maxBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new EducateOsError("validation-failed", "CASE response is not valid UTF-8");
  }
}

/** The delay a `Retry-After` header asks for, in milliseconds, or undefined if absent or unreadable. */
function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Waits `ms`, or rejects as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
