#!/usr/bin/env node

// Lays the district's three UIs out as the district Worker's static assets (DISTRICT_UI_DIR in
// production-config.ts), at deploy time, from their already-built `dist/` directories:
//
//   /         the student Learning Home (path-routed: the assets' single-page fallback is its)
//   /admin/   the admin console, built with SCHOOLOS_UI_BASE=/admin/
//   /teach/   Teacher Studio, built with SCHOOLOS_UI_BASE=/teach/
//
// The admin and teacher apps route by hash, so each needs only its own index.html under its
// prefix. Each build must have been made for its prefix: an app built for `/` would load its
// scripts from the student app's paths and fail in the browser, so that is refused here instead.
//
// Usage (from packages/schoolos-district-worker): node ../../scripts/production/assemble-district-ui.ts

import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PACKAGES_DIR } from "../preview/staging-config.ts";
import { DISTRICT_PACKAGE, DISTRICT_UI_DIR } from "./production-config.ts";

/** One UI and the path prefix it is served under. */
export interface DistrictUi {
  /** The UI's package directory name under packages/. */
  pkg: string;
  /** The prefix it is served under: `/`, or `/<name>/`. */
  base: string;
}

/** The district's UIs, student first: it is served at the root. */
export const DISTRICT_UIS: readonly DistrictUi[] = [
  { pkg: "schoolos-student-ui", base: "/" },
  { pkg: "schoolos-admin-ui", base: "/admin/" },
  { pkg: "schoolos-teacher-ui", base: "/teach/" },
];

/**
 * Copies each UI's `dist/` under `outDir` at its prefix, replacing what was there. Refuses a UI
 * that is not built, or not built for its prefix, and a student build whose own files would
 * collide with another UI's prefix.
 */
export function assembleDistrictUi(packagesDir: string, outDir: string, uis: readonly DistrictUi[] = DISTRICT_UIS): void {
  for (const { pkg, base } of uis) {
    const index = join(packagesDir, pkg, "dist", "index.html");
    if (!existsSync(index)) throw new Error(`${pkg} is not built: ${index} is missing`);
    if (!readFileSync(index, "utf8").includes(`src="${base}assets/`)) {
      throw new Error(`${pkg}/dist was not built for ${base} (set SCHOOLOS_UI_BASE=${base} when building it)`);
    }
    if (base === "/") {
      for (const other of uis) {
        if (other.base !== "/" && existsSync(join(packagesDir, pkg, "dist", other.base))) {
          throw new Error(`${pkg}/dist has its own ${other.base}, which ${other.pkg} is served at`);
        }
      }
    }
  }
  rmSync(outDir, { recursive: true, force: true });
  for (const { pkg, base } of uis) {
    cpSync(join(packagesDir, pkg, "dist"), join(outDir, base), { recursive: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outDir = join(PACKAGES_DIR, DISTRICT_PACKAGE, DISTRICT_UI_DIR);
  assembleDistrictUi(PACKAGES_DIR, outDir);
  console.log(`assembled ${DISTRICT_UIS.map(({ pkg, base }) => `${pkg} at ${base}`).join(", ")} into ${outDir}`);
}
