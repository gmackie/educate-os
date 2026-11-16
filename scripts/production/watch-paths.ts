#!/usr/bin/env node

// Generates deploy/watch-paths.json: for each ForgeGraph Worker target that sets
// `watchPathsFile: deploy/watch-paths.json`, every repository path its build reads (SCHO-316).
// ForgeGraph reads the file at the commit it is about to deploy and skips the push deploy of a
// target none of whose paths changed since its serving commit (FORGE-289), so the list must cover
// everything that can change the deployed Worker. When unsure, a path belongs in the list.
//
// A target's paths are:
//   - REPOSITORY_INPUTS, which every build reads (the lockfile, root configs, vendor/);
//   - every workspace package reachable from its roots, whole, through package.json dependencies
//     of any kind and relative imports (`../../packages/x`) in non-test sources;
//   - in `scripts/`, which is one grab-bag package of build tooling and operator CLIs, only the
//     files a build can load: its package.json, its exports, the files build commands and packages
//     name, and everything those import, followed file by file.
//
// The primary app educate-os is absent on purpose: Kanbanger closes an issue on a fresh healthy
// receipt from each of its targets, so they deploy on every push.
//
// Usage: node scripts/production/watch-paths.ts [--check]

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const WATCH_PATHS_FILE = "deploy/watch-paths.json";

/** Read by every build: dependency resolution, the shared toolchain configs, vendored code. */
export const REPOSITORY_INPUTS = [
  ".npmrc",
  "cloudflare.config.ts",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "vite.config.ts",
  "wrangler.jsonc",
  "vendor/",
];

const DISTRICT_UI = ["packages/educateos-student-ui", "packages/educateos-admin-ui", "packages/educateos-teacher-ui"];
const DISTRICT = {
  roots: ["packages/educateos-district-worker", ...DISTRICT_UI],
  scripts: ["scripts/production/stamp-commit.ts", "scripts/production/assemble-district-ui.ts"],
};
const STAMP = ["scripts/production/stamp-commit.ts"];

/** What one target's build reads: its packages, its build scripts, and repository data it renders. */
export interface WatchedTarget {
  roots: string[];
  scripts: string[];
  /** Repository paths outside the workspace its build reads, such as `curriculum/`. */
  inputs?: string[];
}

/**
 * ForgeGraph target name -> the workspace packages its build compiles (its appDir and every
 * package its buildCommand builds with `-F`), the scripts its buildCommand runs, and any data
 * outside the workspace it reads. Keep in step with the target specs in
 * docs/educateos/runbooks/production-instance.md.
 */
export const WATCHED_TARGETS: Record<string, WatchedTarget> = {
  "schoolos-district-worker": DISTRICT,
  "educateos-prairie-district": DISTRICT,
  "educateos-riverbend-district": DISTRICT,
  "educateos-cedarvalley-district": DISTRICT,
  "educateos-lakeshore-district": DISTRICT,
  "educateos-harbor-district": DISTRICT,
  "schoolos-ai-guard": { roots: ["packages/educateos-ai-guard"], scripts: STAMP },
  "gatekeeper-google": { roots: ["packages/gatekeeper-google"], scripts: STAMP },
  "gatekeeper-clever": { roots: ["packages/gatekeeper-clever"], scripts: STAMP },
  "gatekeeper-schoolos": { roots: ["packages/gatekeeper-educateos"], scripts: STAMP },
  "educateos-admin": { roots: ["packages/educateos-admin"], scripts: STAMP },
  "educateos-demo-fakes": { roots: ["sites/educateos-demo-fakes"], scripts: STAMP },
  // build.mjs renders the course catalog from curriculum/ (SCHO-333): a merged course must deploy.
  "educateos-site": { roots: ["sites/educateos-io", "packages/educateos-demo"], scripts: STAMP, inputs: ["curriculum/"] },
};

