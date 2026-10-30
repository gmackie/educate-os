#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { importSources, selectScenes } from "./import.mjs";
import { readJson, run, assert, writeJson } from "./io.mjs";
import { capture } from "./capture.mjs";
import { narrate } from "./narration.mjs";
import { render } from "./render.mjs";
import { recordReview } from "./review.mjs";
import { preflight } from "./preflight.mjs";

const help = `EducateOS Launch Factory (offline synthetic video engine)
Usage: pnpm run lf <command> [options]
  import      Import all nine scripts and 82 scenes from bundled source
  capture     Record synthetic fixtures (--video V01 / --scene V01-S01)
  narrate     Speech (--engine local|silent|import; import needs --input WAV and --scene)
  render      Draft MP4 + SRT/VTT (--video required; --seconds N previews each scene)
  batch       Capture, narrate and render one video or all nine
  review      Human attestation (--scene ID --review-file JSON)
  preflight   Check media/reviews (--purpose draft|release --artifact renders/V01.json)
  status      Current scene review/media readiness
  doctor      Check Chromium, FFmpeg, FFprobe and local voice engine
Options: --run PATH (default runs/draft), --video V01..V09, --scene V01-S01,
         --engine local|silent|import (default local), --seconds 1..120 (preview).
No publisher, live-site capture, paid TTS, outreach sender, or deploy command exists.`;
export async function main(args) {
  const [command, ...rest] = args;
  if (!command || ["help", "--help"].includes(command)) {
    console.log(help);
    return;
  }
  const options = {};
  const known = new Set([
    "run",
    "video",
    "scene",
    "engine",
    "input",
    "seconds",
    "review-file",
    "purpose",
    "artifact",
  ]);
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].replace(/^--/, "");
    assert(
      rest[i].startsWith("--") &&
        known.has(key) &&
        rest[i + 1] &&
        !rest[i + 1].startsWith("--") &&
        !(key in options),
      "Unknown, repeated, or incomplete option",
    );
    options[key] = rest[i + 1];
  }
  if (options.seconds !== undefined) options.seconds = Number(options.seconds);
  const root = path.resolve(options.run ?? "runs/draft");
  const manifestFile = path.join(root, "manifest.json");
  if (command === "import") {
    const manifest = await importSources(new URL("../source/", import.meta.url), manifestFile);
    console.log(
      `Imported ${manifest.videos.length} videos, ${selectScenes(manifest).length} scenes.`,
    );
    return;
  }
  if (command === "doctor") {
    const { withBrowser } = await import("./browser.mjs");
    const browser = await withBrowser(async (b) => b.version());
    await run("ffmpeg", ["-version"]);
    await run("ffprobe", ["-version"]);
    await run(
      process.platform === "darwin" ? "say" : "espeak-ng",
      process.platform === "darwin" ? ["-v", "?"] : ["--version"],
    );
    console.log(
      JSON.stringify({ chromium: browser, ffmpeg: true, ffprobe: true, localVoice: true }),
    );
    return;
  }
  const manifest = await readJson(manifestFile);
  // The source of truth prevents a hand-edited manifest from upgrading illustrative claims.
  const canonical = await importSources(
    new URL("../source/", import.meta.url),
    path.join(root, ".canonical.json"),
  );
  assert(
    JSON.stringify(manifest) === JSON.stringify(canonical),
    "Manifest differs from source; re-import and review",
  );
  let result;
  if (command === "capture") result = { captured: await capture(root, manifest, options) };
  else if (command === "narrate") result = { narrated: await narrate(root, manifest, options) };
  else if (command === "render") result = await render(root, manifest, options);
  else if (command === "batch") {
    const videos = options.video
      ? manifest.videos.filter((v) => v.id === options.video)
      : manifest.videos;
    assert(
      videos.length > 0 && !options.scene,
      "Batch needs valid video or no video, and no scene",
    );
    result = [];
    for (const video of videos) {
      const selected = { ...options, video: video.id };
      await capture(root, manifest, selected);
      await narrate(root, manifest, selected);
      result.push(await render(root, manifest, selected));
    }
    await writeJson(path.join(root, "batch.json"), result);
  } else if (command === "review") {
    assert(options.scene && options["review-file"], "Review needs --scene and --review-file");
    result = await recordReview(
      root,
      manifest,
      selectScenes(manifest, options.video, options.scene)[0],
      JSON.parse(await readFile(options["review-file"], "utf8")),
    );
  } else if (command === "preflight" || command === "status") {
    result = await preflight(root, manifest, options);
    if (command === "preflight" && !result.ready) process.exitCode = 2;
  } else throw new Error("Unknown command; run help");
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  main(process.argv.slice(2)).catch(() => {
    console.error(
      "Launch Factory failed. Check options, source integrity, media receipts and doctor. See README for recovery.",
    );
    process.exitCode = 1;
  });
