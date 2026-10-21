// Writes each variant of the synthetic Northfield export to `__tests__/fixtures/<variant>/`.
// Run with `pnpm fixtures:write`.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VARIANTS, buildExport } from "./northfield-export.ts";

for (const variant of VARIANTS) {
  const dir = join(import.meta.dirname, variant);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(buildExport(variant))) writeFileSync(join(dir, name), content);
}
