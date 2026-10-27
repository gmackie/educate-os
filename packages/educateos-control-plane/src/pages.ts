// The control plane's pages: plain server-rendered HTML in the site's own shell (its header,
// footer, Kumo tokens and site.css), so /app reads as part of educateos.io and ships no framework.
// Every value that reaches a page passes through `html`, which escapes it.
import { ACCESS_LOGOUT_PATH } from "./access.ts";
import type { ProbedEntry } from "./app.ts";
import { BILLING_PATHS, type BilledInvoice, type BillingOverview, MANAGED_PLANS, PLACEHOLDER_PRICE_NOTE, TERM_DAYS } from "./billing.ts";
import { ECHOED_FIELDS, type InstallEvent } from "./guided-install.ts";
import type { ProbeResult } from "./probe.ts";
import type { Registration } from "./registry.ts";
import type { Operator } from "./store.ts";

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

/**
 * The billing page's headers. Its forms answer with a redirect to Stripe's hosted card setup page or
 * Customer Portal, and `form-action` governs where a form's redirects may go too, so those two
 * origins are admitted on this page alone.
 */
export const BILLING_PAGE_HEADERS: Readonly<Record<string, string>> = {
  ...PAGE_HEADERS,
  "content-security-policy": PAGE_HEADERS["content-security-policy"]!.replace(
    "form-action 'self'",
    "form-action 'self' https://checkout.stripe.com https://billing.stripe.com",
  ),
};

/** A whole page in the site's shell. */
export function page(shell: SiteShell, title: string, body: Html): string {
  const [head, tail] = pageParts(shell, title);
  return `${head}${body.text}${tail}`;
}

// Where a page's body goes. No shell or title can contain it: html escapes nothing to NUL, and the
// partials are text.
const BODY_SLOT = "\u0000";

/** A page's markup before and after its body, for a page streamed as it is written. */
export function pageParts(shell: SiteShell, title: string): [string, string] {
  const [head, tail] = html`<!doctype html>
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
${new Html(BODY_SLOT)}
</main>
${new Html(shell.footer)}
</body>
</html>
`.text.split(BODY_SLOT);
  return [head!, tail!];
}

function signedInBar(operator: Operator): Html {
  return html`<p class="muted">Signed in as <b class="strong">${operator.email}</b> · account <code>${operator.accountId}</code> · <a href="${ACCESS_LOGOUT_PATH}">Sign out</a></p>`;
}

function health(probe: ProbeResult): Html {
  switch (probe.state) {
    case "responding":
      return html`<span class="status avail">Responding</span>`;
    case "behind-sign-in":
      return html`<span class="status dev">Behind sign-in</span><br><small class="muted">Access answered; /healthz has no bypass</small>`;
    case "failing":
      return html`<span class="badge warn">HTTP ${probe.status}</span>`;
    case "unreachable":
      return html`<span class="badge warn">Unreachable</span>`;
  }
}

function registry(registration: Registration | undefined): Html {
  if (registration === undefined) return html`<span class="muted">Not registered</span>`;
  const failing = registration.probes.filter((probe) => probe.status !== "ok").length;
  return html`Registered ${registration.registeredAt.slice(0, 10)}<br><small class="muted">${
    registration.lastHeartbeatAt === undefined ? "No report yet" : `Last report ${registration.lastHeartbeatAt.slice(0, 16).replace("T", " ")} UTC`
  }${registration.probes.length === 0 ? "" : ` · ${registration.probes.length - failing} of ${registration.probes.length} probes ok`}</small>`;
}

/**
 * The operator's home: their installations, read-only. Health is what the dashboard's probe saw
 * just now; version and reports come from the opt-in registry when the installation registered.
 */
