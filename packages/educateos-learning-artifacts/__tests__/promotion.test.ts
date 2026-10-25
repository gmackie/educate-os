import { describe, expect, it } from "vitest";
import { ArtifactContentSweeper } from "../src/index.ts";
import { essay, FALL, O, P, rejectsWith, setup } from "./setup.ts";

/** Amara's Biology essay (two revisions) and her journal, then the fall term completed and closed. */
async function closedClass() {
  const ctx = setup();
  const { artifacts, workspaces, changeDirectory } = ctx;
  const bio = await workspaces.ensureCourseWorkspace(P.amara, O.bioFall);
  const elenaBio = await workspaces.ensureCourseWorkspace(P.elena, O.bioFall);
  const draft = await artifacts.createArtifact(P.amara, { ...essay(bio.id, "Draft"), aiAssistance: { level: "assisted", modelId: "claude-example" } });
  const final = await artifacts.saveRevision(P.amara, draft.artifact.id, { content: { kind: "text", mediaType: "text/markdown", text: "Final essay" }, aiAssistance: { level: "assisted", modelId: "claude-example" } });
  const elenaWork = await artifacts.createArtifact(P.elena, essay(elenaBio.id, "Elena's essay"));
  await changeDirectory((d) => {
    d.terms.find((t) => t.id === FALL)!.state = "completed";
  });
  await workspaces.closeTerm(P.nfAdmin, FALL);
  return { ...ctx, bio, essayId: draft.artifact.id, final, elenaWork };
}

describe("promoting work from a closed class", () => {
  it("copies the latest revision into the personal workspace as personal-private work, with provenance", async () => {
    const { artifacts, workspaces, records, bio, essayId, final } = await closedClass();
    const link = await workspaces.promoteArtifact(P.amara, bio.id, essayId);

    const [copy] = await artifacts.listArtifacts(P.amara, link.toWorkspaceId);
    expect(copy!.artifact).toMatchObject({ classification: "personal-private", workspaceId: link.toWorkspaceId, ownerPrincipalId: "prn_nf-student-amara", title: "Cell membranes essay" });
    expect(copy!.head).toMatchObject({
      number: 1,
      content: final.head.content,
      aiAssistance: { level: "assisted", modelId: "claude-example" },
      provenance: { origin: "promoted", channel: "http", source: { workspaceId: bio.id, artifactId: essayId, revisionId: final.head.id } },
    });
    expect(copy!.head.parentRevisionId).toBeUndefined();
    expect((await artifacts.readRevision(P.amara, copy!.artifact.id)).content).toEqual({ kind: "text", text: "Final essay" });
    // The teacher could read the class work, but the kept copy is the student's alone.
    await rejectsWith(artifacts.getArtifact(P.morgan, copy!.artifact.id), "not-found");

    // Promoting again, or copying the same link again, makes no second copy.
    expect(await workspaces.promoteArtifact(P.amara, bio.id, essayId)).toEqual(link);
    expect((await artifacts.copyPromoted(P.amara, link)).artifact.id).toBe(copy!.artifact.id);
    expect((await records.load()).state.artifacts.filter((a) => a.workspaceId === link.toWorkspaceId)).toHaveLength(1);
  });

  it("records no link for an artifact that is not the caller's or not in that workspace", async () => {
    const { workspaces, workspaceStore, bio, elenaWork } = await closedClass();
    await rejectsWith(workspaces.promoteArtifact(P.amara, bio.id, elenaWork.artifact.id), "not-found");
    expect((await workspaceStore.load()).state.promotions).toEqual([]);
  });

  it("copies only a link the workspace directory recorded for the caller", async () => {
    const { artifacts, workspaces, bio, essayId } = await closedClass();
    const personal = await workspaces.ensurePersonalWorkspace(P.amara);
    const forged = { principalId: P.amara.principal.principalId, fromWorkspaceId: bio.id, toWorkspaceId: personal.id, artifactId: essayId, promotedAt: "2026-10-20T12:00:00.000Z" };
    await rejectsWith(artifacts.copyPromoted(P.amara, forged), "not-found");
    const link = await workspaces.promoteArtifact(P.amara, bio.id, essayId);
    await rejectsWith(artifacts.copyPromoted(P.elena, link), "not-found");
  });

  it("keeps the copy's content when the class's own copy is gone", async () => {
    const { artifacts, workspaces, records, text, bucket, clock, bio, essayId } = await closedClass();
    const link = await workspaces.promoteArtifact(P.amara, bio.id, essayId);
    // As the retention job's eraser would: the class workspace's artifacts are removed outright.
    const { state, version } = await records.load();
    const doomed = new Set(state.artifacts.filter((a) => a.workspaceId === bio.id).map((a) => a.id));
    await records.commit({ ...state, artifacts: state.artifacts.filter((a) => !doomed.has(a.id)), revisions: state.revisions.filter((r) => !doomed.has(r.artifactId)) }, version);
    clock.now = new Date(clock.now.getTime() + 60_000);
    const swept = await new ArtifactContentSweeper({ records, text, r2: bucket, gracePeriodMs: 0, now: () => clock.now }).sweep();
    expect(swept.text).toBe(1); // The draft, which nothing references any more.

    const [copy] = await artifacts.listArtifacts(P.amara, link.toWorkspaceId);
    expect((await artifacts.readRevision(P.amara, copy!.artifact.id)).content).toEqual({ kind: "text", text: "Final essay" });
  });
});
