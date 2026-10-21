// The redirect loop is adapted from PlayTrek `packages/api/src/jobs/interest-fact-investigation.ts`
// (the manual-redirect loop in the source retriever) at commit 7258e4347: every hop is re-checked
// before it is requested. Size caps, the content-type allowlist and the timeout are SchoolOS's own.
import { SchoolOsError } from "@schoolos/contracts";
import { type ContentType, declaredContentType, resolveContentType } from "./sniff.ts";
import { checkImportUrl } from "./url-guard.ts";

/** The fetch the importer sends requests through. Injected so tests and Workers supply their own. */
export type ImportFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Limits on one URL import. */
export interface UrlImportLimits {
  /** The most redirects followed before giving up. */
  maxRedirects: number;
  /** The largest body accepted, in bytes. */
  maxBytes: number;
  /** How long the whole import, redirects and body included, may take. */
  timeoutMs: number;
}

/** The limits used unless a district sets its own. */
export const DEFAULT_URL_IMPORT_LIMITS: UrlImportLimits = { maxRedirects: 3, maxBytes: 5 * 1024 * 1024, timeoutMs: 10_000 };

/** What a URL import retrieved. */
export interface FetchedSource {
  /** The URL the body was finally served from, after redirects. */
  finalUrl: string;
  /** Every URL requested, in order, starting with the submitted one. */
  hops: string[];
  contentType: ContentType;
  bytes: Uint8Array;
}

const refuse = (message: string) => new SchoolOsError("policy-violation", message);

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw refuse(`the source is larger than ${maxBytes} bytes`);
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw refuse(`the source is larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function retrieve(url: string, fetch: ImportFetch, limits: UrlImportLimits, signal: AbortSignal): Promise<FetchedSource> {
  const hops: string[] = [];
  let current = url;
  for (let redirects = 0; ; redirects++) {
    const checked = checkImportUrl(current);
    if (!checked.ok) {
      throw refuse(hops.length === 0 ? `the URL was refused (${checked.reason})` : `a redirect was refused (${checked.reason})`);
    }
    current = checked.url.href;
    hops.push(current);
    let response: Response;
    try {
      response = await fetch(current, {
        method: "GET",
        redirect: "manual",
        headers: { accept: "text/html,application/xhtml+xml,text/plain,application/pdf,image/png,image/jpeg" },
        signal,
      });
    } catch (error) {
      // A fetch that refuses on policy grounds (the pinned egress fetch's DNS check) says so.
      if (error instanceof SchoolOsError) throw error;
      throw new SchoolOsError("unavailable", "the source could not be reached");
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (location === null || !URL.canParse(location, current)) throw refuse("a redirect had no usable location");
      if (redirects >= limits.maxRedirects) throw refuse(`the source redirected more than ${limits.maxRedirects} times`);
      current = new URL(location, current).href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new SchoolOsError("unavailable", `the source answered ${response.status}`);
    }
    const declared = declaredContentType(response.headers.get("content-type") ?? "");
    if (declared === undefined) {
      await response.body?.cancel();
      throw refuse("the source's content type is not accepted");
    }
    const bytes = await readCapped(response, limits.maxBytes);
    const contentType = resolveContentType(declared, bytes);
    if (contentType === undefined) throw refuse("the source's content does not match its declared type");
    return { finalUrl: current, hops, contentType, bytes };
  }
}

/**
 * Fetches a source for import. Every hop, the submitted URL and each redirect target, passes
 * {@link checkImportUrl} before it is requested, so a public page cannot redirect the importer
 * to a private or metadata address. Redirects are followed by hand, never by `fetch`.
 *
 * @throws SchoolOsError `policy-violation` for a refused URL or redirect, too many redirects, an
 *   oversized body, or a content type outside the allowlist or contradicted by the body's magic
 *   bytes; `unavailable` for an error status or a timeout.
 */
export async function fetchForImport(url: string, fetch: ImportFetch, limits: UrlImportLimits = DEFAULT_URL_IMPORT_LIMITS): Promise<FetchedSource> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The race also bounds a fetch implementation that ignores its abort signal.
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SchoolOsError("unavailable", `the source did not respond within ${limits.timeoutMs} ms`));
    }, limits.timeoutMs);
  });
  try {
    return await Promise.race([retrieve(url, fetch, limits, controller.signal), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
