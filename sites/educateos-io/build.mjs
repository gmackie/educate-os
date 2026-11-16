// Keeps the educateos.io pages consistent without a framework (SCHO-229).
//
//   node sites/educateos-io/build.mjs          stamp partials/header.html and footer.html into every page
//   node sites/educateos-io/build.mjs --check  exit 1 if any page's header or footer is out of date
//   node sites/educateos-io/build.mjs --pdf    also print, with Chrome, pdf/district-overview.html to
//                                              public/educateos-district-overview.pdf, each leave-behind
//                                              under public/pilot/brief/ to the PDF beside it, and
//                                              docs/educateos/sales/meeting-deck.html to meeting-deck.pdf
//
// Each page marks where the shared markup goes with <!-- site:header --> ... <!-- /site:header -->
// and the same for footer. The link to the page being stamped gets aria-current="page".
//
// Integration feature statuses live in public/assets/integration-status.json. Every
// <span class="status ..." data-status="key">...</span> is stamped from it here, so the page reads
// correctly without JavaScript, and /assets/integration-status.js re-renders the chips from the
// same file in the browser. Raising a status is a one-line JSON change plus a rebuild.
//
// Every run, --check included, also writes the course catalog (SCHO-333) into public/courses/,
// which git ignores: catalog.mjs renders it from the signed bundles under curriculum/, so a course
// merged there is on educateos.io/courses/ after the next deploy, with no page to edit.

import {execFile} from "node:child_process";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from "node:fs";
import {createServer} from "node:http";
import {tmpdir} from "node:os";
import {dirname, extname, join, relative} from "node:path";
import {pathToFileURL} from "node:url";
import {promisify} from "node:util";
import {CATALOG_DIR, renderCatalog} from "./catalog.mjs";
import {publicDir, root, stamp, urlPath} from "./stamp.mjs";

// public/demo/ is the in-browser demo (SCHO-224): an app that packages/educateos-demo builds there
// (gitignored), not a page of the site, so it carries no header or footer to stamp. public/courses/
// is the course catalog (SCHO-333), which this script generates below, stamped as it is written.
const execFileAsync = promisify(execFile);

// The one-page leave-behinds (SCHO-405): public/pilot/brief/<audience>/ and the PDF printed beside it.
const BRIEFS = ["superintendents", "principals", "teachers", "it"];
const CONTENT_TYPES = {".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".webp": "image/webp", ".png": "image/png", ".woff2": "font/woff2"};

const GENERATED = new Set([join(publicDir, "demo"), join(publicDir, CATALOG_DIR)]);

function htmlFiles(dir) {
  return readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (GENERATED.has(path)) return [];
    if (entry.isDirectory()) return htmlFiles(path);
    return entry.name.endsWith(".html") ? [path] : [];
  });
}

const check = process.argv.includes("--check");
const stale = [];
for (const file of htmlFiles(publicDir)) {
  const before = readFileSync(file, "utf8");
  const after = stamp(before, urlPath(file));
  if (after === before) continue;
  if (check) stale.push(relative(root, file));
  else writeFileSync(file, after);
}
if (stale.length > 0) {
  console.error(`Out of date, run node sites/educateos-io/build.mjs:\n  ${stale.join("\n  ")}`);
  process.exit(1);
}

// The course catalog is generated on every run, --check included, because it is not committed:
// the deploy's build runs --check, so a course merged under curriculum/ is on the next deploy.
const catalogDir = join(publicDir, CATALOG_DIR);
const catalog = await renderCatalog();
rmSync(catalogDir, {recursive: true, force: true});
for (const [path, content] of catalog) {
  mkdirSync(dirname(join(publicDir, path)), {recursive: true});
  writeFileSync(join(publicDir, path), content);
}
const coursePages = [...catalog.keys()].filter((path) => path.endsWith("/index.html")).length - 1;
console.log(`Wrote the course catalog to ${relative(root, catalogDir)}/: ${coursePages} course page${coursePages === 1 ? "" : "s"}`);

if (process.argv.includes("--pdf")) {
  const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  /** Prints the page at `url` to `out` with headless Chrome. */
  const printPdf = async (url, out) => {
    // A throwaway profile, so headless Chrome never attaches to a browser the user already has open.
    const profile = mkdtempSync(join(tmpdir(), "educateos-pdf-"));
    const started = Date.now();
    try {
      await execFileAsync(chrome, [
        "--headless=new",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--disable-gpu",
        "--no-pdf-header-footer",
        `--print-to-pdf=${out}`,
        url,
      ], {stdio: "ignore", timeout: 30_000, killSignal: "SIGKILL"});
    } catch (error) {
      // Desktop Chrome sometimes writes the PDF and then never exits. Accept a PDF written by this run.
      if (!existsSync(out) || statSync(out).mtimeMs < started) throw error;
    } finally {
      rmSync(profile, {recursive: true, force: true});
    }
    console.log(`Wrote ${relative(root, out)}`);
  };

  await printPdf(pathToFileURL(join(root, "pdf/district-overview.html")).href, join(publicDir, "educateos-district-overview.pdf"));

  // The leave-behinds (SCHO-405) are printed from their own pages, which load /assets/ by absolute
  // path, so they are served from public/ on a local port. Analytics is never served here, so
  // printing records nothing.
  const server = createServer(async (request, response) => {
    let path = join(publicDir, decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname));
    if (!path.startsWith(publicDir) || /\/assets\/(?:dataflare|journey)\.js$/.test(path)) return void response.writeHead(404).end();
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
    if (!existsSync(path)) return void response.writeHead(404).end();
    response.writeHead(200, {"content-type": CONTENT_TYPES[extname(path)] ?? "application/octet-stream"}).end(readFileSync(path));
  });
  await new Promise((listening) => server.listen(0, "127.0.0.1", listening));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const audience of BRIEFS) {
      if (!existsSync(join(publicDir, `pilot/brief/${audience}/index.html`))) throw new Error(`No leave-behind page for ${audience}`);
      await printPdf(`${origin}/pilot/brief/${audience}/`, join(publicDir, `pilot/brief/${audience}/educateos-brief-${audience}.pdf`));
    }
  } finally {
    server.close();
  }

  // The school meeting deck (docs/educateos/sales/) is not part of the site; it is self-contained.
  const deck = join(root, "../../docs/educateos/sales/meeting-deck.html");
  await printPdf(pathToFileURL(deck).href, deck.replace(/\.html$/, ".pdf"));
}
