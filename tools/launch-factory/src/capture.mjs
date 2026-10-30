import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { withBrowser, isolatedContext } from "./browser.mjs";
import { fixtureHtml, ORIGIN } from "./fixture.mjs";
import { hash, writeJson, readJson, fileHash, duration } from "./io.mjs";
import { selectScenes } from "./import.mjs";

export async function capture(root, manifest, { video, scene } = {}) {
  const scenes = selectScenes(manifest, video, scene);
  const dir = path.join(root, "captures");
  await mkdir(dir, { recursive: true });
  return withBrowser(async (browser) => {
    for (const shot of scenes) {
      const html = fixtureHtml(shot);
      const { context, assertSafe } = await isolatedContext(browser, html, { recordVideo: dir });
      let recording;
      try {
        const page = await context.newPage();
        recording = page.video();
        await page.goto(`${ORIGIN}/scene/${shot.id}`);
        await page.getByRole("button", { name: "Preview synthetic activity" }).click();
        await page.waitForTimeout(350);
        await page.getByRole("button", { name: "Review fixture" }).click();
        await page.waitForTimeout(350);
        await page.screenshot({ path: path.join(dir, `${shot.id}.png`) });
        assertSafe();
      } finally {
        await context.close();
      }
      const file = `captures/${shot.id}.webm`;
      await rename(await recording.path(), path.join(root, file));
      await writeJson(path.join(root, `captures/${shot.id}.json`), {
        sceneHash: hash(shot),
        fixtureHash: hash(html),
        file,
        sha256: await fileHash(root, file),
        screenshot: `captures/${shot.id}.png`,
        screenshotHash: await fileHash(root, `captures/${shot.id}.png`),
        kind: "illustrative",
        origin: ORIGIN,
        synthetic: true,
        providerVerification: "none",
        browserVersion: browser.version(),
        duration: await duration(path.join(root, file)),
        capturedAt: new Date().toISOString(),
      });
      // Existing renders/reviews bind hashes and are automatically stale after a change.
      await rm(path.join(root, `captures/${shot.id}.partial`), { force: true });
    }
    return scenes.length;
  });
}
export async function captureReceipt(root, scene) {
  const receipt = await readJson(path.join(root, `captures/${scene.id}.json`));
  if (
    receipt.sceneHash !== hash(scene) ||
    receipt.sha256 !== (await fileHash(root, receipt.file)) ||
    receipt.screenshotHash !== (await fileHash(root, receipt.screenshot)) ||
    receipt.fixtureHash !== hash(fixtureHtml(scene)) ||
    receipt.origin !== ORIGIN ||
    receipt.synthetic !== true ||
    receipt.kind !== "illustrative" ||
    receipt.providerVerification !== "none"
  )
    throw new Error(`Stale/unsafe capture ${scene.id}`);
  return receipt;
}
