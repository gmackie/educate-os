import path from "node:path";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { assert, hash, readJson, writeJson, fileHash } from "./io.mjs";
import { captureReceipt } from "./capture.mjs";
import { narrationReceipt } from "./narration.mjs";

export async function sceneBinding(root, manifest, scene) {
  const capture = await captureReceipt(root, scene);
  const audio = await narrationReceipt(root, scene);
  return { digest: hash({ source: manifest.source, scene, capture, audio }), capture, audio };
}
export async function recordReview(
  root,
  manifest,
  scene,
  { reviewer, decision, evidence, note, acknowledgements },
) {
  assert(typeof reviewer === "string" && reviewer.trim().length >= 3, "Reviewer identity required");
  assert(["approved", "rejected"].includes(decision), "Decision must be approved or rejected");
  assert(
    typeof note === "string" && note.trim().length >= 20,
    "Explain evidence and claim limits (20+ characters)",
  );
  assert(
    acknowledgements?.syntheticOnly === true &&
      acknowledgements?.noLiveProviderClaim === true &&
      acknowledgements?.noStudentData === true,
    "All safety acknowledgements required",
  );
  const binding = await sceneBinding(root, manifest, scene);
  assert(
    evidence && [".md", ".txt", ".json"].includes(path.extname(evidence)),
    "Local text evidence file required",
  );
  await mkdir(path.join(root, "evidence"), { recursive: true });
  const body = await readFile(evidence);
  assert(body.length > 0 && body.length < 1000000, "Evidence must be a bounded review record");
  const evidenceFile = `evidence/${scene.id}-${hash(body)}${path.extname(evidence)}`;
  await copyFile(evidence, path.join(root, evidenceFile));
  const review = {
    schema: 1,
    scene: scene.id,
    binding: binding.digest,
    decision,
    reviewer: reviewer.trim(),
    note,
    acknowledgements,
    evidence: evidenceFile,
    evidenceHash: await fileHash(root, evidenceFile),
    recordedAt: new Date().toISOString(),
  };
  await writeJson(path.join(root, `reviews/${scene.id}.json`), review);
  return review;
}
export async function reviewStatus(root, manifest, scene) {
  try {
    const binding = await sceneBinding(root, manifest, scene);
    const review = await readJson(path.join(root, `reviews/${scene.id}.json`));
    assert(
      review.schema === 1 && review.scene === scene.id && review.binding === binding.digest,
      "Stale review",
    );
    assert(
      review.reviewer?.length >= 3 &&
        review.note?.length >= 20 &&
        !Number.isNaN(Date.parse(review.recordedAt)),
      "Invalid review",
    );
    assert(
      review.acknowledgements?.syntheticOnly === true &&
        review.acknowledgements?.noLiveProviderClaim === true &&
        review.acknowledgements?.noStudentData === true,
      "Missing safety acknowledgements",
    );
    assert(review.evidenceHash === (await fileHash(root, review.evidence)), "Evidence changed");
    return {
      state: review.decision === "approved" ? "approved" : "rejected",
      digest: hash(review),
    };
  } catch {
    return { state: "unverified" };
  }
}
