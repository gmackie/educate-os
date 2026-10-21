// Reads a fixture export from disk, as an upload would deliver it.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Variant } from "./northfield-export.ts";

/** Reads every file of a variant's export as bytes. */
export function loadExport(variant: Variant): Record<string, Uint8Array> {
  const dir = join(import.meta.dirname, variant);
  return Object.fromEntries(readdirSync(dir).map((name) => [name, new Uint8Array(readFileSync(join(dir, name)))]));
}
