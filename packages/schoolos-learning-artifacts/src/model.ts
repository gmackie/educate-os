import { z } from "zod";
import {
  ArtifactId,
  ArtifactType,
  Classification,
  ContentDigest,
  DistrictId,
  PrincipalId,
  RequestChannel,
  RevisionId,
  Scope,
  SubmissionId,
  WorkspaceId,
} from "@schoolos/contracts";

/** A `type/subtype` media type, without parameters. */
export const MediaType = z.string().max(127).regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/);
/** A media type. */
export type MediaType = z.infer<typeof MediaType>;

/**
 * The media type of an external reference's canonical descriptor, which is what an
 * `external-ref` revision's digest and size cover.
 */
export const EXTERNAL_REFERENCE_MEDIA_TYPE: MediaType = "application/vnd.schoolos.external-ref+json";

/** Where a revision's content is: inline text, an R2 object, or a document SchoolOS does not hold. */
export const ContentBackendKind = z.enum(["text", "r2", "external"]);
/** A content backend kind. */
export type ContentBackendKind = z.infer<typeof ContentBackendKind>;

/** A pointer to content SchoolOS holds, addressed by its digest. */
export const HeldContentRef = z.strictObject({
  backend: z.enum(["text", "r2"]),
  /** The backend's key, derived from the digest. */
  key: z.string().min(1).max(256),
  /** The digest of the held bytes, checked on every read. */
  digest: ContentDigest,
});
/** A held content reference. */
export type HeldContentRef = z.infer<typeof HeldContentRef>;

/**
 * A pointer to an approved external document. SchoolOS never fetches it or treats it as content
 * it holds: `digest` covers the reference's canonical descriptor (the URL and the snapshot digest),
 * so a receipt commits to which reference, and which snapshot, was used.
 */
export const ExternalContentRef = z.strictObject({
  backend: z.literal("external"),
  /** The approved `https` URL. */
  key: z.url({ protocol: /^https$/ }).max(2048),
  /** The digest of the reference's canonical descriptor. */
  digest: ContentDigest,
  /** The digest of a snapshot of the external document, when one was taken. */
  snapshotDigest: ContentDigest.optional(),
});
/** An external content reference. */
export type ExternalContentRef = z.infer<typeof ExternalContentRef>;

/** Where one revision's content is. */
export const ContentRef = z.discriminatedUnion("backend", [HeldContentRef, ExternalContentRef]);
/** A content reference. */
export type ContentRef = z.infer<typeof ContentRef>;

/** Whether, and how, AI helped produce a revision. The author declares it; it is recorded verbatim. */
export const AiAssistance = z.discriminatedUnion("level", [
  z.strictObject({ level: z.literal("none") }),
  z.strictObject({ level: z.literal("assisted"), modelId: z.string().regex(/^[A-Za-z0-9_.:/@-]{1,200}$/) }),
  z.strictObject({ level: z.literal("generated"), modelId: z.string().regex(/^[A-Za-z0-9_.:/@-]{1,200}$/) }),
]);
/** AI-assistance metadata. */
export type AiAssistance = z.infer<typeof AiAssistance>;

/**
 * How a revision came to exist, recorded by the service from the request it handled, never taken
 * from the caller: `authored` text, `uploaded` bytes, an `external-reference`, or a sanitized
 * `baseline` copy.
 */
export const ProvenanceRecord = z.strictObject({
  origin: z.enum(["authored", "uploaded", "external-reference", "baseline"]),
  /** The surface the revision was saved through. */
  channel: RequestChannel,
});
/** A provenance record. */
export type ProvenanceRecord = z.infer<typeof ProvenanceRecord>;

/**
 * A learning artifact: the stable identity a student saves revisions under. Its classification and
 * scope come from the workspace it was created in and never change, so every decision about it is
 * made from this record rather than anything a caller says.
 */
export const Artifact = z.strictObject({
  id: ArtifactId,
  districtId: DistrictId,
  /** The workspace the artifact lives in. */
  workspaceId: WorkspaceId,
  /** The workspace's owner, who created the artifact. */
  ownerPrincipalId: PrincipalId,
  type: ArtifactType,
  title: z.string().trim().min(1).max(200),
  /** `personal-private` in a personal workspace, `course` in a course workspace. */
  classification: Classification,
  /** The policy scope: the district for a personal workspace, the offering for a course one. */
  scope: Scope,
  createdAt: z.iso.datetime(),
  /**
   * When its owner deleted it. A deleted artifact keeps only its pinned revisions, and is removed
   * altogether once none is left.
   */
  deletedAt: z.iso.datetime().optional(),
});
/** A learning artifact. */
export type Artifact = z.infer<typeof Artifact>;

/** One immutable revision of an artifact. Nothing ever changes a stored revision. */
export const ArtifactRevision = z.strictObject({
  id: RevisionId,
  artifactId: ArtifactId,
  /** 1 for the first revision, increasing by one with each save. */
  number: z.int().positive(),
  /** The revision this one was saved on top of. Absent for a first revision, including a baseline's. */
  parentRevisionId: RevisionId.optional(),
  /** Where the content is, and its digest. */
  content: ContentRef,
  /** The length of the canonical bytes the digest covers. */
  sizeBytes: z.int().nonnegative(),
  mediaType: MediaType,
  authorPrincipalId: PrincipalId,
  createdAt: z.iso.datetime(),
  aiAssistance: AiAssistance,
  provenance: ProvenanceRecord,
});
/** An artifact revision. */
export type ArtifactRevision = z.infer<typeof ArtifactRevision>;

/**
 * Who pinned a revision, which keeps it from ever being garbage-collected:
 * - `submission`: an E01 submission snapshot that captured the revision.
 * - `keep`: the pinning principal keeping that version, such as a teacher's chosen baseline source.
 */
export const PinConsumer = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("submission"), submissionId: SubmissionId }),
  z.strictObject({ kind: z.literal("keep") }),
]);
/** A pin consumer. */
export type PinConsumer = z.infer<typeof PinConsumer>;

/** That a consumer depends on a revision. */
export const Pin = z.strictObject({
  artifactId: ArtifactId,
  revisionId: RevisionId,
  consumer: PinConsumer,
  pinnedBy: PrincipalId,
  pinnedAt: z.iso.datetime(),
});
/** A pin. */
export type Pin = z.infer<typeof Pin>;

/**
 * A record that an artifact's owner shared it with another principal. It grants nothing on its
 * own: the policy information point reads it through `artifactShareRelationships`, and the engine
 * decides every read. Under the default rule table the grantee reads a shared `personal-private`
 * artifact only while the policy floor lets students share personal material, and under a
 * `private` floor the owner cannot share at all.
 */
export const ShareGrant = z.strictObject({
  artifactId: ArtifactId,
  granteePrincipalId: PrincipalId,
  grantedBy: PrincipalId,
  grantedAt: z.iso.datetime(),
});
/** A share grant. */
export type ShareGrant = z.infer<typeof ShareGrant>;

/** Everything the artifact service stores for one district, apart from content. */
export const ArtifactState = z.strictObject({
  artifacts: z.array(Artifact),
  /** Every stored revision, in the order they were saved. */
  revisions: z.array(ArtifactRevision),
  pins: z.array(Pin),
  shares: z.array(ShareGrant),
});
/** The artifact service's stored state. */
export type ArtifactState = z.infer<typeof ArtifactState>;
