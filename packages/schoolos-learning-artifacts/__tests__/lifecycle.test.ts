import { describe, expect, it } from "vitest";
import { essay, O, P, rejectsWith, setup } from "./setup.ts";

const text = (value: string) => ({ content: { kind: "text", mediaType: "text/markdown", text: value } as const, aiAssistance: { level: "none" } as const });

describe("a sanitized baseline", () => {
  it("carries the chosen revision's content and none of the source's history", async () => {
    const { artifacts, workspaces, records } = setup();
    const personal = await workspaces.ensurePersonalWorkspace(P.morgan);
    const starter = await artifacts.createArtifact(P.morgan, essay(personal.id, "Lab template.\n\nANSWER KEY: rate doubles every 10C.", "Enzyme lab starter"));
    const cleaned = await artifacts.saveRevision(P.morgan, starter.artifact.id, text("Lab template."));
    await artifacts.saveRevision(P.morgan, starter.artifact.id, text("Lab template.\n\nTeacher note: grade by Friday."));

    const baseline = await artifacts.publishBaseline(P.morgan, starter.artifact.id, cleaned.head.id, "Enzyme lab");

    expect(baseline.artifact.id).not.toBe(starter.artifact.id);
    expect(baseline.head).toMatchObject({ number: 1, provenance: { origin: "baseline", channel: "http" }, authorPrincipalId: P.morgan.principal.principalId });
    expect(baseline.head.parentRevisionId).toBeUndefined();
    expect(baseline.head.content.digest).toBe(cleaned.head.content.digest);
    expect(await artifacts.history(P.morgan, baseline.artifact.id)).toEqual([baseline.head]);
    const exported = await artifacts.exportArtifact(P.morgan, baseline.artifact.id);
    expect(new TextDecoder().decode(exported.bytes)).toBe("Lab template.");
    expect(exported.manifest.lineage).toEqual([]);

    // Nothing stored for the baseline names the source artifact or any of its other revisions.
    const { state } = await records.load();
    const stored = JSON.stringify({
      artifact: state.artifacts.find((a) => a.id === baseline.artifact.id),
      revisions: state.revisions.filter((r) => r.artifactId === baseline.artifact.id),
    });
    expect(stored).not.toContain(starter.artifact.id);
    for (const revision of state.revisions.filter((r) => r.artifactId === starter.artifact.id)) expect(stored).not.toContain(revision.id);
    expect(stored).not.toContain(starter.head.content.digest);
  });

  it("can only be published by the source's owner", async () => {
    const { artifacts, workspaces } = setup();
    const bio = await workspaces.ensureCourseWorkspace(P.amara, O.bioFall);
    const work = await artifacts.createArtifact(P.amara, essay(bio.id, "Amara's lab"));
    // Morgan may read Amara's course work, but not republish it as his own.
    await rejectsWith(artifacts.publishBaseline(P.morgan, work.artifact.id, work.head.id, "Exemplar"), "forbidden");
  });
});

describe("deleting an artifact", () => {
  it("keeps a pinned revision readable and collects the rest", async () => {
    const { artifacts, workspaces } = setup();
    const personal = await workspaces.ensurePersonalWorkspace(P.amara);
    const draft = await artifacts.createArtifact(P.amara, essay(personal.id, "v1"));
    const kept = await artifacts.saveRevision(P.amara, draft.artifact.id, text("v2"));
    await artifacts.saveRevision(P.amara, draft.artifact.id, text("v3"));
    await artifacts.pin(P.amara, draft.artifact.id, kept.head.id, { kind: "keep" });

    expect(await artifacts.deleteArtifact(P.amara, draft.artifact.id)).toEqual({ keptRevisions: 1 });

    // The artifact is gone from every ordinary view...
    await rejectsWith(artifacts.getArtifact(P.amara, draft.artifact.id), "not-found");
    await rejectsWith(artifacts.history(P.amara, draft.artifact.id), "not-found");
    expect(await artifacts.listArtifacts(P.amara, personal.id)).toEqual([]);
    await rejectsWith(artifacts.readRevision(P.amara, draft.artifact.id, draft.head.id), "not-found");
    // ...but the pinned revision survives, verified, for whoever pinned it.
    expect(await artifacts.readRevision(P.amara, draft.artifact.id, kept.head.id)).toMatchObject({
      revision: { id: kept.head.id },
      content: { kind: "text", text: "v2" },
    });
    // Teachers and other students still see nothing.
    await rejectsWith(artifacts.readRevision(P.morgan, draft.artifact.id, kept.head.id), "not-found");

    // Releasing the last pin lets it be collected.
    await artifacts.unpin(P.amara, draft.artifact.id, kept.head.id);
    await rejectsWith(artifacts.readRevision(P.amara, draft.artifact.id, kept.head.id), "not-found");
  });

  it("is refused for course work, which is retained by policy rather than its author", async () => {
    const { artifacts, workspaces, records } = setup();
    const bio = await workspaces.ensureCourseWorkspace(P.amara, O.bioFall);
    const work = await artifacts.createArtifact(P.amara, essay(bio.id, "Lab report"));
    await rejectsWith(artifacts.deleteArtifact(P.amara, work.artifact.id), "forbidden");
    await rejectsWith(artifacts.deleteArtifact(P.morgan, work.artifact.id), "forbidden");
    expect((await records.load()).state.revisions).toHaveLength(1);
  });

  it("cannot drop a pinned revision even by writing the store directly", async () => {
    const { artifacts, workspaces, records } = setup();
    const bio = await workspaces.ensureCourseWorkspace(P.amara, O.bioFall);
    const work = await artifacts.createArtifact(P.amara, essay(bio.id, "Submitted lab"));
    await artifacts.pin(P.amara, work.artifact.id, work.head.id, { kind: "keep" });
    const { state, version } = await records.load();
    await rejectsWith(records.commit({ ...state, revisions: [], pins: [] }, version), "policy-violation");
  });
});
