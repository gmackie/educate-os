import { z } from "zod";
import {
  ArtifactId,
  ID_PREFIXES,
  OfferingId,
  PrincipalId,
  RevisionId,
  EducateOsError,
  SubmissionId,
  type Action,
  type AuthorizationRequest,
  type Caller,
  type Decision,
  type DistrictDirectorySnapshot,
  type ResourceRef,
  type Scope,
  type TermState,
} from "@educateos/contracts";
import type { AcademicStore } from "@educateos/academics";
import type { SigningIdentity } from "@educateos/fleet";
import type { PolicyDecider } from "@educateos/policy";
import {
  isTextMediaType,
  type ArtifactStore,
  type LearningArtifacts,
  type RevisionContent,
} from "@educateos/learning-artifacts";
import { canonicalItems, isSubmissionDigestOf, submissionDigest, submissionIdFor } from "./digest.ts";
import {
  AssignmentBinding,
  AssignmentId,
  AssignmentPatch,
  CriterionId,
  FeedbackAnchor,
  GradeProposalDecline,
  GradeProposalId,
  GradeScore,
  isPendingProposal,
  NewAssignment,
  Suggester,
  type AssessmentState,
  type CriterionScore,
  type FeedbackComment,
  type FeedbackCommentId,
  type FeedbackRecord,
  type FeedbackSource,
  type FeedbackState,
  type GradeProposal,
  type OfficialGradeVersion,
  type StarterMaterial,
  type SubmissionItem,
  type SubmissionReceipt,
  type SubmissionSnapshot,
  type SubmissionTiming,
} from "./model.ts";
import { signSubmissionReceipt, type SignedSubmissionReceipt } from "./receipt.ts";
import type { AssessmentRecordStore } from "./store.ts";

/** One revision to submit. */
export const SubmittedRevision = z.strictObject({ artifactId: ArtifactId, revisionId: RevisionId });
/** A revision to submit. */
export type SubmittedRevision = z.infer<typeof SubmittedRevision>;

/** The revisions a submission captures: at least one, at most one per artifact. */
const SubmittedRevisions = z.array(SubmittedRevision).min(1).max(50).refine(
  (refs) => new Set(refs.map((r) => r.artifactId)).size === refs.length,
  "a submission names each artifact once",
);

/** What publishing starter material takes: one of the teacher's own revisions and a title for the class. */
export const NewStarterMaterial = z.strictObject({
  artifactId: ArtifactId,
  revisionId: RevisionId,
  title: z.string().trim().min(1).max(200),
});
/** New starter material. */
export type NewStarterMaterial = z.infer<typeof NewStarterMaterial>;

/**
 * Who a score or comment is suggested by. Omit it for the teacher's own judgement, which only a
 * teacher acting through the EducateOS UI or API may enter; anything arriving through an agent, a
 * tool or the system must name its suggester and is recorded as `suggested`.
 */
const suggestedBy = Suggester.optional();

/** What adding a comment takes. */
export const NewComment = z.strictObject({
  anchor: FeedbackAnchor.optional(),
  body: z.string().trim().min(1).max(5000),
  suggestedBy,
});
/** A new comment. */
export type NewComment = z.infer<typeof NewComment>;

/** What scoring a criterion takes. */
export const NewCriterionScore = z.strictObject({
  criterionId: CriterionId,
  points: z.number().nonnegative().max(1000),
  maxPoints: z.number().positive().max(1000).optional(),
  suggestedBy,
}).refine((s) => s.maxPoints === undefined || s.points <= s.maxPoints, "points cannot exceed the maximum");
/** A new criterion score. */
export type NewCriterionScore = z.infer<typeof NewCriterionScore>;

/** What recording an official grade takes. */
export const NewOfficialGrade = z.strictObject({ submissionId: SubmissionId, score: GradeScore });
/** A new official grade. */
export type NewOfficialGrade = z.infer<typeof NewOfficialGrade>;

/** An assignment with the starter material published to it. */
export interface AssignmentView {
  assignment: AssignmentBinding;
  starterMaterials: StarterMaterial[];
}

/**
 * What recording an official grade did: made it official at once (a teacher acting directly), or
 * recorded a proposal that waits for a teacher's approval.
 */
export type GradeOutcome =
  | { status: "official"; version: OfficialGradeVersion }
  | { status: "pending-approval"; proposal: GradeProposal };

/** What an {@link AssessmentService} is built from. */
export interface AssessmentServiceOptions {
  /** Where the district's assessment records are kept. */
  records: AssessmentRecordStore;
  /** The district's learning artifacts: submitted revisions are resolved, pinned and read through it. */
  artifacts: LearningArtifacts;
  /** Where revision content is kept, read for starter material (which has no owner to read it through). */
  content: ArtifactStore;
  /** The district's academic directory, read for offerings and terms. Never written. */
  directory: AcademicStore;
  /** Decides and audits every access. */
  policy: PolicyDecider;
  /** The district's receipt signing key. Without one, {@link AssessmentService.signedReceipt} answers `unavailable`. */
  receiptKey?: SigningIdentity;
  /** The clock. Defaults to the system clock. */
  now?: () => Date;
}

/** A resource to authorize against, with the state of the term it belongs to. */
interface Target {
  resource: ResourceRef;
  termState: TermState;
}

/** Everything one call reads. */
interface Loaded {
  state: AssessmentState;
  snapshot: DistrictDirectorySnapshot;
}

/** One attempt at a change: the state to commit, if anything changed, and the result to return. */
interface Mutation<T> {
  next?: AssessmentState;
  result: T;
}

/** Commit attempts before a write gives up on concurrent changes and reports the conflict. */
const COMMIT_ATTEMPTS = 3;

const FEEDBACK_ORDER: readonly FeedbackState[] = ["draft", "shared-with-student", "final"];

const decoder = new TextDecoder("utf-8", { fatal: true });

function notFound(kind: string, id: string): EducateOsError {
  return new EducateOsError("not-found", `${kind} ${id} was not found.`);
}

/**
 * The EducateOS assignment, submission and feedback service (roadmap E01), and the gate every
 * official grade passes through.
 *
 * - An assignment binds an activity to an offering. Its offering's teachers create and change it,
 *   and may publish starter material to it as an unowned class baseline its students can read.
 * - A submission is an immutable snapshot of exact artifact revisions, each pinned in the learning
 *   artifact store, with a combined digest and a receipt that commits to it.
 * - Feedback is anchored to submitted revisions. A suggested score or comment is always labelled,
 *   never shown to the student, and never official.
 * - An official grade exists only once a teacher of the offering approves it directly; every other
 *   write, including any through an agent or tool, waits as a proposal.
 * - Every operation is decided by the policy engine from a `ResourceRef` built from stored records.
 *   Reads the caller may not make answer `not-found`.
 */
