import { z } from "zod";
import { DistrictId, PrincipalId } from "./ids.ts";
import { Scope } from "./scope.ts";
import { TermState } from "./academic.ts";
import type { PrincipalKind, RoleAssignment } from "./identity.ts";

/**
 * The authorization vocabulary every SchoolOS service and Gatekeeper speaks (ADR-0005). These are
 * closed enums on purpose: a request naming an action or resource kind outside them fails to
 * parse, and a request that cannot be parsed is denied. Adding a member is a contract change.
 */

/** What a principal is trying to do. */
export const Action = z.enum([
  "read",
  "list",
  "create",
  "update",
  "delete",
  "submit",
  "review",
  "grade",
  "publish",
  "approve",
  "assign",
  "export",
  "share",
  "configure",
  "invoke-tool",
]);
/** An action. */
export type Action = z.infer<typeof Action>;

/** What the action is aimed at. Personal and course spaces are distinct kinds, never one kind with a flag. */
export const ResourceKind = z.enum([
  "district",
  "school",
  "term",
  "course",
  "offering",
  "enrollment",
  "personal-workspace",
  "course-workspace",
  "personal-conversation",
  "shared-conversation",
  "artifact",
  "submission",
  "activity",
  "rubric",
  "assessment-run",
  "feedback",
  "official-grade",
  "learning-resource",
  "capability-config",
  "ai-budget",
  "audit-event",
  /** A purpose-bound, time-limited grant of access to one student's record, such as for an appeal. */
  "access-grant",
  /** A pending request to link a sign-in identity, or adopt an existing Workshop user, into a principal. */
  "identity-link",
]);
/** A resource kind. */
export type ResourceKind = z.infer<typeof ResourceKind>;

/**
 * How sensitive a resource's content is, independent of who owns it. Policy reads this alongside
 * ownership; for example a teacher may see a student's `course` artifacts in their offering but
 * never that student's `personal-private` ones (roadmap §8).
 */
export const Classification = z.enum([
  "public",
  "district-internal",
  "course",
  "teacher-only",
  "personal-private",
  "restricted",
]);
/** A classification. */
export type Classification = z.infer<typeof Classification>;

/** The surface a request arrived through. Every surface is authorized identically (roadmap §6.3). */
export const RequestChannel = z.enum(["http", "mcp-tool", "agent", "system"]);
/** A request channel. */
export type RequestChannel = z.infer<typeof RequestChannel>;

/** The resource an authorization request is about. */
export const ResourceRef = z.strictObject({
  kind: ResourceKind,
  /** The resource's own ID, absent for `create` and `list`, which act on the scope. */
  id: z.string().min(1).optional(),
  scope: Scope,
  classification: Classification,
  /** The principal that owns the resource, when it has one (a student's workspace or artifact). */
  ownerPrincipalId: PrincipalId.optional(),
});
/** A resource reference. */
export type ResourceRef = z.infer<typeof ResourceRef>;

/**
 * A request for one decision. The subject is always a resolved, verified principal: nothing a
 * caller asserts about itself (a role claim, a model's tool argument, an MCP tool annotation)
 * appears here or influences the decision.
 */
export const AuthorizationRequest = z.strictObject({
  subject: z.strictObject({ principalId: PrincipalId, districtId: DistrictId }),
  action: Action,
  resource: ResourceRef,
  context: z.strictObject({
    channel: RequestChannel,
    /** The state of the term the resource belongs to, when it belongs to one. */
    termState: TermState.optional(),
  }),
});
/** An authorization request. */
export type AuthorizationRequest = z.infer<typeof AuthorizationRequest>;

/** A principal whose identity the transport has already verified: the subject of every request. */
export type VerifiedPrincipal = AuthorizationRequest["subject"];

/**
 * Who is calling and through which surface. `principal` must come from verified authentication
 * (an HTTP handler's principal resolver, an MCP session), never from a request body or a tool
 * argument.
 */
export interface Caller {
  /** The verified principal. */
  principal: VerifiedPrincipal;
  /** The surface the request arrived through. Every surface is authorized identically. */
  channel: RequestChannel;
  /**
   * Groups every decision one invocation makes, nested service calls included, under one audit
   * correlation ID. Absent, each decision gets its own.
   */
  correlationId?: string;
}

/**
 * What an authorizer knows about a subject, read from the directory rather than from the request.
 * A principal that is not `active` is still known, but holds no roles.
 */
export interface PrincipalFacts {
  /** The principal's district. */
  districtId: DistrictId;
  /** Whether the principal is a student, staff member or service. */
  kind: PrincipalKind;
  /** The roles in force at the time of the lookup. */
  roles: RoleAssignment[];
}

/**
 * Why a request was not simply allowed. Reasons go to audit logs and to administrators
 * troubleshooting access; they are not shown to the requester, who sees `not-found` or
 * `forbidden` (see `errors.ts`).
 */
export const DecisionReason = z.enum([
  "no-matching-grant",
  "cross-district",
  "owner-only",
  "classification-restricted",
  "term-not-active",
  "policy-floor",
  "requires-teacher-review",
  "invalid-request",
]);
/** A decision reason. */
export type DecisionReason = z.infer<typeof DecisionReason>;

/**
 * The outcome of one authorization request. `require-approval` means a human with authority must
 * confirm before the action takes effect, as with an AI-suggested grade (roadmap §7).
 */
export const Decision = z.discriminatedUnion("effect", [
  z.strictObject({ effect: z.literal("allow") }),
  z.strictObject({ effect: z.literal("deny"), reason: DecisionReason }),
  z.strictObject({ effect: z.literal("require-approval"), reason: DecisionReason }),
]);
/** An authorization decision. */
export type Decision = z.infer<typeof Decision>;

/** How one authorization is recorded. */
export interface AuthorizeOptions {
  /** The audit correlation ID of the invocation the decision belongs to (see {@link Caller}). */
  correlationId?: string;
}

/** Decides authorization requests. Implementations must deny anything they were not written to allow. */
export interface Authorizer {
  /**
   * Decides one request. It receives unvalidated input and must deny anything that does not parse.
   * An implementation that audits records the decision under `options.correlationId` when given.
   */
  authorize(request: unknown, options?: AuthorizeOptions): Promise<Decision>;
}

/**
 * The checks every {@link Authorizer} applies before its own rules: the request parses, and the
 * subject and resource are in the same district. Returns the parsed request, or the denial.
 */
export function precheckAuthorization(
  request: unknown,
): { ok: true; request: AuthorizationRequest } | { ok: false; decision: Decision } {
  const parsed = AuthorizationRequest.safeParse(request);
  if (!parsed.success) return { ok: false, decision: { effect: "deny", reason: "invalid-request" } };
  if (parsed.data.subject.districtId !== parsed.data.resource.scope.districtId) {
    return { ok: false, decision: { effect: "deny", reason: "cross-district" } };
  }
  return { ok: true, request: parsed.data };
}
