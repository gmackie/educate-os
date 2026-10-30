import { readFile } from "node:fs/promises";
import { assert, hash, writeJson } from "./io.mjs";

const columns = [
  "Video",
  "Title",
  "Runtime",
  "Scene",
  "Voiceover",
  "Screen_Actions",
  "On_Screen_Text",
  "Editorial_and_Evidence_Gate",
];
/** Parse RFC 4180 quoted commas, newlines, and escaped double quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
        closed = true;
      } else field += c;
    } else if (c === '"') {
      assert(!field && !closed, "Malformed CSV quote");
      quoted = true;
    } else if (c === "," || c === "\n" || c === "\r") {
      row.push(field);
      field = "";
      closed = false;
      if (c !== ",") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        rows.push(row);
        row = [];
      }
    } else {
      assert(!closed, "Unexpected text after CSV quote");
      field += c;
    }
  }
  assert(!quoted, "Unterminated CSV quote");
  if (field || row.length || closed) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
const seconds = (value) => {
  const match = value.match(/^(\d+):(\d\d)(?:$| \()/);
  assert(match, "Invalid runtime");
  const [m, s] = match.slice(1).map(Number);
  assert(s < 60, "Invalid seconds");
  return m * 60 + s;
};
export async function importSources(source, output) {
  const csv = await readFile(new URL("shotlist.csv", source), "utf8");
  const scripts = await readFile(new URL("full-video-scripts.md", source), "utf8");
  const provenance = JSON.parse(await readFile(new URL("provenance.json", source), "utf8"));
  const [header, ...rows] = parseCsv(csv);
  assert(JSON.stringify(header) === JSON.stringify(columns), "Shot-list columns changed");
  const videos = [];
  for (const row of rows) {
    assert(row.length === columns.length && row.every((v) => v.trim()), "Incomplete shot-list row");
    const [id, title, runtime, scene, voiceover, actions, overlay, gate] = row;
    assert(/^V0[1-9]$/.test(id), "Unknown video");
    let video = videos.find((v) => v.id === id);
    if (!video) {
      const start = scripts.indexOf(`# ${id} — `);
      const end = scripts.indexOf("\n# V0", start + 1);
      assert(start >= 0, `Missing full script ${id}`);
      video = {
        id,
        title,
        runtime,
        script: scripts.slice(start, end < 0 ? undefined : end),
        scenes: [],
      };
      videos.push(video);
    }
    assert(video.title === title && video.runtime === runtime, "Inconsistent video metadata");
    const match = scene.match(/^(\d\d:\d\d)[–-](\d\d:\d\d) — (.+)$/);
    assert(match, `Invalid scene timing ${id}`);
    const start = seconds(match[1]);
    const end = seconds(match[2]);
    assert(start === (video.scenes.at(-1)?.end ?? 0) && end > start, "Scene gap/overlap");
    video.scenes.push({
      id: `${id}-S${String(video.scenes.length + 1).padStart(2, "0")}`,
      title: match[3],
      start,
      end,
      voiceover,
      actions,
      overlay,
      gate,
      kind: "illustrative",
      verified: false,
    });
  }
  assert(videos.length === 9 && rows.length === 82, "Expected nine videos and 82 scenes");
  for (const v of videos)
    assert(v.scenes.at(-1).end === seconds(v.runtime), `Runtime mismatch ${v.id}`);
  const manifest = {
    schema: 1,
    source: { ...provenance, csvHash: hash(csv), scriptsHash: hash(scripts) },
    videos,
  };
  await writeJson(output, manifest);
  return manifest;
}
export function selectScenes(manifest, videoId, sceneId) {
  const videos = videoId ? manifest.videos.filter((v) => v.id === videoId) : manifest.videos;
  const scenes = videos.flatMap((v) => v.scenes).filter((s) => !sceneId || s.id === sceneId);
  assert(scenes.length > 0, "No matching scenes");
  return scenes;
}
