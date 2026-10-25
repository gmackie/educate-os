import { describe, expect, it } from "vitest";
import { checkImportUrl, fetchForImport, type ImportFetch } from "../src/index.ts";
import { BIO_SCOPE, fakeWeb, html, LICENSED_PAGE, MORGAN, redirect, rejectsWith, studio } from "./helpers.ts";

describe("import URL checks", () => {
  it.each([
    ["http://open-lessons.example/cells", "not-https"],
    ["ftp://open-lessons.example/cells", "not-https"],
    ["file:///etc/passwd", "not-https"],
    ["https://teacher:hunter2@open-lessons.example/", "credentials-in-url"],
    ["https://token@open-lessons.example/", "credentials-in-url"],
    ["https://open-lessons.example:8443/", "non-default-port"],
    ["https://127.0.0.1/", "ip-literal"],
    ["https://169.254.169.254/latest/meta-data/", "ip-literal"],
    ["https://10.0.0.8/", "ip-literal"],
    ["https://8.8.8.8/", "ip-literal"],
    // Encodings the URL parser turns into dotted IPv4.
    ["https://2130706433/", "ip-literal"],
    ["https://0x7f.0.0.1/", "ip-literal"],
    ["https://0177.0.0.1/", "ip-literal"],
    ["https://127.1/", "ip-literal"],
    ["https://[::1]/", "ip-literal"],
    ["https://[::ffff:169.254.169.254]/", "ip-literal"],
    ["https://[fd00::1]/", "ip-literal"],
    ["https://localhost/", "private-host"],
    ["https://LOCALHOST./", "private-host"],
    ["https://app.localhost/", "private-host"],
    ["https://metadata.google.internal/computeMetadata/v1/", "private-host"],
    ["https://metadata.azure.com/", "private-host"],
    ["https://printer.local/", "private-host"],
    ["https://intranet/", "private-host"],
    ["https://router.home.arpa/", "private-host"],
    ["https://127.0.0.1.nip.io/", "private-host"],
    ["not a url", "malformed"],
  ])("refuses %s (%s)", (url, reason) => {
    expect(checkImportUrl(url)).toStrictEqual({ ok: false, reason });
  });

  it("accepts a public https URL", () => {
    expect(checkImportUrl("https://open-lessons.example/cells?unit=2").ok).toBe(true);
  });
});

const hang: ImportFetch = () => new Promise(() => {});

const OK = { maxRedirects: 3, maxBytes: 1024 * 1024, timeoutMs: 1000 };

