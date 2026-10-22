import { z } from "zod";
import {
  ActivityId,
  ArtifactId,
  ArtifactType,
  ContentDigest,
  DistrictId,
  OfferingId,
  PrincipalId,
  RequestChannel,
  RevisionId,
  RubricId,
  SubmissionId,
} from "@schoolos/contracts";
import { AiAssistance, ContentRef, MediaType } from "@schoolos/learning-artifacts";

const idBody = "[a-z0-9][a-z0-9-]{0,62}";

/**
 * Identifies an assignment: one activity bound to one offering. It may belong in
 * `@schoolos/contracts` once a second package (I02's passback) refers to assignments.
 */
export const AssignmentId = z.string().regex(new RegExp(`^asg_${idBody}$`), "expected an assignment ID (asg_…)").brand<"assignment">();
/** An assignment identifier. */
export type AssignmentId = z.infer<typeof AssignmentId>;

/** Identifies one feedback comment. */
export const FeedbackCommentId = z.string().regex(new RegExp(`^fbc_${idBody}$`), "expected a feedback comment ID (fbc_…)").brand<"feedback-comment">();
/** A feedback comment identifier. */
export type FeedbackCommentId = z.infer<typeof FeedbackCommentId>;

/** Identifies one official-grade proposal waiting for a teacher. */
export const GradeProposalId = z.string().regex(new RegExp(`^gpr_${idBody}$`), "expected a grade proposal ID (gpr_…)").brand<"grade-proposal">();
/** A grade proposal identifier. */
export type GradeProposalId = z.infer<typeof GradeProposalId>;

/**
 * One release of a rubric (roadmap §7). A rubric release never changes, so naming its version
 * names exactly the criteria a submission is assessed against.
 */
export const RubricReleaseRef = z.strictObject({
  rubricId: RubricId,
  version: z.int().positive(),
});
/** A rubric release reference. */
export type RubricReleaseRef = z.infer<typeof RubricReleaseRef>;

/**
 * What happens to work submitted after the due date:
 * - `refuse`: nothing is accepted after it.
 * - `accept`: it is accepted and flagged late, until `closesAt` if one is set.
 */
export const LatePolicy = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("refuse") }),
  z.strictObject({ kind: z.literal("accept"), closesAt: z.iso.datetime().optional() }),
]);
/** A late policy. */
export type LatePolicy = z.infer<typeof LatePolicy>;

/**
 * When a student sees teacher feedback on their submission: once it is `shared-with-student`
 * (or final), or only once it is `final`. Suggested scores and comments are never shown to the
 * student, whatever this says; a teacher adopts one by entering it as their own.
 */
export const FeedbackVisibility = z.enum(["when-shared", "when-final"]);
/** A feedback visibility setting. */
export type FeedbackVisibility = z.infer<typeof FeedbackVisibility>;

/** The settings a teacher chooses for an assignment, and may change while it is open. */
const assignmentSettings = {
  title: z.string().trim().min(1).max(200),
  dueAt: z.iso.datetime(),
  latePolicy: LatePolicy,
  /** How many live (not withdrawn) submissions a student may make. */
  attemptsAllowed: z.int().min(1).max(100),
  /** The artifact types a submission may contain. */
  permittedArtifactTypes: z.array(ArtifactType).min(1).refine((types) => new Set(types).size === types.length, "artifact types must be unique"),
  /** The rubric release submissions are assessed against. Locked once any submission exists. */
  rubric: RubricReleaseRef.optional(),
  feedbackVisibility: FeedbackVisibility,
};

/**
 * An activity bound to an offering as an assignment. `activityId` is opaque here: the activity's
 * definition belongs to the curriculum service (C05). Its offering's teachers create and change
 * it; the offering's enrolled students see it.
 */
