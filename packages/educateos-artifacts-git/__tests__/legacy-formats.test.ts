// SCHO-232: project versions saved before the EducateOS rename are stored under the
// `text/vnd.schoolos.project+json` media type with a `schoolos.project.v1` manifest. They are
// still projects, readable as they were saved, while new versions use the new names.
import { describe, expect, it } from "vitest";
import { LEGACY_PROJECT_MANIFEST_MEDIA_TYPE, PROJECT_MANIFEST_MEDIA_TYPE } from "../src/index.ts";
import { O, P, notebook, saving, setup } from "./setup.ts";

const v1 = [{ path: "lab.py", text: "print('v1')\n" }];

describe("project versions from before the EducateOS rename", () => {
  it("are read, listed and saved on top of", async () => {
    const { projects, artifacts, workspaces, records, manifestOf } = setup({ artifacts: false });
    const bio = await workspaces.ensureCourseWorkspace(P.amara, O.bioFall);
    const created = await projects.createProject(P.amara, notebook(bio.id, v1));
    const current = await manifestOf(created.latest.revisionId);
    expect(current.format).toBe("educateos.project.v1");

    // The same version as the code before the rename saved it.
    const legacy = { ...current, format: "schoolos.project.v1", message: "Saved before the rename" };
    const saved = await artifacts.saveRevision(P.amara, created.artifact.id, {
      content: { kind: "text", mediaType: LEGACY_PROJECT_MANIFEST_MEDIA_TYPE, text: JSON.stringify(legacy) },
      aiAssistance: { level: "none" },
    });

    const history = await projects.history(P.amara, created.artifact.id);
    expect(history.map((v) => v.message)).toEqual(["Saved before the rename", "First version"]);
    const read = await projects.readVersion(P.amara, created.artifact.id, saved.head.id);
    expect(read.files.map((f) => [f.path, new TextDecoder().decode(f.bytes)])).toEqual([["lab.py", v1[0]!.text]]);

    const next = await projects.checkpoint(P.amara, created.artifact.id, saving([{ path: "lab.py", text: "print('v2')\n" }]));
    expect((await manifestOf(next.revisionId)).format).toBe("educateos.project.v1");
    const { state } = await records.load();
    expect(state.revisions.find((r) => r.id === next.revisionId)?.mediaType).toBe(PROJECT_MANIFEST_MEDIA_TYPE);
  });
});
