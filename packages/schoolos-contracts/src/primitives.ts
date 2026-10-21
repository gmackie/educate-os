import { z } from "zod";

/** A UTC timestamp with no offset (`2026-10-20T14:00:00Z`), as every SchoolOS record stores time. */
export const UtcTimestamp = z.iso.datetime();
/** A UTC timestamp string. */
export type UtcTimestamp = z.infer<typeof UtcTimestamp>;

/**
 * A short machine-readable code (`d1.unreachable`, `scheduled-maintenance`). Codes stand in for
 * free text in records that leave a district or are kept indefinitely, because free text is where
 * personal data would leak.
 */
export const OpaqueCode = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "expected an opaque code");
/** An opaque code. */
export type OpaqueCode = z.infer<typeof OpaqueCode>;

/**
 * The kebab-case name of an external system SchoolOS exchanges records with (`oneroster`,
 * `canvas`). It names the system in an {@link Authority}, a grade authority and a source link.
 */
export const ProviderName = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/, "expected a kebab-case provider name");
/** A provider name. */
export type ProviderName = z.infer<typeof ProviderName>;
