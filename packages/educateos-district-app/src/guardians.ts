// Guardian routes (ADR-0012, SCHO-188): the read-only family surface, and a district admin's
// management of guardian relationships and onboarding. Kept apart from app.ts so the guardian
// surface reads as one piece; app.ts builds the request context these handlers run in.
import {
  guardianRelationshipInForce,
  EducateOsError,
  type Action,
  type Caller,
  type DistrictDirectorySnapshot,
  type OfferingId,
  type PrincipalId,
  type ResourceRef,
  type VerifiedPrincipal,
} from "@educateos/contracts";
import type { ResolvedPrincipal } from "@educateos/identity";
import type { AssessmentService } from "@educateos/assessment";
import type { GuardianRelationships, PolicyDecider } from "@educateos/policy";
import type { GuardianInvitations, IdentityLinkAdminService } from "@educateos/identity-links";
import type { Announcement } from "./communication/model.ts";
import { isQuizActivityId } from "./quizzes.ts";
import type { ParsedRouteInput, RouteResponse } from "./routes.ts";
import type { DistrictAppStores } from "./stores.ts";

/** The routes this module handles. The onboarding route is app.ts's, as it runs before sign-in resolves. */
export type GuardianRouteName =
  | "guardian.listChildren"
  | "guardian.childOfferings"
  | "guardian.childCourse"
  | "admin.guardianStudents"
  | "admin.studentGuardians"
  | "admin.inviteGuardian"
  | "admin.confirmGuardian"
  | "admin.updateGuardianScope"
  | "admin.suspendGuardian"
  | "admin.resumeGuardian"
  | "admin.revokeGuardian"
  | "admin.approveIdentityRequest"
  | "admin.rejectIdentityRequest";

/** What a guardian route handler needs from app.ts's request context. */
export interface GuardianRequestContext {
  readonly principal: Pick<ResolvedPrincipal, "districtId" | "principalId">;
  readonly snapshot: DistrictDirectorySnapshot;
  readonly caller: Caller;
  readonly subject: VerifiedPrincipal;
  readonly decider: PolicyDecider;
  /** The request's origin, which an invitation link defaults to. */
  readonly origin: string;
  assessment(): AssessmentService;
  /**
   * An offering's published announcements, newest first, as the policy engine lets the caller read
   * them: none where it does not.
   */
  publishedAnnouncements(offeringId: OfferingId): Promise<Announcement[]>;
  guardianRelationships(): GuardianRelationships;
  guardianInvitations(): GuardianInvitations;
  identityLinks(): IdentityLinkAdminService;
  require(action: Action, resource: ResourceRef, message: string): Promise<void>;
}

/** What the guardian handlers are built from. */
export interface GuardianHandlerOptions {
  stores: DistrictAppStores;
  /** The guardian invitation page, absolute or relative to the request's origin. */
  invitationPage: string | undefined;
  now: () => Date;
}

/** The link a guardian redeems: the invitation page, with the token as its fragment so no server logs it. */
export function guardianInvitationUrl(page: string | undefined, origin: string, token: string): string {
  const url = new URL(page ?? "/family/invitation", origin);
  url.hash = new URLSearchParams({ invitation: token }).toString();
  return url.toString();
}

type GuardianHandlers<C> = { [N in GuardianRouteName]: (ctx: C, input: ParsedRouteInput<N>) => Promise<RouteResponse<N>> };

const notFound = (): EducateOsError => new EducateOsError("not-found", "We couldn't find that.");

/** The records a read found, or none where the reader may not see them (`not-found`). */
async function orNone<T>(read: Promise<T[]>): Promise<T[]> {
  return read.catch((error: unknown) => {
    if (error instanceof EducateOsError && error.code === "not-found") return [];
    throw error;
  });
}

/** A decided identity request as the admin routes answer it. */
function identityOutcome(outcome: Awaited<ReturnType<IdentityLinkAdminService["approve"]>>) {
  return { requestId: outcome.request.requestId, status: outcome.request.status === "rejected" ? "rejected" as const : "approved" as const };
}

/** The student, or `not-found`. */
function requireStudent(snapshot: DistrictDirectorySnapshot, studentId: PrincipalId) {
  const student = snapshot.principals.find((p) => p.id === studentId && p.kind === "student");
  if (student === undefined) throw notFound();
  return student;
}

