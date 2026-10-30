import type {
  WorkshopCapabilityDescriptor, WorkshopCapabilityPolicy,
} from "@gadgets/workshop-shared/capability-policy";

/**
 * The policy actions that admit execution in a workspace (SCHO-309). A principal admitted for one
 * is rechecked for it, together with their district standing, for as long as the workspace
 * instance that admitted them lives; see OverseerImpl.admitPrincipal().
 */
export type ExecutionAction = "gadget.execute" | "agent.execute";

export const EXECUTION_ACTIONS: readonly ExecutionAction[] = ["gadget.execute", "agent.execute"];

/**
 * The bound on how long a principal's live capabilities outlast their loss of standing: how often
 * a workspace rechecks the principals it has admitted, and a user object its watched sessions.
 */
export const STANDING_RECHECK_MS = 60_000;

/** Why execution was refused while (or because) a workspace is restarting to revoke someone. */
export const STANDING_REVOKED_MESSAGE =
    "Workshop access changed for someone in this workspace; it is restarting. Please reconnect.";

/** Check immediately before a protected operation; never cache an authorization decision. */
export async function assertCapability(
    policy: Pick<WorkshopCapabilityPolicy, "authorizeCapability"> | undefined,
    request: WorkshopCapabilityDescriptor): Promise<void> {
  if (policy === undefined) return;
  let decision;
  try {
    decision = await policy.authorizeCapability(request);
  } catch {
    // Do not expose service errors, which may contain private policy records.
    throw new Error(`Workshop policy unavailable; ${request.action} was refused. Try again later.`);
  }
  if (decision?.outcome === "allow") return;
  if (decision?.outcome === "deny" && typeof decision.message === "string" && decision.message) {
    throw new Error(`Workshop policy denied ${request.action}: ${decision.message}`);
  }
  throw new Error(`Workshop policy did not allow ${request.action}.`);
}

/** Refuse a misconfigured mandatory-policy deployment before any protected work. */
export function hasCapabilityPolicy(env: {
  REQUIRE_WORKSHOP_CAPABILITY_POLICY?: string;
  WORKSHOP_CAPABILITY_POLICY?: unknown;
} | undefined): boolean {
  const required = env?.REQUIRE_WORKSHOP_CAPABILITY_POLICY;
  if (required !== undefined && required !== "true" && required !== "false") {
    throw new Error("Invalid REQUIRE_WORKSHOP_CAPABILITY_POLICY setting.");
  }
  if (required === "true" && env?.WORKSHOP_CAPABILITY_POLICY === undefined) {
    throw new Error("Required Workshop capability policy is unavailable.");
  }
  return env?.WORKSHOP_CAPABILITY_POLICY !== undefined;
}
