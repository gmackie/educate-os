import { z } from "zod";
import { ArtifactId, Classification, ContentDigest, OfferingId, PrincipalId, RevisionId, Scope, SubmissionId } from "@schoolos/contracts";
import { MediaType } from "@schoolos/learning-artifacts";
import { SourceRights } from "./archive.ts";

/**
 * The district records an export reads besides artifacts. Submissions and feedback belong to E01
 * and resources to the Learning Registry, neither of which this package depends on, so they reach
 * the exporter through {@link StudentRecordSource}. These shapes may belong in those packages, or
 * in `@schoolos/contracts`, once they exist.
 *
 * The exporter trusts none of them for authorization: it re-checks ownership, derives scope and
 * term state from the academic directory, and asks the policy engine about every record.
 */

/** A revision captured by a submission. */
export const SubmittedRevision = z.strictObject({
  artifactId: ArtifactId,
  revisionId: RevisionId,
  digest: ContentDigest,
});
/** A submitted revision. */
export type SubmittedRevision = z.infer<typeof SubmittedRevision>;

/** A learner's submission, as E01 stores it. */
export const SubmissionSourceRecord = z.strictObject({
  id: SubmissionId,
  ownerPrincipalId: PrincipalId,
  offeringId: OfferingId,
  activityTitle: z.string().min(1).max(200),
  submittedAt: z.iso.datetime(),
  revisions: z.array(SubmittedRevision).max(100),
});
/** A submission source record. */
export type SubmissionSourceRecord = z.infer<typeof SubmissionSourceRecord>;

/**
 * Feedback on a learner's work. Only `shared-with-learner` feedback is ever exported; a
 * `teacher-only` note is the teacher's, even though it is about the learner.
 */
export const FeedbackSourceRecord = z.strictObject({
  id: z.string().min(1).max(128),
  /** The learner the feedback is about. */
  subjectPrincipalId: PrincipalId,
  offeringId: OfferingId,
  submissionId: SubmissionId.optional(),
  authorPrincipalId: PrincipalId,
  visibility: z.enum(["shared-with-learner", "teacher-only"]),
  createdAt: z.iso.datetime(),
  body: z.string().min(1).max(100_000),
});
/** A feedback source record. */
export type FeedbackSourceRecord = z.infer<typeof FeedbackSourceRecord>;

/** A learning resource the learner's work cites, with the rights it was approved under (roadmap §5.3). */
export const ResourceSourceRecord = z.strictObject({
  id: z.string().min(1).max(128),
  title: z.string().min(1).max(200),
  scope: Scope,
  classification: Classification,
  rights: SourceRights,
  /** The resource's canonical `https` location, if it has one. */
  url: z.url({ protocol: /^https$/ }).max(2048).optional(),
  /** The media type of the copy the district holds, if it holds one. */
  contentMediaType: MediaType.optional(),
});
/** A resource source record. */
export type ResourceSourceRecord = z.infer<typeof ResourceSourceRecord>;

/** Where the exporter reads a learner's submissions, feedback and cited resources. */
export interface StudentRecordSource {
  /** The learner's submissions. */
  submissions(principalId: PrincipalId): Promise<SubmissionSourceRecord[]>;
  /** The feedback about the learner's work, of every visibility. */
  feedback(principalId: PrincipalId): Promise<FeedbackSourceRecord[]>;
  /** The resources the learner's work cites. */
  resources(principalId: PrincipalId): Promise<ResourceSourceRecord[]>;
  /** The bytes of the district's copy of a resource. Only called when the copy may be exported. */
  resourceContent(resourceId: string): Promise<Uint8Array<ArrayBuffer>>;
}

/** A {@link StudentRecordSource} held in memory, for tests and the local harness. */
export class InMemoryStudentRecordSource implements StudentRecordSource {
  readonly #submissions: SubmissionSourceRecord[] = [];
  readonly #feedback: FeedbackSourceRecord[] = [];
  readonly #resources: { record: ResourceSourceRecord; citedBy: PrincipalId[]; content?: Uint8Array<ArrayBuffer> }[] = [];

  /** Adds a submission. */
  addSubmission(record: SubmissionSourceRecord): void {
    this.#submissions.push(SubmissionSourceRecord.parse(record));
  }

  /** Adds feedback. */
  addFeedback(record: FeedbackSourceRecord): void {
    this.#feedback.push(FeedbackSourceRecord.parse(record));
  }

  /** Adds a resource cited by `citedBy`, with the district's copy if it holds one. */
  addResource(record: ResourceSourceRecord, citedBy: PrincipalId[], content?: Uint8Array<ArrayBuffer>): void {
    this.#resources.push({ record: ResourceSourceRecord.parse(record), citedBy, ...(content === undefined ? {} : { content }) });
  }

  async submissions(principalId: PrincipalId): Promise<SubmissionSourceRecord[]> {
    return structuredClone(this.#submissions.filter((s) => s.ownerPrincipalId === principalId));
  }

  async feedback(principalId: PrincipalId): Promise<FeedbackSourceRecord[]> {
    return structuredClone(this.#feedback.filter((f) => f.subjectPrincipalId === principalId));
  }

  async resources(principalId: PrincipalId): Promise<ResourceSourceRecord[]> {
    return structuredClone(this.#resources.filter((r) => r.citedBy.includes(principalId)).map((r) => r.record));
  }

  async resourceContent(resourceId: string): Promise<Uint8Array<ArrayBuffer>> {
    const content = this.#resources.find((r) => r.record.id === resourceId)?.content;
    if (content === undefined) throw new Error(`resource ${resourceId} has no held copy`);
    return content.slice();
  }
}
