// The accessibility audit of the demo's district UIs (SCHO-361): every persona on the Northfield
// picker, each of the main screens their app's navigation reaches, in light and dark themes and at
// 320 CSS pixels wide. It runs axe-core's WCAG 2.0/2.1 A and AA rules on each screen, and adds the
// checks axe can't make on its own: where the keyboard goes and whether focus shows, and whether a
// screen reflows at 320px without scrolling sideways.
//
//   pnpm exec vp run -F @educateos/demo build     (writes the demo into sites/educateos-io/public/demo)
//   pnpm --filter @educateos/demo a11y [--out <dir>] [--persona <role substring>] [--pass light|dark|narrow] [--report-only]
//
// It serves the built demo itself, writes `results.json` and `summary.md` to the out directory
// (default /tmp/educateos-a11y), and exits 1 if any screen has a serious or critical axe violation,
// unless --report-only. CHROME names a Chromium to use instead of Playwright's headless shell.
// docs/educateos/accessibility.md is the report written from its results.
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Page } from "playwright";

const { values: args } = parseArgs({
  options: {
    out: { type: "string", default: "/tmp/educateos-a11y" },
    persona: { type: "string" },
    pass: { type: "string" },
    "report-only": { type: "boolean", default: false },
  },
});
const out = args.out;
mkdirSync(out, { recursive: true });

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const axeVersion = (JSON.parse(readFileSync(require.resolve("axe-core/package.json"), "utf8")) as { version: string }).version;
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
/** The demo's own theme setting, which every persona's app reads (see DemoApp's THEME). */
const THEME_KEY = "educateos:theme-mode";
/** How many screens past its home the audit opens for one persona. */
const MAX_SCREENS = 15;
/** Hash routes of the critical flows' screens, which the walk opens wherever a screen links to one. */
const CRITICAL_FLOWS = [
  /\/courses\/[^/]+\/activities\/[^/]+$/,
  /\/courses\/[^/]+\/quizzes\/[^/]+$/,
  /\/classes\/[^/]+\/assignments\/[^/]+$/,
  /\/assignments\/[^/]+\/submissions\/[^/]+$/,
  /\/quizzes\/[^/]+\/results$/,
  /^#\/notifications$/,
  /^#\/settings$/,
];
/** How many Tab presses the keyboard walk makes before it gives up on returning to its start. */
const MAX_TABS = 120;

