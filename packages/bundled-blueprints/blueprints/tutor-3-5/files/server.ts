// Homework Helper's Durable Object: the conversation and the calls to the model. The
// conversation loop, the prompt and the privacy filter are the tutor library's; who the tutor is,
// and how it talks, is lib/persona.ts.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import {
  TutorSession,
  transcriptMarkdown,
  type TutorApi,
  type TutorModel,
  type TutorReply,
  type TutorState,
} from "@gadgets/bundled-blueprints/libraries/tutor/server";
import { PERSONA } from "./lib/persona.ts";

/** What the Workshop binds into this gadget: the blueprint's AI model, as `LLM`. */
interface TutorEnv {
  LLM?: TutorModel;
}

export class Gadget extends DurableObject<TutorEnv, unknown> implements TutorApi {
  #session = new TutorSession(PERSONA, this.ctx.storage, () => this.env.LLM);

  getState(): Promise<TutorState> {
    return this.#session.getState();
  }

  ask(message: string): Promise<TutorReply> {
    return this.#session.ask(message);
  }

  setTopic(topic: string): Promise<TutorState> {
    return this.#session.setTopic(topic);
  }

  reset(): Promise<TutorState> {
    return this.#session.reset();
  }
}

// An export format as the Workshop lists it: a `server` format is produced by ExportHandler.export.
interface ExportFormat {
  id: string;
  label: string;
  mode: "server" | "browser";
  contentType: string;
  fileExtension: string;
}

const EXPORT_FORMATS: ExportFormat[] = [
  { id: "markdown", label: "Conversation (Markdown)", mode: "server", contentType: "text/markdown", fileExtension: ".md" },
];

/** Exports the conversation, so a learner can hand it to their teacher. */
export class ExportHandler extends WorkerEntrypoint {
  async getExportFormats(): Promise<ExportFormat[]> {
    return EXPORT_FORMATS;
  }

  async export(gadget: Pick<TutorApi, "getState">, id: string): Promise<ReadableStream<Uint8Array>> {
    if (id !== "markdown") throw new Error("Unsupported tutor export format: " + id);
    return new Response(transcriptMarkdown(PERSONA, await gadget.getState())).body!;
  }
}
