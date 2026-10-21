import { z } from "zod";
import { Action, DecisionReason, DistrictId, PrincipalId, RequestChannel, ResourceKind } from "@schoolos/contracts";

/**
 * One authorization decision as written to the audit trail (`policy_audit_event`, roadmap §10).
 * It names who asked, for what, the outcome, and the rule that decided it. It never carries
 * content: no resource body, prompt, tool argument or message, only identifiers and closed
 * vocabulary. Fields are absent when the request was too malformed to supply them.
 */
export const PolicyAuditEvent = z.strictObject({
  /** Links this decision to the caller's error body and to other decisions in the same invocation. */
  correlationId: z.string().min(1).max(128),
  /** When the decision was made. */
  decidedAt: z.iso.datetime(),
  /** The subject. */
  principalId: PrincipalId.optional(),
  /** The subject's district. */
  districtId: DistrictId.optional(),
  /** The requested action. */
  action: Action.optional(),
  /** The resource's kind. */
  resourceKind: ResourceKind.optional(),
  /** The resource's ID, absent for `create` and `list`. */
  resourceId: z.string().min(1).optional(),
  /** The channel the request arrived through. */
  channel: RequestChannel.optional(),
  /** The decision. */
  effect: z.enum(["allow", "deny", "require-approval"]),
  /** Why it was not simply allowed. */
  reason: DecisionReason.optional(),
  /** The rule that decided, or a `precheck.*` / `subject.*` / `default.*` pseudo-rule. */
  ruleId: z.string().min(1),
});
/** A policy audit event. */
export type PolicyAuditEvent = z.infer<typeof PolicyAuditEvent>;

/**
 * Where audit events go. The engine awaits `record` before returning a decision, and a sink that
 * throws fails the authorization, so no decision takes effect unrecorded.
 */
export interface PolicyAuditSink {
  /** Stores one event. */
  record(event: PolicyAuditEvent): Promise<void>;
}
