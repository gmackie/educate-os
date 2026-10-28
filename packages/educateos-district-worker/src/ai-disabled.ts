// `/ai` on a district Worker that serves its own hostname, with no router in front (ADR-0014 D7,
// SCHO-259): the demo districts other than Northfield have no Workshop, so `/ai` answers with a
// small "AI isn't enabled at your school" page linking to the AI-enabled demo district
// (`AI_DEMO_URL`), and `/ai/api*` with a plain 404. It is the router's `aiDisabledResponse`
// (packages/router/src/one-origin.ts) for a district without a router, and reads nothing.
//
// Reached only when the deployment runs the Worker first for `/ai` and `/ai/*`; otherwise the UI
// assets answer those paths. Behind a router the router answers `/ai` and never forwards it here.

/** The path the Workshop is served under on a district origin. */
export const AI_PATH = "/ai";

function under(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + "/");
}

/** Whether `pathname` is `/ai` or under it. */
export function isAiPath(pathname: string): boolean {
  return under(pathname, AI_PATH);
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

/** The answer for a request under `/ai` at a district with no Workshop. */
export function aiDisabledResponse(request: Request, demoUrl: string | undefined): Response {
  const { pathname } = new URL(request.url);
  if (under(pathname, AI_PATH + "/api")) {
    return new Response("AI isn't enabled at this school.", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const link = linkableUrl(demoUrl);
  const demo = link ? `<p><a href="${escapeHtml(link)}">See the AI workspace in a demo district</a></p>` : "";
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
  return new Response(request.method === "HEAD" ? null : html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}
