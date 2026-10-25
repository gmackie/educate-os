import { describe, expect, it } from "vitest";
import { PROBE_PREFIX, SandboxGuardError, verifyAccount } from "../scripts/verify-account-probes.ts";

const ACCOUNT = "acc-sandbox";
const TOKEN = "sandbox-token-value-never-reported";
const RUN = "0a1b2c3d";
const PROBE = `${PROBE_PREFIX}${RUN}`;

interface FakeOptions {
  accountName?: string;
  /** Paths (method + path prefix) that answer 403 with code 10000. */
  deny?: string[];
  r2Disabled?: boolean;
  /** Whether a failing D1 batch leaves earlier statements applied. */
  d1Atomic?: boolean;
  /** Resources whose DELETE fails. */
  undeletable?: string[];
}

const ok = (result: unknown, extra: Record<string, unknown> = {}) => Response.json({ success: true, errors: [], result, ...extra });
const fail = (status: number, code: number) => Response.json({ success: false, errors: [{ code, message: "quoted input" }], result: null }, { status });

/** An in-memory Cloudflare API: just the endpoints the harness calls, with a request log. */
function fakeCloudflare(options: FakeOptions = {}) {
  const requests: { method: string; path: string; bearer: string }[] = [];
  const live = new Set<string>();
  const tables = new Map<string, number>();
  let nextId = 1;
  const create = (kind: string, id: string) => {
    live.add(`${kind}:${id}`);
    return id;
  };
  const remove = (kind: string, id: string) => {
    if (options.undeletable?.includes(`${kind}:${id}`)) return fail(500, 10013);
    live.delete(`${kind}:${id}`);
    return ok(null);
  };

  const handler = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace("/client/v4", "");
    const bearer = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "";
    requests.push({ method, path, bearer });
    if (bearer !== TOKEN) return fail(401, 10001);
    if (options.deny?.some((d) => `${method} ${path}`.startsWith(d))) return fail(403, 10000);
    const json = init?.body && typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const a = `/accounts/${ACCOUNT}`;

    if (method === "GET" && path === a) return ok({ id: ACCOUNT, name: options.accountName ?? "EducateOS Sandbox" });
    if (path === "/user/tokens/verify") return fail(401, 1000);
    if (path === `${a}/tokens/verify`) return ok({ status: "active" });
    if (path === `${a}/subscriptions`) return ok([{ rate_plan: { id: "workers_paid" } }]);
    if (path === "/zones") return ok([{ id: "zone-1", name: "sandbox.example", status: "active" }]);
    if (path === "/zones/zone-1/dns_records") return ok([]);
    if (path === `${a}/workers/scripts` && method === "GET") return ok([]);
    if (path === `${a}/workers/domains` && method === "GET") return ok([]);
    if (path === `${a}/workers/domains` && method === "PUT") {
      return ok({ id: create("domain", "dom-1"), hostname: json["hostname"], service: json["service"], zone_id: json["zone_id"] });
    }
    if (path.startsWith(`${a}/workers/domains/`) && method === "DELETE") return remove("domain", path.split("/").pop()!);
    if (path === `${a}/storage/kv/namespaces` && method === "GET") return ok([], { result_info: { total_pages: 1 } });
    if (path === `${a}/storage/kv/namespaces` && method === "POST") return ok({ id: create("kv", `kv-${nextId++}`), title: json["title"] });
    if (path.startsWith(`${a}/storage/kv/namespaces/`) && method === "DELETE") return remove("kv", path.split("/").pop()!);
    if (path === `${a}/r2/buckets` && options.r2Disabled) return fail(403, 10042);
    if (path === `${a}/r2/buckets` && method === "GET") return ok({ buckets: [] });
    if (path === `${a}/r2/buckets` && method === "POST") return ok(create("r2", String(json["name"])));
    if (path.startsWith(`${a}/r2/buckets/`) && method === "DELETE") return remove("r2", decodeURIComponent(path.split("/").pop()!));
    if (path === `${a}/d1/database` && method === "GET") return ok([], { result_info: { total_pages: 1 } });
    if (path === `${a}/d1/database` && method === "POST") return ok({ uuid: create("d1", "db-1"), name: json["name"] });
    if (path.endsWith("/query")) {
      const sql = String(json["sql"]);
      const created = [...sql.matchAll(/CREATE TABLE (\w+)/g)].map((m) => m[1]!);
      if (sql.includes("probe_missing")) {
        if (!options.d1Atomic) for (const t of created) tables.set(t, 0);
        return fail(400, 7500);
      }
      if (sql.startsWith("SELECT count(*) AS n FROM sqlite_master")) {
        return ok([{ results: [{ n: tables.has(String((json["params"] as string[])[0])) ? 1 : 0 }] }]);
      }
      if (sql.startsWith("SELECT count(*) AS n FROM probe_ok")) return ok([{ results: [{ n: tables.get("probe_ok") ?? 0 }] }]);
      for (const t of created) tables.set(t, 1);
      return ok([{ results: [] }]);
    }
    if (path.startsWith(`${a}/d1/database/`) && method === "DELETE") return remove("d1", path.split("/").pop()!);
    if (path === `${a}/workers/scripts/${PROBE}` && method === "PUT") return ok(create("worker", PROBE));
    if (path === `${a}/workers/scripts/${PROBE}` && method === "DELETE") return remove("worker", PROBE);
    if (path === `${a}/workers/scripts/${PROBE}/secrets` && method === "PUT") return ok(null);
    if (path === `${a}/workers/scripts/${PROBE}/secrets`) return ok([{ name: "EDUCATEOS_PROBE_SECRET" }]);
    if (path === `${a}/workers/scripts/${PROBE}/versions`) return ok({ items: [{ id: "v1", metadata: { created_on: "2026-10-21T00:00:00Z" } }] });
    if (path === `${a}/workers/scripts/${PROBE}/versions/v1`) {
      return ok({ resources: { bindings: [{ type: "plain_text", name: "EDUCATEOS_PROBE_VAR", text: "educateos-probe-plain-text" }] } });
    }
    if (path === `${a}/access/organizations`) return ok({ auth_domain: "sandbox.cloudflareaccess.com" });
    if (path === `${a}/access/identity_providers`) return ok([{ id: "idp-1", name: "Test OIDC", type: "oidc" }]);
    if (path === `${a}/access/policies` && method === "GET") return ok([], { result_info: { total_pages: 1 } });
    if (path === `${a}/access/policies` && method === "POST") return ok({ id: create("access-policy", "pol-1"), name: json["name"], decision: "allow", include: [] });
    if (path.startsWith(`${a}/access/policies/`) && method === "DELETE") return remove("access-policy", path.split("/").pop()!);
    if (path === `${a}/access/apps` && method === "GET") return ok([], { result_info: { total_pages: 1 } });
    if (path === `${a}/access/apps` && method === "POST") return ok({ id: create("access-app", "app-1"), name: json["name"], domain: json["domain"], aud: "aud-1", policies: [{ id: "pol-1" }] });
    if (path.startsWith(`${a}/access/apps/`) && method === "DELETE") return remove("access-app", path.split("/").pop()!);
    if (path === `${a}/ai-gateway/gateways` && method === "GET") return ok([], { result_info: { total_pages: 1 } });
    if (path === `${a}/ai-gateway/gateways` && method === "POST") return ok({ id: create("ai-gateway", String(json["id"])) });
    if (path.startsWith(`${a}/ai-gateway/gateways/`) && method === "DELETE") return remove("ai-gateway", path.split("/").pop()!);
    return fail(404, 7003);
  };
  return { fetch: handler as typeof fetch, requests, live };
}

