// The public origin of a gadgets instance. Routes by path prefix to the workshop backend and
// whichever gatekeepers are bound, and serves the workshop frontend for everything else.
//
// Routing config IS the binding set: gatekeepers are discovered by scanning `GATEKEEPER_*` env
// keys, so installing a gatekeeper only requires re-deploying this worker with one more service
// binding — no code or config changes here.
//
// With a `DISTRICT` service binding the router instead owns a district's whole origin (ADR-0014):
// the district at `/`, the Workshop under `/ai`. one-origin.ts has that path table. Without it,
// nothing below changes.
//
// The same worker doubles as the dev router (`pnpm dev-server` at the repo root): dev has no
// `ASSETS` binding, so frontend requests fall through to the backend instead.

import { legacyRedirect, parseLegacyHosts } from "./legacy-hosts";
import {
  aiDisabledResponse, districtOriginTarget, fetchWorkshopAsset, stripAiPrefix,
} from "./one-origin";

// gatekeeper-email's entrypoint: a WorkerEntrypoint whose optional email() handler is present.
type EmailEntrypoint = CloudflareWorkersModule.WorkerEntrypoint &
    Required<Pick<CloudflareWorkersModule.WorkerEntrypoint, "email">>;

export interface Env {
  /**
   * The Workshop backend. Every instance binds it today; only a district origin with no Workshop
   * (see `DISTRICT` and `AI_ENABLED`) may leave it out.
   */
  WORKSHOP_BACKEND?: Fetcher;
  /** School-only MCP transport. */
  EDUCATEOS_EXTERNAL_MCP?: Fetcher;
  /** Present in production (wrangler.jsonc assets stanza); absent in dev. */
  ASSETS?: Fetcher;
  /** Dormant until custom domains + Email Routing exist; the handler ships anyway. */
  GATEKEEPER_EMAIL?: Service<EmailEntrypoint>;
  /**
   * The district Worker (ADR-0014). When bound, the router owns the district's origin: the district
   * serves `/`, `/api/*`, `/lti/*` and `/.well-known/*`, and the Workshop moves under `/ai`. The
   * deployment must then run this Worker first for every path (`run_worker_first: true`).
   */
  DISTRICT?: Fetcher;
  /**
   * With `DISTRICT` bound: "false" serves `/ai` as an "AI isn't enabled at your school" page, for a
   * district with no Workshop. Any other value, or none, serves the Workshop when it is bound.
   */
  AI_ENABLED?: string;
  /** With AI disabled: an AI-enabled demo district the page links to. */
  AI_DEMO_URL?: string;
  /**
   * A district's old hostnames, still attached to this Worker, as JSON: hostname → the https URL
   * prefix it now redirects to (ADR-0014 §7). See legacy-hosts.ts. Unset, nothing redirects.
   */
  LEGACY_HOSTS?: string;
  /**
   * This Worker's version, injected by the service that installed the deployment (no config here
   * declares it). Typed structurally because its shape is not ours to guarantee.
   */
  CF_VERSION_METADATA?: { tag?: unknown };
  [key: string]: unknown;
}

/**
 * Carries the router's version tag to the backend, which reports it to admins as part of the
 * deployment's "modified" check. The backend's copy of this name is ROUTER_VERSION_HEADER in
 * packages/workshop-backend/src/deployment-updates.ts (the router does not depend on
 * workshop-shared). It is a display label, never authority: any request reaching the backend could
 * carry it, which is why the router overwrites whatever value a client sent.
 */
const ROUTER_VERSION_HEADER = "Cloudflare-OS-Router-Version";

/** Forwards `req` to the backend, stamped with this router's version tag. */
function forwardToBackend(req: Request, env: Env): Promise<Response> {
  const tag = env.CF_VERSION_METADATA?.tag;
  const headers = new Headers(req.headers);
  headers.set(ROUTER_VERSION_HEADER, typeof tag === "string" ? tag : "");
  if (!env.WORKSHOP_BACKEND) {
    return Promise.resolve(new Response("This instance has no Workshop.", { status: 503 }));
  }
  return env.WORKSHOP_BACKEND.fetch(new Request(req, { headers }));
}