// The built demo, served the way the site Worker serves it: under /demo/.
const SITE = resolve(import.meta.dirname, "../../../sites/educateos-io/public");
const TYPES: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json",
  ".wasm": "application/wasm", ".woff2": "font/woff2", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg",
};
const server = createServer(async (req, res) => {
  let path = join(SITE, decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname));
  if (!path.startsWith(SITE)) return void res.writeHead(403).end();
  try {
    if ((await stat(path)).isDirectory()) path = join(path, "index.html");
    const body = await readFile(path);
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(0);
await new Promise((ready) => server.once("listening", ready));
const origin = `http://localhost:${(server.address() as { port: number }).port}`;
try {
  await stat(join(SITE, "demo/index.html"));
} catch {
  throw new Error("No built demo: run `pnpm exec vp run -F @educateos/demo build` first.");
}

interface Violation { id: string; impact: string | null; help: string; tags: string[]; nodes: { target: string; summary: string }[] }
interface ScreenResult {
  persona: string;
  screen: string;
  hash: string;
  pass: "light" | "dark" | "narrow";
  violations: Violation[];
  /** Rules axe couldn't decide, with why (contrast over images or gradients, mostly), for manual review. */
  incomplete: { id: string; nodes: number; reasons: string[] }[];
  h1: number;
  /** The document title, which names the screen (WCAG 2.4.2). */
  title: string;
  liveRegions: number;
  /** At 320px: how far the page scrolls sideways, and what sticks out. */
  overflow?: { scrollWidth: number; offenders: string[] };
  /** Form controls whose boundary is under 3:1 against what's around them (WCAG 1.4.11). */
  controlContrast?: { control: string; ratio: number }[];
  /** Text a WCAG 1.4.12 spacing override clips, in the light pass. */
  spacingClipped?: string[];
}
interface FocusStop { name: string; role: string; visible: boolean; inView: boolean }
interface KeyboardResult { persona: string; screen: string; stops: FocusStop[]; cycled: boolean; skipLinkIndex: number }

/** Whether an action's outcome reached a live region, so a screen reader says it (WCAG 4.1.3). */
interface StatusResult { persona: string; action: string; announced: string[] }

const results: ScreenResult[] = [];
const keyboard: KeyboardResult[] = [];
const statuses: StatusResult[] = [];

/**
 * Does `act`, then reports what live regions said in the next two seconds: text added or changed
 * inside role=status, alert or log, or an aria-live region, including an alert added whole.
 */
const announcedBy = async (page: Page, persona: string, action: string, act: () => Promise<unknown>) => {
  await page.evaluate(() => {
    const said: string[] = [];
    (window as unknown as { __said: string[] }).__said = said;
    const LIVE = "[role=status], [role=alert], [role=log], [aria-live]:not([aria-live=off])";
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        const target = m.target instanceof Element ? m.target : m.target.parentElement;
        const live = target?.closest(LIVE) ?? [...m.addedNodes].find((n): n is Element => n instanceof Element && n.matches(LIVE));
        const text = live?.textContent?.trim();
        if (text) said.push(text.slice(0, 80));
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    (window as unknown as { __stopListening: () => void }).__stopListening = () => observer.disconnect();
  });
  let failed: string | undefined;
  await act().catch((error: unknown) => { failed = error instanceof Error ? error.message.split("\n")[0] : String(error); });
  await page.waitForTimeout(2000);
  const said = await page.evaluate(() => {
    (window as unknown as { __stopListening: () => void }).__stopListening();
    return [...new Set((window as unknown as { __said: string[] }).__said)];
  });
  const result = { persona, action, announced: failed === undefined ? said : [`(could not act: ${failed})`] };
  statuses.push(result);
  console.log(`  [status] ${action}: ${result.announced.length === 0 ? "NOTHING ANNOUNCED" : result.announced.join(" | ")}`);
};

/** The status checks each persona gets, on its home screen and on the screen named, if visited. */
const STATUS_CHECKS: { persona: RegExp; screen: string; action: string; act: (page: Page) => Promise<unknown> }[] = [
  {
    persona: /./,
    screen: "Home",
    action: "Switch the theme",
    // Twice, so the pass goes on in the theme it started in.
    act: async (page) => {
      const toggle = page.getByRole("button", { name: /^Theme:/ }).first();
      await toggle.click({ timeout: 5000 });
      await page.waitForTimeout(300);
      await toggle.click({ timeout: 5000 });
    },
  },
  { persona: /teacher/, screen: "Discussions", action: "Pin a discussion", act: async (page) => {
    const pin = page.getByRole("button", { name: /^Pin\b/ });
    if ((await pin.count()) === 0) throw new Error("the class has no discussion to pin");
    await pin.first().click({ timeout: 5000 });
  } },
  { persona: /administrator/, screen: "Manage classes and people", action: "Make a staff member an administrator", act: (page) => page.getByRole("button", { name: /^Make administrator:/ }).first().click({ timeout: 5000 }) },
];

/**
 * WCAG 1.4.11 for form controls: a text field's, checkbox's, radio's or switch's boundary (its border,
 * or its fill where it has no border) against the surface behind it. Run in the page; returns those
 * under 3:1. Colours with alpha are composited over the surface; gradients aren't handled.
 */
const CONTROL_CONTRAST = () => {
  const rgb = (c: string): [number, number, number, number] | undefined => {
    const m = /rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:[, /]+([\d.]+))?/.exec(c);
    if (m !== null) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
    // Chromium reports oklch() and color() as they were written; resolve through a canvas.
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.fillStyle = "#000";
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return [r!, g!, b!, a! / 255];
  };
  const lum = ([r, g, b]: number[]) => {
    const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
  };
  const over = (top: number[], under: number[]) => top.slice(0, 3).map((v, i) => v * top[3]! + under[i]! * (1 - top[3]!));
  const surface = (el: Element | null): number[] => {
    for (let e = el; e !== null; e = e.parentElement) {
      const c = rgb(getComputedStyle(e).backgroundColor);
      if (c !== undefined && c[3] > 0.5) return c.slice(0, 3);
    }
    return [255, 255, 255];
  };
  const ratio = (a: number[], b: number[]) => {
    const [x, y] = [lum(a), lum(b)].toSorted((p, q) => q - p);
    return (x! + 0.05) / (y! + 0.05);
  };
  const under: { control: string; ratio: number }[] = [];
  const controls = document.querySelectorAll('input:not([type=hidden]):not([type=file]), textarea, select, [role=checkbox], [role=radio], [role=switch], [role=combobox]');
  for (const el of controls) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || (el as HTMLInputElement).disabled) continue;
    const s = getComputedStyle(el);
    // A component's own hidden native input, such as a Select's, is not what anyone sees.
    if (s.opacity === "0" || s.visibility === "hidden" || el.closest("[aria-hidden=true]") !== null) continue;
    const behind = surface(el.parentElement);
    const fill = rgb(s.backgroundColor)!;
    const border = parseFloat(s.borderTopWidth) > 0 ? rgb(s.borderTopColor)! : undefined;
    // Kumo draws a control's boundary as a ring: a box-shadow layer with a spread and no blur.
    const rings = [...s.boxShadow.matchAll(/((?:rgba?|oklch|color)\([^)]*\))\s+-?[\d.]+px\s+-?[\d.]+px\s+([\d.]+)px\s+([\d.]+)px/g)]
      .filter((m) => Number(m[3]) > 0 && Number(m[2]) === 0)
      .map((m) => rgb(m[1]!));
    const candidates = [border, ...rings, fill].filter((c): c is [number, number, number, number] => c !== undefined && c[3] > 0);
    const best = Math.max(0, ...candidates.map((c) => ratio(over(c, behind), behind)));
    // A native checkbox or radio is drawn by the browser; its own palette isn't in computed style.
    if (/^(checkbox|radio)$/.test((el as HTMLInputElement).type) && s.appearance !== "none") continue;
    if (best < 3) {
      const name = el.getAttribute("aria-label") ?? (el as HTMLInputElement).labels?.[0]?.textContent ?? el.getAttribute("placeholder") ?? "";
      under.push({ control: `${el.getAttribute("role") ?? el.tagName.toLowerCase()} "${name.trim().slice(0, 30)}"`, ratio: Math.round(best * 100) / 100 });
    }
  }
  return under;
};

