/**
 * The educateos.io site Worker. Requests that match a file in public/ are served before this script
 * runs. The script handles the paths `run_worker_first` names (the operator console under /app,
 * the registry and the /healthz check, SCHO-206, Clever portal launches, SCHO-249, and Stripe's
 * billing webhook, SCHO-208) and hands everything else back to the assets binding, which applies
 * the 404 page. The control plane itself is `@educateos/control-plane`; this file gives it the
 * site's header and footer. It is imported by path because sites/ is outside the pnpm workspace,
 * which keeps release discovery and config generation from ever seeing this Worker (ADR-0013).
 */
import footer from "./partials/footer.html";
import header from "./partials/header.html";
import { siteWorker } from "../../packages/educateos-control-plane/src/worker.ts";

export { ControlPlane } from "../../packages/educateos-control-plane/src/worker.ts";
// The read-only export the admin Worker (admin.educateos.io) binds to import operators,
// installations and slug reservations (SCHO-263). An RPC entrypoint: it has no URL.
export { ControlPlaneExporter } from "../../packages/educateos-control-plane/src/worker.ts";

export default siteWorker({ header, footer });
