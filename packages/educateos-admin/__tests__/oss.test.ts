// The OSS edition: the admin a district deploys into its own account manages only the origins its
// configuration lists, whatever the hosted edition's registry holds.
import { describe, expect, it } from "vitest";
import type { Me, Workspace } from "../src/shared/api.ts";
import { readConfig } from "../src/worker/config.ts";
import { adminDeps, call, districts, enrolled, FakeDistrict, manualClock, uniqueOrigin, uniqueSlug } from "./support.ts";

describe("the OSS edition", () => {
  it("enrolls a listed origin as a self-hosted workspace and refuses (and audits) any other", async () => {
    const clock = manualClock();
    const own = new FakeDistrict(uniqueOrigin(), clock.now);
    const deps = adminDeps({ edition: "oss", ossOrigins: `${own.origin}, https://other.example.org`, fetchDistrict: districts(own), now: clock.now });

    const me = await (await call(deps, "GET", "/api/me")).json<Me>();
    expect(me).toEqual({ operator: { email: "ops@educateos.io", role: "admin" }, edition: "oss", allowedOrigins: [own.origin, "https://other.example.org"] });

    const enrollment = await enrolled(deps, own);
    // Asked for hosted; the OSS admin's workspaces are self-hosted by definition.
    expect(enrollment.workspace.edition).toBe("oss");
    const health = await call(deps, "GET", `/api/workspaces/${enrollment.workspace.id}/health`);
    expect(health.status).toBe(200);
    await health.body?.cancel();

    const elsewhere = await call(deps, "POST", "/api/workspaces", { body: { slug: uniqueSlug(), displayName: "Elsewhere", origin: uniqueOrigin(), edition: "hosted" } });
    expect(elsewhere.status).toBe(403);
    expect(await elsewhere.json()).toMatchObject({ message: expect.stringContaining("OSS_WORKSPACE_ORIGINS") });
  });

  it("hides workspaces outside its origins, even ones already in its D1", async () => {
    const clock = manualClock();
    const district = new FakeDistrict(uniqueOrigin(), clock.now);
    // Enrolled by a hosted admin sharing the database...
    const hosted = adminDeps({ fetchDistrict: districts(district), now: clock.now });
    const { workspace } = await enrolled(hosted, district);
    // ...is invisible to an OSS admin that doesn't list its origin.
    const oss = adminDeps({ edition: "oss", ossOrigins: "https://only-this.example.org", fetchDistrict: districts(district), now: clock.now });
    const list = await (await call(oss, "GET", "/api/workspaces")).json<Workspace[]>();
    expect(list.map((w) => w.id)).not.toContain(workspace.id);
    for (const path of ["", "/health", "/directory"]) {
      const response = await call(oss, "GET", `/api/workspaces/${workspace.id}${path}`);
      expect(response.status, path).toBe(404);
      await response.body?.cancel();
    }
  });

  it("refuses a malformed configuration rather than guessing", () => {
    expect(() => readConfig({ EDITION: "enterprise" })).toThrow("EDITION");
    expect(() => readConfig({ EDITION: "oss", OSS_WORKSPACE_ORIGINS: "northfield.example.org" })).toThrow("OSS_WORKSPACE_ORIGINS");
    expect(readConfig({})).toEqual({ edition: "oss", allowedOrigins: new Set() });
    expect(readConfig({ EDITION: "hosted", OSS_WORKSPACE_ORIGINS: "ignored" })).toEqual({ edition: "hosted" });
  });

  it("answers 503, not 500, when misconfigured", async () => {
    const deps = adminDeps({ edition: "oss" });
    const response = await call({ ...deps, config: () => readConfig({ EDITION: "nope" }) }, "GET", "/api/me");
    expect(response.status).toBe(503);
    await response.body?.cancel();
  });
});
