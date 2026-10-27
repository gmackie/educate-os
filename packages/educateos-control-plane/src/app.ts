// The site Worker's dynamic routes. Static pages never reach this code: the assets binding serves
// every request that matches a file, and `run_worker_first` sends only these paths here first.
//
//   /healthz       the site's health check (ForgeGraph's healthCheckUrl): the store answers
//   /app, /app/*   the operator console, behind Cloudflare Access, on educateos.io only
//   /registry/*    the opt-in instance registry's heartbeats: signed by installations, no sign-in
//   /clever/launch Clever portal launches, sent on to the registered district (SCHO-249), no sign-in
//   /stripe/webhook Stripe's webhook deliveries for billing (SCHO-208): signed by Stripe, no sign-in
//
// Anything else that reaches the Worker is handed back to the assets binding, whose 404 page the
// static site already defines.
import type { ErrorCode } from "@educateos/contracts";
import { Heartbeat, SignedEnvelope } from "@educateos/fleet";
import { AccessUnavailableError, type OperatorIdentity, type OperatorVerifier } from "./access.ts";
import type { InvoiceChargeState } from "@educateos/commerce";
import { BILLING_PATHS, type BillingApi, type BillingReply, type CardSetupOutcome } from "./billing.ts";
import { CLEVER_LAUNCH_PATH, cleverLaunch, type CleverAppCredentials } from "./clever-launch.ts";
import { ECHOED_FIELDS, GuidedInstallForm, runGuidedInstall, type GuidedInstallDeps, type ReleaseBucket } from "./guided-install.ts";
import {
  BILLING_PAGE_HEADERS, billingPage, dashboardPage, installPage, installProgressEvent, installProgressHead, installProgressTail, messagePage, PAGE_HEADERS, type SiteShell,
} from "./pages.ts";
import { probeInstallation, type ProbeResult } from "./probe.ts";
import type { DashboardEntry, RegistryMessage, RegistryReply } from "./registry.ts";
import type { Installation, Operator, Reservation } from "./store.ts";

/** The paths the Worker handles before the assets binding, as `run_worker_first` lists them. */
export const DYNAMIC_PATHS = ["/healthz", "/app", "/app/*", "/registry/*", CLEVER_LAUNCH_PATH, BILLING_PATHS.webhook] as const;

/** The largest Stripe webhook delivery accepted. Stripe's events are a few kilobytes. */
export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

/** The console's form posts. Each must come from the console itself. */
const FORM_POSTS = new Set<string>(["/app/install", BILLING_PATHS.subscribe, BILLING_PATHS.card, BILLING_PATHS.pay, BILLING_PATHS.portal, BILLING_PATHS.cancel]);

/** The largest registry message accepted. A heartbeat is a few kilobytes. */
export const MAX_REGISTRY_BODY_BYTES = 64 * 1024;

/**
 * The registry messages served over HTTP. Registration isn't one of them: only the guided install
 * registers an installation, from inside the control plane, while it holds the install. So nobody
 * who learns an instance's IDs can register it first and lock the real installation out.
 */
export const HTTP_REGISTRY_MESSAGES = ["heartbeat"] as const satisfies readonly RegistryMessage[];

/** How many installations the dashboard probes at once, and at most in all. */
export const PROBE_LIMITS = { concurrency: 6, total: 50 } as const;

const REGISTRY_STATUS: Record<ErrorCode, number> = {
  "unauthenticated": 401,
  "forbidden": 403,
  "not-found": 404,
  "conflict": 409,
  "validation-failed": 400,
  "policy-violation": 403,
  "budget-exceeded": 429,
  "unavailable": 503,
};

/**
 * The one origin the console is served on. The Worker answers on www.educateos.io and the
 * educateos.dev hostnames too, but the Access application covers only this origin's /app, so the
 * console there is a redirect here.
 */
export const CONSOLE_ORIGIN = "https://educateos.io";

