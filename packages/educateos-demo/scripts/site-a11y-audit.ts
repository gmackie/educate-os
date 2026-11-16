// The accessibility audit of the educateos.io marketing pages (SCHO-389): every HTML page under
// sites/educateos-io/public except the demo (which `pnpm --filter @educateos/demo a11y` audits), in
// light and dark themes at 1280 and 320 CSS pixels wide. On each it runs axe-core's WCAG 2.0/2.1 A
// and AA rules and measures whether the page scrolls sideways (WCAG 1.4.10), naming what sticks out.
//
//   node sites/educateos-io/build.mjs              (writes the course catalog pages)
//   pnpm --filter @educateos/demo a11y:site [--out <dir>] [--report-only]
//
// It serves the site itself, writes `site-results.json` to the out directory (default
// /tmp/educateos-a11y) and exits 1 on any axe violation or sideways scroll, unless --report-only.
// CHROME names a Chromium to use instead of Playwright's headless shell.
import { createServer } from "node:http";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";

const { values: args } = parseArgs({
  options: {
    out: { type: "string", default: "/tmp/educateos-a11y" },
    "report-only": { type: "boolean", default: false },
  },
});
mkdirSync(args.out, { recursive: true });

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const WIDTHS = [1280, 320];
const THEMES = ["light", "dark"] as const;

const SITE = resolve(import.meta.dirname, "../../../sites/educateos-io/public");
const TYPES: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json",
  ".woff2": "font/woff2", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".pdf": "application/pdf",
};

/** Every page's path, as the site Worker serves it: `index.html` files by their directory. */
const pages = (readdirSync(SITE, { recursive: true }) as string[])
  .filter((file) => file.endsWith(".html") && !file.startsWith("demo/"))
  .map((file) => "/" + relative(SITE, join(SITE, file)).replace(/(^|\/)index\.html$/, "$1"))
  .toSorted();

const server = createServer(async (req, res) => {
  let path = join(SITE, decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname));
  if (!path.startsWith(SITE)) return void res.writeHead(403).end();
  try {
    if ((await stat(path)).isDirectory()) path = join(path, "index.html");
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" }).end(await readFile(path));
  } catch {
    res.writeHead(404).end();
  }
}).listen(0);
await new Promise((ready) => server.once("listening", ready));
const origin = `http://localhost:${(server.address() as { port: number }).port}`;

interface PageResult {
  page: string;
  theme: (typeof THEMES)[number];
  width: number;
  /** How far the page scrolls sideways, in CSS pixels, and the elements that reach past the viewport. */
  overflow: { by: number; offenders: string[] };
  violations: { id: string; impact: string | null; nodes: { target: string; summary: string }[] }[];
}
const results: PageResult[] = [];

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
try {
  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme });
      // Analytics and remote scripts stay off: the audit is of the page, offline.
      await context.route((url) => !url.href.startsWith(origin), (route) => route.abort());
      const page = await context.newPage();
      for (const path of pages) {
        await page.goto(origin + path, { waitUntil: "load" });
        // Measure what a reader sees once the page settles: after the fonts and the `.rise` fade-ins
        // (not the typing cursor's endless blink), which axe would otherwise read half-transparent.
        await page.evaluate(async () => {
          await document.fonts.ready;
          await Promise.all(document.getAnimations()
            .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
            .map((a) => a.finished.catch(() => undefined)));
        });
        const overflow = await page.evaluate(() => {
          const viewport = document.documentElement.clientWidth;
          const offenders = [...document.querySelectorAll("body *")]
            .filter((el) => {
              const box = el.getBoundingClientRect();
              return box.width > 0 && box.right > viewport + 0.5 && getComputedStyle(el).position !== "fixed";
            })
            // Only the outermost offender of each branch, so one wide box names one element.
            .filter((el, _, all) => !all.some((other) => other !== el && other.contains(el)))
            .slice(0, 8)
            .map((el) => `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${el.classList.length ? "." + [...el.classList].join(".") : ""} (right ${Math.round(el.getBoundingClientRect().right)})`);
          return { by: document.documentElement.scrollWidth - viewport, offenders };
        });
        await page.addScriptTag({ content: axeSource });
        const axe = await page.evaluate(
          (tags) => (window as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<{ violations: { id: string; impact: string | null; nodes: { target: string[]; failureSummary?: string }[] }[] }> } }).axe
            .run(document, { runOnly: { type: "tag", values: tags } }),
          WCAG_TAGS,
        );
        const result: PageResult = {
          page: path, theme, width,
          overflow: overflow.by > 0 ? overflow : { by: 0, offenders: [] },
          violations: axe.violations.map((v) => ({
            id: v.id, impact: v.impact,
            nodes: v.nodes.map((n) => ({ target: n.target.join(" "), summary: (n.failureSummary ?? "").split("\n").slice(1).join(" ").trim() })),
          })),
        };
        results.push(result);
        const problems = [
          ...(result.overflow.by > 0 ? [`scrolls sideways by ${result.overflow.by}px: ${result.overflow.offenders.join(", ")}`] : []),
          ...result.violations.map((v) => `${v.id} (${v.impact}) x${v.nodes.length}: ${v.nodes.slice(0, 3).map((n) => n.target).join(" | ")}`),
        ];
        console.log(`${problems.length ? "FAIL" : "ok  "} ${theme.padEnd(5)} ${String(width).padStart(4)} ${path}`);
        for (const problem of problems) console.log(`       ${problem}`);
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}

writeFileSync(join(args.out, "site-results.json"), JSON.stringify(results, null, 2));
const failing = results.filter((r) => r.overflow.by > 0 || r.violations.length > 0);
console.log(`\n${pages.length} pages x ${THEMES.length} themes x ${WIDTHS.length} widths: ${failing.length} of ${results.length} runs failing. Results in ${join(args.out, "site-results.json")}`);
if (failing.length && !args["report-only"]) process.exit(1);