export const AssignmentBinding = z.strictObject({
  id: AssignmentId,
  districtId: DistrictId,
  offeringId: OfferingId,
  activityId: ActivityId,
  ...assignmentSettings,
  createdBy: PrincipalId,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).refine(
  (a) => a.latePolicy.kind !== "accept" || a.latePolicy.closesAt === undefined || a.latePolicy.closesAt > a.dueAt,
  "a late policy closes after the due date",
);
/** An assignment binding. */
export type AssignmentBinding = z.infer<typeof AssignmentBinding>;

/** What creating an assignment takes. */
export const NewAssignment = z.strictObject({
  offeringId: OfferingId,
  activityId: ActivityId,
  ...assignmentSettings,
});
/** A new assignment. */
export type NewAssignment = z.infer<typeof NewAssignment>;

/** A change to an assignment's settings. An omitted field is unchanged; `rubric: null` removes the rubric. */
export const AssignmentPatch = z.strictObject({
  title: assignmentSettings.title.optional(),
  dueAt: assignmentSettings.dueAt.optional(),
  latePolicy: assignmentSettings.latePolicy.optional(),
  attemptsAllowed: assignmentSettings.attemptsAllowed.optional(),
  permittedArtifactTypes: assignmentSettings.permittedArtifactTypes.optional(),
  rubric: RubricReleaseRef.nullable().optional(),
  feedbackVisibility: assignmentSettings.feedbackVisibility.optional(),
});
/** An assignment patch. */
export type AssignmentPatch = z.infer<typeof AssignmentPatch>;

/**
 * Starter material a teacher published to an assignment: a sanitized class baseline. It is an
 * unowned `course` artifact at the offering, so the offering's enrolled students may read it
 * (policy rules `course.instructor.baseline` and `course.student.baseline-read`). It holds only the
 * chosen revision's content reference, never the source artifact, its other revisions or its
 * author's workspace, so material removed from the source before publishing is unreachable.
 */
export const StarterMaterial = z.strictObject({
  id: ArtifactId,
  assignmentId: AssignmentId,
  title: z.string().trim().min(1).max(200),
  type: ArtifactType,
  mediaType: MediaType,
  sizeBytes: z.int().nonnegative(),
  /** The content, addressed and verified by its digest. */
  content: ContentRef,
  aiAssistance: AiAssistance,
  publishedBy: PrincipalId,
  publishedAt: z.iso.datetime(),
});
/** Starter material. */
export type StarterMaterial = z.infer<typeof StarterMaterial>;

/** One revision captured by a submission, with the metadata carried from it. */
export const SubmissionItem = z.strictObject({
  artifactId: ArtifactId,
  revisionId: RevisionId,
  /** The revision's content digest. */
  digest: ContentDigest,
  artifactType: ArtifactType,
  mediaType: MediaType,
  sizeBytes: z.int().nonnegative(),
  /** The AI-assistance the author declared on the revision, carried verbatim. */
  aiAssistance: AiAssistance,
});
/** A submission item. */
export type SubmissionItem = z.infer<typeof SubmissionItem>;

/** Whether work arrived by its due date. */
export const SubmissionTiming = z.enum(["on-time", "late"]);
/** A submission timing. */
export type SubmissionTiming = z.infer<typeof SubmissionTiming>;

/**
 * Immutable work at one attempt (roadmap §6.1). Every revision it names is pinned with consumer
 * `submission`, so later edits to the artifacts, or deleting them, never change what it holds.
 * Nothing about it changes after it is stored except `withdrawnAt`, which marks it withdrawn and
 * deletes nothing.
 */
export const SubmissionSnapshot = z.strictObject({
  id: SubmissionId,
  districtId: DistrictId,
  assignmentId: AssignmentId,
  offeringId: OfferingId,
  studentPrincipalId: PrincipalId,
  /** 1 for a student's first submission to the assignment, increasing by one with each. */
  attempt: z.int().positive(),
  /** In canonical order: by artifact ID. */
  items: z.array(SubmissionItem).min(1),
  /** See `submissionDigest`. */
  submissionDigest: ContentDigest,
  /** The rubric release in force when it was submitted, which the rubric lock keeps in force. */
  rubric: RubricReleaseRef.optional(),
  submittedAt: z.iso.datetime(),
  timing: SubmissionTiming,
  channel: RequestChannel,
  withdrawnAt: z.iso.datetime().optional(),
});
/** A submission snapshot. */
export type SubmissionSnapshot = z.infer<typeof SubmissionSnapshot>;

/**
 * What a student gets back for a submission. It commits to `submissionDigest`, so anyone holding
 * the receipt and the pinned revisions can recompute the digest and check that the receipt covers
 * exactly that work. A retried submission returns the same receipt.
 */
export const SubmissionReceipt = z.strictObject({
  format: z.literal("schoolos.submission-receipt.v1"),
  submissionId: SubmissionId,
  assignmentId: AssignmentId,
  studentPrincipalId: PrincipalId,
  attempt: z.int().positive(),
  submittedAt: z.iso.datetime(),
  timing: SubmissionTiming,
  items: z.array(z.strictObject({ artifactId: ArtifactId, revisionId: RevisionId, digest: ContentDigest })),
  submissionDigest: ContentDigest,
});
/** A submission receipt. */
export type SubmissionReceipt = z.infer<typeof SubmissionReceipt>;

/**
 * Where a comment points, in one revision the submission captured:
 * - `text-range`: `[start, end)` in UTF-16 code units of the revision's canonical text.
 * - `area`: a rectangle in fractions of the page or image, on `page` for a paged document.
 */
export const AnchorRegion = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("text-range"), start: z.int().nonnegative(), end: z.int().positive() }).refine((r) => r.start < r.end, "a range ends after it starts"),
  z.strictObject({
    kind: z.literal("area"),
    page: z.int().positive().optional(),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  }).refine((r) => r.x + r.width <= 1 && r.y + r.height <= 1, "an area stays inside the page"),
]);
/** An anchor region. */
export type AnchorRegion = z.infer<typeof AnchorRegion>;