/** What the routes need from the store. The Durable Object's RPC stub satisfies it. */
export interface ControlPlaneApi extends BillingApi {
  signIn(identity: OperatorIdentity): Promise<Operator> | Operator;
  installations(operatorSubject: string): Promise<Installation[]> | Installation[];
  dashboard(operator: Operator): Promise<DashboardEntry[]>;
  recordInstallation(operatorSubject: string, installation: Installation): Promise<boolean> | boolean;
  reserveInstall(operatorSubject: string, slug: string, accountId: string, proposed: string): Promise<Reservation> | Reservation;
  endInstall(operatorSubject: string, slug: string, release: boolean): Promise<void> | void;
  receiveRegistryMessage(kind: RegistryMessage, input: unknown): Promise<RegistryReply>;
  cleverLaunchHostname(cleverDistrictId: string): Promise<string | undefined>;
  ping(): Promise<true> | true;
}

/** What {@link handleRequest} is given. */
export interface ControlPlaneDeps {
  shell: SiteShell;
  verifyOperator: OperatorVerifier;
  store: () => ControlPlaneApi;
  /** The static site, for every path the control plane doesn't own. */
  assets: (request: Request) => Promise<Response>;
  /** The commit the Worker was deployed from, if stamped. Reported by /healthz. */
  commit?: string;
  /** Probes an installation's hostname for the dashboard. Defaults to {@link probeInstallation}. */
  probe?: (hostname: string) => Promise<ProbeResult>;
  /** The Clever app's client, for portal launches. Undefined refuses every launch. */
  clever?: CleverAppCredentials;
  /** Reaches Clever for portal launches. Defaults to the global `fetch`. */
  cleverFetch?: (input: string, init: RequestInit) => Promise<Response>;
  /**
   * Clever district ID to hostname for the project's own districts, which aren't registered
   * installations (`CLEVER_LAUNCH_DISTRICTS`). Consulted only when the registry has no match.
   */
  cleverLaunchDistricts?: ReadonlyMap<string, string>;
  /** The guided install's release source and pinned trust. Without them, installing is unavailable. */
  releases?: { bucket: ReleaseBucket; trust: unknown };
  /** Keeps a streamed install running if the browser goes away mid-run. */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** The Cloudflare API the guided install drives. Defaults to api.cloudflare.com. */
  cloudflareApi?: GuidedInstallDeps["cloudflareApi"];
}

function respond(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { ...PAGE_HEADERS, ...headers } });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

/**
 * Routes one request. An unexpected failure is answered with a plain 500 page and logged by its
 * error name only, so neither the page nor the log quotes stored data.
 */
export async function handleRequest(request: Request, deps: ControlPlaneDeps): Promise<Response> {
  try {
    return await route(request, deps);
  } catch (error) {
    console.error("control plane request failed", { error: error instanceof Error ? error.name : typeof error });
    if (error instanceof AccessUnavailableError) {
      return respond(messagePage(deps.shell, "Sign-in is unavailable", "We couldn't check your sign-in just now. Try again shortly."), 503);
    }
    return respond(messagePage(deps.shell, "Something went wrong", "The operator console couldn't answer. Try again shortly."), 500);
  }
}

