import path from "node:path";
import { writeFile, mkdir, mkdtemp, rm, copyFile } from "node:fs/promises";
import { hash, assert, run, duration, writeJson, fileHash, localFile } from "./io.mjs";
import { selectScenes } from "./import.mjs";
import { sceneBinding, reviewStatus } from "./review.mjs";
import { withBrowser, isolatedContext } from "./browser.mjs";
import { overlayHtml, ORIGIN } from "./fixture.mjs";

const time = (seconds, sep = ",") => {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}${sep}${String(ms % 1000).padStart(3, "0")}`;
};
/** Estimate word-chunk caption timing; synchronization requires human review. */
export function captions(timeline) {
  const cues = [];
  for (const scene of timeline) {
    const words = scene.voiceover.split(/\s+/);
    const total = words.length;
    const speechDuration = scene.silent ? scene.duration : scene.audioDuration;
    const visibleWords = Math.min(
      total,
      Math.max(1, Math.ceil((total * scene.duration) / speechDuration)),
    );
    for (let i = 0; i < visibleWords; i += 12) {
      cues.push({
        start: scene.offset + (speechDuration * i) / total,
        end:
          scene.offset +
          Math.min(scene.duration, (speechDuration * Math.min(visibleWords, i + 12)) / total),
        text: words
          .slice(i, Math.min(visibleWords, i + 12))
          .join(" ")
          .replace(/-->/g, "→"),
      });
    }
  }
  return {
    srt: cues
      .map((c, i) => `${i + 1}\n${time(c.start)} --> ${time(c.end)}\n${c.text}\n`)
      .join("\n"),
    vtt:
      "WEBVTT\n\n" +
      cues.map((c) => `${time(c.start, ".")} --> ${time(c.end, ".")}\n${c.text}\n`).join("\n"),
  };
}
export async function render(root, manifest, { video, scene, seconds } = {}) {
  assert(/^V0[1-9]$/.test(video ?? ""), "Render requires --video V01..V09");
  if (seconds !== undefined)
    assert(Number.isFinite(seconds) && seconds >= 1 && seconds <= 120, "--seconds must be 1..120");
  const scenes = selectScenes(manifest, video, scene);
  const timeline = [];
  let offset = 0;
  const outputDir = path.join(root, "renders");
  await mkdir(outputDir, { recursive: true });
  const work = await mkdtemp(path.join(outputDir, ".render-"));
  const stem = `${video}${scene ? `-${scene}` : ""}${seconds !== undefined ? "-preview" : ""}`;
  try {
    await withBrowser(async (browser) => {
      for (const shot of scenes) {
        const binding = await sceneBinding(root, manifest, shot);
        const review = await reviewStatus(root, manifest, shot);
        const audioDuration = await duration(await localFile(root, binding.audio.file));
        const length = seconds ?? Math.max(shot.end - shot.start, audioDuration + 0.3);
        const { context, assertSafe } = await isolatedContext(
          browser,
          overlayHtml(
            shot,
            review.state === "approved" ? "REVIEWED ILLUSTRATION" : "UNVERIFIED SCENE",
          ),
        );
        const overlay = path.join(work, `${shot.id}.png`);
        try {
          const page = await context.newPage();
          await page.goto(`${ORIGIN}/scene/${shot.id}`);
          await page.screenshot({ path: overlay, omitBackground: true });
          assertSafe();
        } finally {
          await context.close();
        }
        const segment = path.join(work, `${shot.id}.mp4`);
        await run(
          "ffmpeg",
          [
            "-y",
            "-v",
            "error",
            "-stream_loop",
            "-1",
            "-i",
            await localFile(root, binding.capture.file),
            "-loop",
            "1",
            "-i",
            overlay,
            "-i",
            await localFile(root, binding.audio.file),
            "-filter_complex",
            "[0:v]fps=24,scale=1280:720,setsar=1[base];[base][1:v]overlay=0:0:shortest=1[v];[2:a]apad[a]",
            "-map",
            "[v]",
            "-map",
            "[a]",
            "-t",
            String(length),
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "25",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-ar",
            "48000",
            "-ac",
            "1",
            "-threads",
            "2",
            segment,
          ],
          { timeout: 600000 },
        );
        timeline.push({
          id: shot.id,
          voiceover: shot.voiceover,
          offset,
          duration: length,
          audioDuration,
          binding: binding.digest,
          review,
          silent: binding.audio.engine === "silent",
        });
        offset += length;
      }
    });
    const subtitle = captions(timeline);
    await writeFile(path.join(work, "captions.srt"), subtitle.srt);
    await writeFile(
      path.join(work, "segments.txt"),
      timeline.map((s) => `file '${s.id}.mp4'`).join("\n"),
    );
    await run("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "concat",
      "-safe",
      "1",
      "-i",
      path.join(work, "segments.txt"),
      "-i",
      path.join(work, "captions.srt"),
      "-map",
      "0:v",
      "-map",
      "0:a",
      "-map",
      "1:0",
      "-c",
      "copy",
      "-c:s",
      "mov_text",
      "-metadata:s:s:0",
      "language=eng",
      "-movflags",
      "+faststart",
      path.join(work, "draft.mp4"),
    ]);
    const file = `renders/${stem}.mp4`;
    await copyFile(path.join(work, "draft.mp4"), path.join(root, file));
    await writeFile(path.join(root, `renders/${stem}.srt`), subtitle.srt);
    await writeFile(path.join(root, `renders/${stem}.vtt`), subtitle.vtt);
    const receipt = {
      schema: 1,
      manifestHash: hash(manifest),
      video,
      file,
      sha256: await fileHash(root, file),
      captions: {
        srt: `renders/${stem}.srt`,
        vtt: `renders/${stem}.vtt`,
        srtHash: hash(subtitle.srt),
        vttHash: hash(subtitle.vtt),
      },
      timeline,
      duration: await duration(path.join(root, file)),
      preview: seconds !== undefined || !!scene,
      publicationAllowed: false,
      watermark: "SYNTHETIC DISTRICT DEMO",
      claims: "illustrative-unverified",
      createdAt: new Date().toISOString(),
    };
    await writeJson(path.join(root, `renders/${stem}.json`), receipt);
    return receipt;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
