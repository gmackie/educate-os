// Git's smart HTTP protocol as a `GitTransport` for Cloudflare Artifacts remotes, built on
// gatekeeper-kit's pkt-line framing and send-pack client. It is a separate entry point
// (`@schoolos/artifacts-git/smart-http`), typechecked against the Workers types the kit's transport
// module is written for (see `tsconfig.transport.json`).
import type { GitOid } from "@gadgets/workshop-shared/gatekeeper";
import { DELIM_PKT, encodePktLine, FLUSH_PKT, parsePktItems, pktText, pushGitRefUpdate } from "@gadgets/gatekeeper-kit/git-transport";
import { readBytesCapped } from "@gadgets/gatekeeper-kit/response-body";
import { SchoolOsError } from "@schoolos/contracts";
import { ARTIFACTS_TOKEN_USERNAME, type BranchUpdate, type GitTransport } from "./artifacts-api.ts";
import { concat, encodePack, type GitObject } from "./git-objects.ts";

/** The largest ref listing {@link SmartHttpGitTransport} reads. */
const MAX_LS_REFS_RESPONSE_BYTES = 64 * 1024;

/**
 * {@link GitTransport} over Git's smart HTTP protocol, using gatekeeper-kit's pkt-line framing and
 * send-pack client. `fetch` is injected so the caller owns timeouts and outbound policy.
 */
export class SmartHttpGitTransport implements GitTransport {
  readonly #fetch: typeof fetch;

  constructor(fetchImpl: typeof fetch) {
    this.#fetch = fetchImpl;
  }

  async readBranch(remote: string, token: string, branch: string): Promise<GitOid | null> {
    const refName = `refs/heads/${branch}`;
    const body = concat([
      encodePktLine("command=ls-refs"),
      DELIM_PKT,
      encodePktLine(`ref-prefix ${refName}`),
      FLUSH_PKT,
    ]);
    const response = await this.#fetch(`${remote}/git-upload-pack`, {
      method: "POST",
      headers: { ...authorization(token), "Content-Type": "application/x-git-upload-pack-request", "Git-Protocol": "version=2" },
      body,
    });
    await assertOk(response);
    for (const item of parsePktItems(await readBytesCapped(response, MAX_LS_REFS_RESPONSE_BYTES))) {
      if (item.kind !== "data") continue;
      const [oid, name] = pktText(item.data).split(" ");
      if (name === refName && oid !== undefined) return oid;
    }
    return null;
  }

  async push(remote: string, token: string, update: BranchUpdate, objects: readonly GitObject[]): Promise<void> {
    const pack = new Blob([await encodePack(objects)]).stream();
    await pushGitRefUpdate(async (requestBody) => {
      const response = await this.#fetch(`${remote}/git-receive-pack`, {
        method: "POST",
        headers: { ...authorization(token), "Content-Type": "application/x-git-receive-pack-request" },
        body: requestBody,
      });
      await assertOk(response);
      return response;
    }, update, pack); // A BranchUpdate is the kit's GitRefUpdate.
  }
}

function authorization(token: string): Record<string, string> {
  return { Authorization: `Basic ${btoa(`${ARTIFACTS_TOKEN_USERNAME}:${token}`)}` };
}

async function assertOk(response: Response): Promise<void> {
  if (response.ok) return;
  await response.body?.cancel().catch(() => {});
  if (response.status === 401 || response.status === 403) {
    throw new SchoolOsError("forbidden", "The project's storage refused this access.");
  }
  throw new SchoolOsError("unavailable", "The project's storage is unavailable; try again later.");
}
