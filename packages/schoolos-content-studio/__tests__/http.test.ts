import { describe, expect, it } from "vitest";
import { createContentStudioHandler, type StudioSubject } from "../src/index.ts";
import { BIO_SCOPE, MORGAN, RIVERA, studio } from "./helpers.ts";

const BASE = "https://studio.northfield.example";

/** A handler whose subject comes from a test header, standing in for a verified Access token. */
async function handler() {
  const { studio: s, catalog } = await studio({ scanner: "none" });
  const subjects: Record<string, StudioSubject> = { morgan: MORGAN, rivera: RIVERA };
  const handle = createContentStudioHandler({
    studio: s,
    resolveSubject: async (request) => subjects[request.headers.get("x-test-subject") ?? ""],
  });
  const call = (as: string | undefined, method: string, path: string, body?: unknown) =>
    handle(new Request(`${BASE}${path}`, {
      method,
      headers: { ...(as === undefined ? {} : { "x-test-subject": as }), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
  return { handle, call, catalog };
}

describe("Content Studio HTTP API", () => {
  it("runs submit, queue, report, approve and releases over HTTP", async () => {
    const { call } = await handler();
    const submitted = await call("morgan", "POST", "/imports/url", { url: "https://open-lessons.example/cells", targetScope: BIO_SCOPE });
    expect(submitted.status).toBe(201);
    const item = (await submitted.json()) as { id: string };

    const queue = await call("morgan", "GET", `/queue?scope=${encodeURIComponent(JSON.stringify(BIO_SCOPE))}`);
    expect(((await queue.json()) as { itemId: string }[]).map((e) => e.itemId)).toStrictEqual([item.id]);

    expect((await call("morgan", "GET", `/items/${item.id}/report`)).status).toBe(200);
    const approved = await call("morgan", "POST", `/items/${item.id}/approve`, { alignments: [] });
    expect(approved.status).toBe(201);

    const releases = await call("morgan", "GET", `/releases?scope=${encodeURIComponent(JSON.stringify(BIO_SCOPE))}`);
    expect(((await releases.json()) as unknown[]).length).toBe(1);
  });

  it("accepts multipart uploads", async () => {
    const { handle } = await handler();
    const form = new FormData();
    form.set("file", new Blob(["Cell notes"]), "notes.txt");
    form.set("metadata", JSON.stringify({ fileName: "notes.txt", mediaType: "text/plain", targetScope: BIO_SCOPE }));
    const response = await handle(new Request(`${BASE}/imports/upload`, { method: "POST", headers: { "x-test-subject": "morgan" }, body: form }));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ contentType: "text", state: "reviewed" });
  });

  it("requires a verified subject and ignores any principal named in the body", async () => {
    const { call } = await handler();
    const anonymous = await call(undefined, "POST", "/imports/url", { url: "https://open-lessons.example/cells", targetScope: BIO_SCOPE });
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ code: "unauthenticated" });

    // A body claiming to be Morgan is refused as an unknown field, and Rivera stays Rivera.
    const claimed = await call("rivera", "POST", "/imports/url", { url: "https://open-lessons.example/cells", targetScope: BIO_SCOPE, principalId: MORGAN.principalId });
    expect(claimed.status).toBe(400);
    const asRivera = await call("rivera", "POST", "/imports/url", { url: "https://open-lessons.example/cells", targetScope: BIO_SCOPE });
    expect(asRivera.status).toBe(403);
  });

  it("maps refusals to their status codes", async () => {
    const { call } = await handler();
    expect((await call("morgan", "POST", "/imports/url", { url: "https://127.0.0.1/", targetScope: BIO_SCOPE })).status).toBe(422);
    expect((await call("morgan", "GET", "/items/cit_missing/report")).status).toBe(404);
    expect((await call("morgan", "GET", "/queue?scope=not-json")).status).toBe(400);
    expect((await call("morgan", "GET", "/nowhere")).status).toBe(404);
    const malformed = await call("morgan", "POST", "/imports/url");
    expect(malformed.status).toBe(400);
  });
});
