import type { ReleaseManifest } from "./manifest-lib.ts";

/** Apply backend authority and public MCP routing before the school manifest is signed. */
export function applySchoolProfile(manifest: Pick<ReleaseManifest, "workers">): void {
  const workers = Object.values(manifest.workers);
  const backend = workers.find(worker => worker.kind === "backend");
  const router = workers.find(worker => worker.kind === "router");
  if (!backend || !router || !manifest.workers["educateos-district-worker"] ||
      !manifest.workers["educateos-external-mcp"]) {
    throw new Error("School release requires district authority and external MCP Workers");
  }
  backend.vars.REQUIRE_PRINCIPAL_RESOLVER = "true";
  if (!backend.bindings.some(binding => binding.name === "PRINCIPAL_RESOLVER")) {
    backend.bindings.push({ type: "service", name: "PRINCIPAL_RESOLVER",
      service: "$WORKER_NAME(educateos-district-worker)", entrypoint: "DistrictPrincipalResolver" });
  }
  backend.vars.REQUIRE_WORKSHOP_CAPABILITY_POLICY = "true";
  backend.bindings.push({ type: "service", name: "WORKSHOP_CAPABILITY_POLICY",
    service: "$WORKER_NAME(educateos-district-worker)", entrypoint: "DistrictWorkshopCapabilityPolicy" });
  router.bindings.push({ type: "service", name: "EDUCATEOS_EXTERNAL_MCP",
    service: "$WORKER_NAME(educateos-external-mcp)" });
}