/**
 * The guardian routes' handlers. Guardian reads are built from the child's own view and decided
 * by the policy engine with the guardian as subject, so a guardian never sees more than the child:
 *
 * - **Children** come from the guardian's relationships that are in force, to active students. A
 *   child the guardian has no such relationship to answers `not-found`, as one that does not exist.
 * - **Offerings** are the child's active student enrollments, each a `read` of the `offering`.
 * - **A course** is the child's assignments in it (a `list` and `read` of `activity`), with the
 *   feedback released to the child, as the child sees it (`AssessmentService.releasedFeedback`, a
 *   `read` of `feedback`), the child's official grades (a `read` of `official-grade`), and the
 *   class's published announcements (a `list` of `announcement`). No submission, artifact or
 *   workspace is ever read for a guardian.
 *
 * The admin routes are a district admin's, decided by the services they call.
 */
export function guardianHandlers<C extends GuardianRequestContext>(options: GuardianHandlerOptions): GuardianHandlers<C> {
  const { stores, now } = options;

  /** The child, if the guardian holds a relationship in force to them as an active student. */
  const childOf = async (ctx: C, studentId: PrincipalId): Promise<{ principalId: PrincipalId; displayName: string } | undefined> =>
    (await childrenOf(ctx)).find((child) => child.principalId === studentId);

  const childrenOf = async (ctx: C): Promise<{ principalId: PrincipalId; displayName: string }[]> => {
    const at = now();
    const relationships = (await stores.guardianRelationships.listForGuardian(ctx.principal.principalId))
      .filter((r) => r.districtId === ctx.principal.districtId && guardianRelationshipInForce(r, at));
    const children = new Map<PrincipalId, string>();
    for (const r of relationships) {
      const student = ctx.snapshot.principals.find((p) => p.id === r.studentPrincipalId && p.kind === "student" && p.status === "active");
      if (student !== undefined) children.set(student.id, student.displayName);
    }
    return [...children].map(([principalId, displayName]) => ({ principalId, displayName })).toSorted((a, b) => a.displayName.localeCompare(b.displayName));
  };

  /** The child's offering with its course, if the child is actively enrolled in it and the engine lets the guardian read it. */
  const readableOffering = async (ctx: C, studentId: PrincipalId, offeringId: OfferingId) => {
    const enrolled = ctx.snapshot.enrollments.some((e) =>
      e.principalId === studentId && e.offeringId === offeringId && e.role === "student" && e.status === "active");
    const offering = ctx.snapshot.offerings.find((o) => o.id === offeringId);
    const course = ctx.snapshot.courses.find((c) => c.id === offering?.courseId);
    const term = ctx.snapshot.terms.find((t) => t.id === offering?.termId);
    if (!enrolled || offering === undefined || course === undefined || term === undefined) return undefined;
    const { decision } = await ctx.decider.decide({
      subject: ctx.subject,
      action: "read",
      resource: {
        kind: "offering",
        id: offering.id,
        scope: { level: "offering", districtId: offering.districtId, schoolId: offering.schoolId, offeringId: offering.id },
        classification: "district-internal",
      },
      context: { channel: "http", termState: term.state },
    });
    return decision.effect === "allow" ? { offering, course, term } : undefined;
  };

  return {
    "guardian.listChildren": async (ctx) =>
      (await childrenOf(ctx)).map(({ principalId, displayName }) => ({ studentPrincipalId: principalId, displayName })),

    "guardian.childOfferings": async (ctx, { params }) => {
      if (await childOf(ctx, params.studentId) === undefined) throw notFound();
      const offeringIds = new Set(ctx.snapshot.enrollments
        .filter((e) => e.principalId === params.studentId && e.role === "student" && e.status === "active")
        .map((e) => e.offeringId));
      const visible = [];
      for (const offeringId of offeringIds) {
        const readable = await readableOffering(ctx, params.studentId, offeringId);
        if (readable !== undefined) visible.push(readable);
      }
      return visible;
    },

    "guardian.childCourse": async (ctx, { params }) => {
      if (await childOf(ctx, params.studentId) === undefined) throw notFound();
      const readable = await readableOffering(ctx, params.studentId, params.offeringId);
      if (readable === undefined) throw notFound();
      const assessment = ctx.assessment();
      const assignments = [];
      for (const assignment of await orNone(assessment.listAssignments(ctx.caller, params.offeringId))) {
        assignments.push({
          assignment: {
            id: assignment.id,
            offeringId: assignment.offeringId,
            title: assignment.title,
            dueAt: assignment.dueAt,
            kind: isQuizActivityId(assignment.activityId) ? "quiz" as const : "activity" as const,
          },
          feedback: await assessment.releasedFeedback(ctx.caller, assignment.id, params.studentId),
          grades: await orNone(assessment.officialGrades(ctx.caller, assignment.id, params.studentId)),
        });
      }
      return {
        ...readable,
        assignments: assignments.toSorted((a, b) => a.assignment.dueAt.localeCompare(b.assignment.dueAt)),
        // Decided with the guardian as subject, so a relationship whose scope leaves announcements out shows none.
        announcements: await ctx.publishedAnnouncements(params.offeringId),
      };
    },

    "admin.guardianStudents": async (ctx) => {
      await ctx.require("list", {
        kind: "guardian-relationship",
        scope: { level: "district", districtId: ctx.principal.districtId },
        classification: "restricted",
      }, "Only a district administrator can manage guardians.");
      return ctx.snapshot.principals
        .filter((p) => p.kind === "student")
        .map(({ id, displayName, status }) => ({ principalId: id, displayName, status }))
        .toSorted((a, b) => a.displayName.localeCompare(b.displayName));
    },

    "admin.studentGuardians": async (ctx, { params }) => {
      const service = ctx.guardianRelationships();
      const relationships = await service.listForStudent(ctx.caller, params.studentId);
      const student = requireStudent(ctx.snapshot, params.studentId);
      const invitations = await ctx.guardianInvitations().listForStudent(ctx.caller, params.studentId);
      const open = await ctx.identityLinks().listPending(ctx.caller);
      const pendingSignIns = invitations.flatMap((invitation) => {
        const requestId = invitation.redeemed?.requestId;
        const request = requestId === undefined ? undefined : open.find((r) => r.requestId === requestId);
        if (request?.kind !== "identity-link") return [];
        const { issuer, subject } = request.link.identity;
        return [{
          requestId: request.requestId,
          invitationId: invitation.id,
          guardianDisplayName: invitation.guardianDisplayName,
          signIn: { issuer, subject },
          requestedAt: request.link.requestedAt,
        }];
      });
      const rows = [];
      for (const relationship of relationships) {
        const guardian = ctx.snapshot.principals.find((p) => p.id === relationship.guardianPrincipalId && p.kind === "guardian");
        rows.push({
          relationship,
          ...(guardian === undefined ? {} : { guardianDisplayName: guardian.displayName }),
          guardianActive: guardian?.status === "active",
          history: await service.history(ctx.caller, relationship.id),
        });
      }
      return { student: { principalId: student.id, displayName: student.displayName }, relationships: rows, invitations, pendingSignIns };
    },

    "admin.inviteGuardian": async (ctx, { params, body }) => {
      const issued = await ctx.guardianInvitations().invite(ctx.caller, { ...body, studentPrincipalId: params.studentId });
      return {
        invitation: issued.invitation,
        relationship: issued.relationship,
        invitationUrl: guardianInvitationUrl(options.invitationPage, ctx.origin, issued.token),
        delivery: "share-link" as const,
      };
    },
    "admin.confirmGuardian": (ctx, { params }) => ctx.guardianRelationships().confirm(ctx.caller, params.relationshipId),
    "admin.updateGuardianScope": (ctx, { params, body }) => ctx.guardianRelationships().updateScope(ctx.caller, params.relationshipId, body),
    "admin.suspendGuardian": (ctx, { params, body }) => ctx.guardianRelationships().suspend(ctx.caller, params.relationshipId, body.reason),
    "admin.resumeGuardian": (ctx, { params }) => ctx.guardianRelationships().resume(ctx.caller, params.relationshipId),
    "admin.revokeGuardian": (ctx, { params }) => ctx.guardianRelationships().revoke(ctx.caller, params.relationshipId),
    "admin.approveIdentityRequest": async (ctx, { params }) => identityOutcome(await ctx.identityLinks().approve(ctx.caller, params.requestId)),
    "admin.rejectIdentityRequest": async (ctx, { params }) => identityOutcome(await ctx.identityLinks().reject(ctx.caller, params.requestId)),
  };
}
