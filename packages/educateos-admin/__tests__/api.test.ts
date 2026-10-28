// The admin API against fake districts that verify every request with the ops protocol's verifier:
// enrollment, verification, the read proxies, and the audited commands.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AuditPage, EnrollmentResponse, WorkspaceDetail } from "../src/shared/api.ts";
import { adminDeps, call, DEVICES, districts, enrolled, FakeDistrict, manualClock, PEOPLE, uniqueOrigin, uniqueSlug } from "./support.ts";

function setup(scopes?: Parameters<typeof enrolled>[2]) {
  const clock = manualClock();
  const district = new FakeDistrict(uniqueOrigin(), clock.now);
  const deps = adminDeps({ fetchDistrict: districts(district), now: clock.now });
  return { clock, district, deps, enroll: () => enrolled(deps, district, scopes) };
}

async function auditFor(deps: ReturnType<typeof adminDeps>, workspaceId: string) {
  return (await (await call(deps, "GET", `/api/audit?workspace=${workspaceId}`)).json<AuditPage>()).entries;
}

describe("enrollment", () => {
  it("creates a pending workspace with a fresh key pair and tells the district's admin what to do", async () => {
    const { deps, enroll } = setup();
    const enrollment = await enroll();
    expect(enrollment.workspace).toMatchObject({ status: "pending", edition: "hosted", displayName: "Northfield" });
    expect(enrollment.registration).toMatchObject({
      adminOrigin: "https://admin.educateos.io",
      keyId: enrollment.workspace.key!.keyId,
      publicKey: enrollment.workspace.key!.publicKey,
      scopes: ["health", "analytics", "directory:read", "directory:write", "devices", "releases"],
    });
    expect(enrollment.instructions.join("\n")).toContain(`${enrollment.workspace.origin}/admin`);

    const detail = await (await call(deps, "GET", `/api/workspaces/${enrollment.workspace.id}`)).json<WorkspaceDetail>();
    expect(detail.key).toEqual(enrollment.workspace.key);
    const audit = await auditFor(deps, enrollment.workspace.id);
    expect(audit).toMatchObject([{ action: "workspace.enroll", target: enrollment.workspace.origin, result: "ok", operatorEmail: "ops@educateos.io" }]);
  });

  it("refuses an origin that isn't https://host, and a slug or origin already enrolled", async () => {
    const { deps, district, enroll } = setup();
    for (const origin of ["http://plain.example.org", "https://x.example.org/admin", "https://10.0.0.1", "https://localhost", "https://u:p@x.example.org"]) {
      const response = await call(deps, "POST", "/api/workspaces", { body: { slug: uniqueSlug(), displayName: "X", origin } });
      expect(response.status, origin).toBe(400);
      await response.body?.cancel();
    }
    const first = await enroll();
    const again = await call(deps, "POST", "/api/workspaces", { body: { slug: uniqueSlug(), displayName: "Again", origin: district.origin } });
    expect(again.status).toBe(409);
    const sameSlug = await call(deps, "POST", "/api/workspaces", { body: { slug: first.workspace.slug, displayName: "Again", origin: uniqueOrigin() } });
    expect(sameSlug.status).toBe(409);
    await again.body?.cancel();
    await sameSlug.body?.cancel();
  });

  it("verifies the connection with a signed health call, then lists the workspace as active", async () => {
    const { deps, enroll } = setup();
    const enrollment = await enroll();
    const verified = await call(deps, "POST", `/api/workspaces/${enrollment.workspace.id}/verify`);
    expect(verified.status).toBe(200);
    expect(await verified.json()).toMatchObject({ workspace: { status: "active" }, health: { status: "ok", releaseVersion: "r000042" } });
    const list = await (await call(deps, "GET", "/api/workspaces")).json<{ id: string; status: string }[]>();
    expect(list.find((w) => w.id === enrollment.workspace.id)?.status).toBe("active");
  });

  it("fails verification, and audits it, while the district hasn't registered the key", async () => {
    const { deps, district } = setup();
    const response = await call(deps, "POST", "/api/workspaces", { body: { slug: uniqueSlug(), displayName: "N", origin: district.origin } });
    const enrollment = await response.json<EnrollmentResponse>();
    const verified = await call(deps, "POST", `/api/workspaces/${enrollment.workspace.id}/verify`);
    expect(verified.status).toBe(502);
    expect(await verified.json()).toMatchObject({ code: "district-error", message: expect.stringContaining("did not accept this admin's key") });
    expect((await auditFor(deps, enrollment.workspace.id))[0]).toMatchObject({ action: "workspace.verify", result: "refused:401" });
  });

  it("refuses to follow a district that redirects (an ops path that isn't an Access bypass)", async () => {
    const { deps, district, enroll } = setup();
    const enrollment = await enroll();
    district.redirectTo = "https://team.cloudflareaccess.com/login";
    const response = await call(deps, "GET", `/api/workspaces/${enrollment.workspace.id}/health`);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ message: expect.stringContaining("Access bypass") });
  });
});

