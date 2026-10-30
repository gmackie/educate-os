import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, symlink, rm, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { importSources, parseCsv, selectScenes } from "../src/import.mjs";
import { hash, writeJson, localFile, safeId } from "../src/io.mjs";
import { allowedRequest } from "../src/browser.mjs";
import { ORIGIN, fixtureHtml, overlayHtml } from "../src/fixture.mjs";
import { captions } from "../src/render.mjs";
import { main } from "../src/cli.mjs";
import { preflight } from "../src/preflight.mjs";

const source = new URL("../source/", import.meta.url);
async function temp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "launch-unit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("imports all 82 ordered scenes, full scripts and editorial gates without losing source fields", async (t) => {
  const root = await temp(t);
  const m = await importSources(source, path.join(root, "manifest.json"));
  assert.deepEqual(
    m.videos.map((v) => v.scenes.length),
    [7, 9, 10, 8, 6, 5, 5, 18, 14],
  );
  const [header, ...rows] = parseCsv(await readFile(new URL("shotlist.csv", source), "utf8"));
  assert.equal(header.length, 8);
  rows.forEach((row, i) => {
    const s = selectScenes(m)[i];
    assert.equal(s.voiceover, row[4]);
    assert.equal(s.actions, row[5]);
    assert.equal(s.overlay, row[6]);
    assert.equal(s.gate, row[7]);
    assert.equal(s.verified, false);
  });
  assert(m.videos.every((v) => v.script.includes("SCRIPT") && v.script.startsWith(`# ${v.id} — `)));
  assert.equal(m.source.commit, "f66d45d7988a8a2ed76ca763ccfd8974c58ff648");
  assert.equal(m.source.csvHash, hash(await readFile(new URL("shotlist.csv", source))));
  assert.match(m.videos[6].runtime, /editorial flexibility/);
  assert.throws(() => selectScenes(m, "V99"));
  assert.throws(() => selectScenes(m, "V01", "V02-S01"));
});
test("CSV accepts RFC4180 multiline/escaped quotes and rejects malformed rows", () => {
  assert.deepEqual(parseCsv('a,b\r\n"line\n1","say ""hi"""\r\n'), [
    ["a", "b"],
    ["line\n1", 'say "hi"'],
  ]);
  for (const input of ['"unfinished', 'bad"quote', '"closed"oops'])
    assert.throws(() => parseCsv(input));
});
test("import rejects missing scenes, changed columns, timing gaps and missing scripts", async (t) => {
  const root = await temp(t);
  const csv = await readFile(new URL("shotlist.csv", source), "utf8");
  await writeFile(
    path.join(root, "provenance.json"),
    await readFile(new URL("provenance.json", source)),
  );
  await writeFile(
    path.join(root, "full-video-scripts.md"),
    await readFile(new URL("full-video-scripts.md", source)),
  );
  const url = new URL(`file://${root}/`);
  for (const bad of [
    csv.replace("Voiceover,", "Narration,"),
    csv.replace("00:10–00:25", "00:11–00:25"),
    csv.slice(0, csv.lastIndexOf("\nV09,")),
  ]) {
    await writeFile(path.join(root, "shotlist.csv"), bad);
    await assert.rejects(importSources(url, path.join(root, "out.json")));
  }
  await writeFile(path.join(root, "shotlist.csv"), csv);
  await writeFile(path.join(root, "full-video-scripts.md"), "no scripts");
  await assert.rejects(importSources(url, path.join(root, "out.json")));
});
test("capture allowlist denies credentials, private IPs, redirects, ports, suffix attacks and unsafe methods", () => {
  assert.equal(allowedRequest(`${ORIGIN}/scene/V01-S01`), true);
  for (const url of [
    "http://127.0.0.1/a",
    "http://169.254.169.254/latest/meta-data",
    "file:///etc/passwd",
    "https://clever.com/scene/V01-S01",
    `${ORIGIN}.evil.test/scene/V01-S01`,
    `${ORIGIN}:444/scene/V01-S01`,
    `${ORIGIN}/scene/V01-S01?token=secret`,
    `${ORIGIN}/scene/V01-S01#bearer`,
    "https://user:pass@synthetic.launch-factory.invalid/scene/V01-S01",
    `${ORIGIN}/redirect`,
    "data:text/html,hello",
  ])
    assert.equal(allowedRequest(url), false, url);
  assert.equal(allowedRequest(`${ORIGIN}/scene/V01-S01`, "POST"), false);
});
test("artifact paths cannot traverse or follow symlinks outside a run", async (t) => {
  const root = await temp(t);
  await writeFile(path.join(root, "inside"), "safe");
  assert.equal(await localFile(root, "inside"), await realpath(path.join(root, "inside")));
  await symlink("/etc/hosts", path.join(root, "escape"));
  for (const file of ["../outside", "/etc/hosts", "escape"])
    await assert.rejects(localFile(root, file));
  assert.throws(() => safeId("../../escape"));
});
test("fixtures escape source markup and retain permanent synthetic/provider warnings", () => {
  const scene = {
    id: "V01-S01",
    title: "<img src=x>",
    actions: "Clever connect",
    overlay: "<script>secret</script>",
  };
  const html = fixtureHtml(scene);
  assert(!html.includes("<img src=x>"));
  assert(html.includes("&lt;img"));
  assert(html.includes("PROVIDER SIMULATION ONLY"));
  for (const state of ["approved", "unverified"]) {
    const overlay = overlayHtml(scene, state);
    assert(overlay.includes("SYNTHETIC DISTRICT DEMO"));
    assert(overlay.includes("UNVERIFIED CLAIMS"));
  }
});
test("captions follow actual narration duration and retain all words in SRT and VTT", () => {
  const voiceover = Array.from({ length: 29 }, (_, i) => `word${i}`).join(" ");
  const { srt, vtt } = captions([{ voiceover, offset: 10, duration: 60, audioDuration: 29 }]);
  assert(srt.includes("00:00:10,000 --> 00:00:22,000"));
  assert(srt.includes("00:00:39,000"));
  assert(vtt.startsWith("WEBVTT\n"));
  assert(vtt.includes("00:00:39.000"));
  for (let i = 0; i < 29; i++) assert(srt.includes(`word${i}`));
});
test("preflight fails closed with missing media/reviews and never authorizes publication", async (t) => {
  const root = await temp(t);
  const manifest = await importSources(source, path.join(root, "manifest.json"));
  const report = await preflight(root, manifest, { video: "V01", purpose: "release" });
  assert.equal(report.ready, false);
  assert.equal(report.publicationAllowed, false);
  assert(report.issues.some((i) => i.code === "publication-disabled"));
  assert(report.issues.some((i) => i.code === "final-render-required"));
  assert.equal(report.issues.filter((i) => i.code === "unverified").length, 7);
});
test("CLI rejects unknown/duplicate options, external URLs, and modified manifests", async (t) => {
  const root = await temp(t);
  for (const args of [
    ["capture", "--url", "https://clever.com"],
    ["capture", "--video"],
    ["render", "--video", "V01", "--video", "V02"],
  ])
    await assert.rejects(main(args));
  const manifest = await importSources(source, path.join(root, "manifest.json"));
  manifest.videos[0].scenes[0].verified = true;
  await writeJson(path.join(root, "manifest.json"), manifest);
  await assert.rejects(main(["status", "--run", root]), /differs from source/);
});

test("short preview captions do not squeeze the entire script into a clipped voiceover", () => {
  const { srt } = captions([
    {
      voiceover: "one two three four five six seven eight nine ten",
      offset: 0,
      duration: 1,
      audioDuration: 10,
    },
  ]);
  assert(srt.includes("one"));
  assert(!srt.includes("ten"));
  assert(srt.includes("00:00:01,000"));
});
