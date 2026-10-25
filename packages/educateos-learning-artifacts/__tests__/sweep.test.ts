import { describe, expect, it } from "vitest";
import { ArtifactId, type WorkspaceId } from "@educateos/contracts";
import {
  ArtifactContentSweeper,
  InMemoryArtifactRecordStore,
  type ArtifactRecordStore,
  type ArtifactState,
  type InlineTextTable,
} from "../src/index.ts";
import { essay, P, rejectsWith, setup } from "./setup.ts";

const HOUR_MS = 60 * 60 * 1000;
const GRACE_MS = 24 * HOUR_MS;

/** A record store that runs a hook once, just before the next commit, as a concurrent request would. */
class RacingRecordStore implements ArtifactRecordStore {
  readonly #inner = new InMemoryArtifactRecordStore();
  beforeNextCommit: (() => Promise<void>) | undefined;

  load() {
    return this.#inner.load();
  }

  async commit(next: ArtifactState, expectedVersion: number): Promise<void> {
    const hook = this.beforeNextCommit;
    this.beforeNextCommit = undefined;
    await hook?.();
    await this.#inner.commit(next, expectedVersion);
  }
}

function sweeperFor(ctx: ReturnType<typeof setup>, text: InlineTextTable = ctx.text) {
  return new ArtifactContentSweeper({ records: ctx.records, text, r2: ctx.bucket, gracePeriodMs: GRACE_MS, batchSize: 2, now: () => ctx.clock.now });
}

const pdf = (workspaceId: WorkspaceId, marker: string) => ({
  workspaceId,
  type: "document" as const,
  title: "Field notes",
  content: { kind: "bytes" as const, mediaType: "application/pdf", bytes: new TextEncoder().encode(`%PDF ${marker}`) },
  aiAssistance: { level: "none" as const },
});

