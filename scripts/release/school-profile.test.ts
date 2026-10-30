import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { applySchoolProfile } from "./school-profile.ts";
import { generateManifest, readDeployablePackages } from "./manifest-lib.ts";

test("school manifest binds district authority and MCP before signing; generic is untouched", () => {
  const packages = readDeployablePackages(join(import.meta.dirname, "../../packages"));
  const manifest = generateManifest({ releaseId: "school-test", commit: "0".repeat(40),
    createdAt: "2026-10-30T00:00:00Z", wranglerVersion: "test", profile: "school", assetVariants: {},
    workers: packages.filter(pkg => ["router", "workshop-backend", "educateos-district-worker",
      "educateos-external-mcp"].includes(pkg.name)).map(pkg => ({ pkgName: pkg.name,
      config: pkg.config, mainModule: "index.js", modules: [] })),
  });
  assert.equal(manifest.workers["workshop-backend"].vars.REQUIRE_WORKSHOP_CAPABILITY_POLICY, undefined);
  applySchoolProfile(manifest);
  assert.equal(manifest.workers["workshop-backend"].vars.REQUIRE_WORKSHOP_CAPABILITY_POLICY, "true");
  assert.deepEqual(manifest.workers["workshop-backend"].bindings.find(b => b.name === "WORKSHOP_CAPABILITY_POLICY"), {
    type: "service", name: "WORKSHOP_CAPABILITY_POLICY", service: "$WORKER_NAME(educateos-district-worker)",
    entrypoint: "DistrictWorkshopCapabilityPolicy",
  });
  assert.equal(manifest.workers["workshop-backend"].vars.REQUIRE_PRINCIPAL_RESOLVER, "true");
  assert.deepEqual(manifest.workers["workshop-backend"].bindings.find(b => b.name === "PRINCIPAL_RESOLVER"), {
    type: "service", name: "PRINCIPAL_RESOLVER", service: "$WORKER_NAME(educateos-district-worker)",
    entrypoint: "DistrictPrincipalResolver",
  });
  assert.equal(manifest.workers.router.bindings.find(b => b.name === "EDUCATEOS_EXTERNAL_MCP")?.type, "service");
  delete manifest.workers["educateos-district-worker"];
  assert.throws(() => applySchoolProfile(manifest), /requires district authority/);
});
