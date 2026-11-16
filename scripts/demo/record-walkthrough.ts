#!/usr/bin/env node
// Records the two-school presenter walkthrough as one narrated video (SCHO-429). Each scene is a
// browser signed in as that scene's own person, recorded while macOS `say` narrates it; ffmpeg
// joins the scenes into one MP4 with a chapter per scene.
//
//   node scripts/demo/record-walkthrough.ts --cookies <dir> [--out ~/Movies/<name>.mp4] [--only <scene,…>]
//
// <dir> holds one Access cookie file per sign-in, named as SIGN_INS below (agent-inbox's
// access-sign-in.ts writes them; the Harbor administrator's is the owner's own). Cookies are read
// into the browser only, never printed or written into the video's folder. Canvas is opened as the
// learner with a single-use session token from the Canvas console (canvas-actors.ts), also never
// printed. The video goes outside the repository; nothing here is committed.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const HARBOR = "https://harbor.educateos.io";
const NORTHFIELD = "https://northfield.educateos.io";
const CANVAS = "https://canvas.mackie.house";
const MARINE = "off_or-d23c51417a3ed125654b4fc5268e9f1f";

/** The sign-ins scenes use, by cookie file name, and the host each is for. */
export const SIGN_INS = {
  "hb-admin": HARBOR, "hb-teacher": HARBOR, "hb-student": HARBOR,
  "nf-admin": NORTHFIELD, "nf-teacher-68": NORTHFIELD, "nf-student-68": NORTHFIELD, "nf-guardian-rosa": NORTHFIELD,
  "canvas-access": CANVAS,
} as const;
type SignIn = keyof typeof SIGN_INS;

/** One scene: who, where, what to bring into view, and what the narrator says. */
export interface Scene {
  id: string;
  chapter: string;
  signIn: SignIn;
  url: string;
  /** Text to wait for, so the scene starts on a loaded page. */
  ready: string;
  /** Text to scroll into view once ready, if not the top of the page. */
  focus?: string;
  /** For Canvas: the demo person the session is minted for. */
  canvasAs?: string;
  narration: string;
}

export const SCENES: readonly Scene[] = [
  {
    id: "harbor-admin", chapter: "Harbor: the administrator", signIn: "hb-admin", url: `${HARBOR}/admin/`, ready: "Dashboard",
    narration: "This is Harbor Charter, a school that runs on Google Classroom. Marisol Vega, the administrator, sees the whole district: six students and three staff in four classes, rostered from Google Classroom. Teachers and students cannot open these pages.",
  },
  {
    id: "harbor-teacher", chapter: "Harbor: Kwame's gradebook", signIn: "hb-teacher", url: `${HARBOR}/teach/#/classes/${MARINE}/gradebook`, ready: "Gradebook", focus: "From Google Classroom",
    narration: "Kwame Asante teaches Marine Science. Under his official gradebook, From Google Classroom shows each student's Classroom grades, read live. The Rocky Shore Field Notes grade he approved in EducateOS is here too: it was published to Classroom by Kwame himself, never by an administrator.",
  },
  {
    id: "harbor-student", chapter: "Harbor: Nia's class", signIn: "hb-student", url: `${HARBOR}/courses/${MARINE}`, ready: "Grades returned in Google Classroom", focus: "From Google Classroom",
    narration: "Nia Fontaine sees only her own work. Her Marine Science page lists the grades her teacher returned in Classroom, including nine out of ten on Rocky Shore Field Notes. A class she is not in answers as if it did not exist.",
  },
  {
    id: "northfield-admin", chapter: "Northfield: the administrator", signIn: "nf-admin", url: `${NORTHFIELD}/admin/`, ready: "Dashboard",
    narration: "Northfield is a co-op whose courses run in Canvas. Its administrator manages fifteen classes, including twelve showcase classes across four grade bands, from kindergarten to twelfth grade.",
  },
  {
    id: "northfield-teacher", chapter: "Northfield: Hannah's classes", signIn: "nf-teacher-68", url: `${NORTHFIELD}/teach/`, ready: "My classes",
    narration: "Hannah Kowalski teaches English 8. When she approves a grade, she sends it to Canvas herself, through LTI Advantage. Canvas keeps it in its own column, left out of the course total so no work counts twice.",
  },
  {
    id: "northfield-student", chapter: "Northfield: Kofi's grades", signIn: "nf-student-68", url: `${NORTHFIELD}/grades`, ready: "My grades",
    narration: "Kofi Mensah, in eighth grade, sees his official grades: fifteen out of sixteen on Phones in the Classroom.",
  },
  {
    id: "canvas-student", chapter: "Canvas: Kofi's grades", signIn: "canvas-access", url: `${CANVAS}/courses/10/grades`, ready: "Grades for", canvasAs: "prn_nf-student-kofi",
    narration: "And here is Kofi's own Canvas view. The grade Hannah approved, fifteen out of sixteen, is in the educateos approved column, and his total counts it once.",
  },
  {
    id: "northfield-family", chapter: "Northfield: Rosa's family view", signIn: "nf-guardian-rosa", url: `${NORTHFIELD}/family`, ready: "Delgado",
    narration: "Rosa Delgado is a parent. She sees each of her children's classes, Lucía's and Mateo's, but only what their teachers have shared. Never their own work, and never another family's children.",
  },
  {
    id: "northfield-ai", chapter: "The AI workspace", signIn: "nf-teacher-68", url: `${NORTHFIELD}/ai/`, ready: "Welcome",
    narration: "Finally, Hannah's AI workspace, on the same district origin. It greets her by name, uses a model the district funds, and its Classroom grading flow only returns grades a teacher has approved.",
  },
];