describe("read proxies", () => {
  it("passes health, releases, the directory and devices through from the district", async () => {
    const { deps, enroll } = setup();
    const { workspace } = await enroll();
    const get = async (path: string) => {
      const response = await call(deps, "GET", `/api/workspaces/${workspace.id}${path}`);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      return response.json<Record<string, unknown>>();
    };
    expect(await get("/health")).toMatchObject({ status: "ok" });
    expect(await get("/releases")).toMatchObject({ current: { version: "r000042" }, available: [{ version: "r000043" }] });
    expect(await get("/directory?role=staff")).toEqual({ entries: [PEOPLE[1]] });
    expect(await get("/directory?query=quill")).toEqual({ entries: [PEOPLE[0]] });
    expect(await get("/directory/prn_ada")).toMatchObject({ entry: PEOPLE[0], deviceCount: 1 });
    expect(await get(`/devices?principal=${PEOPLE[0]!.principal}`)).toEqual({ devices: DEVICES });
  });

  it("forwards only the query parameters the protocol knows, and refuses malformed ones", async () => {
    const { deps, enroll } = setup();
    const { workspace } = await enroll();
    const ok = await call(deps, "GET", `/api/workspaces/${workspace.id}/directory?role=student&debug=1`);
    expect(ok.status).toBe(200);
    await ok.body?.cancel();
    for (const path of ["/directory?role=superuser", "/devices?status=lost", "/analytics?range=1y", "/directory/not-a-principal"]) {
      const response = await call(deps, "GET", `/api/workspaces/${workspace.id}${path}`);
      expect(response.status, path).toBe(400);
      await response.body?.cancel();
    }
  });

  it("answers 404 for an unknown workspace or route", async () => {
    const { deps, enroll } = setup();
    const { workspace } = await enroll();
    for (const path of ["/api/workspaces/wks_nope", "/api/workspaces/wks_nope/health", `/api/workspaces/${workspace.id}/secrets`, "/api/nothing"]) {
      const response = await call(deps, "GET", path);
      expect(response.status, path).toBe(404);
      await response.body?.cancel();
    }
  });

  it("reports a scope the district didn't grant as a refusal", async () => {
    const { deps, enroll } = setup(["health", "analytics"]);
    const { workspace } = await enroll();
    const response = await call(deps, "GET", `/api/workspaces/${workspace.id}/directory`);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ message: expect.stringContaining("not granted") });
  });
});

