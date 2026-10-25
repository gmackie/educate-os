import { describe, expect, it } from "vitest";
import { encodePktLine, FLUSH_PKT, parsePktItems, pktText } from "@gadgets/gatekeeper-kit/git-transport";
import { NO_COMMIT } from "../src/artifacts-api.ts";
import { concat, encodeTree, FILE_MODE, gitObject } from "../src/git-objects.ts";
import { SmartHttpGitTransport } from "../src/smart-http.ts";

const REMOTE = "https://artifacts.educateos.example/git/sos-1.git";
const HEAD = "a".repeat(40);

/** A fetch that records each request and answers with `respond`. */
function recordingFetch(respond: (url: string, body: Uint8Array) => Response) {
  const requests: { url: string; headers: Headers; body: Uint8Array }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = new Uint8Array(await new Response(init?.body).arrayBuffer());
    const url = String(input);
    requests.push({ url, headers: new Headers(init?.headers), body });
    return respond(url, body);
  }) as typeof fetch;
  return { fetchImpl, requests };
}

describe("the smart HTTP transport", () => {
  it("reads a branch with an ls-refs request, authenticated by the repository token", async () => {
    const { fetchImpl, requests } = recordingFetch(() => new Response(concat([encodePktLine(`${HEAD} refs/heads/main`), FLUSH_PKT])));
    const transport = new SmartHttpGitTransport(fetchImpl);
    expect(await transport.readBranch(REMOTE, "tok", "main")).toBe(HEAD);

    const [request] = requests;
    expect(request!.url).toBe(`${REMOTE}/git-upload-pack`);
    expect(request!.headers.get("Git-Protocol")).toBe("version=2");
    expect(request!.headers.get("Authorization")).toBe(`Basic ${btoa("x-access-token:tok")}`);
    const lines = parsePktItems(request!.body).map((i) => (i.kind === "data" ? pktText(i.data) : i.kind));
    expect(lines).toEqual(["command=ls-refs", "delim", "ref-prefix refs/heads/main", "flush"]);
  });

  it("reads a missing branch as null", async () => {
    const { fetchImpl } = recordingFetch(() => new Response(FLUSH_PKT));
    expect(await new SmartHttpGitTransport(fetchImpl).readBranch(REMOTE, "tok", "main")).toBeNull();
  });

  it("pushes the ref update and a pack of the objects, and reports the server's verdict", async () => {
    const blob = await gitObject("blob", new TextEncoder().encode("print(1)\n") as Uint8Array<ArrayBuffer>);
    const tree = await gitObject("tree", encodeTree([{ name: "lab.py", mode: FILE_MODE, oid: blob.oid }]));
    const built = { tree: tree.oid, objects: [blob, tree] };
    const ok = recordingFetch(() => new Response(concat([encodePktLine("unpack ok"), encodePktLine("ok refs/heads/main"), FLUSH_PKT])));
    await new SmartHttpGitTransport(ok.fetchImpl).push(REMOTE, "tok", { branch: "main", oldSha: NO_COMMIT, newSha: built.tree }, built.objects);
    const body = ok.requests[0]!.body;
    expect(ok.requests[0]!.url).toBe(`${REMOTE}/git-receive-pack`);
    expect(new TextDecoder().decode(body.subarray(4, 4 + 122))).toBe(`${NO_COMMIT} ${built.tree} refs/heads/main\0report-status agent=cloudflare-gadgets\n`.slice(0, 122));
    const packAt = body.indexOf(0x50 /* P */, 4 + 100);
    expect(new TextDecoder().decode(body.subarray(packAt, packAt + 4))).toBe("PACK");
    expect(new DataView(body.buffer, body.byteOffset + packAt + 8, 4).getUint32(0)).toBe(built.objects.length);

    const rejected = recordingFetch(() => new Response(concat([encodePktLine("unpack ok"), encodePktLine("ng refs/heads/main stale info"), FLUSH_PKT])));
    await expect(new SmartHttpGitTransport(rejected.fetchImpl).push(REMOTE, "tok", { branch: "main", oldSha: HEAD, newSha: built.tree }, built.objects)).rejects.toThrow(/stale info/);
  });

  it("maps a refused token to forbidden", async () => {
    const { fetchImpl } = recordingFetch(() => new Response("no", { status: 403 }));
    await expect(new SmartHttpGitTransport(fetchImpl).readBranch(REMOTE, "tok", "main")).rejects.toMatchObject({ code: "forbidden" });
  });
});
