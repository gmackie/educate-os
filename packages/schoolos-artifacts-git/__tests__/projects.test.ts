import { describe, expect, it } from "vitest";
import { PROJECT_MANIFEST_MEDIA_TYPE } from "../src/index.ts";
import { bytes, notebook, O, P, rejectsWith, saving, setup } from "./setup.ts";

const v1 = [
  { path: "lab.ipynb", text: '{"cells": []}\n' },
  { path: "data/rates.csv", text: "temp,rate\n10,1.0\n20,2.1\n" },
];
const v2 = [
  { path: "lab.ipynb", text: '{"cells": ["fit"]}\n' },
  { path: "data/rates.csv", text: "temp,rate\n10,1.0\n20,2.1\n30,3.9\n" },
  { path: "src/fit.py", text: "import math\n" },
];

describe("a project with Artifacts on the plan", () => {
  it("keeps each saved version as a commit on top of the last, in its own repository", async () => {
    const { projects, workspaces, storage, manifestOf } = setup();
    const bio = await workspaces.ensureCourseWorkspace(P.amara, O.bioFall);
    const created = await projects.createProject(P.amara, notebook(bio.id, v1));
    const second = await projects.checkpoint(P.amara, created.artifact.id, saving(v2, "Added the fit"));

    expect(created.latest).toMatchObject({ number: 1, message: "First version", fileCount: 2 });
    expect(second).toMatchObject({ number: 2, message: "Added the fit", fileCount: 3, savedBy: P.amara.principal.principalId });

    const first = await manifestOf(created.latest.revisionId);
    const latest = await manifestOf(second.revisionId);
    if (first.storage.kind !== "artifacts-git" || latest.storage.kind !== "artifacts-git") throw new Error("expected Git storage");
    expect(latest.storage.repository).toBe(first.storage.repository);
    // The repository's branch is the latest version, whose only parent is the first.
    const commits = storage.reachableCommits(latest.storage.repository);
    expect(commits.map((c) => c.hash)).toEqual([latest.storage.commit, first.storage.commit]);
    expect(commits[0]).toMatchObject({ parents: [first.storage.commit], treeHash: latest.tree, message: "Added the fit" });
    expect(commits[1]!.parents).toEqual([]);
    // The repository name says nothing about who owns it.
    expect(latest.storage.repository).toMatch(/^sos-[0-9a-f-]{36}$/);

    expect((await projects.history(P.amara, created.artifact.id)).map((v) => [v.number, v.message])).toEqual([[2, "Added the fit"], [1, "First version"]]);
    const read = await projects.readVersion(P.amara, created.artifact.id, created.latest.revisionId);
    expect(read.files.map((f) => [f.path, new TextDecoder().decode(f.bytes)])).toEqual([
      ["data/rates.csv", v1[1]!.text],
      ["lab.ipynb", v1[0]!.text],
    ]);
  });

  it("names the same files by the same tree and content digest, wherever and whenever they are saved", async () => {
    const withGit = setup();
    const without = setup({ artifacts: false });
    const a = await withGit.projects.createProject(P.amara, notebook((await withGit.workspaces.ensurePersonalWorkspace(P.amara)).id, v1));
    withGit.clock.now = new Date("2026-11-01T00:00:00Z");
    const again = await withGit.projects.checkpoint(P.amara, a.artifact.id, saving(v1.toReversed(), "Same files"));
    const b = await without.projects.createProject(P.elena, notebook((await without.workspaces.ensurePersonalWorkspace(P.elena)).id, v1));

    expect(again.contentDigest).toBe(a.latest.contentDigest);
    expect(b.latest.contentDigest).toBe(a.latest.contentDigest);
    const first = await withGit.manifestOf(a.latest.revisionId);
    const bundled = await without.manifestOf(b.latest.revisionId);
    expect(bundled.tree).toBe(first.tree);
    // The revision digest learning-artifacts records still distinguishes the two saves.
    expect(again.revisionDigest).not.toBe(a.latest.revisionDigest);
  });

  it("pushes nothing for a save that would be refused", async () => {
    const { projects, workspaces, storage, changeDirectory, manifestOf } = setup();
    const bio = await workspaces.ensureCourseWorkspace(P.amara, O.bioFall);
    const created = await projects.createProject(P.amara, notebook(bio.id, v1));
    const manifest = await manifestOf(created.latest.revisionId);
    if (manifest.storage.kind !== "artifacts-git") throw new Error("expected Git storage");
    const objectsBefore = storage.objectIds(manifest.storage.repository).length;

    // Morgan may read Amara's course work but never change it.
    await rejectsWith(projects.checkpoint(P.morgan, created.artifact.id, saving(v2)), "forbidden");
    // Nobody changes course work once its term has completed.
    await changeDirectory((d) => {
      for (const term of d.terms) term.state = "completed";
    });
    await rejectsWith(projects.checkpoint(P.amara, created.artifact.id, saving(v2)), "forbidden");

    expect(storage.objectIds(manifest.storage.repository)).toHaveLength(objectsBefore);
    expect(storage.branchHead(manifest.storage.repository)).toBe(manifest.storage.commit);
  });

  it("deletes the new repository if the project cannot be recorded", async () => {
    const { projects, workspaces, storage } = setup();
    const amaras = await workspaces.ensurePersonalWorkspace(P.amara);
    const created: string[] = [];
    const create = storage.create.bind(storage);
    storage.create = async (name, opts) => {
      created.push(name);
      return create(name, opts);
    };
    // Elena cannot add work to Amara's workspace.
    await rejectsWith(projects.createProject(P.elena, notebook(amaras.id, v1)), "not-found");
    expect(created).toHaveLength(1);
    expect(storage.has(created[0]!)).toBe(false);
  });

  it("refuses unsafe paths and ambiguous trees", async () => {
    const { projects, workspaces } = setup();
    const personal = await workspaces.ensurePersonalWorkspace(P.amara);
    for (const path of ["../escape.py", "/abs.py", "a//b.py", ".git/config", "src/.GIT/hooks", "a\\b.py", "line\nbreak.py"]) {
      await rejectsWith(projects.createProject(P.amara, notebook(personal.id, [{ path, text: "x" }])), "validation-failed");
    }
    await rejectsWith(projects.createProject(P.amara, notebook(personal.id, [{ path: "a.py", text: "1" }, { path: "a.py", text: "2" }])), "validation-failed");
    await rejectsWith(projects.createProject(P.amara, notebook(personal.id, [{ path: "a", text: "1" }, { path: "a/b.py", text: "2" }])), "validation-failed");
  });
});

