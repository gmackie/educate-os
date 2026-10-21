// Test worker for the workerd suite: a Durable Object holding one district's optional runs,
// overrides and releases over `DurableObjectOptionalRunStore`.

import { DurableObject } from "cloudflare:workers";
import { SchoolOsError, type AssessmentRunId, type SubmissionId } from "@schoolos/contracts";
import type { AiRelease, OptionalRun, TeacherOverride } from "../../src/index.ts";
import { DurableObjectOptionalRunStore } from "../../src/durable-object-store.ts";

/** What a store call came to, since an error's class does not survive the RPC boundary. */
export type Result = { ok: true } | { ok: false; code: string };

/** One district's optional runs. */
export class TestOptionalRuns extends DurableObject {
  readonly #store = new DurableObjectOptionalRunStore(this.ctx.storage);

  async getRun(id: AssessmentRunId): Promise<OptionalRun | undefined> {
    return this.#store.getRun(id);
  }

  async insertRun(run: OptionalRun): Promise<OptionalRun> {
    return this.#store.insertRun(run);
  }

  async replaceRun(next: OptionalRun, expectedRevision: number): Promise<Result> {
    try {
      await this.#store.replaceRun(next, expectedRevision);
      return { ok: true };
    } catch (error) {
      if (error instanceof SchoolOsError) return { ok: false, code: error.code };
      throw error;
    }
  }

  async runsFor(submissionId: SubmissionId): Promise<OptionalRun[]> {
    return this.#store.runsFor(submissionId);
  }

  async addOverride(override: TeacherOverride): Promise<void> {
    await this.#store.addOverride(override);
  }

  async overridesFor(submissionId: SubmissionId): Promise<TeacherOverride[]> {
    return this.#store.overridesFor(submissionId);
  }

  async addRelease(release: AiRelease): Promise<void> {
    await this.#store.addRelease(release);
  }

  async releasesFor(submissionId: SubmissionId): Promise<AiRelease[]> {
    return this.#store.releasesFor(submissionId);
  }

  /** Tries to rewrite stored overrides directly, as a bug or a compromised path might. */
  async rewriteOverrides(): Promise<string> {
    try {
      this.ctx.storage.sql.exec("UPDATE schoolos_optional_run_overrides SET override_json = '{}'");
      return "rewritten";
    } catch (error) {
      return error instanceof Error ? error.message : "refused";
    }
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response(null, { status: 404 });
  },
};
