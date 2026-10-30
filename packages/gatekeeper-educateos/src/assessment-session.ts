import { z } from "zod";
import type { VerifiedPrincipal } from "@educateos/contracts";
import type { SchoolToolService } from "./district.ts";
import type { DistrictResponse } from "./school-app-api.ts";
import type { GadgetSourceCheckpoint } from "@gadgets/workshop-shared/gatekeeper";

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

/** Source captured by the Workshop, retained unchanged until the student decides. */
export interface AssessmentCheckpointChange {
  assignmentId: string;
  requestId: string;
  blueprint: z.infer<typeof pinSchema>;
  checkpoint: GadgetSourceCheckpoint;
}

/** Dependencies held privately by a single-assignment student capability. */
export interface AssessmentSessionHost {
  district: SchoolToolService;
  account(): Promise<VerifiedPrincipal>;
  observe(): Promise<void>;
  submit(change: AssessmentChange): Promise<void>;
  /** Only the trusted Workshop queue supplies this method; no Gadget argument supplies source. */
  checkpoint?(): Promise<GadgetSourceCheckpoint>;
  submitCheckpoint?(change: AssessmentCheckpointChange): Promise<void>;
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
  #preview?: AssessmentCheckpointChange;
  #previewGeneration = 0;

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

  /** Stage this executable's exact source in this session; no source reaches the district yet. */
  async previewCurrentGadget(): Promise<string> {
    const generation = ++this.#previewGeneration;
    this.#preview = undefined;
    if (!this.#host.checkpoint || !this.#host.submitCheckpoint || !this.#host.district.gadgetAssessmentSubmitCheckpoint) {
      throw new Error("Current Gadget submission is unavailable.");
    }
    const view = JSON.parse(await this.#read());
    const blueprint = pinSchema.parse(view.blueprint.blueprint);
    const checkpoint = structuredClone(await this.#host.checkpoint());
    if (checkpoint.blueprint.id !== blueprint.id || checkpoint.blueprint.commitId !== blueprint.commitId) {
      throw new Error("This Gadget does not use the assignment's reviewed Blueprint release.");
    }
    const preview: AssessmentCheckpointChange = {
      assignmentId: this.#assignmentId,
      requestId: crypto.randomUUID(),
      blueprint,
      checkpoint,
    };
    await this.#host.observe();
    if (generation !== this.#previewGeneration) throw new Error("This source preview was replaced. Preview your Gadget again.");
    this.#preview = preview;
    return JSON.stringify(preview);
  }

  /** Queue exactly the staged preview, without accepting caller-supplied source or provenance. */
  async submitCurrentGadget(previewId: string): Promise<void> {
    const preview = this.#preview;
    if (!preview || preview.requestId !== previewId || !this.#host.submitCheckpoint) throw new Error("Preview the current Gadget before submitting it.");
    const view = JSON.parse(await this.#read());
    const blueprint = pinSchema.parse(view.blueprint.blueprint);
    if (JSON.stringify(blueprint) !== JSON.stringify(preview.blueprint)) {
      throw new Error("The assignment's reviewed release changed. Preview your Gadget again.");
    }
    if (this.#preview !== preview) throw new Error("This source preview was replaced. Preview your Gadget again.");
    // Consume before awaiting submission so two calls cannot queue the same preview concurrently.
    this.#preview = undefined;
    await this.#host.submitCheckpoint(preview);
  }
}
