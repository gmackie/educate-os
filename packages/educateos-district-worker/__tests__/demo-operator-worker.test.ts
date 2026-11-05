// The demo operator's seed routes (SCHO-326) in workerd: through the deployed Worker's fetch handler
// with no Access assertion at all (Access bypasses these paths), and against riverbend's own SQLite
// object, whose seed survives a restart and whose rerun adds nothing.
import { env, evictDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEMO_OPERATOR_TOKEN } from "./fixtures.ts";
import type { OperatorSeedResult, OperatorStatus } from "../src/demo-operator.ts";

type Target = { fetch(request: Request): Promise<Response> };

/** Calls an operator route on `target`, with `token` unless null, reading the whole body. */
async function call(target: Target, method: "GET" | "POST", path: string, token: string | null = DEMO_OPERATOR_TOKEN, body?: unknown): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await target.fetch(new Request(`https://riverbend.example/api/demo/operator/${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  return { status: response.status, body: await response.json() };
}

const worker: Target = { fetch: (request) => SELF.fetch(request) };
const riverbend = () => env.RIVERBEND.getByName("dst_riverbend");

describe("the demo operator routes through the Worker", () => {
  it("reach the district with no Access assertion, and answer only the token", async () => {
    expect((await call(worker, "GET", "status", null)).status).toBe(401);
    expect((await call(worker, "GET", "status", "wrong-token")).status).toBe(401);
    expect((await call(worker, "POST", "seed", `${DEMO_OPERATOR_TOKEN}x`, {})).status).toBe(401);
    // The test Worker's district is Northfield, which is not a standalone demo district: nothing to seed.
    const status = await call(worker, "GET", "status");
    expect(status).toMatchObject({ status: 404, body: { code: "not-found" } });
    expect((await call(worker, "POST", "seed", DEMO_OPERATOR_TOKEN, { dryRun: true })).status).toBe(404);
    // The token opens nothing else: the showcase still needs an Access sign-in.
    const showcase = await SELF.fetch("https://riverbend.example/api/demo/showcase", { headers: { authorization: `Bearer ${DEMO_OPERATOR_TOKEN}` } });
    expect(showcase.status).toBe(401);
    await showcase.arrayBuffer();
  });

  it("are 404 on a demo district without a DEMO_OPERATOR_TOKEN", async () => {
    const off = env.RIVERBEND_WITHOUT_TOKEN.getByName("dst_riverbend");
    expect((await call(off, "GET", "status")).status).toBe(404);
    expect((await call(off, "POST", "seed", DEMO_OPERATOR_TOKEN, {})).status).toBe(404);
  });
});

describe("the demo operator seeding riverbend's own object", () => {
  it("seeds the fixture roster and the starter pack, keeps them across a restart, and a rerun adds nothing", async () => {
    const seeded = await call(riverbend(), "POST", "seed", DEMO_OPERATOR_TOKEN, {});
    expect(seeded.status, JSON.stringify(seeded.body)).toBe(200);
    const result: OperatorSeedResult = seeded.body;
    expect(result).toMatchObject({ districtId: "dst_riverbend", slug: "riverbend", adminPrincipalId: "prn_rb-district-admin", problems: [] });
    expect(result.before).toMatchObject({ health: { directory: { offerings: 0, staff: 1 } }, packs: [] });

    await evictDurableObject(riverbend());
    const status: OperatorStatus = (await call(riverbend(), "GET", "status")).body;
    expect(status.problems).toStrictEqual([]);
    expect(status.export).toMatchObject({ health: { directory: { offerings: 4 } }, packs: [{ listingId: "middle-school-starter-pack", version: "1.0.0" }] });

    const again: OperatorSeedResult = (await call(riverbend(), "POST", "seed", DEMO_OPERATOR_TOKEN, {})).body;
    expect(again.problems).toStrictEqual([]);
    expect(again.log.join("\n")).toMatch(/middle-school-starter-pack 1\.0\.0 is already installed/);
    expect(again.before).toStrictEqual({ ...status.export, exportedAt: again.before.exportedAt });
  }, 120_000);
});
