// seed-district.ts's operator half against in-memory districts; the roster exports are checked against the real
// importer in packages/educateos-district-worker/__tests__/demo-district-rosters.test.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DEMO_DISTRICTS } from "../../packages/educateos-fixtures/src/index.ts";
import { AUTOMATION, demoFor, isLocal, localSteps, nonAdditive, type AuthoringDirectory, type RosterPreview } from "../../packages/educateos-harness/src/demo-district.ts";
import { MIN_OPERATOR_TOKEN_LENGTH, STARTER_PACK, listingOf, operatorClient, operatorToken, runDistrict, runOperator, seedLocal, type DistrictAdminClient } from "./seed-district.ts";

const AUTOMATION_SUBJECT = "adfd94dd-86a7-5838-b9a7-d1eb94227303";

test("demoFor names the standalone demo districts and refuses Northfield", () => {
  assert.equal(demoFor("https://harbor.educateos.io").slug, "harbor");
  assert.throws(() => demoFor("https://northfield.educateos.io"), /not a standalone demo district/);
  assert.equal(DEMO_DISTRICTS.filter((d) => d.slug !== "northfield" && !isLocal(d)).map((d) => d.slug).join(), "riverbend,cedarvalley,lakeshore,harbor");
});

test("nonAdditive refuses a preview that would change, deactivate, retain or relink what is there", () => {
  const empty = { added: [], updated: [], deactivated: [], retained: [] };
  const preview: RosterPreview = { canApply: true, issues: [], integrity: [], quarantined: [], linked: [], changes: { principals: { ...empty, updated: ["prn_x"] }, enrollments: { ...empty, deactivated: ["enr_x"] }, roleAssignments: { added: [], removed: [{}] } } };
  assert.deepEqual(nonAdditive(preview), ["it would change 1 existing principals", "it would deactivate 1 enrollments", "it would remove 1 roleAssignments"]);
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

test("the operator token comes from the named variable, and is refused when missing or short, never quoted", () => {
  const token = "t".repeat(MIN_OPERATOR_TOKEN_LENGTH);
  assert.equal(operatorToken("OP", { OP: ` ${token}\n` }), token);
  assert.throws(() => operatorToken("OP", {}), /^Error: OP is not set$/);
  assert.throws(() => operatorToken("OP", { OP: "short-secret" }), (error: Error) => error.message === "OP is shorter than 32 characters" && !error.message.includes("short-secret"));
});

test("an operator run sends the bearer token and no cookie, saves the before export, and reports the district's problems", async () => {
  const token = "x".repeat(40);
  const requests: { url: string; init: RequestInit }[] = [];
  const answer = { districtId: "dst_harbor", slug: "harbor", dryRun: false, adminPrincipalId: "prn_hb-school-admin", before: { health: { districtId: "dst_harbor" } }, log: ["roster preview: adds"], problems: ["x is not installed"] };
  const fetch = async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return Response.json(answer);
  };
  const writes: [string, string][] = [];
  const lines: string[] = [];
  const problems = await runOperator({
    client: operatorClient("https://harbor.educateos.io", token, fetch),
    demo: demoFor("https://harbor.educateos.io"),
    out: "/tmp/harbor-before.json",
    dryRun: true,
    admitSubject: AUTOMATION_SUBJECT,
    write: async (path, text) => void writes.push([path, text]),
    log: (line) => void lines.push(line),
  });
  assert.deepEqual(problems, ["x is not installed"]);
  assert.equal(requests.length, 1);
  const [{ url, init }] = requests as [{ url: string; init: RequestInit }];
  assert.equal(url, "https://harbor.educateos.io/api/demo/operator/seed");
  assert.equal(init.redirect, "manual");
  const headers = init.headers as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${token}`);
  assert.equal(headers.cookie, undefined);
  assert.deepEqual(JSON.parse(init.body as string), { dryRun: true, admitSubject: AUTOMATION_SUBJECT });
  assert.deepEqual(writes.map(([path, text]) => [path, JSON.parse(text)]), [["/tmp/harbor-before.json", answer.before]]);
  assert.ok(!lines.join("\n").includes(token));

  // The district another host answers for is refused.
  const elsewhere = await runOperator({ client: operatorClient("https://harbor.educateos.io", token, async () => Response.json({ ...answer, slug: "lakeshore", problems: [] })), demo: demoFor("https://harbor.educateos.io"), out: "/tmp/x", dryRun: false, write: async () => {}, log: () => {} });
  assert.deepEqual(elsewhere, ["the district says it is lakeshore, not harbor"]);
});

test("an operator request Access redirects, or the district refuses, is an error that says which", async () => {
  const client = (response: Response) => operatorClient("https://harbor.educateos.io", "x".repeat(40), async () => response);
  await assert.rejects(client(new Response(null, { status: 302, headers: { location: "https://gmacko.cloudflareaccess.com/" } })).status(), /bypass application/);
  await assert.rejects(client(Response.json({ code: "unauthenticated", message: "Unauthorized." }, { status: 401 })).seed({}), /401 unauthenticated/);
  await assert.rejects(client(Response.json({ code: "not-found", message: "No such route." }, { status: 404 })).status(), /404 not-found/);
});
