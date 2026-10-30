// The hosted admin's import command (SCHO-263): what it sends, how it refuses a typo, and how it
// reads the admin's answer. The import itself is tested in packages/educateos-admin.

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_ADMIN, parseArgs, requestImport, summarize, type ImportReport } from "./educateos-admin-import.ts";

const REPORT: ImportReport = {
  dryRun: true, exportedAt: "2026-10-28T11:00:00.000Z",
  operators: { created: 2, updated: 0, unchanged: 1 },
  workspaces: { created: 1, matched: 1 },
  installations: { created: 2, updated: 0, unchanged: 0 },
  reservations: { created: 2, updated: 0, unchanged: 0, removed: 1 },
  skipped: [{ instanceId: "ins_riverbend", slug: "riverbend", reason: "slug-taken" }],
};

test("defaults to a real import against admin.educateos.io, and --dry-run asks for a report only", () => {
  assert.deepEqual(parseArgs([]), { admin: DEFAULT_ADMIN, dryRun: false, tokenFromStdin: false });
  assert.deepEqual(parseArgs(["--dry-run", "--admin", "https://admin.example.org/", "--token-stdin"]), {
    admin: "https://admin.example.org", dryRun: true, tokenFromStdin: true,
  });
});

test("refuses an argument it doesn't know, rather than running a real import", () => {
  assert.throws(() => parseArgs(["--dryrun"]), /unknown argument: --dryrun/);
  assert.throws(() => parseArgs(["--admin"]), /needs a URL/);
  assert.throws(() => parseArgs(["--admin", "http://admin.educateos.io"]), /https origin/);
  assert.throws(() => parseArgs(["--admin", "https://admin.educateos.io/api"]), /https origin/);
});

test("posts the dry-run flag with the Access token, and never follows a redirect", async () => {
  const sent: { input: string; init: RequestInit }[] = [];
  const report = await requestImport({
    admin: DEFAULT_ADMIN, dryRun: true, token: "jwt",
    fetch: async (input, init) => {
      sent.push({ input, init });
      return Response.json(REPORT);
    },
  });
  assert.deepEqual(report, REPORT);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.input, "https://admin.educateos.io/api/import/control-plane");
  assert.equal(sent[0]!.init.method, "POST");
  assert.equal(sent[0]!.init.redirect, "manual");
  assert.deepEqual(JSON.parse(String(sent[0]!.init.body)), { dryRun: true });
  assert.equal((sent[0]!.init.headers as Record<string, string>)["cf-access-token"], "jwt");
});

test("says why when Access redirects or the admin refuses", async () => {
  await assert.rejects(
    requestImport({ admin: DEFAULT_ADMIN, dryRun: true, token: "stale", fetch: async () => new Response(null, { status: 302, headers: { location: "https://x" } }) }),
    /cloudflared access login https:\/\/admin\.educateos\.io/,
  );
  await assert.rejects(
    requestImport({ admin: DEFAULT_ADMIN, dryRun: false, token: "jwt", fetch: async () => Response.json({ code: "forbidden", message: "Viewers can't make changes." }, { status: 403 }) }),
    /403: Viewers can't make changes\./,
  );
});

test("prints what the import did, skipped installations included", () => {
  const lines = summarize(REPORT);
  assert.match(lines[0]!, /^Dry run: nothing was written\./);
  assert.ok(lines.includes("  installations: 2 new, 0 changed, 0 unchanged"));
  assert.ok(lines.includes("  reservations:  2 new, 0 changed, 0 unchanged, 1 removed"));
  assert.ok(lines.includes("  skipped riverbend (ins_riverbend): slug-taken"));
  assert.match(summarize({ ...REPORT, dryRun: false })[0]!, /^Imported\./);
});