async function route(request: Request, deps: ControlPlaneDeps): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;

  if (pathname === "/healthz") {
    if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "method not allowed" }, 405);
    await deps.store().ping();
    return json({ status: "ok", commit: deps.commit ?? null });
  }

  if (pathname === CLEVER_LAUNCH_PATH) {
    return cleverLaunch(request, {
      shell: deps.shell,
      credentials: deps.clever,
      hostnameFor: async (cleverDistrictId) =>
        (await deps.store().cleverLaunchHostname(cleverDistrictId)) ?? deps.cleverLaunchDistricts?.get(cleverDistrictId),
      fetch: deps.cleverFetch ?? ((input, init) => fetch(input, init)),
    });
  }

  if (pathname === BILLING_PATHS.webhook) return receiveStripeWebhook(request, deps);

  if (pathname.startsWith("/registry/")) {
    try {
      return await receiveRegistryMessage(request, pathname, deps);
    } catch (error) {
      console.error("registry request failed", { error: error instanceof Error ? error.name : typeof error });
      return json({ error: "unavailable" }, 503);
    }
  }
  if (pathname !== "/app" && !pathname.startsWith("/app/")) return deps.assets(request);
  if (url.origin !== CONSOLE_ORIGIN) {
    return new Response(null, { status: 308, headers: { location: `${CONSOLE_ORIGIN}${pathname}${url.search}` } });
  }
  if (pathname === "/app") return new Response(null, { status: 308, headers: { location: "/app/" } });

  const identity = await deps.verifyOperator(request);
  if (identity === undefined) {
    // Access admits no request here without signing it in, so this is a request that bypassed
    // Access or carried an assertion for something else. Say so rather than redirect into a loop.
    return respond(messagePage(deps.shell, "Sign-in required",
      "This page is for signed-in operators. Open it again to sign in with your email address."), 401);
  }
  const posting = request.method === "POST" && FORM_POSTS.has(pathname);
  if (request.method !== "GET" && request.method !== "HEAD" && !posting) {
    return respond(messagePage(deps.shell, "Not allowed", "That request isn't supported here."), 405, { allow: "GET, HEAD" });
  }
  // A form post must come from the console itself. Access's cookie is SameSite=Lax, so another
  // site can't post with it anyway; this holds even if that ever changes.
  if (posting && request.headers.get("origin") !== CONSOLE_ORIGIN) {
    return respond(messagePage(deps.shell, "Not allowed", "That form didn't come from the operator console."), 403);
  }

  const store = deps.store();
  const operator = await store.signIn(identity);
  if (posting && pathname === "/app/install") return startInstall(request, operator, deps);
  if (posting || pathname === BILLING_PATHS.page || pathname === BILLING_PATHS.ret) return billing(request, url, operator, deps);
  switch (pathname) {
    case "/app/install":
      return respond(installPage(deps.shell, operator));
    case "/app/":
      return respond(dashboardPage(deps.shell, operator, await withProbes(await store.dashboard(operator), deps)));
    case "/app/api/installations":
      return json(await withProbes(await store.dashboard(operator), deps));
    case "/app/api/me":
      return json({ accountId: operator.accountId, email: operator.email, firstSeenAt: operator.firstSeenAt });
    default:
      return respond(messagePage(deps.shell, "Not found", "There's no operator console page at this address."), 404);
  }
}

// The billing routes (SCHO-208). Each form answers with a redirect: to Stripe's hosted pages, or
// back to the billing page, so reloading it never repeats a post.
async function billing(request: Request, url: URL, operator: Operator, deps: ControlPlaneDeps): Promise<Response> {
  const store = deps.store();
  const seeOther = (location: string) => new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });
  const refused = (reply: Extract<BillingReply<unknown>, { ok: false }>) => {
    if (reply.code === "unavailable") {
      return respond(messagePage(deps.shell, "Billing is unavailable", "educateos.io can't take payments just now. Try again shortly."), 503);
    }
    return respond(messagePage(deps.shell, "That didn't work", `${reply.message[0]!.toUpperCase()}${reply.message.slice(1)}.`), REGISTRY_STATUS[reply.code]);
  };
  switch (url.pathname) {
    case BILLING_PATHS.page: {
      const overview = await store.billingOverview(operator);
      if (!overview.ok) return refused(overview);
      const notice = BILLING_NOTICES[url.searchParams.get("card") ?? ""];
      return respond(billingPage(deps.shell, operator, overview.value, notice), 200, BILLING_PAGE_HEADERS);
    }
    case BILLING_PATHS.ret: {
      const subscription = url.searchParams.get("subscription") ?? "";
      const setup = url.searchParams.get("setup") ?? "";
      if (!REFERENCE.test(subscription) || !REFERENCE.test(setup)) {
        return respond(messagePage(deps.shell, "That didn't work", "This return address is incomplete. Open billing again."), 400);
      }
      const done = await store.completeCardSetup(operator, subscription, setup);
      if (!done.ok) return refused(done);
      return seeOther(`${BILLING_PATHS.page}?card=${returnNotice(done.value)}`);
    }
    case BILLING_PATHS.subscribe: {
      const form = await request.formData();
      const started = await store.subscribe(operator, String(form.get("plan") ?? ""), String(form.get("organization") ?? ""), CONSOLE_ORIGIN);
      return started.ok ? seeOther(started.value.url) : refused(started);
    }
    case BILLING_PATHS.card: {
      const resumed = await store.resumeCardSetup(operator, CONSOLE_ORIGIN);
      return resumed.ok ? seeOther(resumed.value.url) : refused(resumed);
    }
    case BILLING_PATHS.pay: {
      const paid = await store.payInvoice(operator);
      return paid.ok ? seeOther(`${BILLING_PATHS.page}?card=${CHARGE_NOTICES[paid.value]}`) : refused(paid);
    }
    case BILLING_PATHS.portal: {
      const portal = await store.paymentMethodPortal(operator, CONSOLE_ORIGIN);
      return portal.ok ? seeOther(portal.value.url) : refused(portal);
    }
    default: {
      const cancelled = await store.cancelSubscription(operator);
      return cancelled.ok ? seeOther(`${BILLING_PATHS.page}?card=cancelled`) : refused(cancelled);
    }
  }
}

