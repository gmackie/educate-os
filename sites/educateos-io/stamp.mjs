// The shared markup every educateos.io page carries (SCHO-229), for build.mjs and the pages it
// generates (catalog.mjs). See build.mjs for the markers and the integration status chips.

import {readFileSync} from "node:fs";
import {dirname, join, relative, sep} from "node:path";
import {fileURLToPath} from "node:url";

export const root = dirname(fileURLToPath(import.meta.url));
export const publicDir = join(root, "public");

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

/** The URL a file in public/ is served at: public/connectors/index.html is /connectors/ (html_handling: auto-trailing-slash). */
export function urlPath(file) {
  const rel = relative(publicDir, file).split(sep).join("/");
  return "/" + rel.replace(/(^|\/)index\.html$/, "$1").replace(/\.html$/, "");
}

/** Stamps the header, footer and status chips into a page served at `path`. */
export function stamp(html, path) {
  for (const [name, markup] of Object.entries(partials)) {
    const marked = new RegExp(`<!-- site:${name} -->[\\s\\S]*?<!-- /site:${name} -->`);
    if (!marked.test(html)) throw new Error(`${path}: missing <!-- site:${name} --> markers`);
    const current = markup.replaceAll(`<a href="${path}">`, `<a href="${path}" aria-current="page">`);
    html = html.replace(marked, () => `<!-- site:${name} -->\n${current}\n<!-- /site:${name} -->`);
  }
  // Marketing analytics stays disabled until observe.gmac.io is healthy and registered.
  // Exclude demos, intake, operator and district surfaces even if a shared layout is reused.
  html = html.replace(/<!-- site:analytics -->[\s\S]*?<!-- \/site:analytics -->\n?/g, "");
  if (/^\/(?:$|teachers\/?$|leaders\/?$|families\/?$|developers(?:\/.*)?$|gadgets(?:\/.*)?$|connectors(?:\/.*)?$|pricing\/?$|privacy\/?$)/.test(path)) {
    html = html.replace("</body>", '<!-- site:analytics --><script defer src="/assets/dataflare.js" data-enabled="false"></script><!-- /site:analytics -->\n</body>');
  }
  return html.replace(/<span class="status[^"]*" data-status="([^"]+)">[^<]*<\/span>/g, (_, key) => chip(key, path));
}
