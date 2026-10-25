import { z } from "zod";
import { ArtifactId, AuditEventBase, DistrictId, OfferingId, PrincipalId, SchoolId, TermId, WorkspaceId, type TermState } from "@educateos/contracts";

/**
 * Where a workspace is in its life (roadmap §6.1). The first four follow the term; `retained` and
 * `eligible-for-deletion` follow the term's close and the retention policy, and a legal hold keeps
 * a workspace out of `eligible-for-deletion`. Only the retention job (`WorkspaceRetentionJob`)
 * deletes, and `deleted` is the record it leaves behind once the workspace's storage is gone.
 */
export const WorkspaceLifecycle = z.enum(["planned", "active", "grading", "completed", "retained", "eligible-for-deletion", "deleted"]);
/** A workspace lifecycle state. */
export type WorkspaceLifecycle = z.infer<typeof WorkspaceLifecycle>;

/**
 * An opaque reference to the storage backing a workspace: the Workshop workspace the kernel seam
 * creates on the principal's behalf. EducateOS never interprets `ref`; it is absent until that seam
 * (and W02's artifact store) attaches one.
 */
export const StorageHandle = z.strictObject({
  /** The backend that understands `ref`. */
  backend: z.literal("workshop"),
  /** The backend's own identifier for the workspace. */
  ref: z.string().min(1).max(256),
});
/** A storage handle. */
export type StorageHandle = z.infer<typeof StorageHandle>;

/** A legal hold on a workspace. While one is in place the workspace is never eligible for deletion. */
export const LegalHold = z.strictObject({
  /** When the hold was placed. */
  placedAt: z.iso.datetime(),
  /** The administrator who placed it. */
  placedBy: PrincipalId,
});
/** A legal hold. */
export type LegalHold = z.infer<typeof LegalHold>;

/**
 * The retention job's progress deleting a workspace. `pending` is committed before any storage is
 * touched, in the same check-and-commit that confirms the workspace is still eligible (no legal
 * hold), so that commit is the moment of deletion; from then on a legal hold is refused. A job that
 * stops while `pending` resumes the deletion on its next run. `deleted` means the storage is gone.
 */
export const WorkspaceDeletion = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("pending"), startedAt: z.iso.datetime() }),
  z.strictObject({ state: z.literal("deleted"), startedAt: z.iso.datetime(), deletedAt: z.iso.datetime() }),
]);
/** A workspace deletion. */
export type WorkspaceDeletion = z.infer<typeof WorkspaceDeletion>;

const workspaceFields = {
  /** The stable logical ID. It never changes, whatever storage is attached behind it. */
  id: WorkspaceId,
  districtId: DistrictId,
  /** The principal the workspace belongs to. Workspaces are never shared or transferred. */
  ownerPrincipalId: PrincipalId,
  /** When it was first provisioned. */
  createdAt: z.iso.datetime(),
  /** The backing storage, once attached. */
  storageHandle: StorageHandle.optional(),
  /** A legal hold, if one is in place. */
  legalHold: LegalHold.optional(),
  /** The retention job's deletion, once it has begun. Only course workspaces are ever deleted. */
  deletion: WorkspaceDeletion.optional(),
};

/** A principal's personal workspace: one per principal, permanent, and private to them. */
export const PersonalWorkspace = z.strictObject({
  kind: z.literal("personal"),
  ...workspaceFields,
});
/** A personal workspace. */
export type PersonalWorkspace = z.infer<typeof PersonalWorkspace>;

/** A student's workspace for one course offering: one per student per offering, retained after close. */
export const CourseWorkspace = z.strictObject({
  kind: z.literal("course"),
  ...workspaceFields,
  schoolId: SchoolId,
  offeringId: OfferingId,
  /** The offering's term, recorded so the workspace keeps its term if the offering record changes. */
  termId: TermId,
});
/** A course workspace. */
export type CourseWorkspace = z.infer<typeof CourseWorkspace>;

/** A personal or course workspace. They are distinct kinds, never one kind with a flag. */
export const Workspace = z.discriminatedUnion("kind", [PersonalWorkspace, CourseWorkspace]);
/** A workspace. */
export type Workspace = z.infer<typeof Workspace>;

/**
 * A workspace as returned to a caller: its derived lifecycle, and the storage handle only when the
 * caller owns it. Staff and administrators who may see a workspace's record never get the
 * reference to its contents.
 */
export type WorkspaceView = Workspace & {
  /** The lifecycle state now. */
  lifecycle: WorkspaceLifecycle;
};

/**
 * What a live course grant lets a course workspace use:
 * - `course-tools`: the offering's roster-scoped tools and class material.
 * - `course-ai-funding`: AI spend charged to the offering's budget (G01).
 */
export const CourseGrantKind = z.enum(["course-tools", "course-ai-funding"]);
/** A course grant kind. */
export type CourseGrantKind = z.infer<typeof CourseGrantKind>;

/**
 * Why a course grant was revoked: its term closed, the roster dropped the student from the
 * offering, or the student left the district (graduated or became inactive).
 */
