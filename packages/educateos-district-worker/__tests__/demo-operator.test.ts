// The demo operator's seed routes (SCHO-326) over standalone demo districts as their DISTRICT_CONFIG
// seeds them: in-memory stores here (the Worker and its SQLite object are in
// demo-operator-worker.test.ts). Only a bearer token opens them, they act as the district's own
// administrator, and they seed exactly what scripts/demo/seed-district.ts does: additive only, and a
// rerun adds nothing.
import { describe, expect, it } from "vitest";
import { DistrictDirectorySnapshot } from "@educateos/contracts";
import { createDistrictApp, inMemoryDistrictStores, type DistrictApp } from "@educateos/district-app";
import { DEMO_DISTRICTS, NORTHFIELD } from "@educateos/fixtures";
import { AUTOMATION, DEMO_STARTER_PACK, listingOf } from "@educateos/harness/demo-district";
import { demoDistrictConfig } from "../scripts/demo-district-config.ts";
import { readDistrictWorkerConfig } from "../src/config.ts";
import { readMarketplaceTrust } from "../src/district.ts";
import {
  demoOperatorEnabled,
  FAILURE_WINDOW_MS,
  MAX_FAILURES,
  operatorAdministrator,
  startDemoOperator,
  tokenMatches,
  type DemoOperator,
  type DemoOperatorEvent,
  type OperatorSeedResult,
} from "../src/demo-operator.ts";
import { DEMO_MARKETPLACE_TRUST } from "../../../scripts/production/demo-districts.ts";

const TOKEN = "op_0123456789abcdef0123456789abcdef0123456789";
const ADMIN_SUBJECT = "00000000-0000-4000-8000-000000000001";
const AUTOMATION_SUBJECT = "adfd94dd-86a7-5838-b9a7-d1eb94227303";
const demo = (slug: string) => DEMO_DISTRICTS.find((d) => d.slug === slug)!;

/** A standalone demo district as its DISTRICT_CONFIG seeds it, with the operator routes on. */
async function boot(slug: string, options: { now?: () => number; directory?: DistrictDirectorySnapshot } = {}) {
  const config = readDistrictWorkerConfig(JSON.stringify(demoDistrictConfig(demo(slug), { adminSubject: ADMIN_SUBJECT })));
  const app = await createDistrictApp({
    stores: inMemoryDistrictStores(options.directory ?? config.directory),
    verifyRequest: async () => undefined,
    ...(config.authority === undefined ? {} : { authority: config.authority }),
    importFetch: async () => new Response("not found", { status: 404 }),
    marketplaceTrust: readMarketplaceTrust(DEMO_MARKETPLACE_TRUST)!,
  });
  const events: DemoOperatorEvent[] = [];
  const operator = startDemoOperator({ app, token: TOKEN, onEvent: (e) => void events.push(e), ...(options.now === undefined ? {} : { now: options.now }) });
  return { app, operator, events, admin: config.directory.principals[0]!, adminId: config.directory.principals[0]!.id };
}

/** Calls an operator route, reading the whole body. */
async function call(operator: DemoOperator, method: "GET" | "POST", path: string, options: { token?: string | null; body?: unknown } = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const headers: Record<string, string> = {};
  const token = options.token === undefined ? TOKEN : options.token;
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await operator.serve(new Request(`https://demo.example/api/demo/operator/${path}`, { method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) }));
  return { status: response.status, body: await response.json(), headers: response.headers };
}

const seed = (operator: DemoOperator, body: unknown = {}) => call(operator, "POST", "seed", { body }).then((r) => {
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as OperatorSeedResult;
});

/** The directory's record counts. */
const counts = async (app: DistrictApp) => {
  const { snapshot } = await app.stores.directory.load();
  return Object.fromEntries((["schools", "terms", "courses", "offerings", "principals", "enrollments", "roleAssignments"] as const).map((k) => [k, snapshot[k].length]));
};