describe("a project where the plan has no Artifacts", () => {
  it("reports Artifacts unavailable and keeps versions in learning-artifacts' own text or R2 storage", async () => {
    const { projects, workspaces, git, records, bucket } = setup({ artifacts: false });
    expect(git.availability()).toEqual({ status: "unavailable", reason: "not-on-plan" });
    const personal = await workspaces.ensurePersonalWorkspace(P.amara);
    const created = await projects.createProject(P.amara, notebook(personal.id, v1));
    const raw = new Uint8Array(70 * 1024).map((_, i) => (i * 7) % 251);
    const large = [...v2, { path: "data/raw.bin", bytes: raw }];
    const saved = await projects.checkpoint(P.amara, created.artifact.id, saving(large, "Raw data"));

    const { state } = await records.load();
    const [first, second] = state.revisions.filter((r) => r.artifactId === created.artifact.id);
    expect(first).toMatchObject({ mediaType: PROJECT_MANIFEST_MEDIA_TYPE, content: { backend: "text" } });
    expect(second).toMatchObject({ mediaType: PROJECT_MANIFEST_MEDIA_TYPE, content: { backend: "r2" } });
    expect(await bucket.head(second!.content.key)).not.toBeNull();

    expect((await projects.history(P.amara, created.artifact.id)).map((v) => v.number)).toEqual([2, 1]);
    const read = await projects.readVersion(P.amara, created.artifact.id, saved.revisionId);
    expect(read.files.find((f) => f.path === "data/raw.bin")!.bytes).toEqual(raw);
    const diff = await projects.diff(P.amara, created.artifact.id, created.latest.revisionId, saved.revisionId);
    expect(diff.files.map((f) => [f.path, f.change])).toEqual([
      ["data/rates.csv", "modified"],
      ["data/raw.bin", "added"],
      ["lab.ipynb", "modified"],
      ["src/fit.py", "added"],
    ]);
    // Git credentials need Git storage.
    await rejectsWith(projects.issueCredential(P.amara, created.artifact.id, "read"), "unavailable");
    expect(await projects.revokeAll(personal.id)).toEqual({ revoked: 0 });
  });

  it("refuses to read a Git-backed project once the plan loses Artifacts", async () => {
    const withGit = setup();
    const personal = await withGit.workspaces.ensurePersonalWorkspace(P.amara);
    const created = await withGit.projects.createProject(P.amara, notebook(personal.id, v1));
    const { ArtifactsGitBackend, ProjectArtifacts } = await import("../src/index.ts");
    const downgraded = new ProjectArtifacts({
      artifacts: withGit.artifacts,
      git: new ArtifactsGitBackend({ plan: undefined, ledger: withGit.ledger }),
      workspaces: { load: async () => ({ version: 0, state: { workspaces: [] } }) } as never,
      directory: { load: async () => ({ version: 0, snapshot: {} }) } as never,
      policy: { decide: async () => ({ decision: { effect: "deny" } }) } as never,
    });
    // History stays listed, since it lives in learning-artifacts; the files do not.
    expect(await downgraded.history(P.amara, created.artifact.id)).toHaveLength(1);
    await rejectsWith(downgraded.readVersion(P.amara, created.artifact.id), "unavailable");
  });
});

