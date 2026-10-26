// SCHO-232: archives, transfer files and revocation notices made before the EducateOS rename name
// their formats `schoolos.*`, and an archive's provenance names `@schoolos/portability` as its
// generator. Learners and destination districts may still hold them, so they are still read.
import { z } from "zod";

/**
 * The format `educateos.<name>`, also accepting the `schoolos.<name>` spelling of records made
 * before the rename. A parsed record keeps its spelling, so the bytes a signature or digest covers
 * are unchanged; this package writes only the new one.
 */
export function recordFormat<const Name extends string>(name: Name) {
  return z.enum([`educateos.${name}`, `schoolos.${name}`]);
}

/** The generator an archive's provenance names, under either spelling of this package's name. */
export const ArchiveGenerator = z.enum(["@educateos/portability", "@schoolos/portability"]);
