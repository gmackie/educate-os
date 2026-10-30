import type {
  WorkshopCapabilityDescriptor, WorkshopCapabilityPolicy,
} from "@gadgets/workshop-shared/capability-policy";

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
