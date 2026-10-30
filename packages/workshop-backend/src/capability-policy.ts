import type {
  WorkshopCapabilityDescriptor, WorkshopCapabilityPolicy,
} from "@gadgets/workshop-shared/capability-policy";

/** Refuse execution until descendant capabilities support transitive policy revocation. */
export function assertRevocableExecution(
    env: Pick<Cloudflare.Env, "WORKSHOP_CAPABILITY_POLICY"> | undefined): void {
  if (env?.WORKSHOP_CAPABILITY_POLICY !== undefined) {
    throw new Error("Workshop execution is disabled with capability policy: transitive revocation is unavailable.");
  }
}

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
