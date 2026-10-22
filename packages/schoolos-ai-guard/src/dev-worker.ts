// The guard as `pnpm dev-server --with-ai-guard` and PR previews run it: the production guard and
// ledger, with three development stand-ins. Never part of a release, whose entry is worker.ts.
//
// - Hall Monitor is the in-process fake (fake-hall-monitor.ts): it allows everything unless the
//   text carries a marker such as `[[block]]` or `[[support]]`, so moderation can be exercised
//   with no Hall Monitor deployment or signing key.
// - `AI_GUARD_CONFIG` defaults to the synthetic dev config (dev-config.ts) when the var is unset.
// - Users nobody bound resolve to the config's catch-all binding (`DEV_ANY_USER`), because dev
//   user IDs can't be known in advance. Production refuses an unbound user.

import { WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { createHallMonitorClient, serviceBindingTransport } from "@gmacko/hall-monitor-client";
import type {
  AiCallDecision,
  AiCallDescriptor,
  AiCallGuard,
  AiCallModelOutput,
  AiCallOutcome,
  AiCallOutputDecision,
} from "@gadgets/workshop-shared/ai-call-guard";
import type { AiPrincipal, AiWorkspaceContext } from "@schoolos/ai-governance";
import { type GuardConfig, readGuardConfig } from "./config.ts";
import { type GuardContext, type GuardContextResolver, StaticGuardContextResolver } from "./context.ts";
import { DEV_ANY_USER, DEV_GUARD_CONFIG } from "./dev-config.ts";
import { fakeHallMonitor } from "./fake-hall-monitor.ts";
import { AiCallGuardService } from "./guard.ts";
import { DistrictAiLedger as ProductionLedger } from "./ledger-object.ts";

const DEV_GUARD_CONFIG_JSON = JSON.stringify(DEV_GUARD_CONFIG);

/** The env with `AI_GUARD_CONFIG` defaulted to the dev config. */
export function withDevConfig(env: Cloudflare.Env): Cloudflare.Env {
  return env.AI_GUARD_CONFIG ? env : { ...env, AI_GUARD_CONFIG: DEV_GUARD_CONFIG_JSON };
}

/**
 * The static resolver, falling back to the `DEV_ANY_USER` binding for a person nobody bound. An
 * agent initiator still resolves to nothing, as in production.
 */
export class DevGuardContextResolver implements GuardContextResolver {
  readonly #static: StaticGuardContextResolver;

  constructor(config: GuardConfig) {
    this.#static = new StaticGuardContextResolver(config);
  }

  async resolve(call: Pick<AiCallDescriptor, "initiator" | "gadgetId">): Promise<GuardContext | null> {
    const bound = await this.#static.resolve(call);
    if (bound !== null || call.initiator.type === "agent") return bound;
    return this.#static.resolve({ ...call, initiator: { ...call.initiator, id: DEV_ANY_USER } });
  }

  /**
   * The static lookup by principal. A call admitted through the catch-all is recorded under that
   * binding's principal, so this finds it too.
   */
  async resolveAdmitted(principal: AiPrincipal, workspace: AiWorkspaceContext): Promise<GuardContext | null> {
    return this.#static.resolveAdmitted(principal, workspace);
  }
}

/** The production ledger, reading the dev config when `AI_GUARD_CONFIG` is unset. */
export class DistrictAiLedger extends ProductionLedger {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, withDevConfig(env));
  }
}

/** `AI_CALL_GUARD` for development: the production decisions over the stand-ins above. */
@validateRpc()
export class SchoolOsAiCallGuard extends WorkerEntrypoint<Cloudflare.Env> implements AiCallGuard {
  /** Reserves the call's spend and moderates its new messages; see `AiCallGuardService`. */
  async beforeModelCall(call: AiCallDescriptor): Promise<AiCallDecision> {
    return this.#service().beforeModelCall(call);
  }

  /** Settles the call's spend exactly once; see `AiCallGuardService`. */
  async afterModelCall(outcome: AiCallOutcome): Promise<void> {
    return this.#service().afterModelCall(outcome);
  }

  /** Screens a held response before the Workshop releases it; see `AiCallGuardService`. */
  async screenModelOutput(callId: string, output: AiCallModelOutput): Promise<AiCallOutputDecision> {
    return this.#service().screenModelOutput(callId, output);
  }

  #service(): AiCallGuardService {
    const config = readGuardConfig(withDevConfig(this.env).AI_GUARD_CONFIG);
    return new AiCallGuardService({
      config,
      ledger: this.ctx.exports.DistrictAiLedger.getByName(config.districtId),
      resolver: new DevGuardContextResolver(config),
      hallMonitor: createHallMonitorClient({
        transport: serviceBindingTransport({ fetch: fakeHallMonitor }),
        timeoutMs: config.moderation.timeoutMs,
      }),
    });
  }
}

export default {
  /** The guard has no HTTP surface. */
  async fetch(): Promise<Response> {
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Cloudflare.Env>;
