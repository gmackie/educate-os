// The site Worker's dynamic routes. Static pages never reach this code: the assets binding serves
// every request that matches a file, and `run_worker_first` sends only these paths here first.
//
//   /healthz       the site's health check (ForgeGraph's healthCheckUrl): the store answers
//   /app, /app/*   the operator console, behind Cloudflare Access, on educateos.io only
//   /registry/*    the opt-in instance registry's heartbeats: signed by installations, no sign-in
//
// Anything else that reaches the Worker is handed back to the assets binding, whose 404 page the
// static site already defines.
import type { ErrorCode } from "@educateos/contracts";
import { Heartbeat, SignedEnvelope } from "@educateos/fleet";
import { AccessUnavailableError, type OperatorIdentity, type OperatorVerifier } from "./access.ts";
import { dashboardPage, messagePage, PAGE_HEADERS, type SiteShell } from "./pages.ts";
import { probeInstallation, type ProbeResult } from "./probe.ts";
import type { DashboardEntry, RegistryMessage, RegistryReply } from "./registry.ts";
import type { Installation, Operator } from "./store.ts";

/** The paths the Worker handles before the assets binding, as `run_worker_first` lists them. */
export const DYNAMIC_PATHS = ["/healthz", "/app", "/app/*", "/registry/*"] as const;

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
export interface ControlPlaneApi {
  signIn(identity: OperatorIdentity): Promise<Operator> | Operator;
  installations(operatorSubject: string): Promise<Installation[]> | Installation[];
  dashboard(operator: Operator): Promise<DashboardEntry[]>;
  receiveRegistryMessage(kind: RegistryMessage, input: unknown): Promise<RegistryReply>;
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
  if (request.method !== "GET" && request.method !== "HEAD") {
    return respond(messagePage(deps.shell, "Not allowed", "That request isn't supported here."), 405, { allow: "GET, HEAD" });
  }

  const store = deps.store();
  const operator = await store.signIn(identity);
  switch (pathname) {
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
