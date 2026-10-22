// Test worker for the workerd suite: a Durable Object that hosts one district's audit trail over
// `DurableObjectPolicyAuditSink`, the way a deployed district Worker does, so a policy engine in
// the calling Worker records each decision through the object's RPC stub.

import { DurableObject } from "cloudflare:workers";
import type { PolicyAuditEvent } from "../../src/index.ts";
import { DurableObjectPolicyAuditSink, type StoredPolicyAuditEvent } from "../../src/durable-object-audit-sink.ts";

/** One district's append-only policy audit trail. */
export class TestAuditTrail extends DurableObject {
  readonly #sink: DurableObjectPolicyAuditSink;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.#sink = new DurableObjectPolicyAuditSink(ctx.storage);
  }

  /** Records one decision. */
  async record(event: PolicyAuditEvent): Promise<void> {
    await this.#sink.record(event);
  }

  /** A page of the trail. */
  async read(afterSeq: number, limit: number): Promise<StoredPolicyAuditEvent[]> {
    return this.#sink.read({ afterSeq, limit });
  }

  /** One invocation's decisions. */
  async forCorrelation(correlationId: string): Promise<PolicyAuditEvent[]> {
    return this.#sink.forCorrelation(correlationId);
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response(null, { status: 404 });
  },
};
