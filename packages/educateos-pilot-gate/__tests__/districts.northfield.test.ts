// The district validation suite (SCHO-205) for northfield: see district-scenarios.ts and src/districts.ts.
import { districtScenarios } from "./district-gate.ts";
import { SCENARIO_BODIES } from "./district-scenarios.ts";

districtScenarios(SCENARIO_BODIES, "northfield");