/** The district origin (ADR-0014), after `/healthz` and the gatekeepers: see one-origin.ts. */
function routeDistrictOrigin(req: Request, url: URL, env: Env, district: Fetcher): Promise<Response> {
  const aiEnabled = env.AI_ENABLED !== "false" && env.WORKSHOP_BACKEND !== undefined;
  switch (districtOriginTarget(url.pathname, aiEnabled)) {
    case "workshop-backend":
      return forwardToBackend(req, env);
    case "workshop-assets":
      if (env.ASSETS) return fetchWorkshopAsset(req, env.ASSETS);
      // Dev, as below: the backend serves the frontend, at the path the assets would see.
      {
        const stripped = new URL(url);
        stripped.pathname = stripAiPrefix(url.pathname);
        return forwardToBackend(new Request(stripped, req), env);
      }
    case "ai-disabled":
      return Promise.resolve(aiDisabledResponse(req, env.AI_DEMO_URL));
    case "district":
      return district.fetch(req);
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // Liveness for deployers' health probes: answered here, so it reaches no backend or gatekeeper
    // and carries nothing about the instance. A deployment behind Cloudflare Access exempts this
    // one path from sign-in so the probe can reach it.
    if (url.pathname === "/healthz") {
      return new Response("ok", { headers: { "content-type": "text/plain", "cache-control": "no-store" } });
    }

    // A district's old hostnames answer with redirects only, before anything is routed.
    if (env.LEGACY_HOSTS !== undefined) {
      let redirect: Response | undefined;
      try {
        redirect = legacyRedirect(req, parseLegacyHosts(env.LEGACY_HOSTS));
      } catch (error) {
        console.error(error instanceof Error ? error.message : "LEGACY_HOSTS is invalid");
        return new Response("This deployment's legacy hostnames are misconfigured.", { status: 500 });
      }
      if (redirect) return redirect;
    }
    if (env.EDUCATEOS_EXTERNAL_MCP && ["/mcp", "/token",
      "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"].includes(url.pathname)) {
      return env.EDUCATEOS_EXTERNAL_MCP.fetch(req);
    }

    for (const key of Object.keys(env)) {
      if (!key.startsWith("GATEKEEPER_")) continue;
      const suffix = key.slice("GATEKEEPER_".length).toLowerCase().replaceAll("_", "-");
      const prefix = `/gatekeeper/${suffix}`;
      if (url.pathname === prefix || url.pathname.startsWith(prefix + "/")) {
        return (env[key] as Fetcher).fetch(req);
      }
    }

    if (env.DISTRICT) {
      return routeDistrictOrigin(req, url, env, env.DISTRICT);
    }

    if (url.pathname === "/api" || url.pathname.startsWith("/api/") ||
        url.pathname === "/blueprint-screenshot" ||
        url.pathname.startsWith("/blueprint-screenshot/")) {
      return forwardToBackend(req, env);
    }

    // Note: gatekeeper OAuth redirects land on the gatekeeper Workers themselves, at
    // `/gatekeeper/<name>/oauth` (handled by the loop above) — there are no backend /auth
    // callbacks.

    if (env.ASSETS) {
      return env.ASSETS.fetch(req);
    }

    // Dev only: with no assets binding here, everything else goes to the backend.
    //
    // In `run-local` mode the backend has a static `assets` binding configured (with
    // `run_worker_first` for the API routes), so it serves the pre-built single-page app for these
    // frontend requests. In normal dev mode the backend has no assets and frontend requests aren't
    // expected here -- run the Vite dev server with `pnpm dev-client` and open localhost:3000
    // directly instead. (We don't try to forward to localhost:3000 becaues it doesn't work well:
    // Vite's HMR socket gets disconnected every time wrangler restarts workerd.)
    return forwardToBackend(req, env);
  },

  async email(message, env) {
    if (!env.GATEKEEPER_EMAIL) {
      message.setReject("No email gatekeeper is installed on this instance.");
      return;
    }
    await env.GATEKEEPER_EMAIL.email(message);
  },
} satisfies ExportedHandler<Env>;
