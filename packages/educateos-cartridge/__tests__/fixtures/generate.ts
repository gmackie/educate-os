// Regenerates the committed `.imscc` fixtures from the definitions in `../cartridges.ts`.
//
// Usage (authoring time only): node packages/educateos-cartridge/__tests__/fixtures/generate.ts
//
// The bytes are committed so the suite reads exactly what a teacher would upload; regenerating may
// change compressed bytes with the platform's zlib, which is harmless.
import { writeFileSync } from "node:fs";
import { doctypeXxe, fullCcWithUnsupported, pathTraversal, standardsThinCc, validThinCc, zipBomb } from "../cartridges.ts";
import { buildZip, type ZipEntrySpec } from "../zip-writer.ts";

/** Each fixture's file name and entries. */
const FIXTURES: Record<string, () => ZipEntrySpec[]> = {
  "thin-cc-valid.imscc": () => validThinCc(),
  "thin-cc-standards.imscc": standardsThinCc,
  "full-cc-unsupported.imscc": fullCcWithUnsupported,
  "path-traversal.imscc": pathTraversal,
  "doctype-xxe.imscc": doctypeXxe,
  // 128 MiB of zeros, honestly declared: about 128 KiB on disk.
  "zip-bomb.imscc": () => zipBomb(128),
  // The same zeros declared as 1000 bytes, so only counting the inflated output catches it.
  "zip-bomb-lying-header.imscc": () => zipBomb(128, 1000),
};

const directory = `${import.meta.dirname}/`;
for (const [name, entries] of Object.entries(FIXTURES)) {
  writeFileSync(`${directory}${name}`, await buildZip(entries()));
  console.log(`wrote ${name}`);
}
