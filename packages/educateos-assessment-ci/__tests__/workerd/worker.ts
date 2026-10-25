// Test worker for the workerd suite: a Durable Object holding one district's assessment runs over
// `DurableObjectAssessmentRunStore`, so concurrent claims arrive as separate requests to one object.

import { DurableObject } from "cloudflare:workers";
import { EducateOsError, type AssessmentRunId } from "@educateos/contracts";
import type { AssessmentRun } from "../../src/index.ts";
import { DurableObjectAssessmentRunStore } from "../../src/durable-object-store.ts";

/** What a store call came to, since an error's class does not survive the RPC boundary. */
export type Result = { ok: true } | { ok: false; code: string };

/** One district's assessment runs. */
export class TestRuns extends DurableObject {
  readonly #store = new DurableObjectAssessmentRunStore(this.ctx.storage);

  async get(id: AssessmentRunId): Promise<AssessmentRun | undefined> {
    return this.#store.get(id);
  }

  async insert(run: AssessmentRun): Promise<AssessmentRun> {
    return this.#store.insert(run);
  }

  async replace(next: AssessmentRun, expectedRevision: number): Promise<Result> {
    try {
      await this.#store.replace(next, expectedRevision);
      return { ok: true };
    } catch (error) {
      if (error instanceof EducateOsError) return { ok: false, code: error.code };
      throw error;
    }
  }

  async runnable(staleBefore: string, limit: number): Promise<AssessmentRun[]> {
    return this.#store.runnable(new Date(staleBefore), limit);
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response(null, { status: 404 });
  },
};
