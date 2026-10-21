import { describe, expect, it } from "vitest";
import { IntegrationSyncRun, integrationHealth } from "../src/index.ts";

const ZERO = { added: 0, updated: 0, deactivated: 0 };
const COUNTS = {
  schools: ZERO,
  terms: ZERO,
  courses: ZERO,
  offerings: ZERO,
  principals: ZERO,
  enrollments: ZERO,
  roleAssignments: { added: 0, removed: 0 },
};
const SLA = { maxStalenessMinutes: 60 };
const NOW = new Date("2026-10-20T12:00:00Z");

function run(id: string, finishedAt: string, outcome: "succeeded" | "failed", extra: Partial<IntegrationSyncRun> = {}): IntegrationSyncRun {
  return {
    id,
    mode: "delta",
    startedAt: finishedAt,
    finishedAt,
    counts: COUNTS,
    outcome,
    ...(outcome === "failed" ? { errorCode: "source-unavailable" } : { quarantined: 0 }),
    ...extra,
  };
}

describe("integrationHealth", () => {
  it("reports an integration that never succeeded", () => {
    expect(integrationHealth([], SLA, NOW)).toEqual({ status: "never-synced", consecutiveFailures: 0, quarantineBacklog: 0 });
    expect(integrationHealth([run("a", "2026-10-20T11:00:00Z", "failed")], SLA, NOW)).toEqual({
      status: "never-synced",
      consecutiveFailures: 1,
      lastErrorCode: "source-unavailable",
      quarantineBacklog: 0,
    });
  });

  it("is healthy within the SLA, and stale past it", () => {
    const runs = [run("a", "2026-10-20T11:30:00Z", "succeeded", { quarantined: 2 })];
    expect(integrationHealth(runs, SLA, NOW)).toEqual({
      status: "healthy",
      lastSuccessAt: "2026-10-20T11:30:00Z",
      stalenessMinutes: 30,
      consecutiveFailures: 0,
      quarantineBacklog: 2,
    });
    expect(integrationHealth(runs, SLA, new Date("2026-10-20T12:31:00Z")).status).toBe("stale");
  });

  it("counts failures since the last success whatever order the runs are given in", () => {
    const runs = [
      run("c", "2026-10-20T11:50:00Z", "failed", { errorCode: "rate-limited" }),
      run("a", "2026-10-20T11:00:00Z", "failed"),
      run("b", "2026-10-20T11:20:00Z", "succeeded", { quarantined: 1 }),
      run("d", "2026-10-20T11:40:00Z", "failed", { errorCode: "feed-rejected", quarantined: 5 }),
    ];
    expect(integrationHealth(runs, SLA, NOW)).toEqual({
      status: "degraded",
      lastSuccessAt: "2026-10-20T11:20:00Z",
      stalenessMinutes: 40,
      consecutiveFailures: 2,
      lastErrorCode: "rate-limited",
      // A rejected feed applied nothing, so the backlog is still the last success's.
      quarantineBacklog: 1,
    });
  });

  it("rejects a run record that is not well formed", () => {
    expect(() => integrationHealth([{ ...run("a", "2026-10-20T11:00:00Z", "failed"), errorCode: undefined }], SLA, NOW)).toThrow();
    expect(IntegrationSyncRun.safeParse({ ...run("a", "2026-10-20T11:00:00Z", "succeeded"), message: "x" }).success).toBe(false);
  });
});
