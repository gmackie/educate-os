import path from "node:path";
import { assert, hash, fileHash, readJson, writeJson, localFile } from "./io.mjs";
import { selectScenes } from "./import.mjs";
import { reviewStatus, sceneBinding } from "./review.mjs";

export async function preflight(root, manifest, { video, purpose = "draft", artifact } = {}) {
  assert(["draft", "release"].includes(purpose), "Purpose must be draft or release");
  const issues = [];
  const scenes = selectScenes(manifest, video);
  for (const scene of scenes) {
    try {
      const binding = await sceneBinding(root, manifest, scene);
      if (binding.audio.engine === "silent")
        issues.push({ scene: scene.id, code: "silent-narration" });
    } catch {
      issues.push({ scene: scene.id, code: "missing-or-stale-media" });
    }
    const review = await reviewStatus(root, manifest, scene);
    if (review.state !== "approved") issues.push({ scene: scene.id, code: review.state });
  }
  if (artifact) {
    try {
      const receipt = await readJson(await localFile(root, artifact));
      assert(
        receipt.schema === 1 &&
          receipt.manifestHash === hash(manifest) &&
          receipt.sha256 === (await fileHash(root, receipt.file)),
        "Render changed",
      );
      assert(
        receipt.captions.srtHash === (await fileHash(root, receipt.captions.srt)) &&
          receipt.captions.vttHash === (await fileHash(root, receipt.captions.vtt)),
        "Captions changed",
      );
      assert(!receipt.preview && receipt.video === video, "Preview is not full video");
      assert(
        JSON.stringify(receipt.timeline.map((s) => s.id)) ===
          JSON.stringify(scenes.map((s) => s.id)),
        "Incomplete render",
      );
      for (const scene of scenes) {
        const item = receipt.timeline.find((s) => s.id === scene.id);
        assert(
          item.binding === (await sceneBinding(root, manifest, scene)).digest &&
            JSON.stringify(item.review) ===
              JSON.stringify(await reviewStatus(root, manifest, scene)),
          "Stale render review",
        );
      }
    } catch {
      issues.push({ code: "missing-stale-or-preview-render" });
    }
  } else if (purpose === "release") issues.push({ code: "final-render-required" });
  // Local attestations are not authenticated publicity authorization. A separately reviewed,
  // human-controlled publication service must establish that boundary; no publisher exists here.
  if (purpose === "release")
    issues.push({
      code: "publication-disabled",
      detail:
        "Fixture captures do not verify product claims. No publicity authorization or publisher exists.",
    });
  const report = {
    schema: 1,
    purpose,
    video: video ?? "all",
    ready: issues.length === 0,
    publicationAllowed: false,
    issues,
    checkedAt: new Date().toISOString(),
  };
  await writeJson(path.join(root, `preflight-${video ?? "all"}-${purpose}.json`), report);
  return report;
}
