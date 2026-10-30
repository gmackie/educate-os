import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, realpath, rename } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

export const hash = (value) =>
  createHash("sha256")
    .update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value))
    .digest("hex");
export const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, file);
}
export function assert(condition, message) {
  if (!condition) throw new Error(message);
}
export const safeId = (value) => {
  assert(/^[A-Za-z0-9_-]+$/.test(value), "Invalid identifier");
  return value;
};
export async function localFile(root, relative) {
  assert(
    typeof relative === "string" && !path.isAbsolute(relative),
    "Expected relative artifact path",
  );
  const base = await realpath(root);
  const target = await realpath(path.resolve(base, relative));
  assert(target.startsWith(base + path.sep), "Artifact escapes run directory");
  return target;
}
export async function fileHash(root, relative) {
  return hash(await readFile(await localFile(root, relative)));
}
export function run(program, args, { timeout = 180000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      timeout,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        LANG: "en_US.UTF-8",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk).slice(-100000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-100000);
    });
    child.on("error", () => reject(new Error(`${program} unavailable; check doctor`)));
    child.on("close", (code) =>
      code === 0
        ? resolve(stdout)
        : reject(
            new Error(
              `${program} failed (${code}); inspect local inputs and tool versions. ${stderr.includes("No such filter") ? "Required FFmpeg filter unavailable." : ""}`,
            ),
          ),
    );
  });
}
export async function duration(file) {
  const value = Number(
    (
      await run("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=nw=1:nk=1",
        file,
      ])
    ).trim(),
  );
  assert(Number.isFinite(value) && value > 0, "Invalid media duration");
  return value;
}