export class AssessmentService {
  readonly #records: AssessmentRecordStore;
  readonly #artifacts: LearningArtifacts;
  readonly #content: ArtifactStore;
  readonly #directory: AcademicStore;
  readonly #policy: PolicyDecider;
  readonly #receiptKey: SigningIdentity | undefined;
  readonly #now: () => Date;

  constructor(options: AssessmentServiceOptions) {
    this.#records = options.records;
    this.#artifacts = options.artifacts;
    this.#content = options.content;
    this.#directory = options.directory;
    this.#policy = options.policy;
    this.#receiptKey = options.receiptKey;
    this.#now = options.now ?? (() => new Date());
  }

  // Assignments

  /** Binds an activity to an offering the caller teaches. */
  async createAssignment(caller: Caller, rawInput: NewAssignment): Promise<AssignmentBinding> {
    const input = parse(NewAssignment, rawInput);
    const decisions = this.#decisions(caller);
    return this.#mutate(async ({ state, snapshot }) => {
      const at = this.#offering(snapshot, input.offeringId);
      if (!(await decisions.allows("create", assignmentTarget(at, undefined)))) {
        throw new EducateOsError("forbidden", "Only the offering's teachers can add assignments to it.");
      }
      const now = this.#now().toISOString();
      const assignment = parse(AssignmentBinding, {
        id: `asg_${crypto.randomUUID()}`,
        districtId: at.scope.districtId,
        ...input,
        createdBy: caller.principal.principalId,
        createdAt: now,
        updatedAt: now,
      });
      return { next: { ...state, assignments: [...state.assignments, assignment] }, result: assignment };
    });
  }

  /**
   * Changes an assignment's settings. Its rubric release is locked once any submission exists
   * (roadmap §7): re-evaluating against a new rubric is a new assessment run, not an edit.
   */
  async updateAssignment(caller: Caller, rawId: AssignmentId, rawPatch: AssignmentPatch): Promise<AssignmentBinding> {
    const id = parse(AssignmentId, rawId);
    const patch = parse(AssignmentPatch, rawPatch);
    const decisions = this.#decisions(caller);
    return this.#mutate(async (loaded) => {
      const assignment = await this.#visibleAssignment(decisions, loaded, id);
      if (!(await decisions.allows("update", this.#assignmentTarget(loaded, assignment)))) {
        throw new EducateOsError("forbidden", "Only the offering's teachers can change this assignment.");
      }
      const { rubric, ...settings } = patch;
      const nextRubric = rubric === undefined ? assignment.rubric : (rubric ?? undefined);
      if (
        JSON.stringify(nextRubric ?? null) !== JSON.stringify(assignment.rubric ?? null)
        && loaded.state.submissions.some((s) => s.assignmentId === assignment.id)
      ) {
        throw new EducateOsError("policy-violation", "This assignment has submissions, so its rubric can no longer change.");
      }
      const { rubric: _previous, ...rest } = assignment;
      const updated = parse(AssignmentBinding, {
        ...rest,
        ...settings,
        ...(nextRubric === undefined ? {} : { rubric: nextRubric }),
        updatedAt: this.#now().toISOString(),
      });
      const next = { ...loaded.state, assignments: loaded.state.assignments.map((a) => (a.id === id ? updated : a)) };
      return { next, result: updated };
    });
  }

  /** An assignment and its starter material, if the caller may see it. */
  async getAssignment(caller: Caller, rawId: AssignmentId): Promise<AssignmentView> {
    const id = parse(AssignmentId, rawId);
    const loaded = await this.#load();
    const assignment = await this.#visibleAssignment(this.#decisions(caller), loaded, id);
    return { assignment, starterMaterials: loaded.state.starterMaterials.filter((m) => m.assignmentId === id) };
  }

  /** The assignments of an offering the caller may see. */
  async listAssignments(caller: Caller, rawOfferingId: OfferingId): Promise<AssignmentBinding[]> {
    const offeringId = parse(OfferingId, rawOfferingId);
    const loaded = await this.#load();
    const decisions = this.#decisions(caller);
    const at = this.#offering(loaded.snapshot, offeringId);
    if (!(await decisions.allows("list", assignmentTarget(at, undefined)))) throw notFound("offering", offeringId);
    const visible: AssignmentBinding[] = [];
    for (const assignment of loaded.state.assignments) {
      if (assignment.offeringId !== offeringId) continue;
      if (await decisions.allows("read", assignmentTarget(at, assignment.id))) visible.push(assignment);
    }
    return visible;
  }

  /**
   * Publishes one of the caller's own revisions to an assignment as starter material: an unowned
   * class baseline the offering's students can read (see `StarterMaterial`). Only the chosen
   * revision's content is published, never the source artifact's history. The revision is pinned
   * as the material's `baseline`, so its content outlives the source artifact.
   */
  async publishStarterMaterial(caller: Caller, rawAssignmentId: AssignmentId, rawInput: NewStarterMaterial): Promise<StarterMaterial> {
    const assignmentId = parse(AssignmentId, rawAssignmentId);
    const input = parse(NewStarterMaterial, rawInput);
    const { artifact } = await this.#artifacts.getArtifact(caller, input.artifactId);
    if (artifact.ownerPrincipalId !== caller.principal.principalId) {
      throw new EducateOsError("forbidden", "Only your own work can be published as starter material.");
    }
    const revision = (await this.#artifacts.history(caller, artifact.id)).find((r) => r.id === input.revisionId);
    if (revision === undefined) throw notFound("revision", input.revisionId);
    const decisions = this.#decisions(caller);
    // Chosen once, so a commit retried after a conflict pins under the same baseline.
    const id = `${ID_PREFIXES.artifact}_${crypto.randomUUID()}` as ArtifactId;
    return this.#mutate(async (loaded) => {
      const assignment = await this.#visibleAssignment(decisions, loaded, assignmentId);
      if (!(await decisions.allows("publish", starterTarget(this.#offering(loaded.snapshot, assignment.offeringId), id)))) {
        throw new EducateOsError("forbidden", "Only the offering's teachers can publish material to this assignment.");
      }
      await this.#artifacts.pin(caller, artifact.id, revision.id, { kind: "baseline", baselineId: id });
      const material: StarterMaterial = {
        id,
        assignmentId: assignment.id,
        title: input.title,
        type: artifact.type,
        mediaType: revision.mediaType,
        sizeBytes: revision.sizeBytes,
        content: revision.content,
        aiAssistance: revision.aiAssistance,
        publishedBy: caller.principal.principalId,
        publishedAt: this.#now().toISOString(),
      };
      return { next: { ...loaded.state, starterMaterials: [...loaded.state.starterMaterials, material] }, result: material };
    });
  }

  /** Starter material and its verified content, for the offering's teachers and enrolled students. */
  async readStarterMaterial(
    caller: Caller,
    rawAssignmentId: AssignmentId,
    rawMaterialId: ArtifactId,
  ): Promise<{ material: StarterMaterial; content: RevisionContent }> {
    const assignmentId = parse(AssignmentId, rawAssignmentId);
    const materialId = parse(ArtifactId, rawMaterialId);
    const loaded = await this.#load();
    const decisions = this.#decisions(caller);
    const assignment = await this.#visibleAssignment(decisions, loaded, assignmentId);
    const material = loaded.state.starterMaterials.find((m) => m.id === materialId && m.assignmentId === assignment.id);
    if (material === undefined) throw notFound("starter material", materialId);
    if (!(await decisions.allows("read", starterTarget(this.#offering(loaded.snapshot, assignment.offeringId), material.id)))) {
      throw notFound("starter material", materialId);
    }
    const ref = material.content;
    if (ref.backend === "external") {
      return { material, content: { kind: "external", url: ref.key, ...(ref.snapshotDigest === undefined ? {} : { snapshotDigest: ref.snapshotDigest }) } };
    }
    const bytes = await this.#content.read(ref);
    return { material, content: isTextMediaType(material.mediaType) ? { kind: "text", text: decoder.decode(bytes) } : { kind: "bytes", bytes } };
  }

  // Submissions

  /**
   * Submits exact revisions of the caller's own work in the assignment's offering as an immutable
   * snapshot, pinning each revision for the submission, and returns its receipt.
   *
   * - Idempotent per `(assignment, student, attempt, digest)`: submitting the same revisions as the
   *   caller's latest live attempt returns that attempt's receipt instead of using another attempt.
   * - Refused once the caller has as many live (not withdrawn) submissions as the assignment allows,
   *   or after the due date under a `refuse` late policy or once a late window has closed.
   *   Work accepted after the due date is flagged `late`.
   */
  async submit(caller: Caller, rawAssignmentId: AssignmentId, rawRevisions: readonly SubmittedRevision[]): Promise<SubmissionReceipt> {
    const assignmentId = parse(AssignmentId, rawAssignmentId);
    const refs = parse(SubmittedRevisions, rawRevisions);
    const me = caller.principal.principalId;
    const decisions = this.#decisions(caller);

    const assignment = await this.#visibleAssignment(decisions, await this.#load(), assignmentId);
    // Revisions are immutable, so what they hold can be resolved once, before the commit loop.
    const items: SubmissionItem[] = [];
    for (const ref of refs) {
      const { artifact } = await this.#artifacts.getArtifact(caller, ref.artifactId);
      if (
        artifact.ownerPrincipalId !== me
        || artifact.classification !== "course"
        || artifact.scope.level !== "offering"
        || artifact.scope.offeringId !== assignment.offeringId
      ) {
        throw notFound("artifact", ref.artifactId);
      }
      const revision = (await this.#artifacts.history(caller, artifact.id)).find((r) => r.id === ref.revisionId);
      if (revision === undefined) throw notFound("revision", ref.revisionId);
      items.push({
        artifactId: artifact.id,
        revisionId: revision.id,
        digest: revision.content.digest,
        artifactType: artifact.type,
        mediaType: revision.mediaType,
        sizeBytes: revision.sizeBytes,
        aiAssistance: revision.aiAssistance,
      });
    }
    const digest = await submissionDigest(items);

    return this.#mutate(async (loaded) => {
      const current = await this.#visibleAssignment(decisions, loaded, assignmentId);
      const at = this.#offering(loaded.snapshot, current.offeringId);
      if (!(await decisions.allows("submit", submissionTarget(at, me, undefined)))) {
        throw new EducateOsError("forbidden", "You cannot submit to this assignment.");
      }
      const mine = loaded.state.submissions.filter((s) => s.assignmentId === current.id && s.studentPrincipalId === me);
      const live = mine.filter((s) => s.withdrawnAt === undefined);
      const latest = live.at(-1);
      // A retry of the same work returns the same receipt, even for a submission digested before the rename.
      if (latest !== undefined && (await isSubmissionDigestOf(items, latest.submissionDigest))) return { result: receiptOf(latest) };

      const disallowed = items.find((item) => !current.permittedArtifactTypes.includes(item.artifactType));
      if (disallowed !== undefined) {
        throw new EducateOsError("validation-failed", `This assignment does not accept ${disallowed.artifactType} work.`);
      }
      const now = this.#now();
      const timing = timingAt(current, now);
      if (timing === undefined) throw new EducateOsError("forbidden", "This assignment is no longer accepting work.");
      if (live.length >= current.attemptsAllowed) {
        throw new EducateOsError("forbidden", "You have used every attempt this assignment allows.");
      }
      const attempt = Math.max(0, ...mine.map((s) => s.attempt)) + 1;
      const id = await submissionIdFor(current.id, me, attempt);
      for (const item of items) {
        await this.#artifacts.pin(caller, item.artifactId, item.revisionId, { kind: "submission", submissionId: id });
      }
      const snapshot: SubmissionSnapshot = {
        id,
        districtId: current.districtId,
        assignmentId: current.id,
        offeringId: current.offeringId,
        studentPrincipalId: me,
        attempt,
        items: canonicalItems(items),
        submissionDigest: digest,
        ...(current.rubric === undefined ? {} : { rubric: current.rubric }),
        submittedAt: now.toISOString(),
        timing,
        channel: caller.channel,
      };
      return { next: { ...loaded.state, submissions: [...loaded.state.submissions, snapshot] }, result: receiptOf(snapshot) };
    });
  }

  /**
   * Withdraws one of the caller's submissions before the due date. It stays stored, pinned and
   * readable, marked withdrawn, and no longer counts against the attempt limit. Grade proposals
   * still waiting on it expire. Idempotent.
   */
  async withdraw(caller: Caller, rawSubmissionId: SubmissionId): Promise<SubmissionSnapshot> {
    const submissionId = parse(SubmissionId, rawSubmissionId);
    const decisions = this.#decisions(caller);
    return this.#mutate(async (loaded) => {
      const submission = await this.#readableSubmission(decisions, loaded, submissionId);
      if (submission.withdrawnAt !== undefined) return { result: submission };
      const at = this.#offering(loaded.snapshot, submission.offeringId);
      if (!(await decisions.allows("update", submissionTarget(at, submission.studentPrincipalId, submission.id)))) {
        throw new EducateOsError("forbidden", "Only the student who submitted this work can withdraw it.");
      }
      const assignment = this.#assignmentOf(loaded, submission);
      const now = this.#now();
      if (now.getTime() > Date.parse(assignment.dueAt)) {
        throw new EducateOsError("forbidden", "Work can only be withdrawn before the due date.");
      }
      const withdrawnAt = now.toISOString();
      const withdrawn: SubmissionSnapshot = { ...submission, withdrawnAt };
      const next = {
        ...loaded.state,
        submissions: loaded.state.submissions.map((s) => (s.id === submission.id ? withdrawn : s)),
        gradeProposals: loaded.state.gradeProposals.map((p) =>
          p.submissionId === submission.id && isPendingProposal(p) ? { ...p, expired: { expiredAt: withdrawnAt, cause: "submission-withdrawn" as const } } : p),
      };
      return { next, result: withdrawn };
    });
  }

  /**
   * A submission's receipt signed with the district's key (see `SignedSubmissionReceipt`), for
   * whoever may read the submission: its student, to keep, and the offering's teachers.
   */
  async signedReceipt(caller: Caller, rawSubmissionId: SubmissionId): Promise<SignedSubmissionReceipt> {
    const submissionId = parse(SubmissionId, rawSubmissionId);
    const submission = await this.#readableSubmission(this.#decisions(caller), await this.#load(), submissionId);
    if (this.#receiptKey === undefined) throw new EducateOsError("unavailable", "This district does not sign submission receipts.");
    return signSubmissionReceipt(receiptOf(submission), submission.districtId, this.#receiptKey);
  }

  /** A submission, to its student and the offering's teachers. */
  async getSubmission(caller: Caller, rawSubmissionId: SubmissionId): Promise<SubmissionSnapshot> {
    const submissionId = parse(SubmissionId, rawSubmissionId);
    return this.#readableSubmission(this.#decisions(caller), await this.#load(), submissionId);
  }

  /** The submissions to an assignment the caller may read: a student's own, or all of them for its teachers. */
  async listSubmissions(caller: Caller, rawAssignmentId: AssignmentId): Promise<SubmissionSnapshot[]> {
    const assignmentId = parse(AssignmentId, rawAssignmentId);
    const loaded = await this.#load();
    const decisions = this.#decisions(caller);
    const assignment = await this.#visibleAssignment(decisions, loaded, assignmentId);
    const at = this.#offering(loaded.snapshot, assignment.offeringId);
    const visible: SubmissionSnapshot[] = [];
    for (const submission of loaded.state.submissions) {
      if (submission.assignmentId !== assignment.id) continue;
      if (await decisions.allows("read", submissionTarget(at, submission.studentPrincipalId, submission.id))) visible.push(submission);
    }
    return visible;
  }

  /**
   * The content of one artifact as it was submitted: the pinned revision, verified against the
   * digest the snapshot recorded, whatever has been saved to (or deleted from) the artifact since.
   */
  async readSubmittedContent(
    caller: Caller,
    rawSubmissionId: SubmissionId,
    rawArtifactId: ArtifactId,
  ): Promise<{ item: SubmissionItem; content: RevisionContent }> {
    const submissionId = parse(SubmissionId, rawSubmissionId);
    const artifactId = parse(ArtifactId, rawArtifactId);
    const submission = await this.#readableSubmission(this.#decisions(caller), await this.#load(), submissionId);
    const item = submission.items.find((i) => i.artifactId === artifactId);
    if (item === undefined) throw notFound("artifact", artifactId);
    const { revision, content } = await this.#artifacts.readRevision(caller, item.artifactId, item.revisionId);
    if (revision.content.digest !== item.digest) {
      throw new EducateOsError("unavailable", "This submitted work failed its integrity check and cannot be shown.");
    }
    return { item, content };
  }

  // Feedback

  /** Adds a comment to a submission, anchored to a submitted revision or on the whole. */
  async addComment(caller: Caller, rawSubmissionId: SubmissionId, rawInput: NewComment): Promise<FeedbackComment> {
    const submissionId = parse(SubmissionId, rawSubmissionId);
    const input = parse(NewComment, rawInput);
    const source = sourceFor(caller, input.suggestedBy);
    const decisions = this.#decisions(caller);
    return this.#mutate(async (loaded) => {
      const { submission, feedback } = await this.#reviewable(decisions, loaded, submissionId);
      if (input.anchor !== undefined) checkAnchor(submission, input.anchor);
      const comment: FeedbackComment = {
        id: `fbc_${crypto.randomUUID()}` as FeedbackCommentId,
        ...(input.anchor === undefined ? {} : { anchor: input.anchor }),
        body: input.body,
        source,
        enteredBy: caller.principal.principalId,
        enteredAt: this.#now().toISOString(),
      };
      const updated = { ...feedback, comments: [...feedback.comments, comment], updatedAt: comment.enteredAt };
      return { next: withFeedback(loaded.state, updated), result: comment };
    });
  }

  /**
   * Scores one rubric criterion. A teacher's score replaces their earlier score for the criterion;
   * a suggestion replaces the same suggester's earlier suggestion for it.
   */
  async scoreCriterion(caller: Caller, rawSubmissionId: SubmissionId, rawInput: NewCriterionScore): Promise<CriterionScore> {
    const submissionId = parse(SubmissionId, rawSubmissionId);
    const input = parse(NewCriterionScore, rawInput);
    const source = sourceFor(caller, input.suggestedBy);
    const decisions = this.#decisions(caller);
    return this.#mutate(async (loaded) => {
      const { submission, feedback } = await this.#reviewable(decisions, loaded, submissionId);
      if (submission.rubric === undefined) {
        throw new EducateOsError("validation-failed", "This submission has no rubric to score against.");
      }
      const score: CriterionScore = {
        criterionId: input.criterionId,
        points: input.points,
        ...(input.maxPoints === undefined ? {} : { maxPoints: input.maxPoints }),
        source,
        enteredBy: caller.principal.principalId,
        enteredAt: this.#now().toISOString(),
      };
      const replaced = (s: CriterionScore) => s.criterionId === score.criterionId && JSON.stringify(s.source) === JSON.stringify(score.source);
      const updated = { ...feedback, scores: [...feedback.scores.filter((s) => !replaced(s)), score], updatedAt: score.enteredAt };
      return { next: withFeedback(loaded.state, updated), result: score };
    });
  }

  /** Moves a submission's feedback forward to `shared-with-student` or `final`. Idempotent; never backward. */
  async advanceFeedback(caller: Caller, rawSubmissionId: SubmissionId, rawState: "shared-with-student" | "final"): Promise<FeedbackRecord> {
    const submissionId = parse(SubmissionId, rawSubmissionId);
    const state = parse(z.enum(["shared-with-student", "final"]), rawState);
    const decisions = this.#decisions(caller);
    return this.#mutate(async (loaded) => {
      const submission = await this.#readableSubmission(decisions, loaded, submissionId);
      await this.#assertMayReview(decisions, loaded, submission);
      if (caller.channel !== "http") {
        throw new EducateOsError("forbidden", "Feedback is shared with a student only by their teacher, in EducateOS itself.");
      }
      const feedback = loaded.state.feedback.find((f) => f.submissionId === submission.id) ?? emptyFeedback(submission.id, this.#now());
      if (feedback.state === state) return { result: feedback };
      if (FEEDBACK_ORDER.indexOf(state) < FEEDBACK_ORDER.indexOf(feedback.state)) {
        throw new EducateOsError("conflict", `This feedback is already ${feedback.state}.`);
      }
      const updated = { ...feedback, state, updatedAt: this.#now().toISOString() };
      return { next: withFeedback(loaded.state, updated), result: updated };
    });
  }

  /**
   * A submission's feedback. The offering's teachers get all of it. The student gets the teacher's
   * own comments and scores once the assignment's `feedbackVisibility` allows, and never a
   * suggestion; until then, as to everyone else, it answers `not-found`.
   */
  async getFeedback(caller: Caller, rawSubmissionId: SubmissionId): Promise<FeedbackRecord> {
    const submissionId = parse(SubmissionId, rawSubmissionId);
    const loaded = await this.#load();
    const decisions = this.#decisions(caller);
    const submission = await this.#readableSubmission(decisions, loaded, submissionId);
    const at = this.#offering(loaded.snapshot, submission.offeringId);
    if (!(await decisions.allows("read", feedbackTarget(at, submission)))) throw notFound("feedback", submissionId);
    const feedback = loaded.state.feedback.find((f) => f.submissionId === submission.id);
    if (submission.studentPrincipalId !== caller.principal.principalId) return feedback ?? emptyFeedback(submission.id, this.#now());
    const released = this.#asReleasedToStudent(loaded, submission, feedback);
    if (released === undefined) throw notFound("feedback", submissionId);
    return released;
  }

  /**
   * The feedback a student has been given on an assignment, exactly as the student sees it: the
   * teacher's own comments and scores, once the assignment's `feedbackVisibility` releases them,
   * one record per submission that has released feedback, oldest first. This is the student's view
   * for someone the policy engine lets read the student's feedback without being their teacher, a
   * guardian (ADR-0012): it never shows more than the student sees, and it reveals nothing about a
   * submission whose feedback is not released. Each record is decided as a `read` of `feedback`.
   */
  async releasedFeedback(caller: Caller, rawAssignmentId: AssignmentId, rawStudentId: PrincipalId): Promise<FeedbackRecord[]> {
    const assignmentId = parse(AssignmentId, rawAssignmentId);
    const studentId = parse(PrincipalId, rawStudentId);
    const loaded = await this.#load();
    const decisions = this.#decisions(caller);
    const assignment = loaded.state.assignments.find((a) => a.id === assignmentId);
    if (assignment === undefined) throw notFound("assignment", assignmentId);
    const at = this.#offering(loaded.snapshot, assignment.offeringId);
    const released: FeedbackRecord[] = [];
    for (const submission of loaded.state.submissions) {
      if (submission.assignmentId !== assignmentId || submission.studentPrincipalId !== studentId) continue;
      const view = this.#asReleasedToStudent(loaded, submission, loaded.state.feedback.find((f) => f.submissionId === submission.id));
      // Unreleased feedback is not decided at all, so it leaves no trace a reader could learn from.
      if (view !== undefined && (await decisions.allows("read", feedbackTarget(at, submission)))) released.push(view);
    }
    return released;
  }

  /** Feedback as its student sees it, or `undefined` while the assignment has not released it to them. */
  #asReleasedToStudent(loaded: Loaded, submission: SubmissionSnapshot, feedback: FeedbackRecord | undefined): FeedbackRecord | undefined {
    const visibleFrom: FeedbackState = this.#assignmentOf(loaded, submission).feedbackVisibility === "when-final" ? "final" : "shared-with-student";
    if (feedback === undefined || FEEDBACK_ORDER.indexOf(feedback.state) < FEEDBACK_ORDER.indexOf(visibleFrom)) return undefined;
    return {
      ...feedback,
      comments: feedback.comments.filter((c) => c.source.kind === "teacher"),
      scores: feedback.scores.filter((s) => s.source.kind === "teacher"),
    };
  }

  // Official grades

  /**
   * Records an official grade for a submission. A teacher of the offering acting directly through
   * the EducateOS UI or API makes it official at once, as the next version. Any other write the
   * policy engine sends for review, including a teacher's own write through an agent or tool,
   * becomes a {@link GradeProposal} that waits for {@link approveGradeProposal}.
   */
  async recordOfficialGrade(caller: Caller, rawInput: NewOfficialGrade): Promise<GradeOutcome> {
    const [outcome] = await this.#recordGrades(caller, [parse(NewOfficialGrade, rawInput)]);
    return outcome!;
  }

  /**
   * Records several official grades as one action, such as releasing a quiz's scores (SCHO-191):
   * each is decided and recorded exactly as {@link recordOfficialGrade} records one, every decision
   * is audited under one correlation ID, and they are committed together or not at all. At most one
   * grade per student and assignment.
   */
  async recordOfficialGrades(caller: Caller, rawInputs: readonly NewOfficialGrade[]): Promise<GradeOutcome[]> {
    return this.#recordGrades(caller, parse(z.array(NewOfficialGrade).min(1).max(1000), rawInputs));
  }

  async #recordGrades(caller: Caller, inputs: readonly NewOfficialGrade[]): Promise<GradeOutcome[]> {
    const decisions = this.#decisions(caller);
    return this.#mutate<GradeOutcome[]>(async (loaded) => {
      let state = loaded.state;
      const graded = new Set<string>();
      const outcomes: GradeOutcome[] = [];
      for (const input of inputs) {
        const submission = await this.#readableSubmission(decisions, { ...loaded, state }, input.submissionId);
        const key = JSON.stringify([submission.assignmentId, submission.studentPrincipalId]);
        if (graded.has(key)) throw new EducateOsError("validation-failed", "Each student is graded once per assignment in one action.");
        graded.add(key);
        if (submission.withdrawnAt !== undefined) throw new EducateOsError("conflict", "A withdrawn submission cannot be graded.");
        const decision = await decisions.decide("grade", gradeTarget(this.#offering(loaded.snapshot, submission.offeringId), submission));
        const now = this.#now().toISOString();
        if (decision.effect === "allow") {
          const version = nextVersion(state, submission, input.score, caller, now, undefined);
          state = withVersion(state, version);
          outcomes.push({ status: "official", version });
        } else if (decision.effect === "require-approval") {
          const proposal: GradeProposal = {
            id: `gpr_${crypto.randomUUID()}` as GradeProposalId,
            assignmentId: submission.assignmentId,
            studentPrincipalId: submission.studentPrincipalId,
            submissionId: submission.id,
            score: input.score,
            proposedBy: caller.principal.principalId,
            proposedVia: caller.channel,
            proposedAt: now,
          };
          state = { ...state, gradeProposals: [...state.gradeProposals, proposal] };
          outcomes.push({ status: "pending-approval", proposal });
        } else {
          throw new EducateOsError("forbidden", "You cannot grade this work.");
        }
      }
      return { next: state, result: outcomes };
    });
  }

  /**
   * A teacher of the offering, acting directly, approves a proposed grade, which becomes the next
   * official version with the proposal recorded beside the approval. Idempotent.
   */
  async approveGradeProposal(caller: Caller, rawProposalId: GradeProposalId): Promise<OfficialGradeVersion> {
    const proposalId = parse(GradeProposalId, rawProposalId);
    const decisions = this.#decisions(caller);
    return this.#mutate(async (loaded) => {
      const proposal = loaded.state.gradeProposals.find((p) => p.id === proposalId);
      if (proposal === undefined) throw notFound("grade proposal", proposalId);
      const submission = await this.#readableSubmission(decisions, loaded, proposal.submissionId);
      await this.#assertMayReview(decisions, loaded, submission);
      if (proposal.approvedAsVersion !== undefined) {
        const existing = loaded.state.gradeVersions.find((v) => sameGrade(v, submission) && v.version === proposal.approvedAsVersion);
        if (existing === undefined) throw new Error(`proposal ${proposal.id} names a missing version`);
        return { result: existing };
      }
      if (proposal.declined !== undefined) throw new EducateOsError("conflict", "This grade proposal was declined.");
      if (proposal.expired !== undefined) throw new EducateOsError("conflict", "This grade proposal expired and can no longer be approved.");
      if (submission.withdrawnAt !== undefined) throw new EducateOsError("conflict", "A withdrawn submission cannot be graded.");
      const decision = await decisions.decide("approve", gradeTarget(this.#offering(loaded.snapshot, submission.offeringId), submission));
      if (decision.effect !== "allow") throw new EducateOsError("forbidden", "Only a teacher of the offering can approve this grade.");
      const version = nextVersion(loaded.state, submission, proposal.score, caller, this.#now().toISOString(), proposal);
      const approved = { ...loaded.state, gradeProposals: loaded.state.gradeProposals.map((p) => (p.id === proposal.id ? { ...p, approvedAsVersion: version.version } : p)) };
      return { next: withVersion(approved, version), result: version };
    });
  }

  /**
   * A teacher of the offering, acting directly, declines a proposed grade with a reason. It never
   * becomes official and stops waiting. Declining it again returns it unchanged; a proposal already
   * approved or expired answers `conflict`.
   */
  async declineGradeProposal(caller: Caller, rawProposalId: GradeProposalId, rawReason: string): Promise<GradeProposal> {
    const proposalId = parse(GradeProposalId, rawProposalId);
    const reason = parse(GradeProposalDecline.shape.reason, rawReason);
    const decisions = this.#decisions(caller);
    return this.#mutate(async (loaded) => {
      const proposal = loaded.state.gradeProposals.find((p) => p.id === proposalId);
      if (proposal === undefined) throw notFound("grade proposal", proposalId);
      const submission = await this.#readableSubmission(decisions, loaded, proposal.submissionId);
      await this.#assertMayReview(decisions, loaded, submission);
      if (proposal.declined !== undefined) return { result: proposal };
      if (!isPendingProposal(proposal)) throw new EducateOsError("conflict", "This grade proposal is no longer waiting for a decision.");
      if (caller.channel !== "http") throw new EducateOsError("forbidden", "Only a teacher acting directly in EducateOS can decline a grade.");
      const decision = await decisions.decide("approve", gradeTarget(this.#offering(loaded.snapshot, submission.offeringId), submission));
      if (decision.effect !== "allow") throw new EducateOsError("forbidden", "Only a teacher of the offering can decide on this grade.");
      const declined: GradeProposal = { ...proposal, declined: { declinedBy: caller.principal.principalId, declinedAt: this.#now().toISOString(), reason } };
      const next = { ...loaded.state, gradeProposals: loaded.state.gradeProposals.map((p) => (p.id === proposal.id ? declined : p)) };
      return { next, result: declined };
    });
  }

  /** The proposals for an assignment waiting for a teacher, for the offering's staff. */
  async pendingGradeProposals(caller: Caller, rawAssignmentId: AssignmentId): Promise<GradeProposal[]> {
    const assignmentId = parse(AssignmentId, rawAssignmentId);
    const loaded = await this.#load();
    const decisions = this.#decisions(caller);
    await this.#visibleAssignment(decisions, loaded, assignmentId);
    const pending: GradeProposal[] = [];
    for (const proposal of loaded.state.gradeProposals) {
      if (proposal.assignmentId !== assignmentId || !isPendingProposal(proposal)) continue;
      const submission = loaded.state.submissions.find((s) => s.id === proposal.submissionId);
      if (submission === undefined) continue;
      const at = this.#offering(loaded.snapshot, submission.offeringId);
      if (await decisions.allows("review", submissionTarget(at, submission.studentPrincipalId, submission.id))) pending.push(proposal);
    }
    return pending;
  }

  /** A student's official grade versions for an assignment, oldest first, to the student and the offering's staff. */
  async officialGrades(caller: Caller, rawAssignmentId: AssignmentId, rawStudentId: PrincipalId): Promise<OfficialGradeVersion[]> {
    const assignmentId = parse(AssignmentId, rawAssignmentId);
    const studentId = parse(PrincipalId, rawStudentId);
    const loaded = await this.#load();
    const decisions = this.#decisions(caller);
    const assignment = await this.#visibleAssignment(decisions, loaded, assignmentId, { recordsOf: studentId });
    const target = gradeTarget(this.#offering(loaded.snapshot, assignment.offeringId), { assignmentId, studentPrincipalId: studentId });
    if (!(await decisions.allows("read", target))) throw notFound("grade", assignmentId);
    return loaded.state.gradeVersions.filter((v) => v.assignmentId === assignmentId && v.studentPrincipalId === studentId);
  }

  // Internals

  #decisions(caller: Caller): Decisions {
    return new Decisions(caller, this.#policy, caller.correlationId ?? crypto.randomUUID());
  }

  /** The offering's policy scope and term state, or `not-found` if the district has no such offering. */
  #offering(snapshot: DistrictDirectorySnapshot, offeringId: OfferingId): OfferingContext {
    const offering = snapshot.offerings.find((o) => o.id === offeringId);
    if (offering === undefined) throw notFound("offering", offeringId);
    const term = snapshot.terms.find((t) => t.id === offering.termId);
    if (term === undefined) throw new Error(`term ${offering.termId} is missing from the directory`);
    return {
      scope: { level: "offering", districtId: offering.districtId, schoolId: offering.schoolId, offeringId: offering.id },
      termState: term.state,
    };
  }

  #assignmentTarget(loaded: Loaded, assignment: AssignmentBinding): Target {
    return assignmentTarget(this.#offering(loaded.snapshot, assignment.offeringId), assignment.id);
  }

  /**
   * The assignment, if it exists and the caller may read it; else `not-found`. With `recordsOf`,
   * an assignment that student submitted to is reached even once they have left the offering, so
   * their own records stay readable to whoever the policy engine lets read them.
   */
  async #visibleAssignment(
    decisions: Decisions,
    loaded: Loaded,
    id: AssignmentId,
    options: { recordsOf?: PrincipalId } = {},
  ): Promise<AssignmentBinding> {
    const assignment = loaded.state.assignments.find((a) => a.id === id);
    if (assignment === undefined) throw notFound("assignment", id);
    if (await decisions.allows("read", this.#assignmentTarget(loaded, assignment))) return assignment;
    // A student keeps their own records of an assignment after leaving its offering, and so does
    // whoever may read those records (a guardian): the caller still needs the record's own decision.
    if (options.recordsOf !== undefined && loaded.state.submissions.some((s) => s.assignmentId === id && s.studentPrincipalId === options.recordsOf)) {
      return assignment;
    }
    throw notFound("assignment", id);
  }

  #assignmentOf(loaded: Loaded, submission: SubmissionSnapshot): AssignmentBinding {
    const assignment = loaded.state.assignments.find((a) => a.id === submission.assignmentId);
    if (assignment === undefined) throw new Error(`submission ${submission.id} has no assignment ${submission.assignmentId}`);
    return assignment;
  }

  /** The submission, if it exists and the caller may read it; else `not-found`. */
  async #readableSubmission(decisions: Decisions, loaded: Loaded, id: SubmissionId): Promise<SubmissionSnapshot> {
    const submission = loaded.state.submissions.find((s) => s.id === id);
    if (submission === undefined) throw notFound("submission", id);
    const at = this.#offering(loaded.snapshot, submission.offeringId);
    if (!(await decisions.allows("read", submissionTarget(at, submission.studentPrincipalId, submission.id)))) throw notFound("submission", id);
    return submission;
  }

  async #assertMayReview(decisions: Decisions, loaded: Loaded, submission: SubmissionSnapshot): Promise<void> {
    const at = this.#offering(loaded.snapshot, submission.offeringId);
    if (!(await decisions.allows("review", submissionTarget(at, submission.studentPrincipalId, submission.id)))) {
      throw new EducateOsError("forbidden", "Only the offering's teachers can give feedback on this work.");
    }
  }

  /** A live submission the caller may review, with its feedback (a fresh draft if there is none), not yet final. */
  async #reviewable(decisions: Decisions, loaded: Loaded, id: SubmissionId): Promise<{ submission: SubmissionSnapshot; feedback: FeedbackRecord }> {
    const submission = await this.#readableSubmission(decisions, loaded, id);
    await this.#assertMayReview(decisions, loaded, submission);
    if (submission.withdrawnAt !== undefined) throw new EducateOsError("conflict", "This submission was withdrawn.");
    const feedback = loaded.state.feedback.find((f) => f.submissionId === submission.id) ?? emptyFeedback(submission.id, this.#now());
    if (feedback.state === "final") throw new EducateOsError("conflict", "This feedback is final.");
    return { submission, feedback };
  }

  async #load(): Promise<Loaded> {
    const [{ state }, { snapshot }] = await Promise.all([this.#records.load(), this.#directory.load()]);
    return { state, snapshot };
  }

  /** Runs `change` against fresh state and commits what it returns, retrying when a concurrent write wins. */
  async #mutate<T>(change: (loaded: Loaded) => Promise<Mutation<T>>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const [{ state, version }, { snapshot }] = await Promise.all([this.#records.load(), this.#directory.load()]);
      const { next, result } = await change({ state, snapshot });
      if (next === undefined) return result;
      try {
        await this.#records.commit(next, version);
        return result;
      } catch (error) {
        if (!(error instanceof EducateOsError && error.code === "conflict") || attempt >= COMMIT_ATTEMPTS) throw error;
      }
    }
  }
}

