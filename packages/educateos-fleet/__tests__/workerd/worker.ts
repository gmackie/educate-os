// Test worker for the workerd suite: a Durable Object that hosts a district agent's sequence
// counter the way the district's own Worker does, so restarts and concurrent requests reach real
// Durable Object SQLite storage.

import { DurableObject } from "cloudflare:workers";
import type { InstanceId } from "@educateos/contracts";
import { DistrictAgent, type Ed25519PrivateJwk, SigningIdentity } from "../../src/index.ts";
import { DurableObjectSequenceCounter } from "../../src/durable-object-store.ts";

/** One district agent's durable sequence counter. */
export class TestAgent extends DurableObject {
  readonly #sequence: DurableObjectSequenceCounter;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.#sequence = new DurableObjectSequenceCounter(ctx.storage);
  }

  /** The next sequence number. */
  async next(): Promise<number> {
    return this.#sequence.next();
  }

  /** Moves the counter above `floor`. */
  async ensureAbove(floor: number): Promise<void> {
    await this.#sequence.ensureAbove(floor);
  }

  /** A heartbeat signed by the given identity and numbered by this object's counter, as JSON text for the wire. */
  async heartbeat(jwk: Ed25519PrivateJwk, instanceId: InstanceId, sentAt: string): Promise<string> {
    const agent = new DistrictAgent({
      identity: await SigningIdentity.fromJwk(jwk),
      instanceId,
      sequence: this.#sequence,
      sharesAggregateSpend: false,
      now: () => new Date(sentAt),
    });
    return JSON.stringify(await agent.heartbeat({ releaseVersion: "0.1.0", probes: [] }));
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response(null, { status: 404 });
  },
};
