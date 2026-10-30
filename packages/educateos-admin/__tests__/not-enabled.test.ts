// A workspace whose district doesn't serve /api/ops yet (SCHO-263): every way such a district can
// answer is reported as `ops-not-enabled` (424), which the SPA shows as a notice, while a district
// that does serve the API still gets its refusals and not-founds reported as they are. And the
// health check, which ForgeGraph probes, answers only once D1 does.
import { describe, expect, it } from "vitest";
import type { AuditPage, EnrollmentResponse } from "../src/shared/api.ts";
import { AdminStore } from "../src/worker/store.ts";
import { adminDeps, call, districts, enrolled, FakeDistrict, manualClock, uniqueOrigin, uniqueSlug } from "./support.ts";

/** Ways a district without the ops API answers, as its Worker or Access in front of it would. */
const WITHOUT_OPS: [string, () => Response][] = [
  ["the district Worker's own 404", () => Response.json({ code: "not-found", message: "No such route." }, { status: 404 })],
  ["an HTML 404", () => new Response("<h1>Not found</h1>", { status: 404, headers: { "content-type": "text/html" } })],
  ["Access's sign-in redirect", () => new Response(null, { status: 302, headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" } })],
  ["Access's 403 page", () => new Response("<html>Forbidden</html>", { status: 403, headers: { "content-type": "text/html" } })],
  ["a bare 401", () => new Response("Unauthorized", { status: 401 })],
];

async function workspaceAt(answer: () => Response) {
  const clock = manualClock();
  const origin = uniqueOrigin();
  const deps = adminDeps({ now: clock.now, fetchDistrict: async () => answer() });
  const response = await call(deps, "POST", "/api/workspaces", { body: { slug: uniqueSlug(), displayName: "Riverbend", origin } });
  const enrollment = await response.json<EnrollmentResponse>();
  return { deps, id: enrollment.workspace.id };
}

describe("a district without the ops API", () => {
  for (const [what, answer] of WITHOUT_OPS) {
    it(`reports ${what} as operations not enabled, on every read`, async () => {
      const { deps, id } = await workspaceAt(answer);
      for (const path of ["/health", "/analytics?range=24h", "/releases", "/directory", "/devices"]) {
        const response = await call(deps, "GET", `/api/workspaces/${id}${path}`);
        expect(response.status, path).toBe(424);
        expect(await response.json(), path).toEqual({ code: "ops-not-enabled", message: expect.stringContaining("Operations not enabled for this workspace") });
      }
    });
  }

  it("says so when verifying, and audits a command as not enabled", async () => {
    const { deps, id } = await workspaceAt(WITHOUT_OPS[0]![1]);
    const verify = await call(deps, "POST", `/api/workspaces/${id}/verify`);
    expect(verify.status).toBe(424);
    await verify.body?.cancel();
    const revoke = await call(deps, "POST", `/api/workspaces/${id}/devices/revoke-below-version`, { body: { minimumVersion: "1.2.0" } });
    expect(revoke.status).toBe(424);
    await revoke.body?.cancel();
    const audit = (await (await call(deps, "GET", `/api/audit?workspace=${id}`)).json<AuditPage>()).entries;
    expect(audit.map((entry) => [entry.action, entry.result])).toEqual(expect.arrayContaining([
      ["workspace.verify", "ops-not-enabled"],
      ["devices.revoke-below-version", "ops-not-enabled"],
    ]));
  });

  it("still reports a person the district doesn't have as not found, and a key it refuses as a refusal", async () => {
    const clock = manualClock();
    const district = new FakeDistrict(uniqueOrigin(), clock.now);
    const deps = adminDeps({ fetchDistrict: districts(district), now: clock.now });
    const { workspace } = await enrolled(deps, district);
    const missing = await call(deps, "GET", `/api/workspaces/${workspace.id}/directory/prn_nobody`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "not-found" });
    district.keys.clear();
    const refused = await call(deps, "GET", `/api/workspaces/${workspace.id}/health`);
    expect(refused.status).toBe(502);
    expect(await refused.json()).toMatchObject({ code: "district-error", message: expect.stringContaining("did not accept this admin's key") });
  });

  it("reads at most a few kilobytes of a district's error body", async () => {
    let pulled = 0;
    const { deps, id } = await workspaceAt(() => new Response(new ReadableStream({
      pull(controller) {
        pulled += 1024;
        controller.enqueue(new Uint8Array(1024).fill(32));
        if (pulled > 1024 * 1024) controller.close();
      },
    }), { status: 404 }));
    const response = await call(deps, "GET", `/api/workspaces/${id}/health`);
    expect(response.status).toBe(424);
    await response.body?.cancel();
    expect(pulled).toBeLessThan(64 * 1024);
  });
});

describe("/healthz", () => {
  it("answers 503 while D1 doesn't", async () => {
    const broken = { prepare: () => { throw new Error("D1 is down"); } } as unknown as D1Database;
    const response = await call(adminDeps({ store: new AdminStore(broken) }), "GET", "/healthz", { token: null });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unavailable", edition: "hosted" });
  });

  it("answers ok without sign-in once D1 does", async () => {
    const response = await call(adminDeps({ commit: "f".repeat(40) }), "GET", "/healthz", { token: null });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", edition: "hosted", commit: "f".repeat(40) });
  });
});
