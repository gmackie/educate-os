// The control plane's pages: plain server-rendered HTML in the site's own shell (its header,
// footer, Kumo tokens and site.css), so /app reads as part of educateos.io and ships no framework.
// Every value that reaches a page passes through `html`, which escapes it.
import { ACCESS_LOGOUT_PATH } from "./access.ts";
import type { Installation, Operator } from "./store.ts";

/** The site's shared markup, from `sites/educateos-io/partials`. */
export interface SiteShell {
  header: string;
  footer: string;
}

/** A fragment of HTML that is already safe to emit. */
export class Html {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
  toString(): string {
    return this.text;
  }
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escape(value: unknown): string {
  if (value instanceof Html) return value.text;
  if (Array.isArray(value)) return value.map(escape).join("");
  return String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/** A template tag that escapes every interpolated value, except {@link Html} fragments and arrays of them. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  return new Html(strings.reduce((out, part, i) => out + part + (i < values.length ? escape(values[i]) : ""), ""));
}

/**
 * The site's theme switch, the same script every static page carries. It is the only script a
 * control plane page runs, and the content security policy admits it by {@link THEME_SCRIPT_HASH}.
 */
export const THEME_SCRIPT = `
  (() => {
    const q = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => { document.documentElement.dataset.mode = q.matches ? "dark" : "light"; };
    apply(); q.addEventListener("change", apply);
  })();
`;

/** The CSP source for {@link THEME_SCRIPT}. The suite recomputes it, so an edit to one fails until both match. */
export const THEME_SCRIPT_HASH = "sha256-/jpqjCUGK/Wu29hkc/c/Z1gLXcDQYyG9B6SMSiwGz1Y=";

/** The headers every control plane page is served with. Pages are per operator, so never cached. */
export const PAGE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": [
    "default-src 'none'",
    "style-src 'self'",
    "img-src 'self' data:",
    `script-src '${THEME_SCRIPT_HASH}'`,
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
};

/** A whole page in the site's shell. */
export function page(shell: SiteShell, title: string, body: Html): string {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · EducateOS</title>
<meta name="color-scheme" content="light dark">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='%23155dfc'/><path d='M9 10h14M9 16h10M9 22h14' stroke='white' stroke-width='3' stroke-linecap='round'/></svg>">
<link rel="stylesheet" href="/assets/kumo-2.14.0.css">
<script>${new Html(THEME_SCRIPT)}</script>
<link rel="stylesheet" href="/assets/site.css">
</head>
<body>
${new Html(shell.header)}
<main>
${body}
</main>
${new Html(shell.footer)}
</body>
</html>
`.text;
}

function signedInBar(operator: Operator): Html {
  return html`<p class="muted">Signed in as <b class="strong">${operator.email}</b> · account <code>${operator.accountId}</code> · <a href="${ACCESS_LOGOUT_PATH}">Sign out</a></p>`;
}

/** The operator's home: their installations. */
export function dashboardPage(shell: SiteShell, operator: Operator, installations: readonly Installation[]): string {
  const list = installations.length === 0
    ? html`<div class="note-box"><b>No installations yet.</b> Installations you make through educateos.io will be listed here. An installation runs in your own Cloudflare account and keeps running whether or not educateos.io is up.</div>`
    : html`<div class="table-scroll"><table class="spec">
        <thead><tr><th>Installation</th><th>Address</th><th>Version</th><th>Installed</th></tr></thead>
        <tbody>${installations.map((installation) => html`<tr>
          <td>${installation.slug}<br><small class="muted">${installation.instanceId}</small></td>
          <td><a href="https://${installation.hostname}/">${installation.hostname}</a></td>
          <td>${installation.releaseVersion}</td>
          <td>${installation.installedAt.slice(0, 10)}</td>
        </tr>`)}</tbody>
      </table></div>`;
  return page(shell, "Your installations", html`<section class="page-hero">
    <div class="wrap">
      <div class="eyebrow">Operator console</div>
      <h1>Your installations</h1>
      ${signedInBar(operator)}
    </div>
  </section>
  <section class="tight">
    <div class="wrap">${list}</div>
  </section>`);
}

/** A page for a request the control plane turns away. */
export function messagePage(shell: SiteShell, title: string, message: string): string {
  return page(shell, title, html`<section class="page-hero">
    <div class="wrap">
      <div class="eyebrow">Operator console</div>
      <h1>${title}</h1>
      <p class="lede">${message}</p>
      <p><a class="btn" href="/app/">Operator console</a> <a class="btn" href="/">educateos.io</a></p>
    </div>
  </section>`);
}
