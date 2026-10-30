import { WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { BlueprintReleaseSource } from "@gadgets/workshop-shared/api";
import { readBlueprintReleaseSource } from "./blueprint-archive.js";
import { readBlueprintKvRecord } from "./storage-schema/blueprints-kv.js";

/**
 * Read-only service-binding capability for district assessment verification. Cloudflare authenticates
 * possession of the installer-created binding; this entrypoint is not exposed by HTTP. Published
 * Blueprint IDs already grant public read access in PublicApi, including unlisted publications.
 * Private Gadget state, owner identities, bindings and chat are never read here.
 */
@validateRpc()
export class WorkshopAssessmentReleases extends WorkerEntrypoint<Cloudflare.Env> {
  /** Return source only after verifying the exact published release's Git pack and commit. */
  async getBlueprintRelease(id: string, commitId: string): Promise<BlueprintReleaseSource> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || !await readBlueprintKvRecord(this.env, id)) {
      throw new Error("Published Blueprint not found.");
    }
    return readBlueprintReleaseSource(this.env, id, commitId);
  }
}
