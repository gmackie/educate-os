import { EducateOsError } from "@educateos/contracts";
import { describe, expect, it } from "vitest";
import { CaseClient, type CaseFetch, type CaseClientOptions, decodeCasePackage } from "../src/index.ts";
import earthScience from "./fixtures/case-1.1-synthetic-earth-science.json" with { type: "json" };

const BASE = "https://case.registry.example/ims/case/v1p1";
const ID = earthScience.CFDocument.identifier;

interface Call {
  url: string;
  init: RequestInit;
}

/** A fetch double that answers each call with the next responder and records what it was asked. */
function fakeFetch(...responders: Array<(call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetch: CaseFetch = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    const responder = responders[Math.min(calls.length, responders.length) - 1];
    if (!responder) throw new Error("unexpected request");
    return responder(call);
  };
  return { fetch, calls };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { ...init, headers: { "content-type": "application/json", ...init.headers } });

const client = (fetch: CaseFetch, options: Partial<CaseClientOptions> = {}) =>
  new CaseClient({ baseUrl: BASE, fetch, retry: { baseDelayMs: 0 }, ...options });

/** The EducateOS error code a promise rejects with. */
async function errorCode(promise: Promise<unknown>): Promise<string> {
  const error: unknown = await promise.then(() => undefined, (e: unknown) => e);
  if (!(error instanceof EducateOsError)) throw new Error(`expected a EducateOsError, got ${String(error)}`);
  return error.code;
}

describe("CASE client", () => {
  it("fetches a package through the injected fetch and returns validated CASE that decodes", async () => {
    const { fetch, calls } = fakeFetch(() => json(earthScience));
    const pkg = await client(fetch, { apiKey: "test-key" }).getPackage(ID);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/CFPackages/${ID}`);
    expect(calls[0]!.init.redirect).toBe("manual");
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer test-key");
    expect(pkg).toStrictEqual(earthScience);
    expect(decodeCasePackage(pkg, {
      source: "official",
      sourceUri: calls[0]!.url,
      retrievedAt: "2026-10-01T00:00:00Z",
      sourceRevision: pkg.CFDocument.lastChangeDateTime,
    }).nodes).toHaveLength(earthScience.CFItems.length);
  });

  it("uses the CASE 1.1 paths for documents, items and item associations", async () => {
    const item = earthScience.CFItems[0]!;
    const { fetch, calls } = fakeFetch(
      () => json({ CFDocuments: [earthScience.CFDocument] }),
      () => json(item),
      () => json({ CFItem: item, CFAssociations: earthScience.CFAssociations.slice(0, 1) }),
    );
    const case11 = client(fetch);
    await case11.listDocuments({ limit: 10, offset: 20 });
    await case11.getItem(item.identifier);
    await case11.getItemAssociations(item.identifier);
    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/CFDocuments?limit=10&offset=20`,
      `${BASE}/CFItems/${item.identifier}`,
      `${BASE}/CFItemAssociations/${item.identifier}`,
    ]);
  });

  it("accepts only an https base URL with no credentials, query or fragment", () => {
    const { fetch } = fakeFetch();
    for (const baseUrl of [
      "http://case.registry.example/ims/case/v1p1",
      "file:///etc/case",
      "https://user:secret@case.registry.example/v1p1",
      "https://case.registry.example/v1p1?token=x",
      "https://case.registry.example/v1p1#x",
      "case.registry.example",
    ]) {
      expect(() => new CaseClient({ baseUrl, fetch }), baseUrl).toThrow(EducateOsError);
    }
  });

  it("refuses identifiers that could change the request path", async () => {
    const { fetch, calls } = fakeFetch(() => json(earthScience));
    for (const identifier of ["..", "../CFDocuments", "a/b", ""]) {
      expect(await errorCode(client(fetch).getPackage(identifier)), identifier).toBe("validation-failed");
    }
    expect(calls).toHaveLength(0);
  });

  it("does not follow redirects", async () => {
    const { fetch, calls } = fakeFetch(() =>
      new Response(null, { status: 302, headers: { location: "http://elsewhere.example/" } })
    );
    expect(await errorCode(client(fetch).getPackage(ID))).toBe("unavailable");
    expect(calls).toHaveLength(1);
  });

  it("rejects a body over the size cap, whether or not Content-Length declares it", async () => {
    const body = JSON.stringify(earthScience);
    const declared = fakeFetch(() => new Response(body, { headers: { "content-length": String(body.length) } }));
    expect(await errorCode(client(declared.fetch, { maxResponseBytes: 1024 }).getPackage(ID))).toBe("validation-failed");

    const chunk = new TextEncoder().encode("[".repeat(512));
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const undeclared = fakeFetch(() => new Response(endless));
    expect(await errorCode(client(undeclared.fetch, { maxResponseBytes: 4096 }).getPackage(ID))).toBe("validation-failed");
    expect(sent).toBeLessThan(16 * 1024);
  });

  it("times out a request that never answers", async () => {
    const { fetch } = fakeFetch(({ init }) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })
    );
    const started = Date.now();
    expect(await errorCode(client(fetch, { timeoutMs: 50 }).getPackage(ID))).toBe("unavailable");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("lets the deadline cut short a long Retry-After", async () => {
    const { fetch, calls } = fakeFetch(() => json({}, { status: 503, headers: { "retry-after": "3600" } }));
    const started = Date.now();
    expect(await errorCode(client(fetch, { timeoutMs: 50 }).getPackage(ID))).toBe("unavailable");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(calls).toHaveLength(1);
  });

  it("retries transient failures and then succeeds", async () => {
    const { fetch, calls } = fakeFetch(
      () => {
        throw new TypeError("network down");
      },
      () => json({}, { status: 503 }),
      () => json(earthScience),
    );
    await expect(client(fetch).getPackage(ID)).resolves.toStrictEqual(earthScience);
    expect(calls).toHaveLength(3);
  });

  it("does not retry a missing resource, and reports it as not found", async () => {
    const { fetch, calls } = fakeFetch(() => json({ imsx_codeMajor: "failure" }, { status: 404 }));
    expect(await errorCode(client(fetch).getPackage(ID))).toBe("not-found");
    expect(calls).toHaveLength(1);
  });

  it("rejects a response that is not JSON or not CASE 1.1, without echoing it", async () => {
    const notJson = fakeFetch(() => new Response("<html>secret-page</html>"));
    expect(await errorCode(client(notJson.fetch).getPackage(ID))).toBe("validation-failed");

    const wrongShape = fakeFetch(() => json({ ...earthScience, CFDocument: { title: "secret-title" } }));
    const error: unknown = await client(wrongShape.fetch).getPackage(ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EducateOsError);
    expect((error as EducateOsError).message).not.toContain("secret-title");
  });
});
