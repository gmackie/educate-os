// The SchoolOS AI call guard Worker (SCH-01b, ADR-0007). The Workshop backend binds its
// `SchoolOsAiCallGuard` entrypoint as `AI_CALL_GUARD`; the district ledger is the
// `DistrictAiLedger` Durable Object, reached through `ctx.exports`. README.md explains the design.

import { WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { AiCallDecision, AiCallDescriptor, AiCallGuard, AiCallOutcome } from "@gadgets/workshop-shared/ai-call-guard";
import { readGuardConfig } from "./config.ts";
import { StaticGuardContextResolver } from "./context.ts";
import { AiCallGuardService } from "./guard.ts";
import { hallMonitorClient } from "./hall-monitor.ts";

export { DistrictAiLedger } from "./ledger-object.ts";

/** The `AI_CALL_GUARD` entrypoint: SchoolOS budgets and Hall Monitor moderation around every model call. */
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

  #service(): AiCallGuardService {
    const config = readGuardConfig(this.env.AI_GUARD_CONFIG);
    return new AiCallGuardService({
      config,
      ledger: this.ctx.exports.DistrictAiLedger.getByName(config.districtId),
      resolver: new StaticGuardContextResolver(config),
      hallMonitor: hallMonitorClient(this.env, config),
    });
  }
}

export default {
  /** The guard has no HTTP surface. */
  async fetch(): Promise<Response> {
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Cloudflare.Env>;
