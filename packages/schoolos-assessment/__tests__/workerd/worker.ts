// Test worker for the workerd suite: a Durable Object holding one district's assessment records
// over `DurableObjectAssessmentRecordStore`, as a deployed district Worker does, so concurrent
// commits arrive as separate requests to one object.

import { DurableObject } from "cloudflare:workers";
import { SchoolOsError } from "@schoolos/contracts";
import type { AssessmentState, StoredAssessment } from "../../src/index.ts";
import { DurableObjectAssessmentRecordStore } from "../../src/durable-object-store.ts";

/** What a commit came to, since an error's class does not survive the RPC boundary. */
export type CommitResult = { ok: true } | { ok: false; code: string };

/** One district's assessment records. */
export class TestRecords extends DurableObject {
  readonly #store = new DurableObjectAssessmentRecordStore(this.ctx.storage);

  /** The stored records. */
  async load(): Promise<StoredAssessment> {
    return this.#store.load();
  }

  /** Commits `next` over `expectedVersion`. */
  async commit(next: AssessmentState, expectedVersion: number): Promise<CommitResult> {
    try {
      await this.#store.commit(next, expectedVersion);
      return { ok: true };
    } catch (error) {
      if (error instanceof SchoolOsError) return { ok: false, code: error.code };
      throw error;
    }
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response(null, { status: 404 });
  },
};
