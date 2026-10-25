// Keeps the educateos.io pages consistent without a framework (SCHO-229).
//
//   node sites/educateos-io/build.mjs          stamp partials/header.html and footer.html into every page
//   node sites/educateos-io/build.mjs --check  exit 1 if any page's header or footer is out of date
//   node sites/educateos-io/build.mjs --pdf    also print pdf/district-overview.html to
//                                              public/educateos-district-overview.pdf with Chrome
//
// Each page marks where the shared markup goes with <!-- site:header --> ... <!-- /site:header -->
// and the same for footer. The link to the page being stamped gets aria-current="page".
//
// Integration feature statuses live in public/assets/integration-status.json. Every
// <span class="status ..." data-status="key">...</span> is stamped from it here, so the page reads
// correctly without JavaScript, and /assets/integration-status.js re-renders the chips from the
// same file in the browser. Raising a status is a one-line JSON change plus a rebuild.

import {execFileSync} from "node:child_process";
import {existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join, relative, sep} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const publicDir = join(root, "public");
const partials = {
  header: readFileSync(join(root, "partials/header.html"), "utf8").trim(),
  footer: readFileSync(join(root, "partials/footer.html"), "utf8").trim(),
};

const statuses = JSON.parse(readFileSync(join(publicDir, "assets/integration-status.json"), "utf8"));

function chip(key, path) {
  const level = statuses.levels[statuses.features[key]];
  if (!level) throw new Error(`${path}: data-status="${key}" has no level in integration-status.json`);
  return `<span class="status ${level.class}" data-status="${key}">${level.label}</span>`;
}

function htmlFiles(dir) {
  return readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return htmlFiles(path);
    return entry.name.endsWith(".html") ? [path] : [];
  });
}

// public/connectors/index.html is served at /connectors/ (html_handling: auto-trailing-slash).
function urlPath(file) {
  const rel = relative(publicDir, file).split(sep).join("/");
  return "/" + rel.replace(/(^|\/)index\.html$/, "$1").replace(/\.html$/, "");
}

function stamp(html, path) {
  for (const [name, markup] of Object.entries(partials)) {
    const marked = new RegExp(`<!-- site:${name} -->[\\s\\S]*?<!-- /site:${name} -->`);
    if (!marked.test(html)) throw new Error(`${path}: missing <!-- site:${name} --> markers`);
    const current = markup.replaceAll(`<a href="${path}">`, `<a href="${path}" aria-current="page">`);
    html = html.replace(marked, () => `<!-- site:${name} -->\n${current}\n<!-- /site:${name} -->`);
  }
  return html.replace(/<span class="status[^"]*" data-status="([^"]+)">[^<]*<\/span>/g, (_, key) => chip(key, path));
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

if (process.argv.includes("--pdf")) {
  const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const out = join(publicDir, "educateos-district-overview.pdf");
  // A throwaway profile, so headless Chrome never attaches to a browser the user already has open.
  const profile = mkdtempSync(join(tmpdir(), "educateos-pdf-"));
  const started = Date.now();
  try {
    execFileSync(chrome, [
      "--headless=new",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--disable-gpu",
      "--no-pdf-header-footer",
      `--print-to-pdf=${out}`,
      pathToFileURL(join(root, "pdf/district-overview.html")).href,
    ], {stdio: "ignore", timeout: 30_000, killSignal: "SIGKILL"});
  } catch (error) {
    // Desktop Chrome sometimes writes the PDF and then never exits. Accept a PDF written by this run.
    if (!existsSync(out) || statSync(out).mtimeMs < started) throw error;
  } finally {
    rmSync(profile, {recursive: true, force: true});
  }
  console.log(`Wrote ${relative(root, out)}`);
}