describe("the content retention sweep", () => {
  it("deletes only the content no revision references, once it is older than the grace period", async () => {
    const ctx = setup();
    const { artifacts, workspaces, text, bucket, clock } = ctx;
    const personal = await workspaces.ensurePersonalWorkspace(P.amara);
    const kept = await artifacts.createArtifact(P.amara, essay(personal.id, "Kept essay"));
    const pinnedDraft = await artifacts.createArtifact(P.amara, essay(personal.id, "Pinned draft"));
    await artifacts.pin(P.amara, pinnedDraft.artifact.id, pinnedDraft.head.id, { kind: "keep" });
    await artifacts.deleteArtifact(P.amara, pinnedDraft.artifact.id);
    const gone = await artifacts.createArtifact(P.amara, essay(personal.id, "Deleted essay"));
    const scans = [];
    for (const marker of ["a", "b", "c"]) scans.push(await artifacts.createArtifact(P.amara, pdf(personal.id, marker)));
    await artifacts.deleteArtifact(P.amara, gone.artifact.id);
    for (const scan of scans.slice(1)) await artifacts.deleteArtifact(P.amara, scan.artifact.id);

    // Within the grace period nothing is touched, referenced or not.
    expect(await sweeperFor(ctx).sweep()).toEqual({ text: 0, r2: 0 });
    clock.now = new Date(clock.now.getTime() + GRACE_MS);
    expect(await sweeperFor(ctx).sweep()).toEqual({ text: 1, r2: 2 });

    expect((await text.list()).map((c) => c.key).toSorted()).toEqual([kept.head.content.key, pinnedDraft.head.content.key].toSorted());
    expect((await bucket.list()).objects.map((o) => o.key)).toEqual([scans[0]!.head.content.key]);
    // What is left still reads, including the pinned revision of the deleted draft.
    expect((await artifacts.readRevision(P.amara, kept.artifact.id)).content).toEqual({ kind: "text", text: "Kept essay" });
    expect((await artifacts.readRevision(P.amara, pinnedDraft.artifact.id, pinnedDraft.head.id)).content).toEqual({ kind: "text", text: "Pinned draft" });
    expect((await ctx.records.load()).state.sweeping).toBeUndefined();
    expect(await sweeperFor(ctx).sweep()).toEqual({ text: 0, r2: 0 });
  });

  it("never deletes content a save of identical bytes committed a reference to while it ran", async () => {
    const records = new RacingRecordStore();
    const ctx = setup(undefined, { records });
    const { artifacts, workspaces, clock } = ctx;
    const personal = await workspaces.ensurePersonalWorkspace(P.amara);
    const old = await artifacts.createArtifact(P.amara, essay(personal.id, "Photosynthesis notes"));
    await artifacts.deleteArtifact(P.amara, old.artifact.id);
    clock.now = new Date(clock.now.getTime() + GRACE_MS);

    // The save finds the old bytes still stored and skips writing them; the whole sweep then runs
    // between that and the save's commit, which therefore fails its version check and retries.
    records.beforeNextCommit = async () => {
      expect(await sweeperFor(ctx).sweep()).toEqual({ text: 1, r2: 0 });
    };
    const again = await artifacts.createArtifact(P.amara, essay(personal.id, "Photosynthesis notes"));
    expect(again.head.content.digest).toBe(old.head.content.digest);
    expect((await artifacts.readRevision(P.amara, again.artifact.id)).content).toEqual({ kind: "text", text: "Photosynthesis notes" });
  });

  it("refuses a save of content it has marked, and finishes an interrupted sweep on its next run", async () => {
    const ctx = setup();
    const { artifacts, workspaces, text, clock } = ctx;
    const personal = await workspaces.ensurePersonalWorkspace(P.amara);
    const old = await artifacts.createArtifact(P.amara, essay(personal.id, "Mitosis summary"));
    await artifacts.deleteArtifact(P.amara, old.artifact.id);
    clock.now = new Date(clock.now.getTime() + GRACE_MS);

    const failing: InlineTextTable = {
      get: (key) => text.get(key),
      put: (key, value) => text.put(key, value),
      list: () => text.list(),
      delete: async () => {
        throw new Error("the sweep stopped");
      },
    };
    await expect(sweeperFor(ctx, failing).sweep()).rejects.toThrow("the sweep stopped");
    expect((await ctx.records.load()).state.sweeping).toEqual([{ backend: "text", key: old.head.content.key }]);
    await rejectsWith(artifacts.createArtifact(P.amara, essay(personal.id, "Mitosis summary")), "conflict");

    expect(await sweeperFor(ctx).sweep()).toEqual({ text: 1, r2: 0 });
    expect((await ctx.records.load()).state.sweeping).toBeUndefined();
    const saved = await artifacts.createArtifact(P.amara, essay(personal.id, "Mitosis summary"));
    expect((await artifacts.readRevision(P.amara, saved.artifact.id)).content).toEqual({ kind: "text", text: "Mitosis summary" });
  });

  it("keeps starter material's source content once the source is deleted, through its baseline pin", async () => {
    const ctx = setup();
    const { artifacts, workspaces, clock } = ctx;
    const personal = await workspaces.ensurePersonalWorkspace(P.morgan);
    const source = await artifacts.createArtifact(P.morgan, essay(personal.id, "Enzyme lab starter"));
    const pin = await artifacts.pin(P.morgan, source.artifact.id, source.head.id, { kind: "baseline", baselineId: ArtifactId.parse("art_enzyme-starter") });
    expect(pin.consumer).toEqual({ kind: "baseline", baselineId: "art_enzyme-starter" });
    // The owner cannot release a baseline pin as if it were their own keep.
    await rejectsWith(artifacts.unpin(P.morgan, source.artifact.id, source.head.id), "not-found");

    expect(await artifacts.deleteArtifact(P.morgan, source.artifact.id)).toEqual({ keptRevisions: 1 });
    clock.now = new Date(clock.now.getTime() + GRACE_MS);
    expect(await sweeperFor(ctx).sweep()).toEqual({ text: 0, r2: 0 });
    expect((await artifacts.readRevision(P.morgan, source.artifact.id, source.head.id)).content).toEqual({ kind: "text", text: "Enzyme lab starter" });
  });
});
