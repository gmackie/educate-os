// Directory and device data pass through: the admin shows the operator what the district returns
// and writes none of it to D1. Every table is searched for the fake district's people afterwards.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { adminDeps, call, DEVICES, districts, enrolled, FakeDistrict, manualClock, PEOPLE, uniqueOrigin } from "./support.ts";

/** Every value in every table of the admin's D1, as text. */
async function everythingStored(): Promise<string> {
  const { results: tables } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
  ).all<{ name: string }>();
  const dumps = await Promise.all(tables.map(async ({ name }) => JSON.stringify((await env.DB.prepare(`SELECT * FROM "${name}"`).all()).results)));
  return dumps.join("\n");
}

describe("pass-through without persistence", () => {
  it("returns directory and device data and stores none of it", async () => {
    const clock = manualClock();
    const district = new FakeDistrict(uniqueOrigin(), clock.now);
    const deps = adminDeps({ fetchDistrict: districts(district), now: clock.now });
    const { workspace } = await enrolled(deps, district);

    for (const path of ["/directory", "/directory?query=ada", "/directory/prn_ada", "/directory/prn_bea", "/devices", "/health", "/analytics?range=7d"]) {
      const response = await call(deps, "GET", `/api/workspaces/${workspace.id}${path}`);
      expect(response.status, path).toBe(200);
      await response.text();
    }
    for (const [path, body] of [["/directory/prn_ada/suspend", { reason: "Ada Quillfeather asked" }], ["/devices/dev_ada_phone/revoke", {}]] as const) {
      const response = await call(deps, "POST", `/api/workspaces/${workspace.id}${path}`, { body });
      expect(response.status, path).toBe(200);
      await response.text();
    }

    const stored = await everythingStored();
    expect(stored).toContain(workspace.id);
    const personal = [
      ...PEOPLE.flatMap((p) => [p.displayName, p.email!, ...p.schools]),
      ...DEVICES.flatMap((d) => [d.ownerName, d.label, d.model!]),
      "Quillfeather",
      "Ada Quillfeather asked",
    ];
    for (const value of personal) expect(stored, value).not.toContain(value);
  });

  it("has no table for directory or device data", async () => {
    const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
    const names = results.map((row) => row.name).filter((name) => !name.startsWith("_cf_") && !name.startsWith("sqlite_") && name !== "d1_migrations");
    expect(names.toSorted()).toEqual(["analytics_snapshots", "audit_log", "operators", "ops_keys", "workspaces"]);
  });
});
