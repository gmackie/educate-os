import { mkdir, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { hash, run, duration, writeJson, fileHash, assert, readJson } from "./io.mjs";
import { selectScenes } from "./import.mjs";

export async function narrate(root, manifest, { video, scene, engine = "local", input } = {}) {
  assert(
    ["local", "silent", "import"].includes(engine),
    "Narration engine must be local, silent or import",
  );
  const scenes = selectScenes(manifest, video, scene);
  assert(
    engine !== "import" || (input && scenes.length === 1),
    "Import requires one scene and a WAV file",
  );
  const dir = path.join(root, "audio");
  await mkdir(dir, { recursive: true });
  for (const shot of scenes) {
    const stem = path.join(dir, shot.id);
    const file = `audio/${shot.id}.wav`;
    await writeFile(`${stem}.txt`, shot.voiceover, { mode: 0o600 });
    if (engine === "silent")
      await run("ffmpeg", [
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=48000:cl=mono",
        "-t",
        "1",
        `${stem}.wav`,
      ]);
    else if (engine === "import") {
      assert(path.extname(input).toLowerCase() === ".wav", "Import only local WAV narration");
      await copyFile(input, `${stem}.input.wav`);
      await run("ffmpeg", [
        "-y",
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        `${stem}.input.wav`,
        "-ar",
        "48000",
        "-ac",
        "1",
        `${stem}.wav`,
      ]);
    } else if (process.platform === "darwin") {
      await run("say", ["-r", "155", "-f", `${stem}.txt`, "-o", `${stem}.aiff`]);
      await run("ffmpeg", [
        "-y",
        "-v",
        "error",
        "-i",
        `${stem}.aiff`,
        "-ar",
        "48000",
        "-ac",
        "1",
        `${stem}.wav`,
      ]);
    } else await run("espeak-ng", ["-s", "155", "-f", `${stem}.txt`, "-w", `${stem}.wav`]);
    await writeJson(`${stem}.json`, {
      sceneHash: hash(shot),
      textHash: hash(shot.voiceover),
      file,
      sha256: await fileHash(root, file),
      duration: await duration(`${stem}.wav`),
      engine,
      syntheticVoice: engine !== "import",
      generatedAt: new Date().toISOString(),
    });
  }
  return scenes.length;
}
export async function narrationReceipt(root, scene) {
  const receipt = await readJson(path.join(root, `audio/${scene.id}.json`));
  assert(
    receipt.sceneHash === hash(scene) &&
      receipt.textHash === hash(scene.voiceover) &&
      receipt.sha256 === (await fileHash(root, receipt.file)) &&
      ["local", "silent", "import"].includes(receipt.engine),
    `Stale narration ${scene.id}`,
  );
  return receipt;
}
