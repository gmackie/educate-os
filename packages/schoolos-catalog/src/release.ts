import { SchoolOsError } from "@schoolos/contracts";
import {
  caseAdapter,
  CaseClient,
  type CaseClientOptions,
  decodeCasePackage,
  FrameworkRelease,
  ImmutableRelease,
} from "@schoolos/registry";
import { z } from "zod";
import { CATALOG_RELEASED_AT, CATALOG_VERSION, catalogEntry } from "./catalog.ts";
import { contentDigest } from "./digest.ts";
import type { CatalogEntry } from "./entry.ts";
import { PLAYTREK_SEEDED_FRAMEWORKS, type PlayTrekSeededFramework, playTrekSeedRelease } from "./playtrek/mapping.ts";
import { CatalogKey } from "./vocabulary.ts";

/**
 * A release key's signature over a catalog release's statement (its framework key, version,
 * release time and content digest; see `signature.ts`). The digest binds the content, which the
 * mirror checks against it before it asks whether the signature is genuine. Only the shape is
 * checked here; the key ID and signature are judged by the verifier, which refuses any it cannot
 * match to a pinned key.
 */
export const CatalogReleaseSignature = z.strictObject({
  keyId: z.string().min(1).max(200),
  signature: z.string().min(1).max(200),
});
/** A catalog release signature. */
export type CatalogReleaseSignature = z.infer<typeof CatalogReleaseSignature>;

/**
 * One installable release of a framework's records: the catalog's own seed release, or content a
 * district imported from a CASE source. `contentDigest` is the digest of `content`'s canonical
 * JSON, so the mirror can tell whether the bytes it was given are the bytes that were released.
 */
export const CatalogRelease = z.strictObject({
  frameworkKey: CatalogKey,
  ...ImmutableRelease.shape,
  content: FrameworkRelease,
  /**
   * The root's signature, as the catalog publisher issued it. The catalog does not interpret it;
   * the mirror's `verifyRelease` hook does, normally `catalogReleaseVerifier` (roadmap R03).
   */
  signature: CatalogReleaseSignature.optional(),
});
/** A catalog release. */
export type CatalogRelease = z.infer<typeof CatalogRelease>;

function isSeeded(key: string): key is PlayTrekSeededFramework {
  return (PLAYTREK_SEEDED_FRAMEWORKS as readonly string[]).includes(key);
}

/**
 * The catalog's release of an `available` framework's seed records, at {@link CATALOG_VERSION}.
 * Deterministic: the same catalog version always yields the same digest.
 *
 * @throws SchoolOsError `not-found` if the framework is not in the catalog, or `conflict` if the
 *   catalog ships no items for it.
 */
export async function catalogSeedRelease(key: string): Promise<CatalogRelease> {
  const entry = catalogEntry(key);
  if (entry.status !== "available" || !isSeeded(key)) {
    throw new SchoolOsError("conflict", `the catalog ships no items for ${key}; import it from its source`);
  }
  const content = await playTrekSeedRelease(key, entry.framework);
  return {
    frameworkKey: entry.key,
    version: CATALOG_VERSION,
    releasedAt: CATALOG_RELEASED_AT,
    contentDigest: await contentDigest(content),
    content,
  };
}

/** What {@link importCaseRelease} needs besides the entry and source. */
export interface CaseImportOptions {
  /** Sends the CASE requests. */
  fetch: CaseClientOptions["fetch"];
  apiKey?: string;
  /** The district's version label for the imported release, such as `2026.10.0`. */
  version: string;
  /** The import time, recorded as the release time and each record's retrieval time. */
  importedAt: string;
}

/**
 * Imports a framework's content from one of its catalog entry's declared CASE sources, at install
 * time. This is how text the catalog cannot ship reaches a district.
 *
 * Records from the publisher's own server are `official`; records from a mirror are `derived`,
 * because the copy's fidelity to the publisher cannot be checked. A source that names an adapter
 * is read through it, and each record's provenance lists what the adapter changed.
 *
 * @throws SchoolOsError `not-found` if the source is not one the entry declares, and whatever the
 *   CASE client or decoder throws for an unreachable service or a package that is not CASE 1.1
 *   (after the source's adapter, if it names one).
 */
export async function importCaseRelease(
  entry: CatalogEntry,
  documentIdentifier: string,
  options: CaseImportOptions,
): Promise<CatalogRelease> {
  const source = entry.caseSources.find((s) => s.documentIdentifier === documentIdentifier);
  if (source === undefined) {
    throw new SchoolOsError("not-found", `${entry.key} declares no CASE source ${documentIdentifier}`);
  }
  const client = new CaseClient({
    baseUrl: source.serviceBaseUrl,
    fetch: options.fetch,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
  });
  const { value: pkg, adaptations } = source.adapter === undefined
    ? { value: await client.getPackage(source.documentIdentifier), adaptations: [] }
    : await client.getAdaptedPackage(caseAdapter(source.adapter), source.documentIdentifier);
  const content = decodeCasePackage(pkg, {
    source: source.host === "publisher" ? "official" : "derived",
    sourceUri: source.documentUri,
    retrievedAt: options.importedAt,
    sourceRevision: pkg.CFDocument.version ?? pkg.CFDocument.lastChangeDateTime,
  }, adaptations);
  const release = CatalogRelease.safeParse({
    frameworkKey: entry.key,
    version: options.version,
    releasedAt: options.importedAt,
    contentDigest: await contentDigest(content),
    content,
  });
  if (!release.success) throw new SchoolOsError("validation-failed", "the imported release is not valid");
  return release.data;
}
