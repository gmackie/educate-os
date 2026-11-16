import assert from "node:assert/strict";
import { test } from "node:test";
import { chapters, sceneSeconds, SCENES, selectScenes, SIGN_INS } from "./record-walkthrough.ts";

test("every scene signs in to its own host and opens a page on it", () => {
  for (const scene of SCENES) {
    assert.equal(new URL(scene.url).origin, SIGN_INS[scene.signIn], scene.id);
    assert.ok(scene.narration.length > 40, `${scene.id} has narration`);
  }
  assert.equal(new Set(SCENES.map((s) => s.id)).size, SCENES.length);
});

test("the walkthrough covers each role at both schools, Canvas and the AI workspace", () => {
  assert.deepEqual(SCENES.map((s) => s.id), [
    "harbor-admin", "harbor-teacher", "harbor-student",
    "northfield-admin", "northfield-teacher", "northfield-student", "canvas-student", "northfield-family", "northfield-ai",
  ]);
  // Canvas is opened as the learner, never as an administrator acting as one.
  assert.deepEqual(SCENES.filter((s) => s.canvasAs !== undefined).map((s) => s.canvasAs), ["prn_nf-student-kofi"]);
});

test("scenes can be picked by ID, in walkthrough order, and an unknown one is refused", () => {
  assert.deepEqual(selectScenes(["canvas-student", "harbor-admin"]).map((s) => s.id), ["harbor-admin", "canvas-student"]);
  assert.equal(selectScenes(undefined).length, SCENES.length);
  assert.throws(() => selectScenes(["nope"]), /Unknown scene nope/);
});

test("chapters run back to back from the scenes' lengths", () => {
  assert.equal(sceneSeconds(10), 11.2);
  assert.equal(chapters([{ chapter: "A; b", seconds: 2.5 }, { chapter: "C", seconds: 1 }]), [
    ";FFMETADATA1", "title=EducateOS: two-school demo",
    "[CHAPTER]", "TIMEBASE=1/1000", "START=0", "END=2500", "title=A  b",
    "[CHAPTER]", "TIMEBASE=1/1000", "START=2500", "END=3500", "title=C",
  ].join("\n") + "\n");
});
