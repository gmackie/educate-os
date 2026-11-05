// Every internal link and asset on educateos.io must resolve to a file in public/, and every
// #fragment must name an id on the target page (SCHO-229). Run: node --test sites/educateos-io/links.test.mjs
//
// Resolution follows the Worker's assets config (html_handling: auto-trailing-slash): /x/ serves
// x/index.html, and /x serves x.html or x/index.html.

import assert from "node:assert/strict";
import {existsSync, readFileSync, readdirSync, statSync} from "node:fs";
import {dirname, join, relative, sep} from "node:path";
import {test} from "node:test";
import {fileURLToPath} from "node:url";
import {CATALOG_DIR, renderCatalog} from "./catalog.mjs";
import {DYNAMIC_PATHS} from "../../packages/educateos-control-plane/src/app.ts";

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "public");

// public/demo/ is the in-browser demo (SCHO-224), which packages/educateos-demo builds there and git
// ignores. Its pages are the app's, not the site's, and a link to it resolves to the app's source
// page, so the check gives the same answer whether or not the demo has been built.
const DEMO = {dir: join(publicDir, "demo"), source: join(publicDir, "../../../packages/educateos-demo/index.html")};

// public/courses/ is the course catalog (SCHO-333), which build.mjs generates from curriculum/ and
// git ignores. It is rendered here in memory, so the check covers the catalog as the next build
// would write it, whether or not public/courses/ exists or is stale.
const CATALOG = {dir: join(publicDir, CATALOG_DIR), files: new Map([...await renderCatalog()].map(([path, content]) => [join(publicDir, path), content]))};
const read = (file) => CATALOG.files.get(file) ?? readFileSync(file, "utf8");

function htmlFiles(dir) {
  return readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (path === DEMO.dir || path === CATALOG.dir) return [];
    if (entry.isDirectory()) return htmlFiles(path);
    return entry.name.endsWith(".html") ? [path] : [];
  });
}

function isFile(path) {
  if (path.startsWith(CATALOG.dir + sep)) return CATALOG.files.has(path);
  return existsSync(path) && statSync(path).isFile();
}

// The paths the site Worker serves itself (run_worker_first, site-config.test.mjs), such as the guided
// install at /app/install (SCHO-340): a link to one resolves to the Worker, not a file.
const WORKER = "worker";
const isWorkerPath = (pathname) => DYNAMIC_PATHS.some((path) => (path.endsWith("/*") ? pathname.startsWith(path.slice(0, -1)) : pathname === path));

function resolveTarget(pathname) {
  if (isWorkerPath(pathname)) return WORKER;
  if (pathname === "/demo/") return isFile(DEMO.source) ? DEMO.source : null;
  const local = join(publicDir, decodeURIComponent(pathname));
  if (pathname.endsWith("/")) return isFile(join(local, "index.html")) ? join(local, "index.html") : null;
  for (const candidate of [local, `${local}.html`, join(local, "index.html")]) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}

function ids(file) {
  return new Set([...read(file).matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
}

function pagePath(file) {
  const rel = relative(publicDir, file).split(sep).join("/");
  return "/" + rel.replace(/(^|\/)index\.html$/, "$1");
}

const pages = [...htmlFiles(publicDir), ...[...CATALOG.files.keys()].filter((file) => file.endsWith(".html"))];

test("the site has pages to check", () => {
  assert.ok(pages.length > 1);
});

for (const page of pages) {
  test(`links on ${relative(publicDir, page)} resolve`, () => {
    const html = read(page).replace(/<!--[\s\S]*?-->/g, "");
    const base = new URL(pagePath(page), "https://educateos.io");
    const broken = [];
    for (const [, ref] of html.matchAll(/\s(?:href|src|poster)="([^"]+)"/g)) {
      if (/^(?:mailto:|data:|tel:|javascript:)/i.test(ref)) continue;
      const url = new URL(ref, base);
      if (url.hostname !== "educateos.io") continue;
      const target = resolveTarget(url.pathname);
      if (!target) {
        broken.push(`${ref} (no file for ${url.pathname})`);
        continue;
      }
      const fragment = decodeURIComponent(url.hash.slice(1));
      if (fragment && target !== WORKER && target.endsWith(".html") && !ids(target).has(fragment)) {
        broken.push(`${ref} (no id="${fragment}" on ${relative(publicDir, target)})`);
      }
    }
    assert.deepEqual(broken, [], `Broken internal links on ${relative(publicDir, page)}`);
  });
}

// The demo videos (SCHO-343): each offers WebM then MP4, English captions and a poster, never plays
// with sound on its own, and every file fits the Workers static-asset limit of 25 MiB a file.
const ASSET_LIMIT = 25 * 1024 * 1024;
const videos = pages.flatMap((page) => [...read(page).replace(/<!--[\s\S]*?-->/g, "").matchAll(/<video\b([^>]*)>([\s\S]*?)<\/video>/g)].map((m) => ({page, attrs: m[1], body: m[2]})));

test("the site embeds the demo videos", () => {
  assert.ok(videos.length > 0);
});

for (const [i, {page, attrs, body}] of videos.entries()) {
  test(`video ${i + 1} on ${relative(publicDir, page)} has both formats, captions and a poster under the size limit`, () => {
    const sources = [...body.matchAll(/<source\s[^>]*src="([^"]+)"[^>]*type="([^"]+)"/g)].map((m) => [m[2], m[1]]);
    assert.deepEqual(sources.map(([type]) => type), ["video/webm", "video/mp4"], "WebM first, then MP4");
    assert.match(body, /<track\s[^>]*kind="captions"[^>]*srclang="en"[^>]*src="[^"]+\.vtt"/);
    assert.match(attrs, /\sposter="[^"]+"/);
    assert.match(attrs, /\splaysinline\b/);
    assert.ok(/\scontrols\b/.test(attrs) || /\smuted\b/.test(attrs), "a video either has controls or is muted");
    assert.ok(!/\sautoplay\b/.test(attrs) || /\smuted\b/.test(attrs), "nothing autoplays with sound");
    assert.ok(/aria-label(?:ledby)?="/.test(attrs), "a video has an accessible name");
    const files = [...`${attrs} ${body}`.matchAll(/\s(?:src|poster)="(\/assets\/videos\/[^"]+)"/g)].map((m) => join(publicDir, m[1]));
    for (const file of files) {
      assert.ok(isFile(file), `${relative(publicDir, file)} exists`);
      assert.ok(statSync(file).size < ASSET_LIMIT, `${relative(publicDir, file)} is under 25 MiB`);
    }
    const vtt = files.find((file) => file.endsWith(".vtt"));
    assert.match(readFileSync(vtt, "utf8"), /^WEBVTT\n\n1\n\d\d:\d\d:\d\d\.\d{3} --> /);
  });
}
