import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { importSources, selectScenes } from "../src/import.mjs";
import { readJson, run } from "../src/io.mjs";
import { capture } from "../src/capture.mjs";
import { narrate } from "../src/narration.mjs";
import { render } from "../src/render.mjs";
import { preflight } from "../src/preflight.mjs";
import { recordReview, reviewStatus } from "../src/review.mjs";
import { withBrowser, isolatedContext } from "../src/browser.mjs";
import { fixtureHtml, ORIGIN } from "../src/fixture.mjs";

const source = new URL("../source/", import.meta.url);
// E2E never silently skips missing browser/media tools. CI installs all prerequisites.
test(
  "82-scene fixture smoke → full narrated V01 MP4 → fail-closed reviews",
  { timeout: 900000 },
  async (t) => {
    const root = process.env.LAUNCH_FACTORY_E2E_RUN
      ? path.resolve(process.env.LAUNCH_FACTORY_E2E_RUN)
      : await mkdtemp(path.join(os.tmpdir(), "launch-e2e-"));
    if (!process.env.LAUNCH_FACTORY_E2E_RUN)
      t.after(() => rm(root, { recursive: true, force: true }));
    const manifest = await importSources(source, path.join(root, "manifest.json"));
    // Exercise each imported scene in a new isolated context without encoding 82 clips.
    await withBrowser(async (browser) => {
      for (const scene of selectScenes(manifest)) {
        const { context, assertSafe } = await isolatedContext(browser, fixtureHtml(scene));
        try {
          const page = await context.newPage();
          await page.goto(`${ORIGIN}/scene/${scene.id}`);
          assert(
            await page
              .getByText("SYNTHETIC STORYBOARD / NOT ACTUAL PRODUCT FOOTAGE", { exact: false })
              .isVisible(),
          );
          await page.getByRole("button", { name: "Preview synthetic activity" }).click();
          await page.getByRole("button", { name: "Review fixture" }).click();
          assertSafe();
        } finally {
          await context.close();
        }
      }
    });
    assert.equal(await capture(root, manifest, { video: "V01" }), 7);
    assert.equal(
      (await readdir(path.join(root, "captures"))).filter((s) => s.endsWith(".webm")).length,
      7,
    );
    assert.equal(await narrate(root, manifest, { video: "V01", engine: "local" }), 7);
    const audio = await readJson(path.join(root, "audio/V01-S01.json"));
    assert(audio.duration > 3);
    assert.equal(audio.engine, "local");
    const receipt = await render(root, manifest, { video: "V01" });
    const probe = JSON.parse(
      await run("ffprobe", [
        "-v",
        "error",
        "-show_streams",
        "-of",
        "json",
        path.join(root, receipt.file),
      ]),
    );
    assert(
      probe.streams.some((s) => s.codec_name === "h264" && s.width === 1280 && s.height === 720),
    );
    assert(probe.streams.some((s) => s.codec_name === "aac"));
    assert(probe.streams.some((s) => s.codec_name === "mov_text"));
    assert(receipt.duration >= 90 && receipt.duration < 180);
    assert.equal(receipt.timeline.length, 7);
    assert(receipt.timeline.every((s) => s.review.state === "unverified"));
    assert.equal(receipt.publicationAllowed, false);
    const release = await preflight(root, manifest, {
      video: "V01",
      purpose: "release",
      artifact: "renders/V01.json",
    });
    assert.equal(release.ready, false);
    assert(release.issues.some((i) => i.code === "publication-disabled"));
    assert.equal(release.issues.filter((i) => i.code === "unverified").length, 7);
    const scene = selectScenes(manifest, "V01")[0];
    const evidence = path.join(root, "review-evidence.md");
    await writeFile(evidence, "Test fixture evidence only: no product or provider verification.");
    const review = {
      reviewer: "Test Reviewer",
      decision: "approved",
      evidence,
      note: "Illustrative-only review; claims are not verified by fixture footage.",
      acknowledgements: { syntheticOnly: true, noLiveProviderClaim: true, noStudentData: true },
    };
    await assert.rejects(recordReview(root, manifest, scene, { ...review, acknowledgements: {} }));
    await recordReview(root, manifest, scene, review);
    assert.equal((await reviewStatus(root, manifest, scene)).state, "approved");
    // Actual full-length one-scene draft proves speech is not truncated or sped up to fit targets.
    assert(receipt.timeline[0].duration >= audio.duration);
    // Silent and truncated preview media must never pass release preflight.
    await narrate(root, manifest, { scene: scene.id, engine: "silent" });
    const preview = await render(root, manifest, { video: "V01", scene: scene.id, seconds: 1 });
    assert.equal(preview.preview, true);
    const previewReport = await preflight(root, manifest, {
      video: "V01",
      purpose: "release",
      artifact: "renders/V01-V01-S01-preview.json",
    });
    assert(previewReport.issues.some((i) => i.code === "missing-stale-or-preview-render"));
    assert(previewReport.issues.some((i) => i.code === "silent-narration"));
    const importedAudio = path.join(root, "voice.wav");
    await writeFile(importedAudio, await readFile(path.join(root, "audio/V01-S02.wav")));
    await narrate(root, manifest, { scene: scene.id, engine: "import", input: importedAudio });
    assert.equal((await reviewStatus(root, manifest, scene)).state, "unverified");
    await recordReview(root, manifest, scene, { ...review, decision: "rejected" });
    assert.equal((await reviewStatus(root, manifest, scene)).state, "rejected");
    await recordReview(root, manifest, scene, review);
    const saved = await readJson(path.join(root, `reviews/${scene.id}.json`));
    await writeFile(path.join(root, saved.evidence), "tampered");
    assert.equal((await reviewStatus(root, manifest, scene)).state, "unverified");
    await recordReview(root, manifest, scene, review);
    await writeFile(path.join(root, `captures/${scene.id}.webm`), "tampered footage");
    assert.equal((await reviewStatus(root, manifest, scene)).state, "unverified");
    await assert.rejects(render(root, manifest, { video: "V01", scene: scene.id, seconds: 1 }));
    // Re-capture repairs media, but must not revive the old approval.
    await capture(root, manifest, { scene: scene.id });
    assert.equal((await reviewStatus(root, manifest, scene)).state, "unverified");
    console.log(`Internal storyboard artifacts: ${path.join(root, "renders")}`);
  },
);
test(
  "isolated browser blocks external navigation, popups, WebSockets and network subresources",
  { timeout: 60000 },
  async () => {
    await withBrowser(async (browser) => {
      const { context, assertSafe } = await isolatedContext(
        browser,
        fixtureHtml({
          id: "V01-S01",
          title: "Safety",
          actions: "Clever simulation",
          overlay: "Synthetic only",
        }),
      );
      try {
        let page = await context.newPage();
        await page.goto(`${ORIGIN}/scene/V01-S01`);
        await assert.rejects(page.goto("https://clever.com/"));
        assert.throws(assertSafe, /forbidden/);
        // A blocked main-frame navigation asynchronously commits Chrome's error document.
        // A fresh page avoids racing that commit when testing independent resource boundaries.
        await page.close();
        page = await context.newPage();
        await page.goto(`${ORIGIN}/scene/V01-S01`);
        const result = await page.evaluate(async () => {
          try {
            await fetch("http://169.254.169.254/latest/meta-data");
            return "leaked";
          } catch {
            return "blocked";
          }
        });
        assert.equal(result, "blocked");
        const popupPromise = context.waitForEvent("page");
        await page.evaluate(() => window.open("https://example.com/"));
        const popup = await popupPromise;
        await popup.waitForLoadState().catch(() => {});
        assert(!popup.url().startsWith("https://example.com/"));
        const socket = await page.evaluate(
          () =>
            new Promise((resolve) => {
              const ws = new WebSocket("wss://example.com/");
              ws.addEventListener("error", () => resolve("blocked"));
              ws.addEventListener("open", () => resolve("leaked"));
              setTimeout(() => resolve("blocked"), 1000);
            }),
        );
        assert.equal(socket, "blocked");
      } finally {
        await context.close();
      }
    });
  },
);