const SOURCE = /\.(?:[cm]?[jt]sx?|jsonc?)$/;
/** Never part of a build: tests, fixtures, test configs. */
const TEST_ONLY = /(?:\.test\.|\.spec\.|(?:^|\/)(?:__tests__|tests?|fixtures?|testdata)\/|vitest[^/]*\.config\.)/;
const PACKAGE_REF = /(?:\.\.\/|['"`])((?:packages|sites)\/[A-Za-z0-9._-]+)/g;
const SCRIPT_REF = /(?:\.\.\/)+scripts\/([A-Za-z0-9._/-]+\.[cm]?[jt]s)/g;
const IMPORT = /(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;

interface Workspace {
  /** Tracked files under each workspace package directory. */
  files: Map<string, string[]>;
  /** Package name -> directory. */
  dirs: Map<string, string>;
  manifests: Map<string, Record<string, unknown>>;
  read(path: string): string;
}

export function loadWorkspace(root = ROOT): Workspace {
  const tracked = execFileSync("git", ["ls-files", "packages", "sites", "scripts"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const files = new Map<string, string[]>();
  for (const file of tracked) {
    const parts = file.split("/");
    const dir = parts[0] === "scripts" ? "scripts" : parts.slice(0, 2).join("/");
    files.set(dir, [...(files.get(dir) ?? []), file]);
  }
  const dirs = new Map<string, string>();
  const manifests = new Map<string, Record<string, unknown>>();
  for (const dir of files.keys()) {
    const manifest = join(root, dir, "package.json");
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
    manifests.set(dir, pkg);
    if (typeof pkg.name === "string") dirs.set(pkg.name, dir);
  }
  return { files, dirs, manifests, read: (path) => readFileSync(join(root, path), "utf8") };
}

const dependencyNames = (pkg: Record<string, unknown> | undefined) =>
  ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((field) =>
    Object.keys((pkg?.[field] as Record<string, string> | undefined) ?? {}),
  );

/** Files a build can load, as repository paths: non-test sources plus the manifest. */
const buildFiles = (ws: Workspace, dir: string) =>
  (ws.files.get(dir) ?? []).filter((file) => (SOURCE.test(file) && !TEST_ONLY.test(file)) || file.endsWith("package.json"));

/** The paths one target watches, sorted. */
export function watchPaths(ws: Workspace, target: WatchedTarget): string[] {
  const packages = new Set<string>();
  const scriptFiles = new Set<string>();
  const pendingPackages = [...target.roots];
  const pendingScripts = [...target.scripts, "scripts/package.json"];

  const exportsOf = (subpath: string) => {
    const exports = ws.manifests.get("scripts")?.exports as Record<string, unknown> | undefined;
    const entry = exports?.[subpath === "" ? "." : `./${subpath}`];
    const file = typeof entry === "string" ? entry : (entry as { import?: string } | undefined)?.import;
    return file ? normalize(join("scripts", file)) : null;
  };
  const bins = Object.entries((ws.manifests.get("scripts")?.bin as Record<string, string> | undefined) ?? {});
  // A file's references to other workspace code: packages to take whole, scripts to follow.
  const scan = (file: string) => {
    const text = ws.read(file);
    for (const [name, path] of bins) if (new RegExp(`(?:^|[\\s"'])${name}(?:$|[\\s"'])`).test(text)) pendingScripts.push(normalize(join("scripts", path)));
    for (const [, dir] of text.matchAll(PACKAGE_REF)) if (dir && ws.files.has(dir)) pendingPackages.push(dir);
    for (const [, path] of text.matchAll(SCRIPT_REF)) if (path) pendingScripts.push(`scripts/${path}`);
    for (const [, specifier] of text.matchAll(IMPORT)) {
      if (!specifier) continue;
      if (specifier.startsWith("@gadgets/scripts")) {
        const exported = exportsOf(specifier.slice("@gadgets/scripts".length).replace(/^\//, ""));
        if (exported) pendingScripts.push(exported);
      } else if (specifier.startsWith(".")) {
        const resolved = normalize(join(dirname(file), specifier));
        if (resolved.startsWith("scripts/")) pendingScripts.push(resolved);
      } else {
        const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
        const dir = name ? ws.dirs.get(name) : undefined;
        if (dir && dir !== "scripts") pendingPackages.push(dir);
      }
    }
  };

  while (pendingPackages.length > 0 || pendingScripts.length > 0) {
    const dir = pendingPackages.pop();
    if (dir !== undefined) {
      if (packages.has(dir) || dir === "scripts") continue;
      if (!ws.files.has(dir)) throw new Error(`${dir} is not a workspace directory`);
      packages.add(dir);
      for (const name of dependencyNames(ws.manifests.get(dir))) {
        const dep = ws.dirs.get(name);
        if (dep && dep !== "scripts") pendingPackages.push(dep);
      }
      buildFiles(ws, dir).forEach(scan);
      continue;
    }
    const file = scriptsFile(ws, pendingScripts.pop()!);
    if (!file || scriptFiles.has(file)) continue;
    scriptFiles.add(file);
    if (!TEST_ONLY.test(file)) scan(file);
  }
  return [...REPOSITORY_INPUTS, ...(target.inputs ?? []), ...[...packages].map((dir) => `${dir}/`), ...scriptFiles].toSorted();
}

/** The tracked scripts file a reference names, trying TypeScript extensions; null if none. */
function scriptsFile(ws: Workspace, path: string): string | null {
  const tracked = ws.files.get("scripts") ?? [];
  const base = path.replace(/\.js$/, "");
  return [path, `${base}.ts`, `${base}.mts`, `${base}/index.ts`].find((candidate) => tracked.includes(candidate)) ?? null;
}

export function renderWatchPaths(ws: Workspace = loadWorkspace()): string {
  const out: Record<string, string[]> = {};
  for (const name of Object.keys(WATCHED_TARGETS).toSorted()) out[name] = watchPaths(ws, WATCHED_TARGETS[name]!);
  return `${JSON.stringify(out, null, 2)}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const path = join(ROOT, WATCH_PATHS_FILE);
  const expected = renderWatchPaths();
  if (process.argv.includes("--check")) {
    const actual = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (actual !== expected) {
      console.error(`${relative(process.cwd(), path)} is stale: run \`pnpm production:watch-paths\` and commit it.`);
      process.exit(1);
    }
  } else {
    writeFileSync(path, expected);
  }
}