/** A feedback anchor (roadmap §6.2): a revision of the submitted work and a place in it. */
export const FeedbackAnchor = z.strictObject({
  artifactId: ArtifactId,
  revisionId: RevisionId,
  region: AnchorRegion,
});
/** A feedback anchor. */
export type FeedbackAnchor = z.infer<typeof FeedbackAnchor>;

/**
 * What suggested a score or comment: an AI model or a deterministic evaluator release (E02). An
 * evaluator is named `<evaluator>@<release>`, where the release is a semantic version such as
 * `citation.format@1.2.0` (or, from before E02, a bare major version).
 */
export const Suggester = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ai"), modelId: z.string().regex(/^[A-Za-z0-9_.:/@-]{1,200}$/) }),
  z.strictObject({
    kind: z.literal("evaluator"),
    evaluatorId: z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*@[0-9]+(\.[0-9]+\.[0-9]+)?$/, "expected <evaluator>@<release>"),
  }),
]);
/** A suggester. */
export type Suggester = z.infer<typeof Suggester>;

/**
 * Who a score or comment comes from. `teacher` is the teacher's own judgement, entered through the
 * SchoolOS UI or API; `suggested` is always labelled with what suggested it and is never shown to
 * the student or made official without a teacher acting on it.
 */
export const FeedbackSource = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("teacher") }),
  z.strictObject({ kind: z.literal("suggested"), suggester: Suggester }),
]);
/** A feedback source. */
export type FeedbackSource = z.infer<typeof FeedbackSource>;

/** A comment on a submission, anchored to a place in it or, without an anchor, on the whole. */
export const FeedbackComment = z.strictObject({
  id: FeedbackCommentId,
  anchor: FeedbackAnchor.optional(),
  body: z.string().trim().min(1).max(5000),
  source: FeedbackSource,
  enteredBy: PrincipalId,
  enteredAt: z.iso.datetime(),
});
/** A feedback comment. */
export type FeedbackComment = z.infer<typeof FeedbackComment>;

/** A rubric criterion's identifier within its rubric release. */
export const CriterionId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "expected a criterion ID");
/** A criterion identifier. */
export type CriterionId = z.infer<typeof CriterionId>;

/** A score for one rubric criterion. */
export const CriterionScore = z.strictObject({
  criterionId: CriterionId,
  points: z.number().nonnegative().max(1000),
  maxPoints: z.number().positive().max(1000).optional(),
  source: FeedbackSource,
  enteredBy: PrincipalId,
  enteredAt: z.iso.datetime(),
}).refine((s) => s.maxPoints === undefined || s.points <= s.maxPoints, "points cannot exceed the maximum");
/** A criterion score. */
export type CriterionScore = z.infer<typeof CriterionScore>;

/**
 * Where a submission's feedback is: a teacher's `draft`, `shared-with-student`, or `final`. It only
 * moves forward, and a final result never changes.
 */
export const FeedbackState = z.enum(["draft", "shared-with-student", "final"]);
/** A feedback state. */
export type FeedbackState = z.infer<typeof FeedbackState>;

/** The feedback on one submission. */
export const FeedbackRecord = z.strictObject({
  submissionId: SubmissionId,
  state: FeedbackState,
  comments: z.array(FeedbackComment),
  /** At most one teacher score per criterion, and one suggestion per criterion and suggester. */
  scores: z.array(CriterionScore),
  updatedAt: z.iso.datetime(),
});
/** A feedback record. */
export type FeedbackRecord = z.infer<typeof FeedbackRecord>;

/** An official score. */
export const GradeScore = z.strictObject({
  points: z.number().nonnegative().max(100000),
  maxPoints: z.number().positive().max(100000),
}).refine((s) => s.points <= s.maxPoints, "points cannot exceed the maximum");
/** A grade score. */
export type GradeScore = z.infer<typeof GradeScore>;

