import { z } from "zod";
import { PrincipalId } from "@schoolos/contracts";

/**
 * An absolute URI, kept exactly as published. Registry keys are URIs minted by publishers, so they
 * are compared as strings and never normalized: `URL` would lowercase hosts and resolve dot
 * segments, which turns one publisher's identifier into a different one.
 */
export const RegistryUri = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => !/\s/.test(value) && URL.canParse(value), "expected an absolute URI");
/** An absolute URI, compared verbatim. */
export type RegistryUri = z.infer<typeof RegistryUri>;

/** A date and time as published, with or without a UTC offset (CASE `DateTime`). */
export const RegistryDateTime = z.iso.datetime({ offset: true, local: true });
/** A published date and time. */
export type RegistryDateTime = z.infer<typeof RegistryDateTime>;

/** A calendar date (CASE `Date`). */
export const RegistryDate = z.iso.date();
/** A calendar date. */
export type RegistryDate = z.infer<typeof RegistryDate>;

/** A BCP 47 language tag such as `en` or `es-MX`. */
export const LanguageTag = z.string().regex(/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/, "expected a BCP 47 language tag");
/** A language tag. */
export type LanguageTag = z.infer<typeof LanguageTag>;

/** A JSON object whose contents the registry carries but does not interpret. */
export const OpaqueJsonObject = z.record(z.string(), z.json());
/** An opaque JSON object. */
export type OpaqueJsonObject = z.infer<typeof OpaqueJsonObject>;

/**
 * Where a record's content came from.
 *
 * - `official`: copied unchanged from the publisher, such as a CASE package fetched from the
 *   publisher's own server.
 * - `derived`: produced from other content by SchoolOS, a reviewer or a tool, such as a
 *   crosswalk or an AI-suggested alignment. Never presented as the publisher's own words.
 * - `district-authored`: written by the district for its own use.
 */
export const ProvenanceSource = z.enum(["official", "derived", "district-authored"]);
/** A provenance source. */
export type ProvenanceSource = z.infer<typeof ProvenanceSource>;

/**
 * What a named CASE adapter did to a field a publisher sent in a shape CASE 1.1 does not allow
 * (ADR-0011).
 *
 * - `string-to-list`: a single string where CASE 1.1 has a list; it became a one-element list.
 * - `null-omitted`: `null` for an optional field; it was treated as absent.
 * - `listing-wrapped`: a bare array of documents where CASE 1.1 has `{ "CFDocuments": [...] }`.
 * - `derived-education-level`: the publisher gave no `educationLevel`; SchoolOS derived one from
 *   the framework's own structure (such as the grade or course an item sits under).
 */
export const AdaptationChange = z.enum(["string-to-list", "null-omitted", "listing-wrapped", "derived-education-level"]);
/** An adaptation change. */
export type AdaptationChange = z.infer<typeof AdaptationChange>;

/** One deviation a named CASE adapter normalized in a record, kept on the record's provenance. */
export const ProvenanceAdaptation = z.strictObject({
  /** The adapter and its version, such as `tea-teks-api@1`. */
  adapter: z.string().regex(/^[a-z][a-z0-9-]{0,62}@[1-9]\d{0,3}$/, "expected <adapter>@<version>"),
  /** The CASE field the change applies to, such as `CFDocument.subject` or `educationLevel`. */
  field: z.string().min(1).max(200),
  change: AdaptationChange,
  /** What the change rests on, such as the course a derived education level came from. */
  detail: z.string().min(1).max(500).optional(),
});
/** A provenance adaptation. */
export type ProvenanceAdaptation = z.infer<typeof ProvenanceAdaptation>;

/**
 * Provenance every registry record carries, so official and derived content can always be told
 * apart, and a record can be traced back to the exact source revision it was taken from.
 */
export const Provenance = z.strictObject({
  source: ProvenanceSource,
  /** Where the content was taken from: the publisher's URI, or the record it was derived from. */
  sourceUri: RegistryUri,
  /** When SchoolOS retrieved or recorded the content. */
  retrievedAt: z.iso.datetime({ offset: true }),
  /** The source's own revision marker, such as a framework version or `lastChangeDateTime`. */
  sourceRevision: z.string().min(1).max(200),
  /**
   * Every field a named CASE adapter reshaped or supplied in this record. Absent when the record
   * decoded as the publisher sent it. An `official` record with adaptations has the publisher's
   * text and identity, but these fields are SchoolOS's reading of them.
   */
  adaptations: z.array(ProvenanceAdaptation).min(1).max(32).optional(),
});
/** A record's provenance. */
export type Provenance = z.infer<typeof Provenance>;

/** A person's recorded decision about a registry record. */
export const HumanReview = z.strictObject({
  reviewer: PrincipalId,
  reviewedAt: z.iso.datetime({ offset: true }),
});
/** A recorded human review. */
export type HumanReview = z.infer<typeof HumanReview>;

/**
 * A reference to another node by its title, identifier and URI: CASE's `LinkURI`. All three are
 * kept as published, including a title that differs from the target's own title.
 */
export const NodeLink = z.strictObject({
  title: z.string(),
  identifier: z.string().min(1).max(200),
  uri: RegistryUri,
});
/** A link to a node. */
export type NodeLink = z.infer<typeof NodeLink>;

/** A {@link NodeLink} that may also name the kind of node it points at: CASE's `LinkGenURI`. */
export const TypedNodeLink = z.strictObject({
  ...NodeLink.shape,
  targetType: z.string().min(1).max(200).optional(),
});
/** A typed link to a node. */
export type TypedNodeLink = z.infer<typeof TypedNodeLink>;

/**
 * A competency at a particular framework revision. Alignments and evidence contracts pin the
 * revision, so a later framework release cannot silently change what they mean.
 */
export const CompetencyRef = z.strictObject({
  competencyUri: RegistryUri,
  frameworkUri: RegistryUri,
  /** The framework revision, matching the framework's {@link Provenance.sourceRevision}. */
  frameworkRevision: z.string().min(1).max(200),
});
/** A versioned competency reference. */
export type CompetencyRef = z.infer<typeof CompetencyRef>;

/**
 * An immutable release of registry content. The digest names the exact released bytes, so a
 * release cannot be edited in place: changed content is a new release with a new digest.
 */
export const ImmutableRelease = z.strictObject({
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "expected a version such as 1.2.0"),
  releasedAt: z.iso.datetime({ offset: true }),
  contentDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/, "expected sha256:<64 lowercase hex digits>"),
});
/** An immutable release. */
export type ImmutableRelease = z.infer<typeof ImmutableRelease>;