const run = (cf: ReturnType<typeof fakeCloudflare>, extra: { apply?: boolean; zone?: string; expectedAccountName?: string } = {}) =>
  verifyAccount({
    token: TOKEN,
    accountId: ACCOUNT,
    expectedAccountName: extra.expectedAccountName ?? "EducateOS Sandbox",
    apply: extra.apply ?? false,
    runId: RUN,
    fetch: cf.fetch,
    ...(extra.zone ? { zone: extra.zone } : {}),
    now: () => new Date("2026-10-21T00:00:00Z"),
  });

describe("verifyAccount", () => {
  it("stops after one read when the account is not the named sandbox", async () => {
    const cf = fakeCloudflare({ accountName: "Northfield Public Schools" });
    await expect(run(cf, { apply: true })).rejects.toBeInstanceOf(SandboxGuardError);
    expect(cf.requests).toHaveLength(1);
  });

  it("changes nothing in a dry run and lists the create/delete probes as planned", async () => {
    const cf = fakeCloudflare();
    const report = await run(cf, { zone: "sandbox.example" });
    expect(cf.requests.every((r) => r.method === "GET")).toBe(true);
    expect(report.mode).toBe("dry-run");
    expect(report.probes.filter((p) => p.kind === "create-delete").every((p) => p.result === "planned")).toBe(true);
    expect(report.probes.find((p) => p.id === "read.listSubscriptions")?.observation).toEqual({ ratePlanIds: ["workers_paid"] });
  });

  it("creates only prefixed resources and deletes every one of them", async () => {
    const cf = fakeCloudflare({ d1Atomic: true });
    const report = await run(cf, { apply: true, zone: "sandbox.example" });
    expect(cf.live.size).toBe(0);
    expect(report.leftovers).toEqual([]);
    const creates = cf.requests.filter((r) => r.method === "POST" || r.method === "PUT");
    expect(creates.length).toBeGreaterThan(0);
    expect(report.cleanup.map((c) => c.resource)).toEqual(expect.arrayContaining([`worker:${PROBE}`, `r2:${PROBE}`, `ai-gateway:${PROBE}`, `domain:${PROBE}.sandbox.example`]));
    expect(report.probes.find((p) => p.id === "write.d1Batch")?.observation).toMatchObject({ multiStatementWithParamsAccepted: true, atomic: true });
    expect(report.probes.find((p) => p.id === "write.workerVersions")?.observation).toMatchObject({ plainTextVarsExposed: true });
  });

  it("detects a D1 batch that is not atomic", async () => {
    const report = await run(fakeCloudflare({ d1Atomic: false }), { apply: true });
    expect(report.probes.find((p) => p.id === "write.d1Batch")?.observation).toMatchObject({ atomic: false, tablesLeftByFailingBatch: 1 });
  });

  it("records denied permissions and R2's not-enabled code, and still cleans up what it made", async () => {
    const cf = fakeCloudflare({ deny: [`POST /accounts/${ACCOUNT}/ai-gateway`, `GET /accounts/${ACCOUNT}/access/identity_providers`], r2Disabled: true });
    const report = await run(cf, { apply: true });
    expect(report.probes.find((p) => p.id === "write.aiGateway")).toMatchObject({ result: "denied", httpStatus: 403, cloudflareCodes: [10000] });
    expect(report.probes.find((p) => p.id === "read.listAccessIdentityProviders")?.result).toBe("denied");
    expect(report.probes.find((p) => p.id === "read.listR2Buckets")?.observation).toEqual({ r2NotEnabledCode: true });
    expect(cf.live.size).toBe(0);
  });

  it("reports resources it could not delete as leftovers", async () => {
    const cf = fakeCloudflare({ undeletable: ["kv:kv-1"] });
    const report = await run(cf, { apply: true });
    expect(report.leftovers).toEqual(["kv:kv-1"]);
    expect([...cf.live]).toEqual(["kv:kv-1"]);
  });

  it("observes the codes for an unusable credential without sending the real token", async () => {
    const cf = fakeCloudflare();
    const report = await run(cf);
    expect(report.probes.find((p) => p.id === "read.invalidCredentialCodes")).toMatchObject({
      httpStatus: 401,
      cloudflareCodes: [10001],
      observation: { installerTreatsAsCredentialFailure: true },
    });
  });

  it("never puts the token or Cloudflare's free-text messages in the report", async () => {
    const text = JSON.stringify(await run(fakeCloudflare({ r2Disabled: true }), { apply: true, zone: "sandbox.example" }));
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("quoted input");
  });
});
