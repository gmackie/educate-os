// The site Worker's dynamic routes. Static pages never reach this code: the assets binding serves
// every request that matches a file, and `run_worker_first` sends only these paths here first.
//
//   /healthz       the site's health check (ForgeGraph's healthCheckUrl): the store answers
//   /app, /app/*   the operator console, behind Cloudflare Access, on educateos.io only
//
// Anything else that reaches the Worker is handed back to the assets binding, whose 404 page the
// static site already defines.
import { AccessUnavailableError, type OperatorIdentity, type OperatorVerifier } from "./access.ts";
import { dashboardPage, messagePage, PAGE_HEADERS, type SiteShell } from "./pages.ts";
import type { Installation, Operator } from "./store.ts";

/** The paths the Worker handles before the assets binding, as `run_worker_first` lists them. */
export const DYNAMIC_PATHS = ["/healthz", "/app", "/app/*"] as const;

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
      return respond(dashboardPage(deps.shell, operator, await store.installations(operator.subject)));
    case "/app/api/me":
      return json({ accountId: operator.accountId, email: operator.email, firstSeenAt: operator.firstSeenAt });
    default:
      return respond(messagePage(deps.shell, "Not found", "There's no operator console page at this address."), 404);
  }
}
