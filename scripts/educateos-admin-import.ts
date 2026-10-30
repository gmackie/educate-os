#!/usr/bin/env node

// Runs the hosted admin's import of educateos.io's operators, installations and slug reservations
// (SCHO-263): `POST https://admin.educateos.io/api/import/control-plane`, as a signed-in operator,
// through Cloudflare Access. The admin does the work (it reads the control plane's read-only export
// over its CONTROL_PLANE service binding and writes its own D1); this only asks for it and prints
// what it did. Idempotent: a second run with nothing new changes nothing.
//
// Usage:
//   node scripts/educateos-admin-import.ts --dry-run       report what would change, write nothing
//   node scripts/educateos-admin-import.ts                 import
//   ... --admin https://admin.educateos.io                 another admin (default shown)
//   ... --token-stdin                                      read the Access token from stdin
//
// Without --token-stdin, the token comes from `cloudflared access token -app=<admin>`, so sign in
// first with `cloudflared access login <admin>`. The operator must be listed in the admin's ADMINS
// with the admin role. See docs/educateos/runbooks/admin-hosted.md.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The hosted admin. */
export const DEFAULT_ADMIN = "https://admin.educateos.io";

/** What the command line asked for. */
export interface ImportArgs {
  admin: string;
  dryRun: boolean;
  tokenFromStdin: boolean;
}

/** Parses the command line. Throws on anything it doesn't know, so a typo never runs a real import. */
export function parseArgs(argv: readonly string[]): ImportArgs {
  const args: ImportArgs = { admin: DEFAULT_ADMIN, dryRun: false, tokenFromStdin: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--token-stdin") args.tokenFromStdin = true;
    else if (arg === "--admin") {
      const value = argv[++i];
      if (value === undefined) throw new Error("--admin needs a URL");
      args.admin = value;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  const url = new URL(args.admin);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search !== "") throw new Error("--admin must be an https origin, such as https://admin.educateos.io");
  args.admin = url.origin;
  return args;
}

/** The counts the admin answers with (`ImportReport` in packages/educateos-admin/src/shared/api.ts). */
interface Counts {
  created: number;
  updated: number;
  unchanged: number;
}

/** The admin's report. */
export interface ImportReport {
  dryRun: boolean;
  exportedAt: string;
  operators: Counts;
  workspaces: { created: number; matched: number };
  installations: Counts;
  reservations: Counts & { removed: number };
  skipped: { instanceId: string; slug: string; reason: string }[];
}

/** Asks the admin to import (or, with `dryRun`, to report), and returns its report. */
export async function requestImport(options: {
  admin: string;
  dryRun: boolean;
  token: string;
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
}): Promise<ImportReport> {
  const send = options.fetch ?? ((input, init) => fetch(input, init));
  const response = await send(`${options.admin}/api/import/control-plane`, {
    method: "POST",
    // Access reads the token from this header and hands the Worker its own assertion.
    headers: { "cf-access-token": options.token, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ dryRun: options.dryRun }),
    // A redirect here is Access asking for a browser sign-in: the token was missing or stale.
    redirect: "manual",
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`Access redirected the request: sign in again with \`cloudflared access login ${options.admin}\``);
  }
  const body = (await response.json().catch(() => undefined)) as { message?: string } | undefined;
  if (!response.ok) throw new Error(`the admin answered ${response.status}: ${body?.message ?? "no message"}`);
  return body as unknown as ImportReport;
}

const counts = (c: Counts) => `${c.created} new, ${c.updated} changed, ${c.unchanged} unchanged`;

/** The report as lines for a terminal. */
export function summarize(report: ImportReport): string[] {
  return [
    `${report.dryRun ? "Dry run: nothing was written." : "Imported."} educateos.io snapshot of ${report.exportedAt}.`,
    `  operators:     ${counts(report.operators)}`,
    `  installations: ${counts(report.installations)}`,
    `  workspaces:    ${report.workspaces.created} new, ${report.workspaces.matched} matched to an existing workspace`,
    `  reservations:  ${counts(report.reservations)}, ${report.reservations.removed} removed`,
    ...report.skipped.map((s) => `  skipped ${s.slug} (${s.instanceId}): ${s.reason}`),
  ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const token = args.tokenFromStdin
    ? readFileSync(0, "utf8").trim()
    : execFileSync("cloudflared", ["access", "token", `-app=${args.admin}`], { encoding: "utf8" }).trim();
  if (token === "") throw new Error("no Access token");
  const report = await requestImport({ admin: args.admin, dryRun: args.dryRun, token });
  for (const line of summarize(report)) console.log(line);
}