describe("diff", () => {
  for (const artifacts of [true, false]) {
    it(`compares two versions file by file and line by line (${artifacts ? "Git" : "bundle"} storage)`, async () => {
      const { projects, workspaces } = setup({ artifacts });
      const personal = await workspaces.ensurePersonalWorkspace(P.amara);
      const created = await projects.createProject(P.amara, notebook(personal.id, [
        { path: "README.md", text: "# Lab\n" },
        { path: "src/model.py", text: "a = 1\nb = 2\nc = 3\nd = 4\ne = 5\nf = 6\ng = 7\nh = 8\n" },
        { path: "src/old.py", text: "print('old')\n" },
        { path: "img/plot.png", bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]) },
      ]));
      const saved = await projects.checkpoint(P.amara, created.artifact.id, saving([
        { path: "README.md", text: "# Lab\n" },
        { path: "src/model.py", text: "a = 1\nb = 2\nc = 30\nd = 4\ne = 5\nf = 6\ng = 7\nh = 8\ni = 9\n" },
        { path: "src/new.py", text: "print('new')" },
        { path: "img/plot.png", bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 3]) },
      ]));

      const diff = await projects.diff(P.amara, created.artifact.id, created.latest.revisionId, saved.revisionId);
      expect(diff.files.map((f) => [f.path, f.change, f.additions, f.deletions, f.linesOmitted])).toEqual([
        ["img/plot.png", "modified", 0, 0, true],
        ["src/model.py", "modified", 2, 1, false],
        ["src/new.py", "added", 1, 0, false],
        ["src/old.py", "removed", 0, 1, false],
      ]);
      const model = diff.files.find((f) => f.path === "src/model.py")!;
      expect(model.hunks.map((h) => h.header)).toEqual(["@@ -1,8 +1,9 @@"]);
      expect(model.hunks[0]!.lines.filter((l) => l.kind !== "context")).toEqual([
        { kind: "removed", text: "c = 3", oldLineNumber: 3 },
        { kind: "added", text: "c = 30", newLineNumber: 3 },
        { kind: "added", text: "i = 9", newLineNumber: 9 },
      ]);
      expect(diff.files.find((f) => f.path === "src/new.py")!.hunks[0]!.lines).toEqual([
        { kind: "added", text: "print('new')", newLineNumber: 1 },
        { kind: "context", text: "\\ No newline at end of file" },
      ]);
      // A version compared with itself has no differences, and the reverse diff mirrors the forward one.
      expect((await projects.diff(P.amara, created.artifact.id, saved.revisionId, saved.revisionId)).files).toEqual([]);
      const reverse = await projects.diff(P.amara, created.artifact.id, saved.revisionId, created.latest.revisionId);
      expect(reverse.files.map((f) => [f.path, f.change, f.additions, f.deletions])).toEqual([
        ["img/plot.png", "modified", 0, 0],
        ["src/model.py", "modified", 1, 2],
        ["src/new.py", "removed", 0, 1],
        ["src/old.py", "added", 1, 0],
      ]);
    });
  }

  it("shows a teacher course work they may read, and another student nothing", async () => {
    const { projects, workspaces } = setup();
    const bio = await workspaces.ensureCourseWorkspace(P.amara, O.bioFall);
    const created = await projects.createProject(P.amara, notebook(bio.id, v1));
    const saved = await projects.checkpoint(P.amara, created.artifact.id, saving(v2));
    expect((await projects.diff(P.morgan, created.artifact.id, created.latest.revisionId, saved.revisionId)).files).toHaveLength(3);
    await rejectsWith(projects.diff(P.elena, created.artifact.id, created.latest.revisionId, saved.revisionId), "not-found");

    const personal = await workspaces.ensurePersonalWorkspace(P.amara);
    const privateProject = await projects.createProject(P.amara, notebook(personal.id, v1));
    await rejectsWith(projects.history(P.morgan, privateProject.artifact.id), "not-found");
  });

  it("refuses a corrupted object rather than show the wrong difference", async () => {
    const { projects, workspaces, storage, manifestOf } = setup();
    const personal = await workspaces.ensurePersonalWorkspace(P.amara);
    const created = await projects.createProject(P.amara, notebook(personal.id, v1));
    const saved = await projects.checkpoint(P.amara, created.artifact.id, saving(v2));
    const manifest = await manifestOf(saved.revisionId);
    const before = await manifestOf(created.latest.revisionId);
    if (manifest.storage.kind !== "artifacts-git") throw new Error("expected Git storage");
    const files = new Set([...manifest.files, ...before.files].map((f) => f.blob));
    const repo = await storage.get(manifest.storage.repository);
    const readBlob = repo.readBlob.bind(repo);
    const get = storage.get.bind(storage);
    // Every project file reads back wrong; the version manifests themselves are left intact.
    storage.get = async (name) => ({ ...(await get(name)), readBlob: async (hash) => ((await readBlob(hash)) === null || !files.has(hash) ? readBlob(hash) : new Blob([bytes("tampered\n")])) });

    const diff = await projects.diff(P.amara, created.artifact.id, created.latest.revisionId, saved.revisionId);
    expect(diff.files.filter((f) => f.change === "modified").every((f) => f.linesOmitted)).toBe(true);
    await rejectsWith(projects.readVersion(P.amara, created.artifact.id, saved.revisionId), "unavailable");
  });
});