/** A teacher's refusal of a grade proposal, with their reason. */
export const GradeProposalDecline = z.strictObject({
  declinedBy: PrincipalId,
  declinedAt: z.iso.datetime(),
  reason: z.string().trim().min(1).max(1000),
});
/** A grade proposal decline. */
export type GradeProposalDecline = z.infer<typeof GradeProposalDecline>;

/**
 * Why a proposal stopped waiting without a teacher deciding it:
 * - `submission-withdrawn`: its student withdrew the work it grades.
 * - `superseded`: a teacher approved a newer official grade version for the same assignment and
 *   student, which `supersededBy` names, so approving the proposal would overwrite it.
 */
export const GradeProposalExpiry = z.strictObject({
  expiredAt: z.iso.datetime(),
  cause: z.enum(["submission-withdrawn", "superseded"]),
  supersededBy: z.int().positive().optional(),
}).refine((e) => (e.cause === "superseded") === (e.supersededBy !== undefined), "a superseded proposal names the version that superseded it");
/** A grade proposal expiry. */
export type GradeProposalExpiry = z.infer<typeof GradeProposalExpiry>;

/**
 * A proposed official grade waiting for a teacher: what policy answers `require-approval` for,
 * such as a grade written through an agent or tool, or by a co-teacher or administrator. It waits
 * until exactly one of these ends it, after which it never changes: a teacher approves it
 * (`approvedAsVersion`), declines it (`declined`), or it expires (`expired`).
 */
export const GradeProposal = z.strictObject({
  id: GradeProposalId,
  assignmentId: AssignmentId,
  studentPrincipalId: PrincipalId,
  submissionId: SubmissionId,
  score: GradeScore,
  proposedBy: PrincipalId,
  proposedVia: RequestChannel,
  proposedAt: z.iso.datetime(),
  /** The official version its approval created, once a teacher approved it. */
  approvedAsVersion: z.int().positive().optional(),
  declined: GradeProposalDecline.optional(),
  expired: GradeProposalExpiry.optional(),
}).refine(
  (p) => [p.approvedAsVersion, p.declined, p.expired].filter((end) => end !== undefined).length <= 1,
  "a proposal is approved, declined or expired, never more than one",
);
/** A grade proposal. */
export type GradeProposal = z.infer<typeof GradeProposal>;

/** Whether a proposal still waits for a teacher. */
export function isPendingProposal(proposal: GradeProposal): boolean {
  return proposal.approvedAsVersion === undefined && proposal.declined === undefined && proposal.expired === undefined;
}

/**
 * One version of a student's official grade for an assignment, and the teacher approval that made
 * it official. **This is the shape I02's grade passback consumes**: a passback adapter sends a
 * version, and only a version, to the district's system of record.
 *
 * - `version` starts at 1 and increases by one with each new official grade for the same
 *   assignment and student. Stored versions never change or disappear, so a passback can send the
 *   highest version and know any later one supersedes it.
 * - `approval` is always a teacher of the offering acting directly through the SchoolOS UI or API
 *   (policy rule `grade.official.teacher-direct`): who approved, when, and the exact score and
 *   version approved. No agent, tool, evaluator or AI suggestion can produce one.
 * - `proposal` is present when the teacher approved a {@link GradeProposal} rather than entering
 *   the grade themselves; it names who proposed it and through which channel.
 * - `submissionId` and `submissionDigest` name the exact work the grade is for.
 */
export const OfficialGradeVersion = z.strictObject({
  format: z.literal("schoolos.official-grade.v1"),
  districtId: DistrictId,
  offeringId: OfferingId,
  assignmentId: AssignmentId,
  studentPrincipalId: PrincipalId,
  submissionId: SubmissionId,
  submissionDigest: ContentDigest,
  version: z.int().positive(),
  score: GradeScore,
  approval: z.strictObject({
    approvedBy: PrincipalId,
    approvedAt: z.iso.datetime(),
    channel: z.literal("http"),
  }),
  proposal: z.strictObject({
    proposalId: GradeProposalId,
    proposedBy: PrincipalId,
    proposedVia: RequestChannel,
    proposedAt: z.iso.datetime(),
  }).optional(),
});
/** An official grade version. */
export type OfficialGradeVersion = z.infer<typeof OfficialGradeVersion>;

/** Everything the assessment service stores for one district. */
export const AssessmentState = z.strictObject({
  assignments: z.array(AssignmentBinding),
  starterMaterials: z.array(StarterMaterial),
  submissions: z.array(SubmissionSnapshot),
  feedback: z.array(FeedbackRecord),
  gradeProposals: z.array(GradeProposal),
  gradeVersions: z.array(OfficialGradeVersion),
});
/** The assessment service's stored state. */
export type AssessmentState = z.infer<typeof AssessmentState>;
