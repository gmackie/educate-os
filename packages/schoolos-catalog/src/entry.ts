import { CaseAdapterName, FrameworkDefinition, RegistryDate, RegistryIdentifier, RegistryUri } from "@schoolos/registry";
import { z } from "zod";
import { CatalogKey, CatalogSubject, GRADE_BANDS, GradeBand } from "./vocabulary.ts";

/**
 * Whether this public repository may ship a framework's item text.
 *
 * - `permitted`: the publisher's terms clearly allow redistribution, so verified text may ship
 *   with the exact attribution the terms require.
 * - `not-permitted`: the terms do not clearly allow it. Only metadata and pointers ship; the text
 *   reaches a district when it imports from the publisher at install time.
 */
export const TextRedistribution = z.enum(["permitted", "not-permitted"]);
/** A text redistribution decision. */
export type TextRedistribution = z.infer<typeof TextRedistribution>;

/**
 * The terms a framework is published under and SchoolOS's decision about them.
 * `docs/schoolos/standards-licensing.md` records the reasoning and quotes for each decision.
 */
export const FrameworkLicense = z.strictObject({
  /** The terms' own name, such as `Common Core State Standards Public License`. */
  name: z.string().min(1).max(200),
  /** Where the terms were read. */
  termsUrl: RegistryUri,
  /** The notice to display wherever the framework's content is shown, exactly as required. */
  attribution: z.string().min(1).max(2000),
  textRedistribution: TextRedistribution,
  /** When SchoolOS last read the terms at `termsUrl`. */
  verifiedAt: RegistryDate,
});
/** A framework license and the decision about it. */
export type FrameworkLicense = z.infer<typeof FrameworkLicense>;

/**
 * A CASE service that publishes a framework, verified to answer for `documentIdentifier`.
 *
 * `host` says whose server it is. Content imported from the publisher's own server is `official`;
 * content from a mirror (such as OpenSALT hosting a copy) is `derived`, because SchoolOS cannot
 * tell whether the mirror's copy is unchanged.
 */
export const CaseSource = z.strictObject({
  title: z.string().min(1).max(500),
  /** The CASE service root to give a `CaseClient`, such as `https://opensalt.net/ims/case/v1p0`. */
  serviceBaseUrl: RegistryUri,
  documentIdentifier: RegistryIdentifier,
  /** The `CFDocument` URI as the service publishes it. */
  documentUri: RegistryUri,
  host: z.enum(["publisher", "mirror"]),
  /** When SchoolOS last fetched the document from `serviceBaseUrl`. */
  verifiedAt: RegistryDate,
  /**
   * The named adapter for this publisher's known deviations from CASE 1.1 (ADR-0011). Absent for
   * a source that serves strict CASE 1.1.
   */
  adapter: CaseAdapterName.optional(),
  /** What an install should expect, such as deviations from CASE 1.1. */
  notes: z.string().max(2000).optional(),
});
/** A verified CASE source. */
export type CaseSource = z.infer<typeof CaseSource>;

/**
 * What the catalog offers for one subject and grade band.
 *
 * - `items`: the catalog ships items, with their text.
 * - `items-without-text`: the catalog ships the items' codes, hierarchy and grade bands, but their
 *   text is withheld (by licensing, or because the transcription failed verification).
 * - `pointer`: the catalog ships no items here, but a declared source covers the band, so a
 *   district can import it.
 * - `gap`: nothing ships and no declared source covers the band.
 */
export const CoverageState = z.enum(["items", "items-without-text", "pointer", "gap"]);
/** A coverage state. */
export type CoverageState = z.infer<typeof CoverageState>;

/** The catalog's coverage for one subject and grade band of a framework. */
export const CoverageRow = z.strictObject({
  subject: CatalogSubject,
  band: GradeBand,
  state: CoverageState,
  note: z.string().max(1000).optional(),
});
/** A coverage row. */
export type CoverageRow = z.infer<typeof CoverageRow>;

/**
 * - `available`: the catalog ships a release of items for the framework.
 * - `pointer-only`: the catalog ships metadata and pointers only; a district imports the content.
 * - `gap`: the catalog can supply neither content nor a machine-readable source yet.
 */