// A subscription ID or a Stripe Checkout Session ID, as the return address carries them.
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

// The notice after a return from Stripe says what actually happened to the first invoice.
function returnNotice({ subscription, charge }: CardSetupOutcome): string {
  switch (subscription.status) {
    case "trialing":
      return "pending";
    case "cancelled":
      return "cancelled";
    case "active":
      return charge === undefined ? "saved" : CHARGE_NOTICES[charge];
    default:
      return "due";
  }
}

const CHARGE_NOTICES: Record<InvoiceChargeState, string> = {
  paid: "saved", pending: "saved", declined: "declined", uncharged: "uncharged", reopened: "reopened",
};

const BILLING_NOTICES: Record<string, string> = {
  saved: "Your card is saved and your subscription is active. Its invoice has been charged to that card.",
  pending: "No card was saved yet. Add a card to start your subscription.",
  declined: "Your card was declined. Update it under Manage payment methods, then use Pay now.",
  uncharged: "Your card is saved and your subscription is active, but its invoice couldn't be charged just now. Use Pay now to try again.",
  cancelled: "Your subscription is cancelled. Nothing more will be charged for it.",
  reopened: "Your invoice has an amount due again after a refund. Use Pay now to pay it.",
  due: "Your subscription has a payment due. Update your card under Manage payment methods, then use Pay now.",
};

// Stripe's webhook deliveries. The body is passed on exactly as received, because the signature
// covers those bytes; commerce verifies it before reading anything.
async function receiveStripeWebhook(request: Request, deps: ControlPlaneDeps): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  const signature = request.headers.get("stripe-signature");
  if (signature === null) return json({ error: "unauthenticated" }, 400);
  const payload = await boundedText(request, MAX_WEBHOOK_BODY_BYTES);
  if (payload === undefined) return json({ error: "validation-failed", message: "delivery too large" }, 413);
  const reply = await deps.store().receiveStripeWebhook(payload, signature);
  // One of EducateOS's own charges that couldn't be matched yet is answered 503, so Stripe
  // redelivers it; everything else, matched or not, 200.
  if (reply.ok) return json({ outcome: reply.value.outcome }, reply.value.retry === true ? 503 : 200);
  // Stripe redelivers anything but a 2xx. A delivery that fails verification or doesn't parse is
  // answered 400 so it shows as failing in Stripe's dashboard; billing being down is 503.
  return json({ error: reply.code }, reply.code === "unavailable" ? 503 : 400);
}

/** A dashboard row with what the probe saw. */
export interface ProbedEntry extends DashboardEntry {
  probe: ProbeResult;
}