describe("audited commands", () => {
  it("signs each command with the operator, and audits it here while the district audits it there", async () => {
    const { deps, district, enroll } = setup();
    const { workspace } = await enroll();
    const post = async (path: string, body: unknown) => {
      const response = await call(deps, "POST", `/api/workspaces/${workspace.id}${path}`, { body });
      expect(response.status, path).toBe(200);
      return response.json();
    };
    expect(await post("/directory/prn_ada/suspend", { reason: "left the district" })).toEqual({ applied: true, auditId: "aud_1" });
    await post("/directory/prn_ada/restore", {});
    await post("/directory/prn_bea/sign-out-everywhere", {});
    await post("/directory/prn_bea/roles", { grant: ["admin"], revoke: [] });
    await post("/directory/prn_ada/ai-access", { level: "none" });
    await post("/devices/dev_ada_phone/revoke", { reason: "lost" });
    expect(await post("/devices/revoke-below-version", { minimumVersion: "1.2.0", platform: "android" })).toEqual({ revoked: 1, auditId: "aud_7" });

    expect(district.audit.map((entry) => [entry.route, entry.operator])).toEqual([
      ["directory.action", "ops@educateos.io"],
      ["directory.action", "ops@educateos.io"],
      ["directory.action", "ops@educateos.io"],
      ["directory.action", "ops@educateos.io"],
      ["directory.action", "ops@educateos.io"],
      ["devices.revoke", "ops@educateos.io"],
      ["devices.revoke-below-version", "ops@educateos.io"],
    ]);
    expect(district.audit[3]).toMatchObject({ params: { principal: "prn_bea", action: "roles" }, body: { grant: ["admin"], revoke: [] } });

    const audit = await auditFor(deps, workspace.id);
    expect(audit.map((entry) => [entry.action, entry.target, entry.result])).toEqual([
      ["devices.revoke-below-version", "android<1.2.0", "ok:1"],
      ["devices.revoke", "dev_ada_phone", "ok"],
      ["directory.ai-access", "prn_ada", "ok"],
      ["directory.roles", "prn_bea", "ok"],
      ["directory.sign-out-everywhere", "prn_bea", "ok"],
      ["directory.restore", "prn_ada", "ok"],
      ["directory.suspend", "prn_ada", "ok"],
      ["workspace.enroll", workspace.origin, "ok"],
    ]);
    expect(audit.every((entry) => entry.operatorSub === "sub-ops")).toBe(true);
  });

  it("audits a command the district refuses, and one it never received", async () => {
    const { deps, district, enroll } = setup(["directory:read"]);
    const { workspace } = await enroll();
    const refused = await call(deps, "POST", `/api/workspaces/${workspace.id}/directory/prn_ada/suspend`, { body: {} });
    expect(refused.status).toBe(502);
    await refused.body?.cancel();
    district.down = true;
    const down = await call(deps, "POST", `/api/workspaces/${workspace.id}/devices/dev_ada_phone/revoke`, { body: {} });
    expect(down.status).toBe(502);
    await down.body?.cancel();
    const audit = await auditFor(deps, workspace.id);
    expect(audit.slice(0, 2).map((entry) => [entry.action, entry.result])).toEqual([
      ["devices.revoke", "refused:503"],
      ["directory.suspend", "refused:403"],
    ]);
    expect(district.audit).toEqual([]);
  });

  it("checks a command's body before anything is sent or audited", async () => {
    const { deps, district, enroll } = setup();
    const { workspace } = await enroll();
    const before = district.requests;
    for (const [path, body] of [
      ["/directory/prn_ada/roles", { grant: ["student"], revoke: [] }],
      ["/directory/prn_ada/ai-access", { level: "unlimited" }],
      ["/devices/revoke-below-version", { minimumVersion: "latest" }],
      ["/directory/prn_ada/delete", {}],
    ] as const) {
      const response = await call(deps, "POST", `/api/workspaces/${workspace.id}${path}`, { body });
      expect([400, 404], path).toContain(response.status);
      await response.body?.cancel();
    }
    expect(district.requests).toBe(before);
    expect((await auditFor(deps, workspace.id)).map((entry) => entry.action)).toEqual(["workspace.enroll"]);
  });

  it("removes a workspace: retired keys, no cached analytics, audit kept, no longer listed", async () => {
    const { deps, enroll } = setup();
    const { workspace } = await enroll();
    const analytics = await call(deps, "GET", `/api/workspaces/${workspace.id}/analytics?range=24h`);
    await analytics.body?.cancel();
    const removed = await call(deps, "POST", `/api/workspaces/${workspace.id}/remove`);
    expect(removed.status).toBe(200);
    await removed.body?.cancel();
    const gone = await call(deps, "GET", `/api/workspaces/${workspace.id}/health`);
    expect(gone.status).toBe(404);
    await gone.body?.cancel();
    const keys = await env.DB.prepare("SELECT retired_at FROM ops_keys WHERE workspace_id = ?1").bind(workspace.id).all<{ retired_at: string | null }>();
    expect(keys.results.every((row) => row.retired_at !== null)).toBe(true);
    const snapshots = await env.DB.prepare("SELECT COUNT(*) AS n FROM analytics_snapshots WHERE workspace_id = ?1").bind(workspace.id).first<{ n: number }>();
    expect(snapshots?.n).toBe(0);
    expect((await auditFor(deps, workspace.id)).map((entry) => entry.action)).toEqual(["workspace.remove", "workspace.enroll"]);
  });
});
