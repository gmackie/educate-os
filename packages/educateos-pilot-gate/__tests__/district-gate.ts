// Registers the district scenarios as Vitest tests from the registry (`src/districts.ts`), as
// `gate.ts` does for the pilot gate's criteria: a cell that runs needs a body, a blocked cell is an
// `it.todo` naming the issues it waits on, and a cell outside the district's profile registers
// nothing. A body is written once and runs in every district the scenario applies to.
import { describe, it, type TestContext } from "vitest";
import { DEMO_DISTRICTS, demoDistrict, type DemoDistrict, type DemoDistrictSlug } from "@educateos/fixtures";
import { districtTitle, SCENARIOS, scenarioTestName } from "../src/districts.ts";

/** One scenario's body, run once per district it applies to. */
export type ScenarioBody = (demo: DemoDistrict, context: TestContext) => Promise<void>;

/**
 * Registers one district's scenarios. Throws at collection if a scenario that runs in any district
 * has no body, or a body names no scenario or one that runs nowhere, so every district's file
 * checks the whole registry.
 */
export function districtScenarios(bodies: Readonly<Record<string, ScenarioBody>>, slug: DemoDistrictSlug): void {
  for (const id of Object.keys(bodies)) {
    const scenario = SCENARIOS.find((s) => s.id === id);
    if (scenario === undefined) throw new Error(`there is no district scenario ${id}`);
    if (!DEMO_DISTRICTS.some((demo) => scenario.applies(demo).kind === "runs")) throw new Error(`${id} runs in no district but has a body`);
  }
  for (const scenario of SCENARIOS) {
    const runsSomewhere = DEMO_DISTRICTS.filter((demo) => scenario.applies(demo).kind === "runs").map((demo) => demo.slug);
    if (runsSomewhere.length > 0 && bodies[scenario.id] === undefined) throw new Error(`${scenario.id} runs in ${runsSomewhere.join(", ")} but has no body`);
  }
  const demo = demoDistrict(slug);
  describe(districtTitle(demo), () => {
    for (const scenario of SCENARIOS) {
      const applicability = scenario.applies(demo);
      if (applicability.kind === "not-in-profile") continue;
      if (applicability.kind === "blocked") {
        it.todo(scenarioTestName(scenario, applicability));
        continue;
      }
      const body = bodies[scenario.id]!;
      it(scenarioTestName(scenario, applicability), (context) => body(demo, context));
    }
  });
}
