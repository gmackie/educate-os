// Test worker: the production entrypoints, plus the fake Hall Monitor (src/fake-hall-monitor.ts)
// bound as `HALL_MONITOR`, so the guard reaches it through a real service binding. A test picks
// the fake's decision by a marker in what it sends (`[[block]]`, `[[support]]`, `[[down]]`, ...).

import { WorkerEntrypoint } from "cloudflare:workers";
import { fakeHallMonitor } from "../src/fake-hall-monitor.ts";

// Named rather than `export *`: the pool finds entrypoints from the module's named exports.
export { DistrictAiLedger, SchoolOsAiCallGuard } from "../src/worker.ts";
export { default } from "../src/worker.ts";

/** The fake Hall Monitor Worker. */
export class FakeHallMonitor extends WorkerEntrypoint {
  override async fetch(request: Request): Promise<Response> {
    return fakeHallMonitor(request);
  }
}