// Probes the first PROBE_LIMITS.total installations, PROBE_LIMITS.concurrency at a time. The rest
// show as unreachable rather than making one page load fan out without bound.
async function withProbes(entries: DashboardEntry[], deps: ControlPlaneDeps): Promise<ProbedEntry[]> {
  const probe = deps.probe ?? ((hostname: string) => probeInstallation(hostname));
  const results: ProbeResult[] = entries.map(() => ({ state: "unreachable" }));
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < Math.min(entries.length, PROBE_LIMITS.total); i = next++) {
      results[i] = await probe(entries[i]!.installation.hostname);
    }
  };
  await Promise.all(Array.from({ length: PROBE_LIMITS.concurrency }, worker));
  return entries.map((entry, i) => ({ ...entry, probe: results[i]! }));
}

/** The body as text, or undefined once it passes `limit` bytes, whatever Content-Length said. */
async function boundedText(request: Request, limit: number): Promise<string | undefined> {
  if (Number(request.headers.get("content-length") ?? "0") > limit) return undefined;
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function receiveRegistryMessage(request: Request, pathname: string, deps: ControlPlaneDeps): Promise<Response> {
  const kind = HTTP_REGISTRY_MESSAGES.find((message) => pathname === `/registry/v1/${message}`);
  if (kind === undefined) return json({ error: "not-found" }, 404);
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  const text = await boundedText(request, MAX_REGISTRY_BODY_BYTES);
  if (text === undefined) return json({ error: "validation-failed", message: "message too large" }, 413);
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return json({ error: "validation-failed", message: "not JSON" }, 400);
  }
  // Checked here as well as by the registry, so a malformed message never reaches the one object
  // that also serves sign-in and the dashboard.
  const envelope = SignedEnvelope.safeParse(input);
  if (!envelope.success || !Heartbeat.safeParse(envelope.data.payload).success) {
    return json({ error: "validation-failed", message: "malformed heartbeat" }, 400);
  }
  const reply = await deps.store().receiveRegistryMessage(kind, input);
  return reply.ok ? json(reply.body) : json({ error: reply.code, message: reply.message }, REGISTRY_STATUS[reply.code]);
}

// Runs the guided install from a form post and streams its progress as the page itself, so the
// operator watches each step land with no script on the page. The token is read from the form into
// the run and goes nowhere else.
async function startInstall(request: Request, operator: Operator, deps: ControlPlaneDeps): Promise<Response> {
  const fields = Object.fromEntries([...(await request.formData()).entries()].map(([key, value]) => [key, String(value)]));
  const parsed = GuidedInstallForm.safeParse(fields);
  const echoed = Object.fromEntries(ECHOED_FIELDS.map((name) => [name, fields[name] ?? ""]));
  if (!parsed.success) {
    const errors = Object.fromEntries(parsed.error.issues.map((issue) => [String(issue.path[0]), issue.message]));
    return respond(installPage(deps.shell, operator, echoed, errors), 400);
  }
  if (deps.releases === undefined) {
    return respond(messagePage(deps.shell, "Installing is unavailable", "educateos.io has no release source configured."), 503);
  }
  const { releases } = deps;
  const store = deps.store();
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  // A write fails once the browser has gone; the install carries on regardless.
  const write = (text: string) => void writer.write(encoder.encode(text)).catch(() => undefined);

  write(installProgressHead(deps.shell, parsed.data.slug));
  const run = runGuidedInstall(parsed.data, {
    operator,
    bucket: releases.bucket,
    trust: releases.trust,
    reserve: async (slug, accountId, proposed) => store.reserveInstall(operator.subject, slug, accountId, proposed),
    end: async (slug, release) => store.endInstall(operator.subject, slug, release),
    record: async (installation) => store.recordInstallation(operator.subject, installation),
    register: (envelope) => store.receiveRegistryMessage("register", envelope),
    ...(deps.cloudflareApi ? { cloudflareApi: deps.cloudflareApi } : {}),
  }, (event) => write(installProgressEvent(event))).catch((error: unknown) => {
    console.error("guided install failed", { error: error instanceof Error ? error.name : typeof error });
    write(installProgressEvent({ kind: "failed", message: "Unexpected error." }));
  }).finally(() => {
    write(installProgressTail(deps.shell));
    void writer.close().catch(() => undefined);
  });
  deps.waitUntil?.(run);
  return new Response(readable, { headers: { ...PAGE_HEADERS } });
}
