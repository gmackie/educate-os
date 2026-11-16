// Dependency vulnerability scan (SCHO-375). Runs `pnpm audit` against each pnpm lockfile in the
// repository and applies the policy in docs/educateos/security/dependency-scanning.md:
//
//   node scripts/security/dependency-audit.ts                     report only (main, nightly)
//   node scripts/security/dependency-audit.ts --base-ref main     gate a pull request against main
//
// `pnpm audit` reads the lockfile and asks the registry's bulk advisory endpoint, so it needs no
// install and no extra tool. When the registry cannot be reached the scan warns and passes: an
// outage must not block a merge, and the next run reports what this one missed.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { pnpmCommand } from "../pnpm-command.ts";
import {
  type Advisory,
  countBySeverity,
  evaluate,
  parseAudit,
  SEVERITIES,
  validateBaseline,
} from "./dependency-audit-lib.ts";

/** The lockfiles scanned, relative to the repository root. Each is its own pnpm workspace. */
const LOCKFILES = ["pnpm-lock.yaml", "apps/mobile/pnpm-lock.yaml", "tools/launch-factory/pnpm-lock.yaml"];
const BASELINE = "scripts/security/dependency-audit-baseline.json";
const AUDIT_TIMEOUT_MS = 90_000;

const root = path.resolve(import.meta.dirname, "../..");
const { values } = parseArgs({ options: { "base-ref": { type: "string" }, "base-remote": { type: "string", default: "origin" } } });
const baseRef = values["base-ref"];
const baseRemote = values["base-remote"];

// Forgejo Actions reads the same workflow commands as GitHub Actions.
const annotate = (level: "error" | "warning" | "notice", message: string): void => {
  console.log(`::${level} title=Dependency audit::${message.replace(/\r?\n/g, " ")}`);
};

function auditOnce(dir: string, prod: boolean): Advisory[] {
  const [command, args] = pnpmCommand(["audit", "--json", ...(prod ? ["--prod"] : [])]);
  // pnpm audit exits 1 whenever it finds anything, so the exit code says nothing; the JSON does.
  const result = spawnSync(command, args, {
    cwd: dir,
    encoding: "utf8",
    timeout: AUDIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  return parseAudit(result.stdout || result.stderr);
}

/** One retry: the registry's bulk advisory endpoint fails a request now and then ("fetch failed"). */
function audit(dir: string, prod: boolean): Advisory[] {
  try {
    return auditOnce(dir, prod);
  } catch {
    return auditOnce(dir, prod);
  }
}

let baseFetched = false;
/** The base branch's copy of a lockfile, `null` if it has none. Fetched once, shallowly. */
function baseLockfile(lockfile: string): string | null {
  if (!baseFetched) {
    // Shallow checkouts do not have the base branch. One commit of it is enough, and without blobs
    // only the lockfiles `git show` asks for are downloaded (a server without partial clone
    // ignores the filter and sends the commit's tree whole).
    execFileSync("git", ["fetch", "--quiet", "--no-tags", "--depth=1", "--filter=blob:none", baseRemote, `refs/heads/${baseRef}`], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
    baseFetched = true;
  }
  try {
    return execFileSync("git", ["show", `FETCH_HEAD:${lockfile}`], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

const { entries: baseline, errors: baselineErrors } = validateBaseline(JSON.parse(readFileSync(path.join(root, BASELINE), "utf8")));
for (const error of baselineErrors) annotate("error", `${BASELINE}: ${error}`);

const today = new Date().toISOString().slice(0, 10);
let failed = baselineErrors.length > 0;
const summary: string[] = [];

for (const lockfile of LOCKFILES) {
  const dir = path.dirname(path.join(root, lockfile));
  if (!existsSync(path.join(root, lockfile))) {
    annotate("warning", `${lockfile} does not exist; drop it from LOCKFILES in scripts/security/dependency-audit.ts.`);
    continue;
  }
  let all: Advisory[];
  let prod: Advisory[];
  try {
    all = audit(dir, false);
    prod = audit(dir, true);
  } catch (error) {
    annotate("warning", `Could not audit ${lockfile}, so it was not checked this run: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }

  // Report first. Only an unbaselined gating finding needs the base branch to tell new from old.
  let result = evaluate({ lockfile, prod, all, baseline, today });
  if (baseRef !== undefined && result.warnings.length > 0) {
    let baseLock: string | null;
    try {
      baseLock = baseLockfile(lockfile);
    } catch (error) {
      // Without the base we cannot tell new from old, so every unbaselined finding counts as new.
      annotate("warning", `Could not fetch ${baseRef} to compare ${lockfile} against; treating its unbaselined findings as new: ${error instanceof Error ? error.message : String(error)}`);
      baseLock = null;
    }
    result = evaluate({ lockfile, prod, all, baseline, today, baseLock });
  }

  for (const message of result.errors) annotate("error", message);
  for (const message of result.warnings) annotate("warning", message);
  for (const message of result.notices) annotate("notice", message);
  if (result.errors.length > 0) failed = true;

  const counts = (list: Advisory[]): string => {
    const c = countBySeverity(list);
    return SEVERITIES.slice(1).toReversed().map(s => `${c[s]} ${s}`).join(", ");
  };
  summary.push(`${lockfile}: all dependencies ${counts(all)}; production ${counts(prod)}; ${result.errors.length} new gating, ${result.warnings.length} unbaselined pre-existing`);
}

console.log(`Dependency audit (${baseRef === undefined ? "report only" : `gating against ${baseRef}`}):`);
for (const line of summary) console.log(`  ${line}`);
if (failed) {
  console.log("Failed. See docs/educateos/security/dependency-scanning.md for how to triage.");
  process.exitCode = 1;
}
