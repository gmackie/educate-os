// SCHO-200: renames SchoolOS to EducateOS across the repository (ADR-0013). Rerunnable: run it again
// after rebasing onto a main that added new SchoolOS names, then regenerate the generated files.
//
//   node scripts/rename-educateos.ts paths     # git mv every path that names SchoolOS
//   node scripts/rename-educateos.ts contents  # rewrite every tracked text file
//
// Then: `pnpm install` (lockfile), `pnpm configs:generate`, `pnpm production:configs`,
// `pnpm types:generate`, and `UPDATE_GOLDEN=1 node --test scripts/release/manifest-lib.test.ts`.
//
// Nothing was live, so deployed identifiers (Worker names, Durable Object classes, bindings, env
// names, table names, wire formats) are renamed too, with no compatibility readers. What stays is
// listed in KEEP: names owned by something outside this repository.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Names that keep their SchoolOS spelling, and why. */
const KEEP = [
  // The production hostnames move with SCHO-192/SCHO-210, not here.
  "schoolos.gmac.io",
  "schoolos-gmac-io",
  "SCHOOLOS_GMAC_IO",
  // The production instance's existing R2 bucket.
  "schoolos-prod-blueprint-content",
  // Hall Monitor's product id and the issuer it trusts: its published contract enumerates them.
  "\"schoolos\"",
  // ForgeGraph app slugs, which cannot be changed (only an app's display name can), and the
  // repository, which ForgeGraph has no rename for: see SCHO-200's follow-ups.
  "app `schoolos-ai-guard`",
  "app `schoolos-district`",
  "app `schoolos-google`",
  "App `schoolos-district`",
  "App `schoolos-google`",
  // The runbook's secrets table, whose last column is the ForgeGraph app.
  "| `schoolos-ai-guard` |\n",
  "| `schoolos-district` |\n",
  "| `schoolos-google` |\n",
  "school-os",
  // The Google Cloud project that holds the connector's OAuth client.
  "gmacko-schoolos",
];

/** Rewrites, applied in order once the KEEP names are set aside. */
const RENAMES: [RegExp, string][] = [
  [/SchoolOS/g, "EducateOS"],
  [/SchoolOs/g, "EducateOs"],
  [/SCHOOLOS/g, "EDUCATEOS"],
  [/schoolos\.dev/g, "educateos.io"],
  [/schoolos/g, "educateos"],
];

/** Files left alone: the lockfile is regenerated, vendored sources are not ours. */
const SKIP = [/^pnpm-lock\.yaml$/, /^vendor\//, /^scripts\/rename-educateos\.ts$/];

/** Generated files, rewritten by their generators instead (see the header). */
const GENERATED = [/(^|\/)wrangler(\.production)?\.jsonc$/, /(^|\/)worker-configuration\.d\.ts$/];

/** The ADR that records the rename keeps its wording; only its links to moved docs follow. */
const LINKS_ONLY = [/^docs\/(schoolos|educateos)\/adr\/0013-/];

/** Apply the rename to one string. */
export function rename(text: string): string {
  let out = text;
  KEEP.forEach((name, i) => {
    out = out.replaceAll(name, `\uE000KEEP${i}\uE000`);
  });
  for (const [from, to] of RENAMES) out = out.replace(from, to);
  return out.replace(/\uE000KEEP(\d+)\uE000/g, (_, i: string) => KEEP[Number(i)]!);
}

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
}

function renamePaths(): void {
  for (const path of trackedFiles()) {
    if (SKIP.some((re) => re.test(path))) continue;
    const target = rename(path);
    if (target === path) continue;
    // `git mv` does not create parent directories.
    mkdirSync(dirname(join(ROOT, target)), { recursive: true });
    execFileSync("git", ["mv", path, target], { cwd: ROOT });
  }
}

function rewriteContents(): void {
  let changed = 0;
  for (const path of trackedFiles()) {
    if (SKIP.some((re) => re.test(path)) || GENERATED.some((re) => re.test(path))) continue;
    const file = join(ROOT, path);
    const bytes = readFileSync(file);
    if (bytes.includes(0)) continue; // binary
    const text = bytes.toString("utf8");
    const next = LINKS_ONLY.some((re) => re.test(path))
      ? text.replaceAll("docs/schoolos/", "docs/educateos/")
      : rename(text);
    if (next === text) continue;
    writeFileSync(file, next);
    changed++;
  }
  console.log(`rewrote ${changed} files`);
}

const mode = process.argv[2];
if (mode === "paths") renamePaths();
else if (mode === "contents") rewriteContents();
else if (mode !== undefined) throw new Error(`usage: rename-educateos.ts paths|contents (got ${mode})`);
