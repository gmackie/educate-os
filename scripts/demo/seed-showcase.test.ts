import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BANDS,
  accessSubject,
  districtOrigin,
  runShowcase,
  showcaseClient,
  verifyShowcase,
  type Band,
  type ShowcaseStatus,
} from "./seed-showcase.ts";

const ORIGIN = "https://northfield.educateos.io";

function status(overrides: Partial<{ present: boolean; assignments: number; students: number }> = {}): ShowcaseStatus {
  const bands = Object.fromEntries(BANDS.map((band) => [band, {
    offerings: [{ offeringId: `off_${band}`, title: `${band} class`, present: true, assignments: 3, students: 3, ...overrides }],
    assignments: overrides.assignments ?? 3,
  }])) as ShowcaseStatus["bands"];
  return { showcase: "northfield", districtId: "dst_gmacko-coop", bands, personas: { present: 30, linked: 0 } };
}

/** A recorded district: answers each route from `routes`, and records what was asked. */
function fakeDistrict(routes: Record<string, (body: unknown) => unknown>) {
  const calls: { method: string; path: string; body: unknown; headers: Headers; redirect: string | undefined }[] = [];
  const fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const body = init.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ method: init.method ?? "GET", path: url.pathname, body, headers: new Headers(init.headers), redirect: init.redirect });
    const route = routes[`${init.method ?? "GET"} ${url.pathname}`];
    if (route === undefined) return Response.json({ code: "not-found", message: "No such route." }, { status: 404 });
    return Response.json(route(body));
  };
  return { fetch, calls };
}

test("only the demo districts' hosts are accepted, unless forced", () => {
  assert.equal(districtOrigin("https://northfield.educateos.io/api/x"), ORIGIN);
  assert.equal(districtOrigin("https://harbor.educateos.io"), "https://harbor.educateos.io");
  assert.equal(districtOrigin("https://district.schoolos.gmac.io"), "https://district.schoolos.gmac.io");
  assert.throws(() => districtOrigin("https://learn.springfield.k12.example"), /not a demo district/);
  assert.throws(() => districtOrigin("https://educateos.io"), /not a demo district/);
  assert.throws(() => districtOrigin("http://northfield.educateos.io"), /not https/);
  assert.equal(districtOrigin("http://localhost:8787", true), "http://localhost:8787");
});

test("every request carries the Access cookie, says it is JSON, and never follows a redirect", async () => {
  const district = fakeDistrict({ "POST /api/demo/showcase/seed": () => ({ dryRun: true, directory: {}, bands: [] }) });
  await showcaseClient(ORIGIN, "cookie-value", district.fetch).seed({ dryRun: true });
  const [call] = district.calls;
  assert.equal(call!.headers.get("cookie"), "CF_Authorization=cookie-value");
  assert.equal(call!.headers.get("content-type"), "application/json");
  assert.equal(call!.redirect, "manual");
  assert.deepEqual(call!.body, { dryRun: true });
});

const redirecting = async () => new Response(null, { status: 302, headers: { location: "https://gmacko.cloudflareaccess.com/login" } });
const refusing = async () => Response.json({ code: "forbidden", message: "Only a district administrator can manage the showcase." }, { status: 403 });
const off = async () => Response.json({ code: "not-found", message: "This district has no showcase." }, { status: 404 });

test("an Access redirect and a district refusal are errors that say which", async () => {
  await assert.rejects(showcaseClient(ORIGIN, "stale", redirecting).status(), /Access did not accept the cookie/);
  await assert.rejects(showcaseClient(ORIGIN, "c", refusing).status(), /403 forbidden: Only a district administrator/);
  await assert.rejects(showcaseClient(ORIGIN, "c", off).exportDistrict(), /no showcase/);
});

test("a presenter's subject is read from Access's identity endpoint with their own cookie", async () => {
  const fetch = async (input: string, init: RequestInit) => {
    assert.equal(input, `${ORIGIN}/cdn-cgi/access/get-identity`);
    assert.equal(new Headers(init.headers).get("cookie"), "CF_Authorization=student-cookie");
    return Response.json({ user_uuid: "33333333-3333-4333-8333-333333333333", email: "student@agents.gmac.io" });
  };
  assert.deepEqual(await accessSubject(ORIGIN, "student-cookie", fetch), { subject: "33333333-3333-4333-8333-333333333333", email: "student@agents.gmac.io" });
  await assert.rejects(accessSubject(ORIGIN, "x", async () => Response.json({}, { status: 403 })), /did not say who/);
});

