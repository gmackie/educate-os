import { describe, expect, it } from "vitest";
import {
  ARTIFACTS_GIT_PROVIDER,
  buildTree,
  encodeCommit,
  gitObject,
  NO_COMMIT,
  PROJECT_BRANCH,
  VERSION_MANIFEST_PATH,
  VERSION_REF_PREFIX,
} from "../src/index.ts";
import { notebook, O, P, rejectsWith, saving, setup } from "./setup.ts";

const v1 = [{ path: "lab.py", text: "print('v1')\n" }];
const v2 = [{ path: "lab.py", text: "print('v2')\n" }];

/** Amara's course project with two saved versions, and what her repository holds. */
async function twoVersions(options: { provider?: boolean } = {}) {
  const env = setup(options);
  const bio = await env.workspaces.ensureCourseWorkspace(P.amara, O.bioFall);
  const created = await env.projects.createProject(P.amara, notebook(bio.id, v1));
  const second = await env.projects.checkpoint(P.amara, created.artifact.id, saving(v2, "Second"));
  const first = await env.manifestOf(created.latest.revisionId);
  const latest = await env.manifestOf(second.revisionId);
  if (first.storage.kind !== "artifacts-git" || latest.storage.kind !== "artifacts-git") throw new Error("expected Git storage");
  const repository = latest.storage.repository;
  const remote = (await (await env.storage.get(repository)).info()).remote;
  return { ...env, bio, created, second, first: first.storage.commit, latest: latest.storage.commit, repository, remote };
}

/** A commit with one file on top of `parent`, as a student's own Git client would push it. */
async function studentCommit(parent: string | undefined, text: string) {
  const built = await buildTree([{ path: "lab.py", text }]);
  const commit = await gitObject("commit", encodeCommit({
    tree: built.tree,
    parents: parent === undefined ? [] : [parent],
    author: { name: "Amara", email: "amara@students.northfield.example", seconds: 1_790_000_000 },
    message: "From my laptop",
  }));
  return { newSha: commit.oid, objects: [...built.objects, commit] };
}

describe("saved versions in Git", () => {
  it("each have a service-owned ref to a version commit holding the manifest above the project commit", async () => {
    const { storage, records, repository, created, second, first, latest } = await twoVersions();
    const branches = storage.branches(repository);
    expect([...branches.keys()].toSorted()).toEqual([PROJECT_BRANCH, `${VERSION_REF_PREFIX}${first}`, `${VERSION_REF_PREFIX}${latest}`].toSorted());
    expect(branches.get(PROJECT_BRANCH)).toBe(latest);

    const [version] = storage.reachableCommits(repository, `${VERSION_REF_PREFIX}${latest}`);
    expect(version!.parents).toEqual([latest]);
    const repo = await storage.get(repository);
    expect((await repo.readTree(version!.treeHash))!.map((e) => e.name)).toEqual([VERSION_MANIFEST_PATH]);

    // learning-artifacts records each version as artifacts-git content naming its version commit.
    const { state } = await records.load();
    const revisions = state.revisions.filter((r) => r.artifactId === created.artifact.id);
    expect(revisions.map((r) => r.content)).toEqual([
      expect.objectContaining({ backend: "registered", provider: ARTIFACTS_GIT_PROVIDER, key: expect.stringMatching(new RegExp(`^${repository}/[0-9a-f]{40}$`)) }),
      { backend: "registered", provider: ARTIFACTS_GIT_PROVIDER, key: `${repository}/${version!.hash}`, digest: second.revisionDigest },
    ]);
  });

  it("refuse a student's own Git client, which may still push its branch", async () => {
    const { projects, storage, created, remote, repository, first, latest } = await twoVersions();
    const write = await projects.issueCredential(P.amara, created.artifact.id, "write");
    const versionRef = `${VERSION_REF_PREFIX}${first}`;
    const versionHead = storage.branchHead(repository, versionRef)!;
    const rogue = await studentCommit(latest, "print('rewritten')\n");

    await rejectsWith(storage.push(remote, write.reveal(), { branch: versionRef, oldSha: versionHead, ...rogue }, rogue.objects), "forbidden");
    await rejectsWith(storage.push(remote, write.reveal(), { branch: versionRef, oldSha: versionHead, newSha: NO_COMMIT }, []), "forbidden");
    await rejectsWith(storage.push(remote, write.reveal(), { branch: `${VERSION_REF_PREFIX}${rogue.newSha}`, oldSha: NO_COMMIT, ...rogue }, rogue.objects), "forbidden");
    expect(storage.branchHead(repository, versionRef)).toBe(versionHead);

    await storage.push(remote, write.reveal(), { branch: PROJECT_BRANCH, oldSha: latest, ...rogue }, rogue.objects);
    expect(storage.branchHead(repository)).toBe(rogue.newSha);
  });

  it("stay readable, and the next save lands, after a student rewrites the branch", async () => {
    const { projects, storage, created, second, remote, repository, first, latest } = await twoVersions();
    const write = await projects.issueCredential(P.amara, created.artifact.id, "write");
    const unrelated = await studentCommit(undefined, "print('fresh start')\n");
    await storage.push(remote, write.reveal(), { branch: PROJECT_BRANCH, oldSha: storage.branchHead(repository)!, ...unrelated }, unrelated.objects);

    // Both versions are still reachable from their own refs, whatever the branch says.
    const read = await projects.readVersion(P.amara, created.artifact.id, created.latest.revisionId);
    expect(read.files.map((f) => new TextDecoder().decode(f.bytes))).toEqual(["print('v1')\n"]);
    expect(storage.reachableCommits(repository, `${VERSION_REF_PREFIX}${first}`).map((c) => c.parents.length)).toEqual([1, 0]);

    const third = await projects.checkpoint(P.amara, created.artifact.id, saving([{ path: "lab.py", text: "print('v3')\n" }], "Third"));
    expect(third.number).toBe(3);
    // The new commit's parent comes from the version record, not from the rewritten branch.
    const [head, parent] = storage.reachableCommits(repository);
    expect(head!.parents).toEqual([latest]);
    expect(parent!.hash).toBe(latest);
    expect(storage.reachableCommits(repository).map((c) => c.hash)).not.toContain(unrelated.newSha);
    expect((await projects.diff(P.amara, created.artifact.id, second.revisionId, third.revisionId)).files.map((f) => f.path)).toEqual(["lab.py"]);
  });

  it("record their manifests as inline text where learning-artifacts has no artifacts-git provider, and still push the refs", async () => {
    const { records, storage, repository, created, latest } = await twoVersions({ provider: false });
    const { state } = await records.load();
    expect(state.revisions.filter((r) => r.artifactId === created.artifact.id).map((r) => r.content.backend)).toEqual(["text", "text"]);
    expect(storage.branchHead(repository, `${VERSION_REF_PREFIX}${latest}`)).toBeDefined();
  });

  it("read as unavailable when the version commit is not what the record names", async () => {
    const { artifacts, records, created, content } = await twoVersions();
    const { state } = await records.load();
    const revision = state.revisions.find((r) => r.artifactId === created.artifact.id)!;
    if (revision.content.backend !== "registered") throw new Error("expected registered content");
    const [repository] = revision.content.key.split("/");
    for (const key of [`${repository}/${"0".repeat(40)}`, `${repository}/not-an-oid`, "../escape/x", `${repository}/${"a".repeat(40)}/extra`]) {
      await rejectsWith(content.read({ ...revision.content, key }), "unavailable");
    }
    expect(artifacts.hasContentProvider(ARTIFACTS_GIT_PROVIDER)).toBe(true);
  });
});
