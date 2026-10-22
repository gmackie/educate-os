import { describe, expect, it } from "vitest";
import { ArtifactContentSweeper, sha256Digest, type ContentProvider, type RegisteredContentRef, type RevisionContentInput } from "../src/index.ts";
import { P, rejectsWith, setup } from "./setup.ts";

const encoder = new TextEncoder();

/** A provider holding bytes by key, which a test can tamper with. */
class MapProvider implements ContentProvider {
  readonly name = "project-store";
  readonly objects = new Map<string, Uint8Array<ArrayBuffer>>();

  async read(ref: RegisteredContentRef): Promise<Uint8Array<ArrayBuffer> | null> {
    return this.objects.get(ref.key) ?? null;
  }
}

async function withProvider() {
  const provider = new MapProvider();
  const ctx = setup(undefined, { providers: [provider] });
  const personal = await ctx.workspaces.ensurePersonalWorkspace(P.amara);
  const bytes = encoder.encode("{\"files\":[]}");
  provider.objects.set("repo-1/v1", bytes);
  const content: RevisionContentInput & { kind: "registered" } = {
    kind: "registered",
    provider: "project-store",
    key: "repo-1/v1",
    mediaType: "application/json",
    digest: await sha256Digest(bytes),
  };
  return { ...ctx, provider, personal, content };
}

describe("content held by a registered provider", () => {
  it("is recorded as a reference to the provider, and read back through it", async () => {
    const { artifacts, personal, content } = await withProvider();
    const view = await artifacts.createArtifact(P.amara, { workspaceId: personal.id, type: "dataset", title: "Readings", content, aiAssistance: { level: "none" } });
    expect(view.head.content).toEqual({ backend: "registered", provider: "project-store", key: "repo-1/v1", digest: content.digest });
    expect(view.head.provenance.origin).toBe("registered");
    expect((await artifacts.readRevision(P.amara, view.artifact.id)).content).toEqual({ kind: "bytes", bytes: encoder.encode("{\"files\":[]}") });
    expect(artifacts.hasContentProvider("project-store")).toBe(true);
  });

  it("is refused unless the provider is registered and holds bytes matching the digest", async () => {
    const { artifacts, provider, personal, content, records } = await withProvider();
    const create = (c: typeof content) => artifacts.createArtifact(P.amara, { workspaceId: personal.id, type: "dataset", title: "Readings", content: c, aiAssistance: { level: "none" } });
    await rejectsWith(create({ ...content, provider: "elsewhere" }), "validation-failed");
    await rejectsWith(create({ ...content, key: "repo-1/missing" }), "unavailable");
    provider.objects.set("repo-1/v1", encoder.encode("tampered"));
    await rejectsWith(create(content), "unavailable");
    expect((await records.load()).state.artifacts).toEqual([]);
  });

  it("fails its integrity check on read if the provider's bytes change, and is never swept", async () => {
    const { artifacts, provider, personal, content, records, text, bucket, clock } = await withProvider();
    const view = await artifacts.createArtifact(P.amara, { workspaceId: personal.id, type: "dataset", title: "Readings", content, aiAssistance: { level: "none" } });
    clock.now = new Date(clock.now.getTime() + 60_000);
    expect(await new ArtifactContentSweeper({ records, text, r2: bucket, gracePeriodMs: 0, now: () => clock.now }).sweep()).toEqual({ text: 0, r2: 0 });
    expect(provider.objects.has("repo-1/v1")).toBe(true);

    provider.objects.set("repo-1/v1", encoder.encode("tampered"));
    await rejectsWith(artifacts.readRevision(P.amara, view.artifact.id), "unavailable");
  });
});
