// Test worker: the production entrypoints, plus the fake Hall Monitor (src/fake-hall-monitor.ts)
// bound as `HALL_MONITOR`, so the guard reaches it through a real service binding. A test picks
// the fake's decision by a marker in what it sends (`[[block]]`, `[[support]]`, `[[down]]`, ...).

import { WorkerEntrypoint } from "cloudflare:workers";
import type { GuardSubjectRequest } from "@schoolos/district-app/guard-directory";
import { readGuardConfig } from "../src/config.ts";
import { configuredGuardDirectory } from "../src/context.ts";
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

/**
 * A stand-in for a deployed district app's guard entrypoint, bound as `SCHOOLOS_DISTRICT`: it
 * answers from the configured directory, but over a real service binding.
 */
export class FakeDistrictDirectory extends WorkerEntrypoint<Cloudflare.Env> {
  async guardSubject(request: GuardSubjectRequest): Promise<unknown> {
    return configuredGuardDirectory(readGuardConfig(this.env.AI_GUARD_CONFIG)).guardSubject(request);
  }

  async ledgerDirectory(): Promise<unknown> {
    return configuredGuardDirectory(readGuardConfig(this.env.AI_GUARD_CONFIG)).ledgerDirectory();
  }
}
