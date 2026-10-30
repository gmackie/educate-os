// The district origin's path table (ADR-0014, SCHO-259). When the router has a `DISTRICT` service
// binding it owns the district's whole origin, `<slug>.educateos.io` or the district's own domain:
//
//   /healthz                         the router itself (answered in index.ts)
//   /gatekeeper/<name>[/...]         the bound gatekeepers (index.ts)
//   /ai/api, /ai/api/*               the Workshop backend, URL unchanged (it accepts both /api... and
//                                    /ai/api...)
//   /ai/blueprint-screenshot[/*]     the Workshop backend too, URL unchanged: the Workshop built for
//                                    /ai asks for its screenshots there (workshopPath)
//   /ai, /ai/*                       the Workshop SPA from ASSETS, with `/ai` stripped and the SPA's
//                                    index.html as the fallback
//   LEGACY_WORKSHOP_PATHS            the Workshop backend, for one release, so older Workshop builds and
//                                    phones keep working
//   everything else                  the district Worker: `/`, `/api/*`, `/lti/*`, `/.well-known/*`
//                                    and the district's UI assets
//
// A district with no Workshop (`AI_ENABLED` = "false", or no WORKSHOP_BACKEND bound) answers `/ai`
// with a small "AI isn't enabled at your school" page, and the legacy Workshop paths go to the
// district like any other path.
//
// Such a deployment must run the router first for every path (`run_worker_first: true`), since the
// Workshop's assets would otherwise answer `/` and shadow the district's `/assets/*`.

/** The prefix the Workshop is served under on a district origin. */
export const AI_PREFIX = "/ai";

/**
 * The Workshop backend's own paths under {@link AI_PREFIX}, matched as `<prefix>` exactly or
 * `<prefix>/...`: its RPC and HTTP API, and its blueprint screenshots (BLUEPRINT_SCREENSHOT_PATH_PREFIX
 * in workshop-shared, which the frontend puts under its base). The backend strips `/ai` itself
 * (workshop-backend/src/public-path.ts).
 */
export const AI_BACKEND_PREFIXES: readonly string[] = [AI_PREFIX + "/api", AI_PREFIX + "/blueprint-screenshot"];

/**
 * The Workshop backend's HTTP endpoints at the root, from packages/workshop-backend/src/server.ts,
 * answered for one release after the move to `/ai` (exact paths). On a collision the district wins,
 * so none of these may name a district route; today none does (the district owns
 * `/api/{student,teacher,admin,guardian,me,calendar,onboarding,lti,m,pair,ops}`).
 */
export const LEGACY_WORKSHOP_EXACT_PATHS: readonly string[] = [
  "/api", // the Cap'n Web RPC (WebSocket or HTTP batch)
  "/api/router-tag", // ROUTER_TAG_PROBE_PATH in workshop-shared
  "/api/site-logo", // SITE_LOGO_PATH in workshop-backend/src/site-logo.ts
  "/api/client-errors",
];

/** The legacy Workshop endpoints matched by prefix, as `<prefix>` exactly or `<prefix>/...`. */
export const LEGACY_WORKSHOP_PREFIXES: readonly string[] = [
  "/api/device-session", // /api/device-session/callback, the native app's sign-in handoff
  "/blueprint-screenshot", // BLUEPRINT_SCREENSHOT_PATH_PREFIX in workshop-shared
];

/** Where a request on a district origin goes, apart from `/healthz` and the gatekeepers. */
export type DistrictOriginTarget =
  /** The Workshop backend, URL unchanged. */
  | "workshop-backend"
  /** The Workshop's assets, at the path with `/ai` stripped. */
  | "workshop-assets"
  /** The "AI isn't enabled" page (or a 404 for its API). */
  | "ai-disabled"
  /** The district Worker, unchanged. */
  | "district";

function underPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + "/");
}

/** Routes one path on a district origin. `aiEnabled` says whether a Workshop serves `/ai`. */
export function districtOriginTarget(pathname: string, aiEnabled: boolean): DistrictOriginTarget {
  if (underPrefix(pathname, AI_PREFIX)) {
    if (!aiEnabled) return "ai-disabled";
    return AI_BACKEND_PREFIXES.some((prefix) => underPrefix(pathname, prefix)) ? "workshop-backend" : "workshop-assets";
  }
  if (aiEnabled && (LEGACY_WORKSHOP_EXACT_PATHS.includes(pathname) ||
      LEGACY_WORKSHOP_PREFIXES.some((prefix) => underPrefix(pathname, prefix)))) {
    return "workshop-backend";
  }
  return "district";
}

/** `/ai` → `/`, `/ai/x` → `/x`. Only called on paths under AI_PREFIX. */
export function stripAiPrefix(pathname: string): string {
  return pathname.slice(AI_PREFIX.length) || "/";
}

/**
 * Fetches `req` from the Workshop's assets with `/ai` stripped. A 404 for a GET or HEAD falls back
 * to the SPA's index.html (the assets binding may already do this itself), and a redirect the
 * assets answer with gets its root-relative `Location` put back under `/ai`.
 */
export async function fetchWorkshopAsset(req: Request, assets: Fetcher): Promise<Response> {
  const url = new URL(req.url);
  url.pathname = stripAiPrefix(url.pathname);
  let res = await assets.fetch(new Request(url, req));
  if (res.status === 404 && (req.method === "GET" || req.method === "HEAD")) {
    const index = new URL(url);
    index.pathname = "/";
    index.search = "";
    res = await assets.fetch(new Request(index, { method: req.method, headers: req.headers }));
  }
  const location = res.headers.get("Location");
  if (res.status >= 300 && res.status < 400 && location?.startsWith("/") && !location.startsWith("//")) {
    const headers = new Headers(res.headers);
    headers.set("Location", AI_PREFIX + location);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
  return res;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** An http(s) URL to link to, or undefined. */
function linkableUrl(text: string | undefined): string | undefined {
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The answer on `/ai` at a district with no Workshop: a small page that follows the system theme,
 * with a link to `demoUrl` (the AI-enabled demo district) when one is configured. Its API paths get
 * a plain 404 instead, since no page can help a script.
 */
export function aiDisabledResponse(req: Request, demoUrl: string | undefined): Response {
  const { pathname } = new URL(req.url);
  if (underPrefix(pathname, AI_PREFIX + "/api")) {
    return new Response("AI isn't enabled at this school.", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  const link = linkableUrl(demoUrl);
  const demo = link
    ? `<p><a href="${escapeHtml(link)}">See the AI workspace in a demo district</a></p>`
    : "";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>AI isn't enabled at your school</title>
<style>
:root { color-scheme: light dark; --bg: #f7f7f8; --fg: #1b1c1f; --muted: #5d606a; --card: #fff; --accent: #2458ac; }
@media (prefers-color-scheme: dark) { :root { --bg: #121317; --fg: #ececf0; --muted: #a2a5b0; --card: #1c1d23; --accent: #8fb3ff; } }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg);
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 28rem; margin: 1.5rem; padding: 2rem; background: var(--card); border-radius: 12px; box-shadow: 0 1px 3px rgb(0 0 0 / 0.12); }
h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
p { margin: 0.5rem 0 0; color: var(--muted); }
a { color: var(--accent); }
</style>
</head>
<body>
<main>
<h1>AI isn't enabled at your school</h1>
<p>Your school hasn't turned on the AI workspace. Everything else works as usual.</p>
<p><a href="/">Back to your classes</a></p>
${demo}
</main>
</body>
</html>
`;
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
