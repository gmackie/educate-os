import type { WorkerEntrypoint } from "cloudflare:workers";

/** Read-only authoring discovery target; no principal, role or authorization claim is accepted. */
export type WorkshopAuthoringTarget = {
  /** Creating a new Gadget or adapting a specific approved Blueprint. */
  operation: "create" | "adapt";
  /** Blueprint being adapted, or the approved starting Blueprint for creation. */
  sourceBlueprintId?: string;
};

/** Advisory visibility only; never a grant, and never reusable to authorize a mutation. */
export type WorkshopAuthoringCapability = {
  /** True only when a configured deployment policy explicitly allows this target now. */
  allowed: boolean;
};

/** Authority requested at a kernel choke point; these values are data, never instructions. */
export type WorkshopCapabilityScope =
  | { action: "workspace.create.query" }
  | ({ action: "workshop.authoring.query" } & WorkshopAuthoringTarget)
  | { action: "gadget.create"; workspaceId: string }
  | { action: "blueprint.import" }
  | { action: "blueprint.publish"; workspaceId: string }
  | { action: "workspace.share"; workspaceId: string }
  | { action: "gadget.execute"; workspaceId: string }
  | { action: "agent.execute"; workspaceId: string }
  | { action: "workspace.create"; workspaceId: string; sourceBlueprintId?: string }
  | { action: "model.configure"; modelId: string; provider: string }
  | { action: "gatekeeper.connect"; vendorId: string; accountId?: number;
      resourceUrlPatterns?: string[] }
  | { action: "resource.acquire"; vendorId: string; accountId?: number; resource: string };

/** Backend-built request. No role, credentials, code, prompts, or private records are sent. */
export type WorkshopCapabilityDescriptor = WorkshopCapabilityScope & {
  /** Persisted Workshop user ID (the principal name on principal-resolver deployments). */
  userId: string;
};

/** Only an explicit allow admits an operation. A denial message must be safe to show the user. */
export type WorkshopCapabilityDecision =
  | { outcome: "allow" }
  | { outcome: "deny"; message: string };

/**
 * Optional deployment service bound as WORKSHOP_CAPABILITY_POLICY. Resolve roles and grants from
 * trusted domain storage, never from request fields or text embedded in resource names. Unknown
 * principals, actions and scopes must deny. Decisions are checked afresh, allowing grant revocation
 * to stop subsequent protected operations. Already-issued raw capabilities and running
 * operations are not transitively revoked by this contract.
 */
export interface WorkshopCapabilityPolicy extends WorkerEntrypoint {
  /** Authorizes one mint. Unavailability, rejection or a malformed decision refuses it. */
  authorizeCapability(request: WorkshopCapabilityDescriptor): Promise<WorkshopCapabilityDecision>;
}