/**
 * WCAG 1.4.12: applies the success criterion's spacing (line height 1.5, paragraph spacing 2em,
 * letter spacing 0.12em, word spacing 0.16em), then lists text that a box with hidden overflow now
 * cuts off. Run in the page; removes the override before it returns.
 */
const TEXT_SPACING = () => {
  const style = document.createElement("style");
  style.textContent = "* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }";
  document.head.append(style);
  const clipped: string[] = [];
  for (const el of document.querySelectorAll<HTMLElement>("body *")) {
    const s = getComputedStyle(el);
    // Only a box that hides overflow in that direction clips; one that scrolls lets the text be reached.
    const clipsX = /hidden|clip/.test(s.overflowX) && s.textOverflow !== "ellipsis";
    const clipsY = /hidden|clip/.test(s.overflowY);
    if ((!clipsX && !clipsY) || el.textContent?.trim() === "" || el.closest(".sr-only") !== null) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if ((clipsY && el.scrollHeight > el.clientHeight + 2) || (clipsX && el.scrollWidth > el.clientWidth + 2)) {
      clipped.push(`${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 40)}"`);
    }
  }
  style.remove();
  return clipped.slice(0, 10);
};

const settle = async (page: Page) => {
  // A pointer left over a link would audit its hover colour, not its colour.
  await page.mouse.move(0, 0);
  // The district runs in the page, so "loaded" is when its loaders have gone and the DOM is still.
  await page.waitForFunction(() => document.querySelectorAll('[role="status"] [class*="animate-spin"], [aria-busy="true"]').length === 0, null, { timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(700);
};

const audit = async (page: Page, base: Pick<ScreenResult, "persona" | "screen" | "hash" | "pass">) => {
  await page.evaluate(axeSource);
  const raw = await page.evaluate(async (tags) => {
    // axe is injected above; its types aren't in this page's scope.
    const axe = (window as unknown as { axe: { run: (context: Document, options: object) => Promise<{ violations: { id: string; impact: string | null; help: string; tags: string[]; nodes: { target: string[]; failureSummary?: string }[] }[]; incomplete: { id: string; nodes: { any: { data?: { messageKey?: string } | null }[] }[] }[] }> } }).axe;
    const r = await axe.run(document, { runOnly: { type: "tag", values: tags }, resultTypes: ["violations", "incomplete"] });
    return {
      violations: r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, tags: v.tags, nodes: v.nodes.map((n) => ({ target: n.target.join(" "), summary: (n.failureSummary ?? "").split("\n").slice(0, 3).join(" ") })) })),
      incomplete: r.incomplete.map((i) => ({ id: i.id, nodes: i.nodes.length, reasons: [...new Set(i.nodes.map((n) => n.any[0]?.data?.messageKey ?? "unspecified"))] })),
      h1: document.querySelectorAll("h1, [role=heading][aria-level='1']").length,
      title: document.title,
      liveRegions: document.querySelectorAll("[role=status], [role=alert], [role=log], [aria-live]:not([aria-live=off])").length,
    };
  }, WCAG_TAGS);
  const result: ScreenResult = { ...base, ...raw };
  if (base.pass === "narrow") {
    result.overflow = await page.evaluate(() => {
      const width = document.documentElement.clientWidth;
      const offenders = [...document.querySelectorAll("body *")]
        .filter((e) => {
          const r = e.getBoundingClientRect();
          if (r.width === 0 || r.right <= width + 1) return false;
          // Only the outermost element that sticks out, and not one inside a scroll container of its own.
          for (let p = e.parentElement; p !== null; p = p.parentElement) {
            const s = getComputedStyle(p);
            if (/(auto|scroll|hidden)/.test(s.overflowX) && p !== document.body && p !== document.documentElement) return false;
            if (p.getBoundingClientRect().right > width + 1) return false;
          }
          return true;
        })
        .slice(0, 5)
        .map((e) => `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ""}${e.getAttribute("role") ? `[role=${e.getAttribute("role")}]` : ""} "${(e.textContent ?? "").trim().slice(0, 40)}"`);
      // Nothing in flow sticks out: then it's something positioned outside the scroller that clips it.
      const positioned = offenders.length > 0 ? [] : [...document.querySelectorAll("body *")]
        .filter((e) => /absolute|fixed/.test(getComputedStyle(e).position) && e.getBoundingClientRect().right > width + 1)
        .slice(0, 3)
        .map((e) => `positioned ${e.tagName.toLowerCase()}.${String(e.getAttribute("class")).split(" ")[0]} "${(e.textContent ?? "").trim().slice(0, 30)}"`);
      return { scrollWidth: document.documentElement.scrollWidth - width, offenders: [...offenders, ...positioned] };
    });
  } else {
    result.controlContrast = await page.evaluate(CONTROL_CONTRAST);
  }
  if (base.pass === "light") result.spacingClipped = await page.evaluate(TEXT_SPACING);
  results.push(result);
  const counts = result.violations.map((v) => `${v.id}(${v.impact}×${v.nodes.length})`).join(" ");
  const extra = [
    result.overflow && result.overflow.scrollWidth > 0 ? `scrolls sideways ${result.overflow.scrollWidth}px` : "",
    result.controlContrast?.length ? `${result.controlContrast.length} controls under 3:1` : "",
    result.spacingClipped?.length ? `${result.spacingClipped.length} clipped by text spacing` : "",
  ].filter(Boolean);
  console.log(`  [${base.pass}] ${base.screen}: ${result.violations.length === 0 ? "no violations" : counts}${extra.map((e) => ` · ${e}`).join("")}`);
};

