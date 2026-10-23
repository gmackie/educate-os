// Fixtures shared by the workerd suite and its config.
import { NORTHFIELD } from "@schoolos/fixtures";
import type { DistrictWorkerConfig } from "../src/config.ts";

/** The Access team domain the tests sign as: Northfield's trusted issuer. */
export const ACCESS_ISSUER = NORTHFIELD.district.trustedIssuers[0]!;
/** The Access application audience the tests sign for. */
export const ACCESS_AUDIENCE = "test-district-aud";

/** Northfield as the district's seed, its records owned by the roster, funded for one synthetic model. */
export const TEST_CONFIG: DistrictWorkerConfig = {
  directory: NORTHFIELD,
  fundingPools: [{
    id: "fpl_courses" as never,
    name: "Course AI",
    purpose: "course",
    scope: { level: "district", districtId: NORTHFIELD.district.id },
    monthlyAllocationUsdNano: "100000000000" as never,
    allowedModels: [{ provider: "cloudflare", modelId: "synthetic-model" }],
  }],
  modelCatalog: [{ provider: "cloudflare", modelId: "synthetic-model", mode: "enabled" }],
  // SCHO-189: email through the (recorded) Email Service binding.
  email: { from: "schoolos@northfield.example", fromName: "Northfield SchoolOS", appUrl: "https://learn.northfield.example" },
};