export const GrantRevocationReason = z.enum(["term-closed", "roster-dropped", "principal-departed"]);
/** A grant revocation reason. */
export type GrantRevocationReason = z.infer<typeof GrantRevocationReason>;

/**
 * A live permission a course workspace holds through its owner's enrollment. Revoking one keeps
 * the record, so an administrator can see what was revoked, when and why.
 */
export const CourseGrant = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("live"),
    workspaceId: WorkspaceId,
    principalId: PrincipalId,
    offeringId: OfferingId,
    termId: TermId,
    kind: CourseGrantKind,
    grantedAt: z.iso.datetime(),
  }),
  z.strictObject({
    state: z.literal("revoked"),
    workspaceId: WorkspaceId,
    principalId: PrincipalId,
    offeringId: OfferingId,
    termId: TermId,
    kind: CourseGrantKind,
    grantedAt: z.iso.datetime(),
    revokedAt: z.iso.datetime(),
    reason: GrantRevocationReason,
  }),
]);
/** A course grant. */
export type CourseGrant = z.infer<typeof CourseGrant>;

/** That a term's workspaces were closed: their grants revoked and the workspaces retained from `closedAt`. */
export const TermClosure = z.strictObject({
  termId: TermId,
  closedAt: z.iso.datetime(),
  closedBy: PrincipalId,
});
/** A term closure. */
export type TermClosure = z.infer<typeof TermClosure>;

/**
 * A student's link from an artifact in a closed course workspace to their personal workspace. It
 * records the promotion only; copying content is W02's.
 */
export const PromotionLink = z.strictObject({
  principalId: PrincipalId,
  fromWorkspaceId: WorkspaceId,
  toWorkspaceId: WorkspaceId,
  artifactId: ArtifactId,
  promotedAt: z.iso.datetime(),
});
/** A promotion link. */
export type PromotionLink = z.infer<typeof PromotionLink>;

/**
 * An event for other services, kept in the store's outbox. `course-ai-funding.cancelled` tells
 * G01 to stop funding the listed principals' AI use from the offering's budget. Events carry
 * identifiers only.
 */
export const WorkspaceEvent = z.strictObject({
  type: z.literal("course-ai-funding.cancelled"),
  offeringId: OfferingId,
  termId: TermId,
  principalIds: z.array(PrincipalId),
  reason: GrantRevocationReason,
  occurredAt: z.iso.datetime(),
});
/** A workspace event. */
export type WorkspaceEvent = z.infer<typeof WorkspaceEvent>;

/**
 * The audit record of one workspace deletion, written in the same commit that marks the workspace
 * `deleted`, so there is exactly one per deletion however often the job is interrupted. Identifiers
 * and times only: it never names what the workspace held.
 */
export const WorkspaceDeletionRecord = AuditEventBase.extend({
  action: z.literal("workspace.storage-deleted"),
  target: z.strictObject({
    workspaceId: WorkspaceId,
    ownerPrincipalId: PrincipalId,
    offeringId: OfferingId,
    termId: TermId,
  }),
  /** When the term closed and when retention made the workspace eligible, so the deletion can be checked against policy. */
  retention: z.strictObject({ closedAt: z.iso.datetime(), eligibleFrom: z.iso.datetime() }),
});
/** A workspace deletion record. */
export type WorkspaceDeletionRecord = z.infer<typeof WorkspaceDeletionRecord>;

/** Everything the workspace directory stores for one district. */
export const WorkspaceState = z.strictObject({
  workspaces: z.array(Workspace),
  grants: z.array(CourseGrant),
  closures: z.array(TermClosure),
  promotions: z.array(PromotionLink),
  /** The outbox, oldest first. */
  events: z.array(WorkspaceEvent),
  /** One audit record per workspace the retention job deleted, oldest first. */
  deletions: z.array(WorkspaceDeletionRecord),
});
/** The workspace directory's stored state. */
export type WorkspaceState = z.infer<typeof WorkspaceState>;

/**
 * How long a course workspace is kept after its term closes before it becomes eligible for
 * deletion. It may belong in the policy floor (F03) later.
 */
export const RetentionPolicy = z.strictObject({
  courseWorkspaceRetentionDays: z.int().positive(),
});
/** A retention policy. */
export type RetentionPolicy = z.infer<typeof RetentionPolicy>;

/** What closing a term would change, in counts only, for the admin UI. */
export interface TermRolloverPreview {
  termId: TermId;
  /** The term's state in the directory. Only a `completed` term can be closed. */
  termState: TermState;
  /** Whether {@link TermClosure} has already been recorded for the term. */
  alreadyClosed: boolean;
  /** Whether `closeTerm` would run now: the term is completed and not yet closed. */
  canClose: boolean;
  /** The term's offerings. Each gets one `course-ai-funding.cancelled` event. */
  offerings: number;
  /** Course workspaces in the term that closing moves to `retained`, and how many of them are on legal hold. */
  workspaces: { toRetain: number; onLegalHold: number };
  /** Live course grants that closing revokes. */
  grants: { toRevoke: number };
  /** Principals actively enrolled in the term's offerings, who lose live course access. */
  principals: { students: number; staff: number };
}
