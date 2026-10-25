import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VARIANTS, buildExport } from "./fixtures/northfield-export.ts";

describe("fixture exports", () => {
  it.each(VARIANTS)("%s on disk matches its generator (run `pnpm fixtures:write` after editing it)", (variant) => {
    for (const [name, content] of Object.entries(buildExport(variant))) {
      expect(readFileSync(join(import.meta.dirname, "fixtures", variant, name), "utf8"), name).toBe(content);
    }
  });
});
