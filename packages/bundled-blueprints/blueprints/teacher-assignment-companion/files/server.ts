import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { getPreparation, savePreparation, preparationMarkdown, type Preparation, type BoardApi } from "@gadgets/bundled-blueprints/libraries/teacher-board/server";
import type { GoogleClassroomCourseSession } from "./lib/connector.d.ts";
import { readSource } from "./lib/source.ts";

/** Only the selected connector session is available, never the owner's account capability. */
interface BoardEnv { CLASSROOM?: GoogleClassroomCourseSession; }

export class Gadget extends DurableObject<BoardEnv> implements BoardApi {
  getPreparation() { return getPreparation(this.ctx.storage); }
  savePreparation(value: Preparation) { return savePreparation(this.ctx.storage, value); }
  refresh(input: string) { return readSource(this.env.CLASSROOM, input); }
}

/** Export only local teacher preparation; source records retain their provider access checks. */
export class ExportHandler extends WorkerEntrypoint {
  async getExportFormats() {
    return [{ id: "markdown", label: "Preparation (Markdown)", mode: "server" as const, contentType: "text/markdown", fileExtension: ".md" }];
  }
  async export(board: Pick<BoardApi, "getPreparation">, id: string): Promise<ReadableStream<Uint8Array>> {
    if (id !== "markdown") throw new Error("Unsupported preparation export format.");
    return new Response(preparationMarkdown(await board.getPreparation())).body!;
  }
}
