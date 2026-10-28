// Analytics snapshot caching: aggregates are kept for five minutes, refreshed on request, served
// stale when the district can't be reached, and stored only as the validated aggregates.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AnalyticsEnvelope } from "../src/shared/api.ts";
import { SNAPSHOT_TTL_MS } from "../src/worker/app.ts";
import { adminDeps, call, districts, enrolled, FakeDistrict, manualClock, uniqueOrigin } from "./support.ts";

async function setup() {
  const clock = manualClock();
  const district = new FakeDistrict(uniqueOrigin(), clock.now);
  const deps = adminDeps({ fetchDistrict: districts(district), now: clock.now });
  const { workspace } = await enrolled(deps, district);
  const analytics = async (query = "range=24h") => {
    const response = await call(deps, "GET", `/api/workspaces/${workspace.id}/analytics?${query}`);
    expect(response.status).toBe(200);
    return response.json<AnalyticsEnvelope>();
  };
  return { clock, district, workspace, analytics };
}

describe("analytics snapshots", () => {
  it("asks the district once per window, then serves the snapshot until it is five minutes old", async () => {
    const { clock, district, analytics } = await setup();
    const first = await analytics();
    expect(first).toMatchObject({ cached: false, stale: false, fetchedAt: "2026-10-28T12:00:00.000Z", analytics: { range: "24h", http: { requests: 1001 } } });

    clock.advance(SNAPSHOT_TTL_MS - 1000);
    expect(await analytics()).toMatchObject({ cached: true, stale: false, fetchedAt: first.fetchedAt, analytics: { http: { requests: 1001 } } });
    expect(district.analyticsCalls).toBe(1);

    // Each window is its own snapshot.
    expect(await analytics("range=7d")).toMatchObject({ cached: false, analytics: { range: "7d" } });
    expect(district.analyticsCalls).toBe(2);

    clock.advance(2000);
    expect(await analytics()).toMatchObject({ cached: false, analytics: { http: { requests: 1003 } } });
    expect(district.analyticsCalls).toBe(3);
  });

  it("asks again on refresh=1, whatever the snapshot's age", async () => {
    const { district, analytics } = await setup();
    await analytics();
    expect(await analytics("range=24h&refresh=1")).toMatchObject({ cached: false });
    expect(district.analyticsCalls).toBe(2);
  });

  it("serves the last snapshot, marked stale, while the district is down", async () => {
    const { clock, district, analytics, workspace } = await setup();
    await analytics();
    district.down = true;
    clock.advance(SNAPSHOT_TTL_MS * 3);
    expect(await analytics()).toMatchObject({ cached: true, stale: true, analytics: { http: { requests: 1001 } } });
    // With no snapshot for the window there is nothing to fall back on.
    const response = await call(adminDeps({ fetchDistrict: districts(district), now: clock.now }), "GET", `/api/workspaces/${workspace.id}/analytics?range=30d`);
    expect(response.status).toBe(502);
    await response.body?.cancel();
  });

  it("stores exactly the aggregates, keyed by workspace and window", async () => {
    const { analytics, workspace } = await setup();
    const { analytics: report } = await analytics();
    const row = await env.DB.prepare("SELECT time_range, aggregates_json, fetched_at FROM analytics_snapshots WHERE workspace_id = ?1")
      .bind(workspace.id).first<{ time_range: string; aggregates_json: string; fetched_at: string }>();
    expect(row).toMatchObject({ time_range: "24h", fetched_at: "2026-10-28T12:00:00.000Z" });
    expect(JSON.parse(row!.aggregates_json)).toEqual(report);
  });
});
