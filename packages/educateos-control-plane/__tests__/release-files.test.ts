// The read-only release mirror under /releases/ (SCHO-341), in workerd against a real R2 binding:
// what it serves, how long each file may be cached, and what it never serves.

import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { RELEASE_FILE_CACHING } from "../src/release-files.ts";

const ORIGIN = "https://educateos.io";
const SHA = "ab".repeat(32);
const ASSET = "cd".repeat(16);

async function publish(releaseId: string, prefix = "releases") {
  await env.RELEASES!.put(`${prefix}/${releaseId}/manifest.json`, JSON.stringify({ releaseId }));
  await env.RELEASES!.put(`${prefix}/${releaseId}/manifest.signed.json`, JSON.stringify({ signed: releaseId }));
}

async function get(path: string, method = "GET") {
  return SELF.fetch(`${ORIGIN}${path}`, { method });
}

describe("the release mirror", () => {
  it("names the newest published release, ignoring candidates and incomplete releases", async () => {
    expect((await get("/releases/latest.json")).status).toBe(404);
    await publish("r000002-aaaaaaa");
    await publish("r000009-bbbbbbb", "candidates");
    // A statement without its manifest yet, as upload-release.ts leaves it mid-upload.
    await env.RELEASES!.put("releases/r000003-ccccccc/manifest.signed.json", "{}");

    const response = await get("/releases/latest.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(RELEASE_FILE_CACHING.latest);
    expect(await response.json()).toEqual({ releaseId: "r000002-aaaaaaa" });
  });

  it("serves a release's manifest and statement with short caching", async () => {
    await publish("r000004-ddddddd");
    const manifest = await get("/releases/r000004-ddddddd/manifest.json");
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("cache-control")).toBe(RELEASE_FILE_CACHING.manifest);
    expect(await manifest.json()).toEqual({ releaseId: "r000004-ddddddd" });
    expect(await (await get("/releases/r000004-ddddddd/manifest.signed.json")).json()).toEqual({ signed: "r000004-ddddddd" });
  });

  it("serves content-addressed blobs as immutable, and answers HEAD without a body", async () => {
    await env.RELEASES!.put(`blobs/modules/${SHA}`, "export default {}");
    await env.RELEASES!.put(`blobs/assets/${ASSET}`, "<html></html>");
    const module = await get(`/releases/blobs/modules/${SHA}`);
    expect(module.headers.get("cache-control")).toBe(RELEASE_FILE_CACHING.blob);
    expect(await module.text()).toBe("export default {}");
    expect(await (await get(`/releases/blobs/assets/${ASSET}`)).text()).toBe("<html></html>");
    const head = await get(`/releases/blobs/modules/${SHA}`, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("17");
    expect(await head.text()).toBe("");
  });

  it("never serves candidates, malformed names or anything but GET and HEAD", async () => {
    await publish("r000005-eeeeeee", "candidates");
    for (const path of [
      "/releases/r000005-eeeeeee/manifest.json",
      "/releases/candidates/r000005-eeeeeee/manifest.json",
      "/releases/blobs/modules/not-a-hash",
      `/releases/blobs/modules/${SHA.toUpperCase()}`,
      "/releases/r000004-ddddddd/other.json",
      "/releases/",
    ]) {
      const response = await get(path);
      expect(response.status, path).toBe(404);
      await response.body?.cancel();
    }
    const post = await get("/releases/latest.json", "POST");
    expect(post.status).toBe(405);
    await post.body?.cancel();
  });
});