/**
 * The links a screen offers onward: its app's navigation (links to hash routes, outside the demo's
 * banner), then the first thing its main content leads into, such as a class or an activity.
 */
const linksOn = async (page: Page) =>
  page.evaluate((flows) => {
    const links: { name: string; hash: string; flow?: number }[] = [];
    const add = (a: HTMLAnchorElement, flow?: number) => {
      const hash = new URL(a.href).hash;
      if (!hash.startsWith("#/") || a.closest('header[aria-label="Demo"]')) return;
      const name = (a.getAttribute("aria-label") ?? a.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40) || hash;
      links.push({ name, hash, ...(flow === undefined ? {} : { flow }) });
    };
    document.querySelectorAll<HTMLAnchorElement>("nav a[href]").forEach((a) => add(a));
    const first = document.querySelector<HTMLAnchorElement>("main a[href*='#/']");
    if (first !== null) add(first);
    // And the first of each screen the critical flows go through: a student doing an activity or a
    // quiz, a teacher reviewing an assignment's submissions, a quiz's results, and everyone's
    // notifications and settings.
    const all = [...document.querySelectorAll<HTMLAnchorElement>("a[href*='#/']")];
    flows.forEach((flow, i) => {
      const link = all.find((a) => new RegExp(flow).test(new URL(a.href).hash));
      if (link !== undefined) add(link, i);
    });
    return links;
  }, CRITICAL_FLOWS.map((r) => r.source));

