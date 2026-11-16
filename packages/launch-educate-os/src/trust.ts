// What this installer trusts, fixed when the package is built.
import { ReleaseTrust } from "@educateos/releases";

/**
 * The EducateOS release keys every release is verified against before anything is installed: the
 * same public keys educateos.io's guided install pins (`RELEASE_TRUST` in
 * sites/educateos-io/wrangler.jsonc; a test fails if the two drift apart). Only public halves.
 * A release whose signed statement doesn't verify against these is refused, wherever it came from.
 */
export const EDUCATEOS_RELEASE_TRUST: ReleaseTrust = ReleaseTrust.parse({
  root: {
    threshold: 1,
    keys: [{ keyId: "ed25519-ZcqIp-xFaMyAdLm9A_VLfM9gzi-04hir2JmHXqornqc", publicKey: "mUuoDdWb6ERTjC_o3SI4hYf6pdb7tElPlkoVqPxx24k" }],
  },
  keySetVersion: 0,
  keys: [{ keyId: "ed25519-Y5ayv_OFgjE5j_YaqCuiuNvx-H7_d6AVfSjTnQlIc58", publicKey: "LVFy9O5qtmgvCGs0uhfjF9Q3aJZ4cQhrYYyouuF6YKg" }],
});

/** Where signed releases are published (the educateos.io site Worker's read-only `/releases/` mirror). */
export const DEFAULT_RELEASE_URL = "https://educateos.io/releases/";
