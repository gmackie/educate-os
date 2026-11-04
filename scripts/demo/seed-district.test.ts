// seed-district.ts's operator half against in-memory districts; the roster exports are checked against the real
// importer in packages/educateos-district-worker/__tests__/demo-district-rosters.test.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DEMO_DISTRICTS } from "../../packages/educateos-fixtures/src/index.ts";
import { AUTOMATION, demoFor, isLocal, localSteps, nonAdditive, type AuthoringDirectory, type RosterPreview } from "./district-roster.ts";
import { STARTER_PACK, listingOf, runDistrict, seedLocal, type DistrictAdminClient } from "./seed-district.ts";

const AUTOMATION_SUBJECT = "adfd94dd-86a7-5838-b9a7-d1eb94227303";

test("demoFor names the standalone demo districts and refuses Northfield", () => {
  assert.equal(demoFor("https://harbor.educateos.io").slug, "harbor");
  assert.throws(() => demoFor("https://northfield.educateos.io"), /not a standalone demo district/);
  assert.equal(DEMO_DISTRICTS.filter((d) => d.slug !== "northfield" && !isLocal(d)).map((d) => d.slug).join(), "riverbend,cedarvalley,lakeshore,harbor");
});

test("nonAdditive refuses a preview that would change, retain or relink what is there", () => {
  const empty = { added: [], updated: [], deactivated: [], retained: [] };
  const preview: RosterPreview = { canApply: true, issues: [], integrity: [], quarantined: [], linked: [], changes: { principals: { ...empty, updated: ["prn_x"] }, roleAssignments: { added: [], removed: [{}] } } };
  assert.deepEqual(nonAdditive(preview), ["it would change 1 existing principals", "it would remove 1 roleAssignments"]);
  assert.match(nonAdditive({ ...preview, canApply: false, changes: {}, issues: [{ severity: "error", file: "users.csv", row: 2, message: "bad" }] }).join("\n"), /would not apply[\s\S]*users\.csv:2/);
});

/** An in-memory local-authority district behind the admin routes `seedLocal` calls. */
function fakeLocalDistrict(directory: AuthoringDirectory) {
  const enrollments: { offeringId: string; principalId: string; role: string }[] = [];
  const calls: string[] = [];
  let n = 0;
  const client: DistrictAdminClient = {
    get: async <T>(path: string) => {
      const offeringId = /^\/api\/admin\/offerings\/([^/]+)\/roster$/.exec(path)?.[1];
      if (offeringId === undefined) throw new Error(`unexpected GET ${path}`);
      return enrollments.filter((e) => e.offeringId === offeringId).map((e) => ({ enrollment: { ...e, status: "active" }, displayName: "" })) as T;
    },
    post: async <T>(path: string, body: unknown) => {
      calls.push(path);
      const b = body as Record<string, string>;
      const id = `id-${++n}`;
      if (path === "/api/admin/schools") directory.schools.push({ id, name: b.name! });
      else if (path === "/api/admin/terms") directory.terms.push({ id, name: b.name! });
      else if (path === "/api/admin/courses") directory.courses.push({ id, title: b.title! });
      else if (path === "/api/admin/offerings") directory.offerings.push({ id, schoolId: b.schoolId!, termId: b.termId!, courseId: b.courseId!, sectionName: b.sectionName! });
      else if (path === "/api/admin/principals") directory.principals.push({ id, kind: b.kind!, displayName: b.displayName!, districtAdmin: false });
      else if (path.endsWith("/district-admin")) directory.principals.find((p) => path.includes(`/${p.id}/`))!.districtAdmin = true;
      else if (path.endsWith("/enrollments")) enrollments.push({ offeringId: path.split("/")[4]!, principalId: b.principalId!, role: b.role! });
      else throw new Error(`unexpected POST ${path}`);
      return { id } as T;
    },
  };
  return { client, calls, enrollments };
}

test("prairie: authoring steps make the fixture's classes once, under the Access team, and admit the automation", async () => {
  const demo = demoFor("https://prairie.educateos.io");
  const steps = localSteps(demo, { admitSubject: AUTOMATION_SUBJECT });
  for (const step of steps) if (step.kind === "principal") assert.equal(step.body.identity.issuer, "https://gmacko.cloudflareaccess.com");
  assert.ok(!steps.some((s) => s.kind === "principal" && s.fixtureId === "prn_pr-coordinator"), "the seeded administrator is left out");
  assert.ok(!steps.some((s) => s.kind === "principal" && s.fixtureId === "prn_pr-guardian-hollis"), "guardians are left out");

  const directory: AuthoringDirectory = { authority: { principal: "local" }, trustedIssuers: [], schools: [], terms: [], courses: [], offerings: [], principals: [{ id: "prn_pr-coordinator", kind: "staff", displayName: "Hazel Brooks", districtAdmin: true }] };
  const { client, calls, enrollments } = fakeLocalDistrict(directory);
  const dry = await seedLocal(client, steps, structuredClone(directory), () => {}, true);
  assert.equal(calls.length, 0);
  const made = await seedLocal(client, steps, directory, () => {}, false);
  assert.deepEqual(dry, made);
  assert.deepEqual(made, { schools: 2, terms: 1, courses: 4, offerings: 4, principals: 7, "district admins": 1, enrollments: 12 });
  assert.equal(enrollments.length, 12);
  assert.ok(directory.principals.find((p) => p.displayName === AUTOMATION.displayName)?.districtAdmin);

  calls.length = 0;
  assert.deepEqual(await seedLocal(client, steps, directory, () => {}, false), {});
  assert.deepEqual(calls, []);
});

test("runDistrict saves the before state first, and installs the starter pack only once", async () => {
  const pack: unknown = JSON.parse(readFileSync(STARTER_PACK, "utf8"));
  const { listingId, version } = listingOf(pack);
  assert.equal(listingId, "middle-school-starter-pack");
  const demo = demoFor("https://harbor.educateos.io");
  const writes: string[] = [];
  const posts: string[] = [];
  const installed: { listingId: string; version: string }[] = [];
  const empty = { added: [], updated: [], deactivated: [], retained: [] };
  const client: DistrictAdminClient = {
    get: async <T>(path: string) => ({
      "/api/admin/health": { districtId: "dst_harbor", directory: { schools: 0, terms: 0, offerings: 0, students: 0, staff: 1, activeEnrollments: 0 } },
      "/api/admin/authoring": { authority: { principal: "external:oneroster" }, principals: [] },
      "/api/admin/offerings": [],
      "/api/admin/marketplace/packs": installed,
    } as Record<string, unknown>)[path] as T,
    post: async <T>(path: string) => {
      posts.push(path);
      if (path === "/api/admin/marketplace/packs") installed.push({ listingId, version });
      return (path === "/api/admin/marketplace/packs" ? { listingId, version } : { canApply: true, issues: [], integrity: [], quarantined: [], linked: [], changes: { schools: empty } }) as T;
    },
  };
  const write = async (path: string) => {
    assert.equal(posts.length, 0, "the export is saved before anything is changed");
    writes.push(path);
  };
  await runDistrict({ client, demo, out: "/tmp/before.json", dryRun: false, pack, write, log: () => {} });
  await runDistrict({ client, demo, out: "/tmp/before-2.json", dryRun: false, pack, write: async (p) => void writes.push(p), log: () => {} });
  assert.deepEqual(writes, ["/tmp/before.json", "/tmp/before-2.json"]);
  assert.equal(posts.filter((p) => p === "/api/admin/marketplace/packs").length, 1);
});
