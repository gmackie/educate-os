import {
  OBSERVABILITY, bindings, defineGadgetsWorker, type WranglerExtras,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "router",
  entrypoint: "src/index.ts",

  // The router owns the public origin for customer instances, so it serves the frontend.
  // `runWorkerFirst` keeps API and gatekeeper prefixes, and the `/healthz` liveness probe, on the
  // worker; everything else falls through to static assets with SPA fallback, which would answer
  // the probe with index.html.
  assets: {
    notFoundHandling: "single-page-application",
    runWorkerFirst: [
      "/api",
      "/api/*",
      "/blueprint-screenshot",
      "/blueprint-screenshot/*",
      "/gatekeeper/*",
      "/healthz",
    ],
  },

  env: {
    // Gatekeeper service bindings (GATEKEEPER_*) are added dynamically at deploy time — by the
    // deploy service for customer instances, from the release manifest's binding templates. Only
    // the static backend binding is checked in.
    WORKSHOP_BACKEND: bindings.worker({ worker: "workshop-backend" }),
    ASSETS: bindings.assets(),
    // One origin per district (ADR-0014): a deployment that serves a district at the router's
    // hostname adds the district Worker as `DISTRICT`, sets the assets' `run_worker_first` to
    // `true` (the Workshop's assets move under /ai, and would otherwise answer `/` and shadow the
    // district's `/assets/*`), and may set `AI_ENABLED: "false"` with `AI_DEMO_URL` for a district
    // with no Workshop. No checked-in config does yet; the production cutover adds it. For example:
    //
    //   DISTRICT: bindings.worker({ worker: "educateos-district-worker" }),
  },

  observability: OBSERVABILITY,
});

export const wrangler = {
  assetsDirectory: "../workshop-frontend/dist",
} satisfies WranglerExtras;
