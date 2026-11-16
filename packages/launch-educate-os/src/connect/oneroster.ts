// OneRoster 1.2 CSV: the district's roster from a bulk export (an SIS's, or ClassLink Roster
// Server's), through the district's own preview and apply (`POST /api/admin/roster/preview|apply`).
// The preview is a dry run: it shows every change and blocks on any error before anything is
// applied, and applying the same export again changes nothing.
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { EducateOsError } from "@educateos/contracts";
import { adminSession, askValue, type ConnectContext, describeAccessToken, printCheck } from "./district.ts";
import type { Check, ConnectOutcome } from "./outcome.ts";

const CSV_NAME = /^[A-Za-z]+\.csv$/;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** What the district's preview answers, in the parts this flow reports. */
export interface RosterPreview {
  canApply: boolean;
  issues: { severity?: string }[];
  integrity: unknown[];
  quarantined: unknown[];
  linked: unknown[];
  changes: Record<string, unknown>;
}

/** Reads a OneRoster CSV export directory: every `<Name>.csv`, as the district's import takes them. */
export async function readCsvExport(dir: string): Promise<Record<string, string>> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    throw new EducateOsError("not-found", `${dir} is not a readable directory`);
  }
  const files: Record<string, string> = {};
  for (const name of names.filter((n) => CSV_NAME.test(n)).toSorted()) {
    const path = join(dir, name);
    if ((await stat(path)).size > MAX_FILE_BYTES) throw new EducateOsError("validation-failed", `${name} is over 5 MiB, the district's limit per file`);
    files[name] = await readFile(path, "utf8");
  }
  if (!files["users.csv"] && !files["manifest.csv"]) {
    throw new EducateOsError("validation-failed", `${dir} has no OneRoster export (expected manifest.csv, users.csv, orgs.csv, classes.csv, enrollments.csv ...)`);
  }
  return files;
}

/** Counts each kind of change in a preview, as `{ kind: count }`. */
export function countChanges(changes: Record<string, unknown>): Record<string, number> {
  const counts: Record<string, number> = {};
  const add = (key: string, value: unknown) => {
    if (Array.isArray(value)) counts[key] = (counts[key] ?? 0) + value.length;
    else if (typeof value === "object" && value !== null) for (const [inner, v] of Object.entries(value)) add(`${key}.${inner}`, v);
  };
  for (const [key, value] of Object.entries(changes)) add(key, value);
  return Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0));
}

/** Previews a OneRoster CSV export against the district, and applies it if the administrator agrees. */
export async function connectOneRoster(context: ConnectContext): Promise<ConnectOutcome> {
  const { out, district } = context;
  const checks: Check[] = [];
  out.line("Before you start: a OneRoster 1.2 CSV export (bulk) from your SIS or ClassLink Roster Server, unzipped into a");
  out.line("directory, and a district administrator in EducateOS. The district's records must be owned by the roster");
  out.line("(DISTRICT_CONFIG.authority \"oneroster\", the default).");
  out.line();
  const dir = await askValue(context, context.flags.csvDir, "Directory holding the OneRoster CSV files");
  if (!dir) return { integration: "oneroster", status: "pending", checks, nextSteps: ["Re-run with --csv-dir <directory>."] };
  const files = await readCsvExport(resolve(dir));
  out.line(`Read ${Object.keys(files).length} file(s): ${Object.keys(files).join(", ")}.`);

  const admin = await adminSession(context);
  if (!admin) {
    describeAccessToken(out, district.origin);
    return { integration: "oneroster", status: "pending", checks, nextSteps: [`Upload the export in the district admin console (${district.origin}/admin), or re-run with an Access token.`] };
  }
  const preview = await admin.call<RosterPreview>("POST", "/api/admin/roster/preview", { files });
  const errors = preview.issues.filter((issue) => issue.severity === "error").length;
  const counts = countChanges(preview.changes ?? {});
  out.line();
  out.line("Preview (nothing applied):");
  for (const [kind, count] of Object.entries(counts)) out.line(`  ${kind.padEnd(28)} ${count}`);
  if (Object.keys(counts).length === 0) out.line("  no changes: the district already matches this export");
  out.line(`  issues ${preview.issues.length} (${errors} blocking), integrity problems ${preview.integrity.length}, users left out ${preview.quarantined.length}, linked by identity ${preview.linked.length}`);
  const check: Check = preview.canApply
    ? { name: "roster-preview", ok: true, detail: "the district accepts this export" }
    : { name: "roster-preview", ok: false, detail: "the export has blocking problems: fix them in the SIS export (the admin console's roster preview lists each one) and run again" };
  checks.push(check);
  printCheck(out, check);
  if (!check.ok) return { integration: "oneroster", status: "failed", checks, nextSteps: [check.detail] };
  if (Object.keys(counts).length === 0) return { integration: "oneroster", status: "connected", checks, nextSteps: ["Upload each new export the same way."] };

  const go = context.yes || (context.prompter !== undefined && await context.prompter.confirm("Apply this roster to the district now?", false));
  if (!go) {
    return { integration: "oneroster", status: "pending", checks, nextSteps: [`Apply it with --yes, or in the district admin console (${district.origin}/admin).`] };
  }
  const applied = await admin.call<{ applied: boolean; grantsRevoked?: number }>("POST", "/api/admin/roster/apply", { files });
  const done: Check = applied.applied
    ? { name: "roster-apply", ok: true, detail: `applied${applied.grantsRevoked ? `; ${applied.grantsRevoked} course grant(s) revoked from people the roster dropped` : ""}` }
    : { name: "roster-apply", ok: false, detail: "the district did not apply it (it changed since the preview): run again" };
  checks.push(done);
  printCheck(out, done);
  return {
    integration: "oneroster",
    status: done.ok ? "connected" : "failed",
    checks,
    nextSteps: done.ok
      ? ["Check that a teacher and a student can sign in and see their classes (people whose sign-in the district can't match are listed under identity requests in the admin console).", "Re-run with each new export: unchanged records stay as they are, and large removals are held for review."]
      : [done.detail],
  };
}