describe("the operator gate", () => {
  it("is on only with a demo configuration, the deployment's DEMO_SHOWCASE and a token of 32 characters or more", () => {
    expect(demoOperatorEnabled({ showcase: "northfield" }, "northfield", TOKEN)).toBe(true);
    expect(demoOperatorEnabled(undefined, "northfield", TOKEN)).toBe(false);
    expect(demoOperatorEnabled({ showcase: "northfield" }, undefined, TOKEN)).toBe(false);
    expect(demoOperatorEnabled({ showcase: "northfield" }, "", TOKEN)).toBe(false);
    expect(demoOperatorEnabled({ showcase: "northfield" }, "riverbend", TOKEN)).toBe(false);
    expect(demoOperatorEnabled({ showcase: "northfield" }, "northfield", undefined)).toBe(false);
    expect(demoOperatorEnabled({ showcase: "northfield" }, "northfield", "")).toBe(false);
    expect(demoOperatorEnabled({ showcase: "northfield" }, "northfield", "x".repeat(31))).toBe(false);
    expect(demoOperatorEnabled({ showcase: "northfield" }, "northfield", "x".repeat(32))).toBe(true);
    expect(demoOperatorEnabled({ showcase: "northfield" }, "northfield", ` ${"x".repeat(31)}\n`)).toBe(false);
  });

  it("compares tokens whole", async () => {
    expect(await tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(await tokenMatches(TOKEN.slice(0, -1), TOKEN)).toBe(false);
    expect(await tokenMatches(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(await tokenMatches("", TOKEN)).toBe(false);
  });
});

describe("the administrator the operator acts as", () => {
  const d = NORTHFIELD.district.id;
  const grant = (principalId: string, extra: object = {}) => ({ principalId, role: "district-admin", scope: { level: "district", districtId: d }, source: "local-grant", ...extra });
  const staff = (id: string, status = "active") => ({ id, districtId: d, kind: "staff", status, displayName: id, externalIdentities: [{ districtId: d, issuer: NORTHFIELD.district.trustedIssuers[0]!, subject: id }] });
  const snapshot = (principals: object[], roleAssignments: object[]) => DistrictDirectorySnapshot.parse({
    district: NORTHFIELD.district, schools: [], terms: [], courses: [], offerings: [], enrollments: [], principals, roleAssignments,
  });
  const at = new Date("2026-11-05T12:00:00Z");

  it("is the earliest district-admin grant at district scope, in force, of active staff", () => {
    expect(operatorAdministrator(snapshot([staff("prn_a"), staff("prn_b")], [grant("prn_b"), grant("prn_a")]), at)).toBe("prn_b");
    expect(operatorAdministrator(snapshot([staff("prn_a", "inactive"), staff("prn_b")], [grant("prn_a"), grant("prn_b")]), at)).toBe("prn_b");
    expect(operatorAdministrator(snapshot([staff("prn_a"), staff("prn_b")], [grant("prn_a", { validUntil: "2026-01-01T00:00:00Z" }), grant("prn_b")]), at)).toBe("prn_b");
    expect(operatorAdministrator(snapshot([staff("prn_a")], []), at)).toBeUndefined();
  });
});

describe("the operator routes' authentication", () => {
  it("answers 401 with no detail to a missing or wrong token, and logs no token", async () => {
    // A clock a window ahead on every reading, so the failures never add up to closing the routes.
    let clock = 0;
    const { operator, events } = await boot("riverbend", { now: () => (clock += FAILURE_WINDOW_MS) });
    for (const token of [null, "", "wrong", TOKEN.slice(0, -1), `${TOKEN}0`]) {
      for (const [method, path] of [["GET", "status"], ["POST", "seed"]] as const) {
        const answer = await call(operator, method, path, { token, ...(method === "POST" ? { body: {} } : {}) });
        expect(answer.status, `${String(token)} ${path}`).toBe(401);
        expect(answer.body).toStrictEqual({ code: "unauthenticated", message: "Unauthorized." });
        expect(answer.headers.get("www-authenticate")).toBe("Bearer");
      }
    }
    expect(events.every((e) => e.event === "demo.operator.refused" && e.reason === "unauthenticated")).toBe(true);
    expect(JSON.stringify(events)).not.toContain(TOKEN.slice(3, 20));
    // A raw token without the Bearer scheme is no better.
    const raw = await operator.serve(new Request("https://demo.example/api/demo/operator/status", { headers: { authorization: TOKEN } }));
    expect(raw.status).toBe(401);
    await raw.arrayBuffer();
  });

  it("ignores the whitespace a secret was piped in with", async () => {
    const { app } = await boot("riverbend");
    const operator = startDemoOperator({ app, token: `${TOKEN}\n` });
    expect((await call(operator, "GET", "status")).status).toBe(200);
  });

  it("closes to everyone, the right token too, after too many failures in a window", async () => {
    let clock = 1_000_000;
    const { operator } = await boot("riverbend", { now: () => clock });
    for (let i = 0; i < MAX_FAILURES; i++) expect((await call(operator, "GET", "status", { token: "wrong" })).status).toBe(401);
    expect((await call(operator, "GET", "status")).status).toBe(429);
    clock += FAILURE_WINDOW_MS;
    expect((await call(operator, "GET", "status")).status).toBe(200);
  });

  it("answers 404 to any other route, 400 to a POST that is not JSON or has unknown fields", async () => {
    const { operator } = await boot("riverbend");
    expect((await call(operator, "GET", "seed")).status).toBe(404);
    expect((await call(operator, "POST", "status", { body: {} })).status).toBe(404);
    const form = await operator.serve(new Request("https://demo.example/api/demo/operator/seed", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "text/plain" }, body: "{}" }));
    expect(form.status).toBe(400);
    await form.arrayBuffer();
    expect((await call(operator, "POST", "seed", { body: { dryRun: true, extra: 1 } })).status).toBe(400);
    expect((await call(operator, "POST", "seed", { body: { admitSubject: "not-a-uuid" } })).status).toBe(400);
  });

  it("has nothing to seed in a district that is not a standalone demo district", async () => {
    const app = await createDistrictApp({ stores: inMemoryDistrictStores(NORTHFIELD), verifyRequest: async () => undefined, importFetch: async () => new Response(null, { status: 404 }) });
    const operator = startDemoOperator({ app, token: TOKEN });
    expect((await call(operator, "GET", "status")).status).toBe(404);
    expect((await call(operator, "POST", "seed", { body: {} })).status).toBe(404);
  });
});

describe("seeding a roster demo district", () => {
  it("dry-runs without writing, then imports the fixture roster and the starter pack as the seeded administrator, and a rerun adds nothing", async () => {
    const { app, operator, admin, adminId, events } = await boot("riverbend");
    const fixture = demo("riverbend").directory;
    const empty = await counts(app);

    const dry = await seed(operator, { dryRun: true });
    expect(dry).toMatchObject({ districtId: "dst_riverbend", slug: "riverbend", dryRun: true, adminPrincipalId: adminId, problems: [] });
    expect(dry.log.join("\n")).toMatch(/would install middle-school-starter-pack 1\.0\.0/);
    expect(await counts(app)).toStrictEqual(empty);

    const run = await seed(operator);
    expect(run.problems).toStrictEqual([]);
    // The "before" export is the district as it was: the seeded administrator alone, no pack.
    expect(run.before).toMatchObject({ health: { districtId: "dst_riverbend", directory: { schools: 0, offerings: 0, staff: 1 } }, packs: [] });
    const after = await app.stores.directory.load();
    expect(after.snapshot.offerings).toHaveLength(fixture.offerings.length);
    expect(after.snapshot.principals.find((p) => p.id === adminId)).toStrictEqual(admin);
    expect(after.snapshot.roleAssignments.filter((r) => r.role === "district-admin").map((r) => r.principalId)).toStrictEqual([adminId]);
    const packs = await app.stores.marketplacePacks.list();
    expect(packs.map((p) => p.listing.listingId)).toStrictEqual([listingOf(DEMO_STARTER_PACK).listingId]);

    const status = await call(operator, "GET", "status");
    expect(status.body).toMatchObject({ slug: "riverbend", adminPrincipalId: adminId, problems: [] });

    const seeded = await counts(app);
    const again = await seed(operator);
    expect(again.problems).toStrictEqual([]);
    expect(again.log.join("\n")).toMatch(/already installed/);
    expect(await counts(app)).toStrictEqual(seeded);
    expect(events.filter((e) => e.event === "demo.operator.seeded").map((e) => e.principalId)).toStrictEqual([adminId, adminId, adminId]);
  }, 60_000);

  it("admits the automation person as a district administrator, and refuses a later run that would drop them, writing nothing", async () => {
    const { app, operator, adminId } = await boot("lakeshore");
    const run = await seed(operator, { admitSubject: AUTOMATION_SUBJECT });
    expect(run.problems).toStrictEqual([]);
    const { snapshot } = await app.stores.directory.load();
    const automation = snapshot.principals.find((p) => p.displayName === AUTOMATION.displayName)!;
    expect(automation.externalIdentities.map((i) => i.subject)).toStrictEqual([AUTOMATION_SUBJECT]);
    expect(snapshot.roleAssignments.filter((r) => r.role === "district-admin" && r.scope.level === "district").map((r) => r.principalId)).toStrictEqual([adminId, automation.id]);
    // Still the seeded administrator who acts, the earliest grant.
    expect((await seed(operator, { admitSubject: AUTOMATION_SUBJECT })).adminPrincipalId).toBe(adminId);

    const before = await counts(app);
    const dropping = await seed(operator);
    expect(dropping.problems.join("\n")).toMatch(/^roster: it would deactivate 1 principals$/m);
    expect(await counts(app)).toStrictEqual(before);
  }, 60_000);
});

describe("seeding the local-authority demo district", () => {
  it("builds prairie's classes through the authoring routes, admits the automation, and a rerun makes nothing", async () => {
    const { app, operator } = await boot("prairie");
    const fixture = demo("prairie").directory;
    const run = await seed(operator, { admitSubject: AUTOMATION_SUBJECT });
    expect(run.problems).toStrictEqual([]);
    expect(run.log.join("\n")).toMatch(/made: 2 schools, 1 terms, 4 courses, 4 offerings, 7 principals, 1 district admins, 12 enrollments/);
    const { snapshot } = await app.stores.directory.load();
    expect(snapshot.offerings).toHaveLength(fixture.offerings.length);
    expect(snapshot.principals.find((p) => p.displayName === AUTOMATION.displayName)?.externalIdentities[0]?.subject).toBe(AUTOMATION_SUBJECT);

    const seeded = await counts(app);
    const again = await seed(operator, { admitSubject: AUTOMATION_SUBJECT });
    expect(again.problems).toStrictEqual([]);
    expect(again.log.join("\n")).toMatch(/made: nothing new/);
    expect(await counts(app)).toStrictEqual(seeded);
  }, 60_000);
});
