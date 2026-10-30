import { z } from "zod";
import type { VerifiedPrincipal } from "@educateos/contracts";
import type { SchoolToolService } from "./district.ts";
import type { DistrictResponse } from "./school-app-api.ts";

const revisionsSchema = z.array(z.strictObject({
  artifactId: z.string().regex(/^art_[A-Za-z0-9_-]+$/),
  revisionId: z.string().regex(/^rev_[A-Za-z0-9_-]+$/),
})).min(1).max(50);
const pinSchema = z.strictObject({ id: z.string(), commitId: z.string().regex(/^[a-f0-9]{40}$/), sourceDigest: z.string() });

/** A queued submission fixes the assignment, release and revision IDs before user approval. */
export interface AssessmentChange {
  assignmentId: string;
  blueprint: z.infer<typeof pinSchema>;
  revisions: z.infer<typeof revisionsSchema>;
}

/** Dependencies held privately by a single-assignment student capability. */
export interface AssessmentSessionHost {
  district: SchoolToolService;
  account(): Promise<VerifiedPrincipal>;
  observe(): Promise<void>;
  submit(change: AssessmentChange): Promise<void>;
}

/** Refuse failed district responses without leaking backend diagnostics into a Gadget. */
export function requireAssessmentResponse(response: DistrictResponse): string {
  if (response.status < 200 || response.status >= 300) throw new Error(`Assessment access refused (${response.status}).`);
  return response.body;
}

/** The assignment is captured once; callers cannot substitute identity, policy or a release. */
export class AssessmentSessionCore {
  readonly #assignmentId: string;
  readonly #host: AssessmentSessionHost;

  constructor(assignmentId: string, host: AssessmentSessionHost) {
    this.#assignmentId = z.string().regex(/^asg_[A-Za-z0-9_-]+$/).parse(assignmentId);
    this.#host = host;
  }

  async #read(): Promise<string> {
    const district = this.#host.district;
    if (!district.gadgetAssessmentRead) throw new Error("Assessment capability unavailable.");
    return requireAssessmentResponse(await district.gadgetAssessmentRead(await this.#host.account(), this.#assignmentId));
  }

  /** Read through current district policy, recording the observation before returning content. */
  async read(): Promise<string> {
    const body = await this.#read();
    await this.#host.observe();
    return body;
  }

  /** Queue a frozen request. The district checks ownership and policy again when it is applied. */
  async submit(raw: unknown): Promise<void> {
    const revisions = revisionsSchema.parse(raw);
    const view = JSON.parse(await this.#read());
    const blueprint = pinSchema.parse(view.blueprint.blueprint);
    await this.#host.submit({ assignmentId: this.#assignmentId, blueprint, revisions });
  }
}
