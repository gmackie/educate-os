import { chromium } from "playwright";
import { assert } from "./io.mjs";
import { ORIGIN } from "./fixture.mjs";

export function allowedRequest(url, method = "GET") {
  try {
    const u = new URL(url);
    return (
      u.origin === ORIGIN &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      method === "GET" &&
      /^\/scene\/[A-Z0-9-]+$/.test(u.pathname)
    );
  } catch {
    return false;
  }
}
/** Run with an ephemeral browser; accepts no stored sessions or live URLs. */
export async function withBrowser(callback) {
  const browser = await chromium.launch({
    headless: true,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      LANG: "en_US.UTF-8",
    },
  });
  try {
    return await callback(browser);
  } finally {
    await browser.close();
  }
}
export async function isolatedContext(browser, html, { recordVideo } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    serviceWorkers: "block",
    acceptDownloads: false,
    permissions: [],
    ...(recordVideo
      ? { recordVideo: { dir: recordVideo, size: { width: 1280, height: 720 } } }
      : {}),
  });
  const denied = [];
  await context.route("**/*", async (route) => {
    if (!allowedRequest(route.request().url(), route.request().method())) {
      denied.push("Blocked non-fixture request");
      return route.abort("blockedbyclient");
    }
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      headers: {
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; font-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'",
        "Cache-Control": "no-store",
      },
      body: html,
    });
  });
  await context.routeWebSocket(/.*/, (socket) => {
    denied.push("Blocked WebSocket");
    socket.close();
  });
  context.on("page", (page) => {
    page.on("download", (download) => download.cancel());
  });
  return {
    context,
    denied,
    assertSafe: () => assert(denied.length === 0, "Capture attempted a forbidden request"),
  };
}