/** An offering as policy sees it. */
interface OfferingContext {
  scope: Extract<Scope, { level: "offering" }>;
  termState: TermState;
}

/** One caller's policy decisions within one call, audited under one correlation ID. */
class Decisions {
  readonly #caller: Caller;
  readonly #policy: PolicyDecider;
  readonly #correlationId: string;

  constructor(caller: Caller, policy: PolicyDecider, correlationId: string) {
    this.#caller = caller;
    this.#policy = policy;
    this.#correlationId = correlationId;
  }

  async decide(action: Action, target: Target): Promise<Decision> {
    const request: AuthorizationRequest = {
      subject: this.#caller.principal,
      action,
      resource: target.resource,
      context: { channel: this.#caller.channel, termState: target.termState },
    };
    return (await this.#policy.decide(request, { correlationId: this.#correlationId })).decision;
  }

  async allows(action: Action, target: Target): Promise<boolean> {
    return (await this.decide(action, target)).effect === "allow";
  }
}

/** Parses caller input, answering `validation-failed` rather than a raw Zod error. */
function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new EducateOsError("validation-failed", z.prettifyError(parsed.error).slice(0, 1000));
  return parsed.data;
}

/** An assignment as policy sees it: an unowned `course` activity in its offering, before it has an ID for `create` and `list`. */
function assignmentTarget(at: OfferingContext, id: AssignmentId | undefined): Target {
  return {
    resource: { kind: "activity", ...(id === undefined ? {} : { id }), scope: at.scope, classification: "course" },
    termState: at.termState,
  };
}

/** Starter material as policy sees it: an unowned `course` artifact in the offering, a class baseline. */
function starterTarget(at: OfferingContext, id: ArtifactId): Target {
  return { resource: { kind: "artifact", id, scope: at.scope, classification: "course" }, termState: at.termState };
}

/** A submission as policy sees it: `course` work its student owns. */
function submissionTarget(at: OfferingContext, studentPrincipalId: PrincipalId, id: SubmissionId | undefined): Target {
  return {
    resource: { kind: "submission", ...(id === undefined ? {} : { id }), scope: at.scope, classification: "course", ownerPrincipalId: studentPrincipalId },
    termState: at.termState,
  };
}

/** Feedback as policy sees it: a `course` record about, and owned by, the submission's student. */
function feedbackTarget(at: OfferingContext, submission: SubmissionSnapshot): Target {
  return {
    resource: { kind: "feedback", id: submission.id, scope: at.scope, classification: "course", ownerPrincipalId: submission.studentPrincipalId },
    termState: at.termState,
  };
}

/** A student's official grade for an assignment as policy sees it: a `course` record the student owns. */
function gradeTarget(at: OfferingContext, of: { assignmentId: AssignmentId; studentPrincipalId: PrincipalId }): Target {
  return {
    resource: { kind: "official-grade", id: of.assignmentId, scope: at.scope, classification: "course", ownerPrincipalId: of.studentPrincipalId },
    termState: at.termState,
  };
}

/** Whether work submitted at `now` is on time or late, or `undefined` if the assignment no longer accepts it. */
function timingAt(assignment: AssignmentBinding, now: Date): SubmissionTiming | undefined {
  if (now.getTime() <= Date.parse(assignment.dueAt)) return "on-time";
  const late = assignment.latePolicy;
  if (late.kind === "refuse") return undefined;
  if (late.closesAt !== undefined && now.getTime() > Date.parse(late.closesAt)) return undefined;
  return "late";
}

/** The receipt for a stored submission. */
export function receiptOf(submission: SubmissionSnapshot): SubmissionReceipt {
  return {
    format: "educateos.submission-receipt.v1",
    submissionId: submission.id,
    assignmentId: submission.assignmentId,
    studentPrincipalId: submission.studentPrincipalId,
    attempt: submission.attempt,
    submittedAt: submission.submittedAt,
    timing: submission.timing,
    items: submission.items.map(({ artifactId, revisionId, digest }) => ({ artifactId, revisionId, digest })),
    submissionDigest: submission.submissionDigest,
  };
}

/** Where a score or comment comes from. Only a direct (HTTP) caller may enter one as their own judgement. */
function sourceFor(caller: Caller, suggester: Suggester | undefined): FeedbackSource {
  if (suggester !== undefined) return { kind: "suggested", suggester };
  if (caller.channel !== "http") {
    throw new EducateOsError("validation-failed", "Feedback from an agent, tool or evaluator must name what suggested it.");
  }
  return { kind: "teacher" };
}

/** Checks a comment's anchor points into a revision the submission captured. */
function checkAnchor(submission: SubmissionSnapshot, anchor: FeedbackAnchor): void {
  const item = submission.items.find((i) => i.artifactId === anchor.artifactId && i.revisionId === anchor.revisionId);
  if (item === undefined) throw new EducateOsError("validation-failed", "A comment can only point into the submitted revisions.");
  if (anchor.region.kind === "text-range") {
    // A UTF-16 offset never exceeds the UTF-8 byte length, so this bounds the range without the content.
    if (!isTextMediaType(item.mediaType) || anchor.region.end > item.sizeBytes) {
      throw new EducateOsError("validation-failed", "That text range is outside the submitted text.");
    }
  }
}

function emptyFeedback(submissionId: SubmissionId, now: Date): FeedbackRecord {
  return { submissionId, state: "draft", comments: [], scores: [], updatedAt: now.toISOString() };
}

function withFeedback(state: AssessmentState, feedback: FeedbackRecord): AssessmentState {
  const exists = state.feedback.some((f) => f.submissionId === feedback.submissionId);
  return {
    ...state,
    feedback: exists ? state.feedback.map((f) => (f.submissionId === feedback.submissionId ? feedback : f)) : [...state.feedback, feedback],
  };
}

function sameGrade(version: OfficialGradeVersion, submission: Pick<SubmissionSnapshot, "assignmentId" | "studentPrincipalId">): boolean {
  return version.assignmentId === submission.assignmentId && version.studentPrincipalId === submission.studentPrincipalId;
}

/**
 * `state` with `version` official, and every proposal still waiting for the same assignment and
 * student expired as superseded by it: approving one later would replace a newer teacher decision.
 */
function withVersion(state: AssessmentState, version: OfficialGradeVersion): AssessmentState {
  const expired = { expiredAt: version.approval.approvedAt, cause: "superseded" as const, supersededBy: version.version };
  return {
    ...state,
    gradeVersions: [...state.gradeVersions, version],
    gradeProposals: state.gradeProposals.map((p) => (isPendingProposal(p) && sameGrade(version, p) ? { ...p, expired } : p)),
  };
}

/** The next official version of a student's grade for an assignment, approved by `caller` at `now`. */
function nextVersion(
  state: AssessmentState,
  submission: SubmissionSnapshot,
  score: GradeScore,
  caller: Caller,
  now: string,
  proposal: GradeProposal | undefined,
): OfficialGradeVersion {
  // The approval shape promises a direct teacher action; a rule table that allowed anything else is misconfigured.
  if (caller.channel !== "http") throw new EducateOsError("policy-violation", "An official grade is approved only by a teacher acting directly.");
  const previous = state.gradeVersions.filter((v) => sameGrade(v, submission));
  return {
    format: "educateos.official-grade.v1",
    districtId: submission.districtId,
    offeringId: submission.offeringId,
    assignmentId: submission.assignmentId,
    studentPrincipalId: submission.studentPrincipalId,
    submissionId: submission.id,
    submissionDigest: submission.submissionDigest,
    version: Math.max(0, ...previous.map((v) => v.version)) + 1,
    score,
    approval: { approvedBy: caller.principal.principalId, approvedAt: now, channel: "http" },
    ...(proposal === undefined
      ? {}
      : { proposal: { proposalId: proposal.id, proposedBy: proposal.proposedBy, proposedVia: proposal.proposedVia, proposedAt: proposal.proposedAt } }),
  };
}
