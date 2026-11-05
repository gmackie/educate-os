// The demo videos answer byte-range requests, which Safari needs to play them (SCHO-343).
// Run: node --test sites/educateos-io/video-range.test.mjs

import assert from "node:assert/strict";
import {test} from "node:test";
import {handleVideo, parseRange} from "./video-range.mjs";

const FILE = new Uint8Array(Array.from({length: 1000}, (_, i) => i % 256));
const env = {
  ASSETS: {
    async fetch(request) {
      assert.equal(request.headers.get("Range"), null, "the assets binding is asked for the whole file");
      if (new URL(request.url).pathname !== "/assets/videos/clip.v1.mp4") return new Response("Not found", {status: 404});
      return new Response(FILE, {headers: {"Content-Type": "video/mp4", ETag: '"abc"'}});
    },
  },
};
const get = (path, headers = {}, method = "GET") => handleVideo(new Request(`https://educateos.io${path}`, {method, headers}), env);

test("paths outside /assets/videos/ are not handled", async () => {
  assert.equal(await get("/assets/site.css"), undefined);
});

test("a request with no Range gets the whole file, saying ranges are accepted", async () => {
  const response = await get("/assets/videos/clip.v1.mp4");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Accept-Ranges"), "bytes");
  assert.equal(response.headers.get("Content-Length"), "1000");
  assert.equal(response.headers.get("Content-Type"), "video/mp4");
  assert.match(response.headers.get("Cache-Control"), /immutable/);
  assert.equal((await response.arrayBuffer()).byteLength, 1000);
});

test("a byte range gets a 206 with exactly those bytes", async () => {
  const response = await get("/assets/videos/clip.v1.mp4", {Range: "bytes=0-1"});
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("Content-Range"), "bytes 0-1/1000");
  assert.equal(response.headers.get("Content-Length"), "2");
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0, 1]);

  const tail = await get("/assets/videos/clip.v1.mp4", {Range: "bytes=990-"});
  assert.equal(tail.headers.get("Content-Range"), "bytes 990-999/1000");
  assert.deepEqual([...new Uint8Array(await tail.arrayBuffer())], [...FILE.subarray(990)]);
});

test("a range past the end is refused with 416", async () => {
  const response = await get("/assets/videos/clip.v1.mp4", {Range: "bytes=1000-"});
  assert.equal(response.status, 416);
  assert.equal(response.headers.get("Content-Range"), "bytes */1000");
});

test("HEAD has the headers and no body; a missing file keeps the assets' 404", async () => {
  const head = await get("/assets/videos/clip.v1.mp4", {Range: "bytes=10-19"}, "HEAD");
  assert.equal(head.status, 206);
  assert.equal(head.headers.get("Content-Length"), "10");
  assert.equal(head.body, null);
  assert.equal((await get("/assets/videos/missing.mp4")).status, 404);
  assert.equal((await get("/assets/videos/clip.v1.mp4", {}, "POST")).status, 405);
});

test("Range headers parse as RFC 9110 single ranges", () => {
  assert.deepEqual(parseRange("bytes=0-99", 1000), [0, 99]);
  assert.deepEqual(parseRange("bytes=500-", 1000), [500, 999]);
  assert.deepEqual(parseRange("bytes=-100", 1000), [900, 999]);
  assert.deepEqual(parseRange("bytes=-5000", 1000), [0, 999]);
  assert.deepEqual(parseRange("bytes=900-5000", 1000), [900, 999]);
  assert.equal(parseRange(null, 1000), undefined);
  assert.equal(parseRange("bytes=0-1,5-9", 1000), undefined);
  assert.equal(parseRange("items=0-1", 1000), undefined);
  assert.equal(parseRange("bytes=9-1", 1000), undefined);
  assert.equal(parseRange("bytes=1000-1001", 1000), "unsatisfiable");
  assert.equal(parseRange("bytes=-0", 1000), "unsatisfiable");
});
