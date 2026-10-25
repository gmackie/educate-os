import type { TermState } from "@educateos/contracts";
import type { RetentionPolicy, TermClosure, Workspace, WorkspaceLifecycle } from "./model.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The facts a workspace's lifecycle is derived from. None of them is the roster. */
export interface LifecycleFacts {
  /** The state of the course workspace's term. Absent for a personal workspace. */
  termState?: TermState;
  /** The term's closure, once `closeTerm` has run. */
  closure?: TermClosure;
  /** The retention policy in force. */
  retention: RetentionPolicy;
  /** The time to evaluate at. */
  now: Date;
}

/**
 * A workspace's lifecycle state, derived rather than stored so it can never drift from the term.
 *
 * - A personal workspace is permanent: always `active`.
 * - A course workspace follows its term until the term is closed, then is `retained`, and once the
 *   retention period has passed is `eligible-for-deletion`, unless a legal hold keeps it retained.
 *   It stays `eligible-for-deletion` while the retention job deletes it, and is `deleted` after.
 *
 * Enrollment is deliberately not an input: a student leaving the roster changes their access, never
 * how long their work is kept (roadmap §6.1, §14).
 */
export function workspaceLifecycle(workspace: Workspace, facts: LifecycleFacts): WorkspaceLifecycle {
  if (workspace.kind === "personal") return "active";
  if (workspace.deletion?.state === "deleted") return "deleted";
  if (facts.termState === undefined) throw new Error(`course workspace ${workspace.id} has no term state`);
  if (facts.termState !== "completed") return facts.termState;
  if (facts.closure === undefined) return "completed";
  if (workspace.deletion?.state === "pending") return "eligible-for-deletion";
  if (workspace.legalHold !== undefined || facts.now.getTime() < eligibleFrom(facts.closure, facts.retention).getTime()) return "retained";
  return "eligible-for-deletion";
}

/** When a closed term's course workspaces become eligible for deletion, legal holds aside. */
export function eligibleFrom(closure: TermClosure, retention: RetentionPolicy): Date {
  return new Date(Date.parse(closure.closedAt) + retention.courseWorkspaceRetentionDays * DAY_MS);
}