/** Seconds a scene lasts: its narration plus a short pause. */
export const sceneSeconds = (narrationSeconds: number) => Math.ceil((narrationSeconds + 1.2) * 10) / 10;

/** The ffmpeg chapter metadata for scenes of these lengths, in milliseconds. */
export function chapters(scenes: readonly { chapter: string; seconds: number }[]): string {
  let start = 0;
  const lines = [";FFMETADATA1", "title=EducateOS: two-school demo"];
  for (const scene of scenes) {
    const end = start + Math.round(scene.seconds * 1000);
    lines.push("[CHAPTER]", "TIMEBASE=1/1000", `START=${start}`, `END=${end}`, `title=${scene.chapter.replace(/[=;#\\\n]/g, " ")}`);
    start = end;
  }
  return `${lines.join("\n")}\n`;
}

/** The scenes to record: all, or those `only` names, in walkthrough order. */
export function selectScenes(only: readonly string[] | undefined): Scene[] {
  if (only === undefined) return [...SCENES];
  const unknown = only.filter((id) => !SCENES.some((s) => s.id === id));
  if (unknown.length > 0) throw new Error(`Unknown scene ${unknown.join(", ")}; scenes are ${SCENES.map((s) => s.id).join(", ")}`);
  return SCENES.filter((s) => only.includes(s.id));
}

const run = (command: string, args: string[]) => execFileSync(command, args, { stdio: ["ignore", "pipe", "pipe"] }).toString();
const seconds = (file: string) => Number(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).trim());

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const dir = flag("--cookies");
  if (dir === undefined) throw new Error("usage: record-walkthrough.ts --cookies <dir> [--out <file.mp4>] [--only <scene,…>]");
  const out = flag("--out") ?? join(homedir(), "Movies", `EducateOS-two-school-demo-${new Date().toISOString().slice(0, 10)}.mp4`);
  if (existsSync(out)) throw new Error(`${out} exists; choose a new --out`);
  const scenes = selectScenes(flag("--only")?.split(","));
  for (const scene of scenes) if (!existsSync(join(dir, scene.signIn))) throw new Error(`No cookie file ${join(dir, scene.signIn)} for ${scene.id}`);

  const { chromium } = await import("playwright");
  const work = mkdtempSync(join(tmpdir(), "educateos-walkthrough-"));
  const browser = await chromium.launch();
  const made: { chapter: string; seconds: number; file: string }[] = [];
  try {
    for (const scene of scenes) {
      const audio = join(work, `${scene.id}.aiff`);
      execFileSync("say", ["-v", "Samantha", "-r", "175", "-o", audio, scene.narration]);
      const length = sceneSeconds(seconds(audio));
      const host = new URL(SIGN_INS[scene.signIn]).hostname;
      const value = readFileSync(join(dir, scene.signIn), "utf8").trim().replace(/^CF_Authorization=/, "");
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 }, locale: "en-US",
        recordVideo: { dir: join(work, scene.id), size: { width: 1280, height: 720 } },
      });
      const opened = Date.now();
      await context.addCookies([{ name: "CF_Authorization", value, domain: host, path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
      const page = await context.newPage();
      let url = scene.url;
      if (scene.canvasAs !== undefined) {
        const { consoleActors, railsRunner } = await import("./canvas-actors.ts");
        const token = await consoleActors(railsRunner(), "educateos-demo walkthrough video").session(scene.canvasAs);
        url = `${scene.url}?session_token=${encodeURIComponent(token)}`;
      }
      await page.goto(url, { waitUntil: "domcontentloaded" });
      // Visible text only: a page's navigation often repeats a title, hidden on a narrow screen.
      await page.getByText(scene.ready).filter({ visible: true }).first().waitFor({ timeout: 30_000 });
      if (scene.focus !== undefined) await page.getByText(scene.focus).filter({ visible: true }).first().scrollIntoViewIfNeeded();
      await page.waitForTimeout(800);
      const ready = (Date.now() - opened) / 1000;
      await page.waitForTimeout(length * 1000);
      const video = page.video();
      await context.close();
      const recorded = await video!.path();
      const clip = join(work, `${scene.id}.mp4`);
      // The page's loading is cut; the narration starts on the ready page.
      run("ffmpeg", ["-y", "-ss", ready.toFixed(2), "-i", recorded, "-i", audio, "-t", String(length),
        "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "aac", "-ar", "48000", "-af", "apad", clip]);
      made.push({ chapter: scene.chapter, seconds: length, file: clip });
      console.log(`${scene.id}: ${length}s`);
    }
  } finally {
    await browser.close();
  }
  writeFileSync(join(work, "list.txt"), made.map((m) => `file '${m.file}'`).join("\n"));
  writeFileSync(join(work, "chapters.txt"), chapters(made));
  const joined = join(work, "joined.mp4");
  run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", join(work, "list.txt"), "-i", join(work, "chapters.txt"), "-map_metadata", "1", "-map_chapters", "1", "-c", "copy", joined]);
  renameSync(joined, out);
  rmSync(work, { recursive: true, force: true });
  console.log(`Wrote ${out}: ${made.length} scenes, ${made.reduce((a, m) => a + m.seconds, 0).toFixed(0)}s`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