/** Tabs from the top of the page until focus comes back round, noting each stop. */
const walkKeyboard = async (page: Page, persona: string, screen: string) => {
  // Start where a visitor does: before the first element of the page. A focusable marker at the top
  // of the body sets the browser's sequential focus starting point there; it isn't a stop itself.
  await page.evaluate(() => {
    const start = document.createElement("span");
    start.tabIndex = -1;
    start.dataset.auditStart = "";
    document.body.prepend(start);
    start.focus();
    window.scrollTo(0, 0);
    (window as unknown as { __stops: Element[] }).__stops = [start];
  });
  const stops: FocusStop[] = [];
  /** Each stop's outline, ring, border, background and underline while it has focus. */
  const looks: string[] = [];
  let cycled = false;
  for (let i = 0; i < MAX_TABS; i++) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate(() => {
      const el = document.activeElement;
      const record = (window as unknown as { __stops: Element[] }).__stops;
      if (el === null || el === document.body) return { again: false, none: true } as const;
      if (record.includes(el)) return { again: true, none: false } as const;
      record.push(el);
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const labelled = el.getAttribute("aria-labelledby")?.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
      const name = (el.getAttribute("aria-label") ?? labelled ?? ((el as HTMLInputElement).labels?.[0]?.textContent) ?? (el.textContent || el.getAttribute("title") || el.querySelector("img")?.getAttribute("alt") || (el as HTMLInputElement).placeholder || "")).trim().replace(/\s+/g, " ");
      return {
        again: false,
        none: false,
        name: name.slice(0, 50),
        role: el.getAttribute("role") ?? el.tagName.toLowerCase(),
        focused: `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}|${s.boxShadow}|${s.borderColor}|${s.backgroundColor}|${s.textDecorationLine}`,
        inView: r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth,
      };
    });
    if (stop.none) continue;
    if (stop.again) {
      cycled = true;
      break;
    }
    looks.push(stop.focused);
    stops.push({ name: stop.name, role: stop.role, visible: true, inView: stop.inView });
  }
  // Focus shows if the focused element's outline, ring, border, background or underline differs from
  // its unfocused look. Compared after the walk, so measuring doesn't disturb the tab order.
  const unfocused = await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    const [start, ...walked] = (window as unknown as { __stops: Element[] }).__stops;
    start?.remove();
    return walked.map((el) => {
      const s = getComputedStyle(el);
      return `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}|${s.boxShadow}|${s.borderColor}|${s.backgroundColor}|${s.textDecorationLine}`;
    });
  });
  const walked = stops.map((stop, i) => ({ ...stop, visible: looks[i] !== unfocused[i] }));
  const skipLinkIndex = walked.findIndex((s) => /skip to/i.test(s.name));
  keyboard.push({ persona, screen, stops: walked, cycled, skipLinkIndex });
  const hidden = walked.filter((s) => !s.visible);
  const nameless = walked.filter((s) => s.name === "");
  console.log(`  [keyboard] ${walked.length} stops${cycled ? "" : " (did not cycle)"}, skip link at ${skipLinkIndex}, ${hidden.length} without visible focus${hidden.length ? `: ${hidden.slice(0, 6).map((s) => `${s.role} "${s.name}"`).join(", ")}` : ""}, ${nameless.length} without a name`);
};

type Pass = ScreenResult["pass"];
const PASSES: { pass: Pass; theme: "light" | "dark"; width: number }[] = [
  { pass: "light", theme: "light", width: 1280 },
  { pass: "dark", theme: "dark", width: 1280 },
  { pass: "narrow", theme: "light", width: 320 },
];

