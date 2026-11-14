// `connect` and `status` in process, against an installed district in the installer's Cloudflare
// fake, a stand-in for the district Worker's HTTP surface, and the provider fakes.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CLASSROOM_SCOPES } from "@educateos/provider-fakes";
import { afterEach, describe, expect, it } from "vitest";
import { ACCESS_TOKEN_ENV } from "../src/connect/district.ts";
import { CLEVER_TOKEN_ENV } from "../src/connect/roster.ts";
import { ADMIN_ACCESS_TOKEN, type ConnectWorld, connectWorld, DISTRICT_WORKER, ORIGIN, run, serviceAccountKeyFile, WORKSPACE_ADMIN } from "./connect-harness.ts";

const worlds: ConnectWorld[] = [];
afterEach(async () => {
  await Promise.all(worlds.splice(0).map((world) => world.close()));
});

async function setup(): Promise<ConnectWorld> {
  const created = await connectWorld();
  worlds.push(created);
  return created;
}

const events = (stdout: string) => stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { event: string } & Record<string, unknown>);
const ROSTER_SCOPES = [CLASSROOM_SCOPES.coursesReadonly, CLASSROOM_SCOPES.rostersReadonly, CLASSROOM_SCOPES.profileEmails];

describe("connect canvas and moodle", () => {
  it("creates an invitation, then approves Canvas's registration on a second run (CI)", async () => {
    const w = await setup();
    const env = { ...w.env, [ACCESS_TOKEN_ENV]: ADMIN_ACCESS_TOKEN };
    const first = await run(["connect", "canvas", "--json"], { cwd: w.dir, env, fetch: w.fetch });
    expect(first.code).toBe(0);
    const started = events(first.stdout).find((e) => e.event === "connect")!;
    expect(started).toMatchObject({ integration: "canvas", status: "pending" });
    expect(first.stderr).toContain(`${ORIGIN}/lti/register?invitation=synthetic-invitation-1`);
    expect(first.stderr).toContain("Developer Keys > + Developer Key > LTI Registration");
    expect(first.stderr).not.toContain(ADMIN_ACCESS_TOKEN);

    // Canvas registers, returning no deployment ID (as Canvas does).
    w.district.register({ id: "lpr_canvas", issuer: "https://canvas.northfield.example", clientId: "10000000000003", productFamily: "canvas" });
    const second = await run([
      "connect", "canvas", "--json", "--yes", "--issuer", "https://canvas.northfield.example",
      "--context-id", "61f3600b24f01a51af8076f1fd9c04d5be7541ab", "--offering-id", "off_earth-science", "--deployment-id", "2:61f3",
    ], { cwd: w.dir, env, fetch: w.fetch });
    expect(second.stderr).not.toContain("error");
    expect(second.code).toBe(0);
    const done = events(second.stdout).find((e) => e.event === "connect")!;
    expect(done).toMatchObject({ integration: "canvas", status: "connected" });
    expect(w.district.trusted).toEqual(["https://canvas.northfield.example"]);
    expect(w.district.registrations).toEqual([{
      provider: "canvas", issuer: "https://canvas.northfield.example", clientId: "10000000000003", deploymentIds: ["2:61f3"],
      offerings: [{ contextId: "61f3600b24f01a51af8076f1fd9c04d5be7541ab", offeringId: "off_earth-science" }],
    }]);
  });

  it("walks a Moodle administrator through registration on a terminal", async () => {
    const w = await setup();
    w.district.onInvitation = { id: "lpr_moodle", issuer: "https://moodle.northfield.example", clientId: "x7IjNe4cMM4OBAY", deploymentId: "1", productFamily: "moodle" };
    const result = await run(["connect", "moodle"], {
      cwd: w.dir, env: w.env, fetch: w.fetch,
      answers: [ADMIN_ACCESS_TOKEN, "", "2", "off_earth-science", "y"],
    });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Add LTI Advantage");
    expect(result.stdout).toContain("Moodle registered: issuer https://moodle.northfield.example");
    expect(result.stdout).toContain("ok    https://moodle.northfield.example is approved: 1 deployment(s), 1 course(s) mapped");
    expect(result.stdout).toContain("Moodle is connected.");
    expect(result.stdout).not.toContain(ADMIN_ACCESS_TOKEN);
    expect(w.district.registrations[0]).toMatchObject({ provider: "moodle", deploymentIds: ["1"], offerings: [{ contextId: "2", offeringId: "off_earth-science" }] });
  });

  it("stops before any registration when Access is in front of /lti/*", async () => {
    const w = await setup();
    w.district.ltiBehindAccess = true;
    const result = await run(["connect", "canvas"], { cwd: w.dir, env: { ...w.env, [ACCESS_TOKEN_ENV]: ADMIN_ACCESS_TOKEN }, fetch: w.fetch });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Cloudflare Access is in front of /lti/*");
    expect(w.district.invitations).toBe(0);
  });

  it("prints the requests to make when there is no Access token and no terminal", async () => {
    const w = await setup();
    const result = await run(["connect", "moodle"], { cwd: w.dir, env: w.env, fetch: w.fetch });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`cloudflared access token --app ${ORIGIN}`);
    expect(result.stdout).toContain("/api/lti/invitations");
    expect(w.district.adminCalls).toEqual([]);
  });

  it("says Schoology and ClassLink aren't available rather than faking them", async () => {
    const w = await setup();
    const schoology = await run(["connect", "schoology"], { cwd: w.dir, env: w.env, fetch: w.fetch });
    expect(schoology.code).toBe(1);
    expect(schoology.stdout).toContain("Schoology isn't available yet.");
    expect(schoology.stdout).toContain("Dynamic Registration");
    const classlink = await run(["connect", "classlink"], { cwd: w.dir, env: w.env, fetch: w.fetch });
    expect(classlink.stdout).toContain("connect oneroster");
  });
});

describe("connect clever", () => {
  it("checks the district-app token against Clever, then stores it as the district Worker's secret", async () => {
    const w = await setup();
    const env = { ...w.env, [CLEVER_TOKEN_ENV]: w.clever.districtToken };
    const result = await run(["connect", "clever", "--clever-district-id", w.clever.districtId, "--yes"], { cwd: w.dir, env, fetch: w.fetch });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`ok    the token reads Clever district ${w.clever.districtId}`);
    expect(result.stdout).toContain(`Plan: set the Worker secret CLEVER_DISTRICT_TOKEN on ${DISTRICT_WORKER}`);
    expect(result.stdout).toContain("provider clever");
    expect(result.stdout).not.toContain(w.clever.districtToken);
    expect(w.cloudflare.fake.secretValue(DISTRICT_WORKER, "CLEVER_DISTRICT_TOKEN")).toBe(w.clever.districtToken);
  });

  it("refuses a token for another district and stores nothing", async () => {
    const w = await setup();
    const env = { ...w.env, [CLEVER_TOKEN_ENV]: w.clever.districtToken };
    const result = await run(["connect", "clever", "--clever-district-id", "0".repeat(24), "--yes"], { cwd: w.dir, env, fetch: w.fetch });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(`not ${"0".repeat(24)}`);
    expect(w.cloudflare.fake.worker(DISTRICT_WORKER)?.secretNames ?? []).not.toContain("CLEVER_DISTRICT_TOKEN");
  });

  it("asks for the token hidden on a terminal, and changes nothing if the operator declines", async () => {
    const w = await setup();
    const result = await run(["connect", "clever"], {
      cwd: w.dir, env: w.env, fetch: w.fetch,
      answers: [w.clever.districtId, w.clever.districtToken, "n"],
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Clever district-app token (input hidden)");
    expect(result.stdout).not.toContain(w.clever.districtToken);
    expect(w.cloudflare.fake.worker(DISTRICT_WORKER)?.secretNames ?? []).not.toContain("CLEVER_DISTRICT_TOKEN");
  });
});

describe("connect google-classroom", () => {
  it("checks the delegation, stores the key, writes DISTRICT_CONFIG.classroom and applies it", async () => {
    const w = await setup();
    const key = await serviceAccountKeyFile(w, ROSTER_SCOPES);
    const roster = join(w.dir, "classroom-roster.json");
    writeFileSync(roster, JSON.stringify({
      term: { sourcedId: "term-2026", title: "2026-27", startDate: "2026-08-20", endDate: "2027-06-10" },
      schools: [{ sourcedId: "school-hs", name: "Northfield High", grades: ["09", "10", "11", "12"] }],
    }));
    const result = await run([
      "connect", "google-classroom", "--service-account-key", key, "--workspace-admin", WORKSPACE_ADMIN,
      "--classroom-roster", roster, "--yes", "--release-url", w.mirror.base, "--trust", w.trust,
    ], { cwd: w.dir, env: w.env, fetch: w.fetch });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`ok    delegation works: the service account reads Classroom as ${WORKSPACE_ADMIN}`);
    const keyText = readFileSync(key, "utf8");
    expect(result.stdout).not.toContain(JSON.parse(keyText).private_key.split("\n")[1]);
    expect(w.cloudflare.fake.secretValue(DISTRICT_WORKER, "GOOGLE_CLASSROOM_SERVICE_ACCOUNT_KEY")).toBe(JSON.stringify(JSON.parse(keyText)));

    const answers = JSON.parse(readFileSync(w.answersPath, "utf8"));
    const config = JSON.parse(answers.install.services["educateos-district-worker"].vars.DISTRICT_CONFIG);
    expect(config).toMatchObject({ synthetic: "northfield district config", classroom: { admin: WORKSPACE_ADMIN, rosterScopes: "readonly" }, additionalTrustedIssuers: ["https://accounts.google.com"] });
    // Applied with the release already installed: the Worker now carries the new configuration.
    const binding = w.cloudflare.fake.worker(DISTRICT_WORKER)?.bindings.find((b) => b.name === "DISTRICT_CONFIG") as { text?: string } | undefined;
    expect(JSON.parse(binding?.text ?? "{}").classroom.admin).toBe(WORKSPACE_ADMIN);
    // The secret survived the redeploy.
    expect(w.cloudflare.fake.worker(DISTRICT_WORKER)?.secretNames).toContain("GOOGLE_CLASSROOM_SERVICE_ACCOUNT_KEY");
  });

  it("fails the live check, storing nothing, when the domain didn't delegate the scopes", async () => {
    const w = await setup();
    const key = await serviceAccountKeyFile(w, [CLASSROOM_SCOPES.coursesReadonly]);
    const result = await run(["connect", "google-classroom", "--service-account-key", key, "--workspace-admin", WORKSPACE_ADMIN, "--yes"], { cwd: w.dir, env: w.env, fetch: w.fetch });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Google refused a token");
    expect(w.cloudflare.fake.worker(DISTRICT_WORKER)?.secretNames ?? []).not.toContain("GOOGLE_CLASSROOM_SERVICE_ACCOUNT_KEY");
  });
});

describe("connect oneroster", () => {
  it("previews a CSV export and applies it", async () => {
    const w = await setup();
    const csv = join(w.dir, "export");
    mkdirSync(csv);
    writeFileSync(join(csv, "manifest.csv"), "propertyName,value\noneroster.version,1.2\n");
    writeFileSync(join(csv, "users.csv"), "sourcedId,givenName\nu1,Ada\nu2,Sam\n");
    writeFileSync(join(csv, "notes.txt"), "ignored");
    const result = await run(["connect", "oneroster", "--csv-dir", csv, "--yes"], { cwd: w.dir, env: { ...w.env, [ACCESS_TOKEN_ENV]: ADMIN_ACCESS_TOKEN }, fetch: w.fetch });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Read 2 file(s): manifest.csv, users.csv.");
    expect(result.stdout).toMatch(/principals\.created\s+2/);
    expect(result.stdout).toContain("ok    applied");
    expect(Object.keys(w.district.rosterApplies[0]!)).toEqual(["manifest.csv", "users.csv"]);
  });
});

describe("status", () => {
  it("reports the district, sign-in, the LTI tool and each integration, with fixes", async () => {
    const w = await setup();
    await run(["connect", "clever", "--clever-district-id", w.clever.districtId, "--yes"], { cwd: w.dir, env: { ...w.env, [CLEVER_TOKEN_ENV]: w.clever.districtToken }, fetch: w.fetch });
    w.district.registrations.push({ provider: "canvas", issuer: "https://canvas.northfield.example", clientId: "1", deploymentIds: ["d"], offerings: [{ contextId: "c", offeringId: "o" }] });
    w.district.rosterProvider = "clever";
    w.district.rosterReason = undefined;
    const result = await run(["status", "--json"], { cwd: w.dir, env: { ...w.env, [ACCESS_TOKEN_ENV]: ADMIN_ACCESS_TOKEN }, fetch: w.fetch });
    expect(result.code).toBe(0);
    const rows = Object.fromEntries((events(result.stdout).find((e) => e.event === "status")!.rows as { area: string; state: string }[]).map((r) => [r.area, r.state]));
    expect(rows).toMatchObject({
      district: "ok", "sign-in": "ok", "lti-tool": "ok", canvas: "ok", moodle: "not configured",
      clever: "ok", "google-classroom": "not configured", "roster-sync": "ok", "oneroster-api": "not available",
    });
  });

  it("fails and names the fix when Access is missing from /lti/*, without needing any token", async () => {
    const w = await setup();
    w.district.ltiBehindAccess = true;
    const { CLOUDFLARE_API_TOKEN: _token, ...env } = w.env;
    const result = await run(["status"], { cwd: w.dir, env, fetch: w.fetch });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("FAIL  lti-tool");
    expect(result.stdout).toContain("fix: Access is in front of /lti/*");
    expect(result.stdout).toContain("??    clever");
  });
});

describe("the CLI", () => {
  it("lists connect and status in its help, and refuses an unknown integration", async () => {
    const w = await setup();
    const help = await run(["--help"], { cwd: w.dir, env: w.env });
    expect(help.stdout).toContain("npx launch-educate-os connect");
    expect(help.stdout).toContain("canvas, moodle, schoology, google-classroom, clever, classlink, oneroster");
    expect(help.stdout).toContain("npx launch-educate-os status");
    const unknown = await run(["connect", "blackboard"], { cwd: w.dir, env: w.env, fetch: w.fetch });
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("unknown integration blackboard");
  });
});
