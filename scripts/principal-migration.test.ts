// The command-line half of the principal migration (scripts/principal-migration.ts, SCHO-259): its
// arguments, the request it sends, and the report it prints. The migration itself is tested in
// packages/workshop-backend/__tests__/principal-migration.test.ts.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatReport, migrationUrl, parseArgs, runMigration, type MigrationReport,
} from "./principal-migration.ts";

const replying = (response: Response) => (async () => response) as unknown as typeof fetch;

const REPORT: MigrationReport = {
  applied: true,
  users: 3,
  threads: 4,
  counts: { "alias": 1, "already-aliased": 1, "ambiguous": 1, "cross-district": 0, "unmatched": 0, "conflict": 0 },
  entries: [
    { user: "a@d.example", outcome: "alias", threads: 2, principalId: "prn_a", threadsViaPrincipal: 2 },
    { user: "b@d.example", outcome: "already-aliased", threads: 1, principalId: "prn_b", threadsViaPrincipal: 1 },
    { user: "f@d.example", outcome: "ambiguous", threads: 1 },
  ],
};

test("needs a workshop URL and exactly one of --dry-run and --apply", () => {
  assert.deepEqual(parseArgs(["--workshop", "https://nf.example/ai", "--dry-run"]),
    { workshop: new URL("https://nf.example/ai"), apply: false, json: false });
  assert.equal(parseArgs(["--workshop=https://nf.example/ai", "--apply", "--json"]).apply, true);
  assert.throws(() => parseArgs(["--workshop", "https://nf.example/ai"]), /exactly one/);
  assert.throws(() => parseArgs(["--workshop", "https://nf.example/ai", "--dry-run", "--apply"]), /exactly one/);
  assert.throws(() => parseArgs(["--dry-run"]), /--workshop is required/);
  assert.throws(() => parseArgs(["--workshop", "http://nf.example/ai", "--dry-run"]), /https/);
  assert.throws(() => parseArgs(["--workshop", "https://nf.example", "--dry-run", "--force"]), /unknown argument/);
});

test("posts under the Workshop's mount, with the Access token and same-origin header", async () => {
  assert.equal(migrationUrl(new URL("https://nf.example/ai/")).href, "https://nf.example/ai/api/admin/principal-migration");
  assert.equal(migrationUrl(new URL("https://workshop.example")).href, "https://workshop.example/api/admin/principal-migration");

  const calls: { url: string; init: RequestInit }[] = [];
  const fake = (async (url: URL, init: RequestInit) => {
    calls.push({ url: url.href, init });
    return Response.json(REPORT);
  }) as unknown as typeof fetch;
  const report = await runMigration(parseArgs(["--workshop", "https://nf.example/ai", "--dry-run"]), "tok", fake);
  assert.deepEqual(report, REPORT);
  assert.equal(calls[0]!.url, "https://nf.example/ai/api/admin/principal-migration");
  assert.deepEqual(calls[0]!.init.headers, {
    "cf-access-token": "tok", Origin: "https://nf.example", "Content-Type": "application/json",
  });
  assert.equal(calls[0]!.init.body, JSON.stringify({ apply: false }));
});

test("explains a missing route, an Access redirect and a refusal", async () => {
  const args = parseArgs(["--workshop", "https://nf.example/ai", "--apply"]);
  await assert.rejects(runMigration(args, "t", replying(new Response("Not Found", { status: 404 }))), /bind PRINCIPAL_MIGRATION/);
  await assert.rejects(runMigration(args, "t", replying(new Response(null, { status: 302 }))), /refresh CF_ACCESS_TOKEN/);
  await assert.rejects(runMigration(args, "t", replying(new Response("Only a Workshop administrator", { status: 403 }))),
    /refused \(403\): Only a Workshop administrator/);
});

test("prints the counts, then each user's mapping and thread counts", () => {
  const text = formatReport(REPORT);
  assert.match(text, /^Applied: 3 email-keyed users, 4 threads$/m);
  assert.match(text, /^ {2}already-aliased +1$/m);
  assert.match(text, /^alias +a@d\.example -> principal:prn_a: 2 threads, 2 via principal$/m);
  assert.match(text, /^ambiguous +f@d\.example: 1 threads$/m);
  assert.doesNotMatch(text, /WARNING/);
  assert.match(formatReport({ ...REPORT, applied: false }), /^Dry run \(nothing written\)/);

  const drifted = { ...REPORT, entries: [{ ...REPORT.entries[0]!, threadsViaPrincipal: 0 }] };
  assert.match(formatReport(drifted), /WARNING: 1 users' thread counts differ/);
});
