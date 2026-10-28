#!/usr/bin/env node
// Runs the Workshop's one-time migration of email-keyed users to principals (SCHO-259) against
// one deployment, as a Workshop administrator signed in through Cloudflare Access. The backend does
// the work (packages/workshop-backend/src/auth/principal-aliases.ts); this prints its report.
//
//   cloudflared access login https://northfield.educateos.io/ai
//   CF_ACCESS_TOKEN=$(cloudflared access token --app https://northfield.educateos.io/ai) \
//     node scripts/principal-migration.ts --workshop https://northfield.educateos.io/ai --dry-run
//   ... --apply
//
// `--dry-run` writes nothing; `--apply` records the aliases, and can be run again safely. Add
// `--json` for the raw report. The cutover is in docs/educateos/runbooks/production-instance.md.

import { pathToFileURL } from "node:url";

/** What the backend's report says about one user (`PrincipalMigrationEntry`, matched by hand). */
export type MigrationEntry = {
  user: string;
  outcome: string;
  threads: number;
  principalId?: string;
  reason?: string;
  threadsViaPrincipal?: number;
};

/** The backend's report (`PrincipalMigrationReport`). */
export type MigrationReport = {
  applied: boolean;
  users: number;
  threads: number;
  counts: Record<string, number>;
  entries: MigrationEntry[];
};

/** The parsed command line. */
export type MigrationArgs = { workshop: URL; apply: boolean; json: boolean };

const USAGE = "usage: node scripts/principal-migration.ts --workshop <url> (--dry-run | --apply) [--json]";

/** Parses the command line. Exactly one of `--dry-run` and `--apply` is required. */
export function parseArgs(argv: readonly string[]): MigrationArgs {
  let workshop: string | undefined;
  let dryRun = false;
  let apply = false;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--workshop") workshop = argv[++i];
    else if (arg.startsWith("--workshop=")) workshop = arg.slice("--workshop=".length);
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--apply") apply = true;
    else if (arg === "--json") json = true;
    else throw new Error(`unknown argument ${arg}\n${USAGE}`);
  }
  if (dryRun === apply) throw new Error(`pass exactly one of --dry-run and --apply\n${USAGE}`);
  if (!workshop) throw new Error(`--workshop is required\n${USAGE}`);
  const url = new URL(workshop);
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new Error("--workshop must be an https URL");
  }
  return { workshop: url, apply, json };
}

/**
 * The migration endpoint under the Workshop's mount: `https://host/ai` gives
 * `https://host/ai/api/admin/principal-migration`.
 */
export function migrationUrl(workshop: URL): URL {
  const base = workshop.pathname.replace(/\/+$/, "");
  return new URL(`${base}/api/admin/principal-migration`, workshop.origin);
}

/** Calls the endpoint, as the Access user `accessToken` names. Throws with the backend's refusal. */
export async function runMigration(
  args: MigrationArgs, accessToken: string, fetchImpl: typeof fetch = fetch,
): Promise<MigrationReport> {
  const url = migrationUrl(args.workshop);
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      // Access accepts a CLI token in this header and passes the request on with its assertion.
      "cf-access-token": accessToken,
      Origin: url.origin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ apply: args.apply }),
    redirect: "manual",
  });
  const text = await response.text();
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`Access redirected the request to sign in (${response.status}); refresh CF_ACCESS_TOKEN`);
  }
  if (response.status === 404) {
    throw new Error("the Workshop has no principal migration here: bind PRINCIPAL_MIGRATION (or PRINCIPAL_RESOLVER) first");
  }
  if (!response.ok) throw new Error(`the Workshop refused (${response.status}): ${text}`);
  return JSON.parse(text) as MigrationReport;
}

/** The report for a person: counts, then one line per user. */
export function formatReport(report: MigrationReport): string {
  const lines = [
    `${report.applied ? "Applied" : "Dry run (nothing written)"}: ${report.users} email-keyed users, ${report.threads} threads`,
    ...Object.entries(report.counts).map(([outcome, count]) => `  ${outcome.padEnd(16)} ${count}`),
    "",
  ];
  for (const entry of report.entries) {
    const target = entry.principalId === undefined ? "" : ` -> principal:${entry.principalId}`;
    const reason = entry.reason === undefined ? "" : ` (${entry.reason})`;
    const via = entry.threadsViaPrincipal === undefined ? "" : `, ${entry.threadsViaPrincipal} via principal`;
    lines.push(`${entry.outcome.padEnd(16)} ${entry.user}${target}${reason}: ${entry.threads} threads${via}`);
  }
  const mismatched = report.entries.filter(e => e.threadsViaPrincipal !== undefined && e.threadsViaPrincipal !== e.threads);
  if (mismatched.length > 0) lines.push("", `WARNING: ${mismatched.length} users' thread counts differ through their principal`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env["CF_ACCESS_TOKEN"];
  if (!token) throw new Error("set CF_ACCESS_TOKEN (cloudflared access token --app <workshop url>)");
  const report = await runMigration(args, token);
  console.log(args.json ? JSON.stringify(report, null, 2) : formatReport(report));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