export const CatalogStatus = z.enum(["available", "pointer-only", "gap"]);
/** A catalog status. */
export type CatalogStatus = z.infer<typeof CatalogStatus>;

/** Where an `available` entry's PlayTrek-derived items came from: a transcription SchoolOS did not author. */
export const SeedOrigin = z.strictObject({
  /** Who transcribed or authored the items. */
  transcriber: z.literal("PlayTrek"),
  /** The PlayTrek source path and commit the items were extracted from. */
  sourcePath: z.string().min(1).max(500),
  sourceCommit: z.string().regex(/^[0-9a-f]{7,40}$/),
});
/** A seed origin. */
export type SeedOrigin = z.infer<typeof SeedOrigin>;

/**
 * Where an `available` entry's publisher text came from: statements SchoolOS read from the
 * publisher's own pages or publication and checked against a second publisher source (SCHO-63).
 * SchoolOS transcribes; it never writes standards text.
 */
export const TranscriptionOrigin = z.strictObject({
  transcriber: z.literal("SchoolOS"),
  /** The publisher sources read, the first being the one the text is taken from. */
  sources: z.array(RegistryUri).min(1).max(10),
  /** The script that reads and checks them, so the data can be regenerated. */
  generator: z.string().regex(/^packages\/schoolos-catalog\/scripts\/[a-z0-9-]+\.ts$/),
  retrievedOn: RegistryDate,
});
/** A transcription origin. */
export type TranscriptionOrigin = z.infer<typeof TranscriptionOrigin>;

/**
 * One reviewed framework in the catalog.
 *
 * The framework definition is catalog metadata written by SchoolOS reviewers, so its provenance is
 * always `derived`; publisher text reaches a district only through a release.
 * Every declared subject has exactly one coverage row per grade band, so a band the catalog cannot
 * cover (high school, most often) is declared as such rather than left out.
 */
export const CatalogEntry = z
  .strictObject({
    key: CatalogKey,
    framework: FrameworkDefinition,
    status: CatalogStatus,
    license: FrameworkLicense,
    caseSources: z.array(CaseSource),
    subjects: z.array(CatalogSubject).min(1),
    coverage: z.array(CoverageRow),
    seed: SeedOrigin.optional(),
    transcription: TranscriptionOrigin.optional(),
  })
  .superRefine((entry, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    if (entry.framework.provenance.source !== "derived") {
      issue(["framework", "provenance", "source"], "catalog metadata is SchoolOS-authored and must be derived");
    }
    if ((entry.status === "available") !== (entry.seed !== undefined || entry.transcription !== undefined)) {
      issue(["seed"], "an available entry names where its items came from, and no other entry does");
    }
    if (entry.transcription !== undefined && entry.license.textRedistribution !== "permitted") {
      issue(["transcription"], "publisher text is transcribed only where the license permits redistribution");
    }
    const declared = new Set<string>();
    for (const [index, row] of entry.coverage.entries()) {
      const key = `${row.subject}/${row.band}`;
      if (declared.has(key)) issue(["coverage", index], `duplicate coverage row ${key}`);
      declared.add(key);
      if (!entry.subjects.includes(row.subject)) issue(["coverage", index, "subject"], `${row.subject} is not a declared subject`);
      const shipsItems = row.state === "items" || row.state === "items-without-text";
      if (shipsItems && entry.status !== "available") issue(["coverage", index, "state"], "only an available entry ships items");
      if (row.state === "items" && entry.license.textRedistribution !== "permitted") {
        issue(["coverage", index, "state"], "item text ships only where the license permits redistribution");
      }
      if (row.state === "pointer" && entry.caseSources.length === 0) {
        issue(["coverage", index, "state"], "a pointer needs a declared CASE source");
      }
    }
    for (const subject of entry.subjects) {
      for (const band of GRADE_BANDS) {
        if (!declared.has(`${subject}/${band}`)) issue(["coverage"], `no coverage row for ${subject}/${band}`);
      }
    }
  });
/** A catalog entry. */
export type CatalogEntry = z.infer<typeof CatalogEntry>;
