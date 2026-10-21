import { describe, expect, it } from "vitest";
import { ArtifactId, SchoolOsError, type Caller, type WorkspaceId } from "@schoolos/contracts";
import type { ArtifactPromoter, PromotionLink } from "../src/index.ts";
import { O, P, rejectsWith, setTermState, setup, T } from "./setup.ts";

/** A promoter that confirms only `promotable` and records each copy it is asked for. */
class FakePromoter implements ArtifactPromoter {
  readonly confirmed: ArtifactId[] = [];
  readonly copies: PromotionLink[] = [];
  readonly promotable: ArtifactId;
  failCopy = false;

  constructor(promotable: ArtifactId) {
    this.promotable = promotable;
  }

  async confirmPromotable(_caller: Caller, _from: WorkspaceId, artifactId: ArtifactId): Promise<void> {
    this.confirmed.push(artifactId);
    if (artifactId !== this.promotable) throw new SchoolOsError("not-found", `artifact ${artifactId} was not found.`);
  }

  async copyPromoted(_caller: Caller, link: PromotionLink): Promise<void> {
    if (this.failCopy) throw new SchoolOsError("unavailable", "storage is unavailable");
    this.copies.push(link);
  }
}

const essay = ArtifactId.parse("art_cell-respiration-essay");
const elsewhere = ArtifactId.parse("art_not-in-this-workspace");

async function closedWith(promoter: FakePromoter) {
  const ctx = setup(undefined, { promoter });
  const amaraBio = await ctx.workspaces.ensureCourseWorkspace(P.amara, O.bioFall);
  await ctx.changeDirectory((d) => setTermState(d, T.fall, "completed"));
  await ctx.workspaces.closeTerm(P.nfAdmin, T.fall);
  return { ...ctx, amaraBio };
}

describe("promotion through the artifact service", () => {
  it("records no link for an artifact the artifact service does not confirm", async () => {
    const promoter = new FakePromoter(essay);
    const { workspaces, store, amaraBio } = await closedWith(promoter);
    await rejectsWith(workspaces.promoteArtifact(P.amara, amaraBio.id, elsewhere), "not-found");
    expect(promoter.confirmed).toEqual([elsewhere]);
    expect(promoter.copies).toEqual([]);
    expect((await store.load()).state.promotions).toEqual([]);
  });

  it("copies after the link is recorded, and a retry after a failed copy completes it", async () => {
    const promoter = new FakePromoter(essay);
    const { workspaces, store, amaraBio } = await closedWith(promoter);
    promoter.failCopy = true;
    await rejectsWith(workspaces.promoteArtifact(P.amara, amaraBio.id, essay), "unavailable");
    const [link] = (await store.load()).state.promotions;
    expect(link).toMatchObject({ fromWorkspaceId: amaraBio.id, artifactId: essay });

    promoter.failCopy = false;
    expect(await workspaces.promoteArtifact(P.amara, amaraBio.id, essay)).toEqual(link);
    expect(promoter.copies).toEqual([link]);
    expect((await store.load()).state.promotions).toHaveLength(1);
  });

  it("asks nothing of the artifact service for someone else's workspace", async () => {
    const promoter = new FakePromoter(essay);
    const { workspaces, amaraBio } = await closedWith(promoter);
    await rejectsWith(workspaces.promoteArtifact(P.elena, amaraBio.id, essay), "not-found");
    expect(promoter.confirmed).toEqual([]);
  });
});
