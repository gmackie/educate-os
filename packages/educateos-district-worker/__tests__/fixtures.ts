// Fixtures shared by the workerd suite and its config.
import { NORTHFIELD } from "@educateos/fixtures";
import type { DistrictWorkerConfig } from "../src/config.ts";

/** The Access team domain the tests sign as: Northfield's trusted issuer. */
export const ACCESS_ISSUER = NORTHFIELD.district.trustedIssuers[0]!;
/** The district's own Access application audience, which the tests sign for by default. */
export const ACCESS_AUDIENCE = "test-district-aud";
/** The instance Workshop's Access application audience, which the district also accepts (SCHO-218). */
export const WORKSHOP_ACCESS_AUDIENCE = "test-workshop-aud";
/** `CF_ACCESS_AUD` as the tests deploy it: both audiences, with an empty and a blank entry to ignore. */
export const ACCESS_AUDIENCES = ` ${ACCESS_AUDIENCE},, ,${WORKSHOP_ACCESS_AUDIENCE} `;

/** The LTI Tool's origin, as the tests deploy it (SCHO-177): the host their requests name. */
export const LTI_TOOL_ORIGIN = "https://district.example";
/** The synthetic LMS the LTI tests register (SCHO-177). Not one of Northfield's trusted issuers. */
export const LMS_ISSUER = "https://lms.northfield.example";

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
  email: { from: "educateos@northfield.example", fromName: "Northfield EducateOS", appUrl: "https://learn.northfield.example" },
};