const browser = await chromium.launch(process.env.CHROME === undefined ? {} : { executablePath: process.env.CHROME });
try {
  for (const { pass, theme, width } of PASSES.filter((p) => args.pass === undefined || p.pass === args.pass)) {
    console.log(`\n# ${pass} (${theme}, ${width}px)`);
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.on("pageerror", (error) => console.log(`  page error: ${error.message}`));
    await page.addInitScript(([key, mode]) => window.localStorage.setItem(key, mode), [THEME_KEY, theme] as const);
    await page.goto(`${origin}/demo/`);
    await page.getByRole("heading", { name: "Try EducateOS" }).waitFor();
    await settle(page);
    await audit(page, { persona: "Picker", screen: "Persona picker", hash: "", pass });
    const roles = await page.locator("main li > button").evaluateAll((buttons) => buttons.map((b) => b.querySelector("span span")?.textContent?.trim() ?? ""));
    for (const role of roles.filter((r) => args.persona === undefined || r.includes(args.persona))) {
      console.log(`- ${role}`);
      await page.locator("main li > button").filter({ hasText: role }).first().click();
      await page.locator('a[href="#main"], a[href$="#main-content"], nav').first().waitFor({ timeout: 60_000 }).catch(() => undefined);
      await settle(page);
      // Breadth first from the home screen, so every persona's main screens come before any deeper one.
      const home = await page.evaluate(() => location.hash || "#/");
      const queue = [{ name: "Home", hash: home }];
      const seen = new Set([home]);
      const flowsTaken = new Set<number>();
      for (let visited = 0; queue.length > 0 && visited <= MAX_SCREENS; visited++) {
        const screen = queue.shift()!;
        if (visited > 0) {
          await page.evaluate((hash) => { location.hash = hash; }, screen.hash);
          await settle(page);
        }
        await audit(page, { persona: role, screen: screen.name, hash: screen.hash, pass });
        if (pass === "light") {
          await walkKeyboard(page, role, screen.name);
          for (const check of STATUS_CHECKS.filter((c) => c.persona.test(role) && c.screen === screen.name)) {
            await announcedBy(page, role, check.action, () => check.act(page));
          }
        }
        // One screen of each critical flow, opened next, ahead of the navigation still to visit.
        for (const link of await linksOn(page)) {
          if (seen.has(link.hash) || (link.flow !== undefined && flowsTaken.has(link.flow))) continue;
          seen.add(link.hash);
          if (link.flow === undefined) queue.push(link);
          else {
            flowsTaken.add(link.flow);
            queue.unshift(link);
          }
        }
      }
      // Back to the picker through the banner, as a visitor does; the district stays up.
      await page.getByRole("button", { name: "Switch persona" }).click();
      await page.getByRole("heading", { name: "Try EducateOS" }).waitFor();
    }
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}

// The summary: each rule's violations by pass, then the keyboard walks and reflow.
const byRule = new Map<string, { impact: string | null; help: string; tags: string[]; screens: Set<string>; nodes: number }>();
for (const r of results) {
  for (const v of r.violations) {
    const key = `${v.id}|${r.pass}`;
    const entry = byRule.get(key) ?? { impact: v.impact, help: v.help, tags: v.tags.filter((t) => /^wcag\d/.test(t)), screens: new Set(), nodes: 0 };
    entry.screens.add(`${r.persona} › ${r.screen}`);
    entry.nodes += v.nodes.length;
    byRule.set(key, entry);
  }
}
const lines = [
  `# EducateOS demo accessibility audit`,
  ``,
  `axe-core ${axeVersion}, rules tagged ${WCAG_TAGS.join(", ")}; Playwright Chromium; ${new Date().toISOString()}.`,
  `${results.length} screen audits across ${new Set(results.map((r) => r.persona)).size} personas.`,
  ``,
  `## axe violations by rule`,
  ``,
  `| Rule | Impact | WCAG | Pass | Screens | Nodes |`,
  `|---|---|---|---|---|---|`,
  ...[...byRule].map(([key, e]) => `| ${key.split("|")[0]} | ${e.impact} | ${e.tags.join(" ")} | ${key.split("|")[1]} | ${e.screens.size} | ${e.nodes} |`),
  ``,
  `## Left to manual review (axe "incomplete")`,
  ``,
  `| Rule | Pass | Nodes | Why |`,
  `|---|---|---|---|`,
  ...[...results.reduce((acc, r) => {
    for (const i of r.incomplete) {
      const e = acc.get(`${i.id}|${r.pass}`) ?? { nodes: 0, reasons: new Set<string>() };
      e.nodes += i.nodes;
      i.reasons.forEach((reason) => e.reasons.add(reason));
      acc.set(`${i.id}|${r.pass}`, e);
    }
    return acc;
  }, new Map<string, { nodes: number; reasons: Set<string> }>())].map(([key, e]) => `| ${key.replace("|", " | ")} | ${e.nodes} | ${[...e.reasons].join(", ")} |`),
  ``,
  `## Screens`,
  ``,
  `| Persona | Screen | Title | Pass | Violations | h1 | Live regions | Sideways scroll at 320px |`,
  `|---|---|---|---|---|---|---|---|`,
  ...results.map((r) => `| ${r.persona} | ${r.screen} | ${r.title} | ${r.pass} | ${r.violations.map((v) => `${v.id} (${v.nodes.length})`).join(", ") || "none"} | ${r.h1} | ${r.liveRegions} | ${r.overflow === undefined ? "" : r.overflow.scrollWidth > 0 ? `${r.overflow.scrollWidth}px: ${r.overflow.offenders.join("; ")}` : "none"} |`),
  ``,
  `## Page titles`,
  ``,
  `Screens of one persona that share a document title (WCAG 2.4.2), from the light pass. A persona's Home is the screen its app opens on (the admin Dashboard, a guardian's first child), so it shares that screen's title; any other row is a failure.`,
  ``,
  `| Persona | Title | Screens |`,
  `|---|---|---|`,
  ...[...results.filter((r) => r.pass === "light").reduce((acc, r) => {
    const key = `${r.persona}|${r.title}`;
    acc.set(key, [...acc.get(key) ?? [], r.screen]);
    return acc;
  }, new Map<string, string[]>())].filter(([, screens]) => screens.length > 1)
    .map(([key, screens]) => `| ${key.split("|")[0]} | ${key.split("|").slice(1).join("|")} | ${screens.join("; ")} |`),
  ``,
  `## Keyboard`,
  ``,
  `| Persona | Screen | Stops | Cycled | Skip link at | Without visible focus | Without a name |`,
  `|---|---|---|---|---|---|---|`,
  ...keyboard.map((k) => `| ${k.persona} | ${k.screen} | ${k.stops.length} | ${k.cycled} | ${k.skipLinkIndex} | ${k.stops.filter((s) => !s.visible).map((s) => `${s.role} "${s.name}"`).join("; ") || "none"} | ${k.stops.filter((s) => s.name === "").map((s) => s.role).join("; ") || "none"} |`),
  ``,
  `## Status messages`,
  ``,
  `| Persona | Action | Announced |`,
  `|---|---|---|`,
  ...statuses.map((st) => `| ${st.persona} | ${st.action} | ${st.announced.join(" / ") || "**nothing**"} |`),
  ``,
  `## Non-text contrast and text spacing`,
  ``,
  `| Persona | Screen | Pass | Controls under 3:1 | Clipped by text spacing |`,
  `|---|---|---|---|---|`,
  ...results.filter((r) => (r.controlContrast?.length ?? 0) + (r.spacingClipped?.length ?? 0) > 0)
    .map((r) => `| ${r.persona} | ${r.screen} | ${r.pass} | ${r.controlContrast?.map((c) => `${c.control} ${c.ratio}`).join("; ") ?? ""} | ${r.spacingClipped?.join("; ") ?? ""} |`),
];
writeFileSync(join(out, "results.json"), JSON.stringify({ axeVersion, tags: WCAG_TAGS, date: new Date().toISOString(), results, keyboard, statuses }, null, 2));
writeFileSync(join(out, "summary.md"), `${lines.join("\n")}\n`);
console.log(`\nWrote ${join(out, "summary.md")} and results.json`);

const blocking = results.flatMap((r) => r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${r.persona} › ${r.screen} [${r.pass}]: ${v.id}`));
if (blocking.length > 0 && !args["report-only"]) {
  console.error(`${blocking.length} serious or critical violations`);
  process.exitCode = 1;
}
