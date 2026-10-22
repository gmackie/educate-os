import { describe, expect, it } from "vitest";
import { SchoolOsError } from "@schoolos/contracts";
import { InMemoryArtifactRecordStore, type ArtifactImportBatch, type ArtifactState } from "../src/index.ts";
import { DOCS_HOST, P, rejectsWith, setup } from "./setup.ts";

const text = (value: string) => ({ content: { kind: "text", mediaType: "text/markdown", text: value } as const, aiAssistance: { level: "none" } as const });

/** Every artifact and revision the store holds. */
async function stored(records: InMemoryArtifactRecordStore): Promise<ArtifactState> {
  return (await records.load()).state;
}

describe("an import batch", () => {
  it("creates every artifact with its whole history in one commit, each revision marked imported", async () => {
    const { artifacts, workspaces, records } = setup();
    const personal = await workspaces.ensurePersonalWorkspace(P.amara);
    const before = (await records.load()).version;

    const views = await artifacts.importArtifacts(P.amara, {
      workspaceId: personal.id,
      artifacts: [
        { type: "document", title: "Essay", revisions: [text("Draft one."), { ...text("Draft two."), aiAssistance: { level: "assisted", modelId: "workers-ai/example-model" } }] },
        { type: "external-ref", title: "Notes", revisions: [{ content: { kind: "external", url: `https://${DOCS_HOST}/d/notes` }, aiAssistance: { level: "none" } }] },
      ],
    });

    expect((await records.load()).version).toBe(before + 1);
    expect(views.map((v) => [v.artifact.title, v.head.number])).toEqual([["Essay", 2], ["Notes", 1]]);
    const history = await artifacts.history(P.amara, views[0]!.artifact.id);
    expect(history.map((r) => [r.number, r.parentRevisionId === undefined, r.provenance.origin, r.aiAssistance.level])).toEqual([
      [2, false, "imported", "assisted"],
      [1, true, "imported", "none"],
    ]);
    expect(views[1]!.head.provenance.origin).toBe("imported");
    for (const { artifact } of views) expect(artifact).toMatchObject({ ownerPrincipalId: P.amara.principal.principalId, classification: "personal-private" });
  });

  it("stores nothing when any artifact in it is invalid", async () => {
    const { artifacts, workspaces, records } = setup();
    const personal = await workspaces.ensurePersonalWorkspace(P.amara);
    const batch: ArtifactImportBatch = {
      workspaceId: personal.id,
      artifacts: [
        { type: "document", title: "Essay", revisions: [text("Fine.")] },
        { type: "external-ref", title: "Elsewhere", revisions: [{ content: { kind: "external", url: "https://docs.unapproved.example/d/1" }, aiAssistance: { level: "none" } }] },
      ],
    };

    await rejectsWith(artifacts.importArtifacts(P.amara, batch), "validation-failed");
    expect(await stored(records)).toMatchObject({ artifacts: [], revisions: [] });
  });

  it("stores nothing when the commit fails, and nothing needs cleaning up", async () => {
    const { artifacts, workspaces, records } = setup();
    const personal = await workspaces.ensurePersonalWorkspace(P.amara);
    const failing = Object.assign(records, {
      commit: async () => {
        throw new SchoolOsError("unavailable", "storage is down");
      },
    });

    await rejectsWith(artifacts.importArtifacts(P.amara, {
      workspaceId: personal.id,
      artifacts: [{ type: "document", title: "One", revisions: [text("1")] }, { type: "document", title: "Two", revisions: [text("2")] }],
    }), "unavailable");
    expect(await stored(failing)).toMatchObject({ artifacts: [], revisions: [] });
  });

  it("is refused for a workspace that is not the caller's", async () => {
    const { artifacts, workspaces, records } = setup();
    const elenas = await workspaces.ensurePersonalWorkspace(P.elena);

    await rejectsWith(artifacts.importArtifacts(P.amara, { workspaceId: elenas.id, artifacts: [{ type: "document", title: "Planted", revisions: [text("x")] }] }), "not-found");
    expect((await stored(records)).artifacts).toEqual([]);
  });
});

describe("approvesExternalUrl", () => {
  it("accepts only credential-free https links to an approved host", () => {
    const { artifacts } = setup();
    expect(artifacts.approvesExternalUrl(`https://${DOCS_HOST}/d/1`)).toBe(true);
    expect(artifacts.approvesExternalUrl(`https://${DOCS_HOST.toUpperCase()}/d/1`)).toBe(true);
    expect(artifacts.approvesExternalUrl(`http://${DOCS_HOST}/d/1`)).toBe(false);
    expect(artifacts.approvesExternalUrl(`https://user:pw@${DOCS_HOST}/d/1`)).toBe(false);
    expect(artifacts.approvesExternalUrl("https://docs.unapproved.example/d/1")).toBe(false);
    expect(artifacts.approvesExternalUrl("not a url")).toBe(false);
  });
});