export function dashboardPage(shell: SiteShell, operator: Operator, entries: readonly ProbedEntry[]): string {
  const list = entries.length === 0
    ? html`<div class="note-box"><b>No installations yet.</b> Installations you make through educateos.io will be listed here. An installation runs in your own Cloudflare account and keeps running whether or not educateos.io is up.</div>`
    : html`<div class="table-scroll"><table class="spec">
        <thead><tr><th>Installation</th><th>Address</th><th>Version</th><th>Health</th><th>Registry</th></tr></thead>
        <tbody>${entries.map(({ installation, registration, probe }) => html`<tr>
          <td>${installation.slug}<br><small class="muted">${installation.instanceId} · installed ${installation.installedAt.slice(0, 10)}</small></td>
          <td><a href="https://${installation.hostname}/">${installation.hostname}</a><br><small class="muted">account ${installation.accountId.slice(0, 8)}…</small></td>
          <td>${registration?.releaseVersion ?? installation.releaseVersion}</td>
          <td>${health(probe)}</td>
          <td>${registry(registration)}</td>
        </tr>`)}</tbody>
      </table></div>`;
  return page(shell, "Your installations", html`<section class="page-hero">
    <div class="wrap">
      <div class="eyebrow">Operator console</div>
      <h1>Your installations</h1>
      ${signedInBar(operator)}
      <p><a class="btn primary" href="/app/install">Install EducateOS</a> <a class="btn" href="${BILLING_PATHS.page}">Billing</a></p>
    </div>
  </section>
  <section class="tight">
    <div class="wrap">${list}</div>
  </section>`);
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const CHARGE_LABELS: Record<BilledInvoice["charge"], Html> = {
  paid: html`<span class="status avail">Paid</span>`,
  pending: html`<span class="status planned">Open</span> <small class="muted">charge on its way</small>`,
  declined: html`<span class="badge warn">Declined</span>`,
  uncharged: html`<span class="status planned">Open</span> <small class="muted">not charged yet</small>`,
  reopened: html`<span class="status planned">Open</span> <small class="muted">due again after a refund</small>`,
};

const STATUS_LABELS: Record<NonNullable<BillingOverview["subscription"]>["status"], Html> = {
  "trialing": html`<span class="status planned">Waiting for a card</span>`,
  "active": html`<span class="status avail">Active</span>`,
  "past-due": html`<span class="badge warn">Payment due</span>`,
  "grace": html`<span class="badge warn">In grace</span>`,
  "lapsed": html`<span class="badge warn">Lapsed</span>`,
  "cancelled": html`<span class="muted">Cancelled</span>`,
};

/**
 * The operator's billing: the managed services plans until they subscribe, then their subscription
 * and invoices. Every price is marked as a placeholder until pricing is decided (SCHO-208).
 */
export function billingPage(shell: SiteShell, operator: Operator, overview: BillingOverview, notice?: string): string {
  const { subscription } = overview;
  const payable = subscription !== undefined && subscription.status !== "trialing" &&
    overview.invoices.some(({ invoice, charge }) => invoice.subscriptionId === subscription.subscriptionId && (charge === "declined" || charge === "uncharged" || charge === "reopened"));
  const planName = (planId: string) => MANAGED_PLANS.find(({ plan }) => plan.planId === planId)?.name ?? planId;
  const current = subscription === undefined
    ? html`<form method="post" action="${BILLING_PATHS.subscribe}" class="card">
        <div class="field">
          <label for="organization">Organization billed</label>
          <input class="input" id="organization" name="organization" value="${overview.organization ?? ""}" placeholder="Riverbend Unified School District" required maxlength="120" autocomplete="organization">
          <small class="muted">The district or organization the invoices are made out to.</small>
        </div>
        <div class="field">
          ${MANAGED_PLANS.map(({ plan, name, summary }, i) => html`<label class="li"><input type="radio" name="plan" value="${plan.planId}"${i === 0 ? new Html(" checked") : ""}> <b class="strong">${name}</b>, ${dollars(plan.termFeeCents)} per ${TERM_DAYS} days <span class="badge warn">${PLACEHOLDER_PRICE_NOTE}</span><br><small class="muted">${summary}</small></label>`)}
        </div>
        <p class="muted">Next, Stripe asks for a card and saves it; nothing is charged until you come back. Billing pays for what educateos.io does for you. Your installations never check it, and keep running and keep their data whether or not you subscribe.</p>
        <p><button class="btn primary" type="submit">Continue to add a card</button></p>
      </form>`
    : html`<div class="card">
        <p><b class="strong">${planName(subscription.planId)}</b> ${STATUS_LABELS[subscription.status]}</p>
        <p class="muted">Billed to ${overview.organization ?? ""} · term ends ${subscription.termEnd.slice(0, 10)}</p>
        ${subscription.status === "trialing"
          ? html`<form method="post" action="${BILLING_PATHS.card}"><p><button class="btn primary" type="submit">Add a card</button></p></form>`
          : ""}
        ${payable ? html`<form method="post" action="${BILLING_PATHS.pay}"><p><button class="btn primary" type="submit">Pay now</button></p></form>` : ""}
        <p>${overview.hasCustomer ? html`<form method="post" action="${BILLING_PATHS.portal}" class="inline"><button class="btn" type="submit">Manage payment methods</button></form>` : ""}
        <form method="post" action="${BILLING_PATHS.cancel}" class="inline"><button class="btn" type="submit">Cancel subscription</button></form></p>
        <small class="muted">Cancelling stops further charges. Your installations keep running and keep their data.</small>
      </div>`;
  const invoices = overview.invoices.length === 0
    ? ""
    : html`<h2>Invoices</h2><div class="table-scroll"><table class="spec">
        <thead><tr><th>Invoice</th><th>Issued</th><th>Due</th><th>Total</th><th>Status</th></tr></thead>
        <tbody>${overview.invoices.map(({ invoice, charge }) => html`<tr>
          <td><code>${invoice.invoiceId}</code></td>
          <td>${invoice.issuedAt.slice(0, 10)}</td>
          <td>${invoice.dueAt.slice(0, 10)}</td>
          <td>${dollars(invoice.totalCents)}</td>
          <td>${CHARGE_LABELS[charge]}</td>
        </tr>`)}</tbody>
      </table></div>`;
  return page(shell, "Billing", html`<section class="page-hero">
    <div class="wrap">
      <div class="eyebrow">Operator console</div>
      <h1>Billing</h1>
      ${signedInBar(operator)}
      <p><a class="btn" href="/app/">Your installations</a></p>
      ${notice === undefined ? "" : html`<div class="note-box">${notice}</div>`}
    </div>
  </section>
  <section class="tight">
    <div class="wrap">${current}${invoices}</div>
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

/**
 * The permissions the guided install's token needs, as Cloudflare's token editor names them
 * (docs/educateos/installer-permissions.md). `key` and `type` prefill the editor.
 */
export const INSTALL_TOKEN_PERMISSIONS = [
  { scope: "Account", name: "Account Settings", level: "Read", key: "account_settings", type: "read" },
  { scope: "Account", name: "Billing", level: "Read", key: "billing", type: "read" },
  { scope: "Account", name: "Workers Scripts", level: "Edit", key: "workers_scripts", type: "edit" },
  { scope: "Account", name: "Workers KV Storage", level: "Edit", key: "workers_kv_storage", type: "edit" },
  { scope: "Account", name: "Workers R2 Storage", level: "Edit", key: "workers_r2", type: "edit" },
  { scope: "Account", name: "D1", level: "Edit", key: "d1", type: "edit" },
  { scope: "Account", name: "Access: Apps and Policies", level: "Edit", key: "access", type: "edit" },
  { scope: "Account", name: "Access: Organizations, Identity Providers, and Groups", level: "Read", key: "access_acct", type: "read" },
  { scope: "Account", name: "AI Gateway", level: "Edit", key: "aig", type: "edit" },
  { scope: "Zone", name: "Zone", level: "Read", key: "zone", type: "read" },
  { scope: "Zone", name: "DNS", level: "Edit", key: "dns", type: "edit" },
  { scope: "Zone", name: "Workers Routes", level: "Edit", key: "workers_routes", type: "edit" },
  { scope: "Zone", name: "SSL and Certificates", level: "Edit", key: "ssl_and_certificates", type: "edit" },
] as const;

/** Cloudflare's token editor, prefilled with {@link INSTALL_TOKEN_PERMISSIONS}. */
export function installTokenLink(): string {
  const keys = INSTALL_TOKEN_PERMISSIONS.map(({ key, type }) => ({ key, type }));
  const query = new URLSearchParams({ permissionGroupKeys: JSON.stringify(keys), name: "EducateOS guided install" });
  return `https://dash.cloudflare.com/profile/api-tokens?${query}`;
}

const FIELD_LABELS: Record<(typeof ECHOED_FIELDS)[number], { label: string; hint: string; placeholder: string }> = {
  slug: { label: "Address", hint: "Your installation serves at <slug>.educateos.io. Lowercase letters, digits and hyphens.", placeholder: "riverbend" },
  accountId: { label: "Cloudflare account ID", hint: "The account EducateOS is installed into: yours. It is on your account's dashboard home.", placeholder: "32 hexadecimal characters" },
  baseDomain: { label: "Your domain", hint: "A zone in that account. EducateOS also serves at <slug>.<your domain>.", placeholder: "riverbend.example" },
  accessTeam: { label: "Zero Trust team name", hint: "Your Cloudflare Access team, <team>.cloudflareaccess.com. Students and staff sign in through it.", placeholder: "riverbend" },
  allowedEmailDomains: { label: "Email domains that may sign in", hint: "Comma-separated.", placeholder: "riverbend.example" },
  admins: { label: "Administrator emails", hint: "Comma-separated. They become the installation's administrators.", placeholder: "it@riverbend.example" },
};

/** The guided install form. Rejected values are shown again with their errors; the token never is. */
export function installPage(
  shell: SiteShell,
  operator: Operator,
  values: Partial<Record<(typeof ECHOED_FIELDS)[number], string>> = {},
  errors: Partial<Record<string, string>> = {},
): string {
  const field = (name: (typeof ECHOED_FIELDS)[number]) => {
    const { label, hint, placeholder } = FIELD_LABELS[name];
    return html`<div class="field">
      <label for="${name}">${label}</label>
      <input class="input" id="${name}" name="${name}" value="${values[name] ?? ""}" placeholder="${placeholder}" required autocomplete="off" spellcheck="false">
      <small class="muted">${hint}</small>${errors[name] ? html`<br><small class="badge warn">${errors[name]}</small>` : ""}
    </div>`;
  };
  return page(shell, "Install EducateOS", html`<section class="page-hero">
    <div class="wrap">
      <div class="eyebrow">Operator console</div>
      <h1>Install EducateOS</h1>
      ${signedInBar(operator)}
      <p class="lede">educateos.io installs the latest signed release into your own Cloudflare account. Your installation then runs there, whether or not educateos.io is up.</p>
    </div>
  </section>
  <section class="tight">
    <div class="wrap">
      <form method="post" action="/app/install" class="card">
        ${ECHOED_FIELDS.map(field)}
        <div class="field">
          <label for="token">Cloudflare API token</label>
          <input class="input" id="token" name="token" type="password" required autocomplete="off" spellcheck="false">
          <small class="muted">Used once, for this install, and never stored. <a href="${installTokenLink()}" target="_blank" rel="noopener">Create a token with exactly these permissions</a>, scoped to that account and your domain's zone and educateos.io's zone if you own both, with a short expiry, then delete it once the install finishes.</small>
          ${errors.token ? html`<br><small class="badge warn">${errors.token}</small>` : ""}
          <details><summary class="muted">The permissions it needs</summary><ul class="checks">${INSTALL_TOKEN_PERMISSIONS.map((p) => html`<li>${p.scope}: ${p.name}: ${p.level}</li>`)}</ul></details>
        </div>
        <div class="field">
          <label><input type="checkbox" name="register"> Register this installation with educateos.io (optional)</label>
          <small class="muted">Registration lets your dashboard show the version and health your installation reports. It sends only the registry's fixed, content-free fields (see the privacy policy), and you can leave it off.</small>
        </div>
        <p><button class="btn primary" type="submit">Install</button> <a class="btn" href="/app/">Cancel</a></p>
      </form>
    </div>
  </section>`);
}

/** The top of the streamed progress page. */
export function installProgressHead(shell: SiteShell, slug: string): string {
  const [head] = pageParts(shell, "Installing EducateOS");
  return head + html`<section class="page-hero"><div class="wrap">
    <div class="eyebrow">Operator console</div>
    <h1>Installing ${slug}.educateos.io</h1>
    <p class="lede">Keep this page open until it finishes. If the page is closed or the connection drops, the install stops partway: run it again with the same settings and it continues from what is already in your account.</p>
  </div></section>
  <section class="tight"><div class="wrap"><ol class="list">`.text;
}

/** One progress event, as it is streamed. */
export function installProgressEvent(event: InstallEvent): string {
  switch (event.kind) {
    case "release":
      return html`<li class="li">Verified release <code>${event.releaseId}</code> (version ${event.version}) against the pinned release keys</li>`.text;
    case "step":
      return html`<li class="li"><span class="status avail">done</span> ${event.action} <code>${event.key}</code></li>`.text;
    case "report":
      return html`${event.blocking.map((entry) => html`<li class="li"><span class="badge warn">blocking</span> ${entry}</li>`)}${
        event.blocked.map((entry) => html`<li class="li"><span class="badge warn">blocked</span> ${entry}</li>`)}${
        event.warnings.map((entry) => html`<li class="li"><span class="status planned">note</span> ${entry}</li>`)}`.text;
    case "registration":
      return html`<li class="li">Registration with educateos.io: ${event.status}</li>`.text;
    case "done":
      return html`</ol><div class="note-box"><b>Installed.</b> <a href="https://${event.installation.hostname}/">${event.installation.hostname}</a> is live in your account, release ${event.installation.releaseVersion}. educateos.io has already discarded your token: delete it now in your Cloudflare dashboard (<a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noopener">API Tokens</a>). <a href="/app/">Back to your installations</a>.</div><ol class="list">`.text;
    case "failed":
      return html`</ol><div class="note-box"><b>The install stopped.</b> ${event.message} educateos.io has discarded your token. <a href="/app/install">Try again</a> or <a href="/app/">go back</a>.</div><ol class="list">`.text;
  }
}

/** The bottom of the streamed progress page. */
export function installProgressTail(shell: SiteShell): string {
  return `</ol></div></section>${pageParts(shell, "")[1]}`;
}