test("verification names every class that is missing, unlisted, empty or unpopulated", () => {
  const listed = BANDS.map((band) => `off_${band}`);
  assert.deepEqual(verifyShowcase(status(), listed), []);
  assert.match(verifyShowcase(status({ present: false }), listed)[0]!, /K-2 K-2 class \(off_K-2\) is not in the directory/);
  assert.match(verifyShowcase(status(), listed.slice(1))[0]!, /not in the admin console's offerings/);
  assert.equal(verifyShowcase(status({ assignments: 0 }), listed).filter((p) => p.includes("no activities")).length, 4);
  assert.equal(verifyShowcase(status({ students: 1 }), listed, ["9-12"]).length, 1);
});

test("a run saves the export first, seeds band by band, and verifies", async () => {
  const seeded: Band[][] = [];
  const district = fakeDistrict({
    "GET /api/demo/showcase/export": () => ({ format: "educateos.showcase-export/v1", directory: { district: { id: "dst_gmacko-coop" } } }),
    "POST /api/demo/showcase/seed": (body) => {
      const { dryRun, bands } = body as { dryRun?: boolean; bands: Band[] };
      if (!dryRun) seeded.push(bands);
      return { dryRun: dryRun === true, directory: { offerings: dryRun ? 13 : 0 }, bands, guardiansConfirmed: 0, showcase: { created: 1, skipped: [], bands: Object.fromEntries(BANDS.map((b) => [b, { activities: 1 }])) } };
    },
    "GET /api/demo/showcase": () => status(),
    "GET /api/admin/offerings": () => BANDS.map((band) => ({ offering: { id: `off_${band}` } })),
  });
  const written: [string, string][] = [];
  const lines: string[] = [];
  const problems = await runShowcase({
    client: showcaseClient(ORIGIN, "c", district.fetch),
    out: "before.json",
    dryRun: false,
    bands: BANDS,
    write: async (path, text) => {
      written.push([path, text]);
    },
    log: (line) => lines.push(line),
  });
  assert.deepEqual(problems, []);
  assert.equal(written[0]![0], "before.json");
  assert.equal(JSON.parse(written[0]![1]).format, "educateos.showcase-export/v1");
  assert.deepEqual(district.calls.map((c) => `${c.method} ${c.path}`).slice(0, 2), ["GET /api/demo/showcase/export", "POST /api/demo/showcase/seed"]);
  assert.deepEqual(seeded, BANDS.map((band) => [band]));
  assert.ok(lines.some((line) => line.includes("would gain: 13 offerings")));
});

test("a dry run exports and plans, and seeds nothing", async () => {
  const district = fakeDistrict({
    "GET /api/demo/showcase/export": () => ({}),
    "POST /api/demo/showcase/seed": (body) => {
      assert.equal((body as { dryRun?: boolean }).dryRun, true);
      return { dryRun: true, directory: { offerings: 13 }, bands: BANDS };
    },
  });
  const problems = await runShowcase({ client: showcaseClient(ORIGIN, "c", district.fetch), out: "x.json", dryRun: true, bands: BANDS, write: async () => {}, log: () => {} });
  assert.deepEqual(problems, []);
  assert.deepEqual(district.calls.map((c) => `${c.method} ${c.path}`), ["GET /api/demo/showcase/export", "POST /api/demo/showcase/seed"]);
});

test("a failed export stops the run before anything is seeded", async () => {
  const district = fakeDistrict({ "POST /api/demo/showcase/seed": () => assert.fail("seeded without an export") });
  await assert.rejects(runShowcase({ client: showcaseClient(ORIGIN, "c", district.fetch), out: "x.json", dryRun: false, bands: BANDS, write: async () => {}, log: () => {} }), /404/);
  assert.equal(district.calls.length, 1);
});