describe("fetching for import", () => {
  it("re-checks every redirect hop and never requests a private target", async () => {
    for (const target of ["https://169.254.169.254/latest/meta-data/", "https://[::1]/admin", "http://open-lessons.example/", "https://metadata.google.internal/"]) {
      const web = fakeWeb({ "https://open-lessons.example/start": redirect(target) });
      await rejectsWith(fetchForImport("https://open-lessons.example/start", web, OK), "policy-violation");
      expect(web.requested).toStrictEqual(["https://open-lessons.example/start"]);
    }
  });

  it("refuses a relative redirect that resolves to a refused URL", async () => {
    const web = fakeWeb({ "https://open-lessons.example/start": redirect("//127.0.0.1/x") });
    await rejectsWith(fetchForImport("https://open-lessons.example/start", web, OK), "policy-violation");
    expect(web.requested).toHaveLength(1);
  });

  it("follows public redirects up to the limit, and no further", async () => {
    const chain = fakeWeb({
      "https://a.example/": redirect("https://b.example/"),
      "https://b.example/": redirect("/next", 301),
      "https://b.example/next": redirect("https://c.example/"),
      "https://c.example/": html(LICENSED_PAGE),
    });
    const fetched = await fetchForImport("https://a.example/", chain, OK);
    expect(fetched).toMatchObject({ finalUrl: "https://c.example/", contentType: "html" });
    expect(fetched.hops).toStrictEqual(["https://a.example/", "https://b.example/", "https://b.example/next", "https://c.example/"]);

    await rejectsWith(fetchForImport("https://a.example/", chain, { ...OK, maxRedirects: 2 }), "policy-violation");
  });

  it("asks fetch not to follow redirects itself", async () => {
    const inits: RequestInit[] = [];
    const fetch: ImportFetch = async (_url, init) => {
      inits.push(init);
      return html(LICENSED_PAGE)();
    };
    await fetchForImport("https://open-lessons.example/", fetch, OK);
    expect(inits[0]?.redirect).toBe("manual");
  });

  it("refuses a body over the size cap, whether or not it declares its length", async () => {
    const big = "<html><body>" + "a".repeat(2048) + "</body></html>";
    const declared = fakeWeb({ "https://a.example/": html(big) });
    await rejectsWith(fetchForImport("https://a.example/", declared, { ...OK, maxBytes: 1024 }), "policy-violation");

    const streamed: ImportFetch = async () =>
      new Response(new Blob([big]).stream(), { headers: { "content-type": "text/html" } });
    await rejectsWith(fetchForImport("https://a.example/", streamed, { ...OK, maxBytes: 1024 }), "policy-violation");
  });

  it("refuses content types outside the allowlist, and bodies that contradict their declared type", async () => {
    const web = fakeWeb({
      "https://a.example/app.js": () => new Response("alert(1)", { headers: { "content-type": "application/javascript" } }),
      "https://a.example/svg": () => new Response("<svg onload=alert(1)>", { headers: { "content-type": "image/svg+xml" } }),
      // A byte body gets no default content type.
      "https://a.example/none": () => new Response(new TextEncoder().encode("hello")),
      "https://a.example/fake.pdf": () => new Response("<html><body>not a pdf</body></html>", { headers: { "content-type": "application/pdf" } }),
    });
    for (const url of ["https://a.example/app.js", "https://a.example/svg", "https://a.example/none", "https://a.example/fake.pdf"]) {
      await rejectsWith(fetchForImport(url, web, OK), "policy-violation");
    }
  });

  it("times out a source that never answers, even if fetch ignores the abort signal", async () => {
    await rejectsWith(fetchForImport("https://slow.example/", hang, { ...OK, timeoutMs: 20 }), "unavailable");
  });

  it("reports an error status as unavailable", async () => {
    await rejectsWith(fetchForImport("https://a.example/", fakeWeb({}), OK), "unavailable");
  });
});

describe("URL import into the studio", () => {
  it("records nothing for a refused URL", async () => {
    const { studio: s, storage, web } = await studio({ routes: { "https://open-lessons.example/go": redirect("https://10.1.2.3/") } });
    await rejectsWith(s.submitUrl(MORGAN, { url: "https://open-lessons.example/go", targetScope: BIO_SCOPE }), "policy-violation");
    expect(await storage.listItems()).toStrictEqual([]);
    expect(web.requested).toStrictEqual(["https://open-lessons.example/go"]);
  });

  it("extracts the title, canonical URL, license evidence and language, and keeps the snapshot", async () => {
    const { studio: s, storage } = await studio();
    const item = await s.submitUrl(MORGAN, { url: "https://open-lessons.example/cells", targetScope: BIO_SCOPE });
    expect(item).toMatchObject({
      title: "Cell Structure & Function",
      canonicalUrl: "https://open-lessons.example/cells",
      lang: "en",
      license: { status: "recognized", license: { name: "CC BY 4.0" } },
      contentType: "html",
    });
    expect(item.snapshotDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(new TextDecoder().decode(await storage.getSnapshot(item.snapshotDigest))).toBe(LICENSED_PAGE);
  });

  it("ignores a canonical URL on another origin, which would claim another publisher's identity", async () => {
    const page = LICENSED_PAGE.replace("https://open-lessons.example/cells", "https://trusted-publisher.example/cells");
    const { studio: s } = await studio({ routes: { "https://open-lessons.example/cells": html(page) } });
    const item = await s.submitUrl(MORGAN, { url: "https://open-lessons.example/cells", targetScope: BIO_SCOPE });
    expect(item.canonicalUrl).toBeUndefined();
  });
});
