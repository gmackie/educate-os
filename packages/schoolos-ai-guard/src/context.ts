// Who a model call is for, in SchoolOS terms. The Workshop names only its own user; this port maps
// that to a district principal and everything moderation and funding need to know about them.

import type { AiCallDescriptor } from "@gadgets/workshop-shared/ai-call-guard";
import type { AiPrincipal, AiWorkspaceContext } from "@schoolos/ai-governance";
import type { GradeBand } from "@gmacko/hall-monitor-contracts";
import type { GuardConfig, GuardProfile } from "./config.ts";

/** Everything the guard needs to know about who a call is for. Labels only, never learner data. */
export interface GuardContext {
  /** The district principal the call is billed to. */
  principal: AiPrincipal;
  /** The workspace the call is billed to. */
  workspace: AiWorkspaceContext;
  /** Who reads the model's output. A student audience always fails closed. */
  audience: "student" | "educator";
  /** The principal's verified grade band, when known. */
  gradeBand?: GradeBand;
  /** How the principal's input is moderated. */
  profile: GuardProfile;
}

/**
 * Resolves the {@link GuardContext} of a model call, or `null` when the call's initiator is no
 * principal this deployment serves (it is then refused). Implementations must derive everything
 * from trusted state keyed by the Workshop-authenticated initiator, never from message content.
 */
export interface GuardContextResolver {
  /** The context of `call`, or `null`. */
  resolve(call: Pick<AiCallDescriptor, "initiator" | "gadgetId">): Promise<GuardContext | null>;
}

/**
 * A {@link GuardContextResolver} over the deployment's configured principal bindings. It stands in
 * for `@schoolos/identity` until the district app publishes a resolver the guard can call; until
 * then the bindings are the source of truth. A `user` or `gadget` initiator is looked up by its
 * Workshop user ID (a gadget's calls are its owner's); an `agent` initiator names a model, not a
 * person, and resolves to nothing.
 */
export class StaticGuardContextResolver implements GuardContextResolver {
  readonly #config: GuardConfig;

  constructor(config: GuardConfig) {
    this.#config = config;
  }

  async resolve(call: Pick<AiCallDescriptor, "initiator" | "gadgetId">): Promise<GuardContext | null> {
    if (call.initiator.type === "agent") return null;
    const binding = this.#config.principals.find((candidate) => candidate.workshopUserId === call.initiator.id);
    const profile = binding === undefined ? undefined : this.#config.profiles[binding.profile];
    if (binding === undefined || profile === undefined) return null;
    const gadgetWorkspace = call.gadgetId === undefined ? undefined : binding.gadgetWorkspaces?.[call.gadgetId];
    return {
      principal: { principalId: binding.principalId, districtId: this.#config.districtId },
      workspace: gadgetWorkspace ?? binding.workspace,
      audience: binding.audience,
      ...(binding.gradeBand === undefined ? {} : { gradeBand: binding.gradeBand }),
      profile,
    };
  }
}
