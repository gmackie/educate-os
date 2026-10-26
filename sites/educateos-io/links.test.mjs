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

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "public");

// public/demo/ is the in-browser demo (SCHO-224), which packages/educateos-demo builds there and git
// ignores. Its pages are the app's, not the site's, and a link to it resolves to the app's source
// page, so the check gives the same answer whether or not the demo has been built.
const DEMO = {dir: join(publicDir, "demo"), source: join(publicDir, "../../../packages/educateos-demo/index.html")};

function htmlFiles(dir) {
  return readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (path === DEMO.dir) return [];
    if (entry.isDirectory()) return htmlFiles(path);
    return entry.name.endsWith(".html") ? [path] : [];
  });
}

function isFile(path) {
  return existsSync(path) && statSync(path).isFile();
}

function resolveTarget(pathname) {
  if (pathname === "/demo/") return isFile(DEMO.source) ? DEMO.source : null;
  const local = join(publicDir, decodeURIComponent(pathname));
  if (pathname.endsWith("/")) return isFile(join(local, "index.html")) ? join(local, "index.html") : null;
  for (const candidate of [local, `${local}.html`, join(local, "index.html")]) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}

function ids(file) {
  return new Set([...readFileSync(file, "utf8").matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
}

function pagePath(file) {
  const rel = relative(publicDir, file).split(sep).join("/");
  return "/" + rel.replace(/(^|\/)index\.html$/, "$1");
}

const pages = htmlFiles(publicDir);

test("the site has pages to check", () => {
  assert.ok(pages.length > 1);
});

for (const page of pages) {
  test(`links on ${relative(publicDir, page)} resolve`, () => {
    const html = readFileSync(page, "utf8").replace(/<!--[\s\S]*?-->/g, "");
    const base = new URL(pagePath(page), "https://educateos.io");
    const broken = [];
    for (const [, ref] of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
      if (/^(?:mailto:|data:|tel:|javascript:)/i.test(ref)) continue;
      const url = new URL(ref, base);
      if (url.hostname !== "educateos.io") continue;
      const target = resolveTarget(url.pathname);
      if (!target) {
        broken.push(`${ref} (no file for ${url.pathname})`);
        continue;
      }
      const fragment = decodeURIComponent(url.hash.slice(1));
      if (fragment && target.endsWith(".html") && !ids(target).has(fragment)) {
        broken.push(`${ref} (no id="${fragment}" on ${relative(publicDir, target)})`);
      }
    }
    assert.deepEqual(broken, [], `Broken internal links on ${relative(publicDir, page)}`);
  });
}
