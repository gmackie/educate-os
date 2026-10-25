import { describe, expect, it } from "vitest";
import { buildTree, encodeCommit, gitObject, NO_COMMIT } from "../src/index.ts";
import { as, notebook, O, P, rejectsWith, saving, setup } from "./setup.ts";

const files = [{ path: "lab.py", text: "print('hello')\n" }];

/** A setup with a course project for Amara and one for Elena, and their repositories. */
async function twoStudents() {
  const env = setup();
  const amaraBio = await env.workspaces.ensureCourseWorkspace(P.amara, O.bioFall);
  const elenaBio = await env.workspaces.ensureCourseWorkspace(P.elena, O.bioFall);
  const amara = await env.projects.createProject(P.amara, notebook(amaraBio.id, files));
  const elena = await env.projects.createProject(P.elena, notebook(elenaBio.id, files));
  const repositoryOf = async (revisionId: string) => {
    const manifest = await env.manifestOf(revisionId);
    if (manifest.storage.kind !== "artifacts-git") throw new Error("expected Git storage");
    return { name: manifest.storage.repository, head: manifest.storage.commit, remote: (await (await env.storage.get(manifest.storage.repository)).info()).remote };
  };
  return {
    ...env,
    amaraBio,
    elenaBio,
    amara,
    elena,
    amaraRepo: await repositoryOf(amara.latest.revisionId),
    elenaRepo: await repositoryOf(elena.latest.revisionId),
  };
}

/** A commit on top of `parent` with one file, ready to push. */
async function commitObjects(parent: string, text: string) {
  const built = await buildTree([{ path: "lab.py", text }]);
  const commit = await gitObject("commit", encodeCommit({
    tree: built.tree,
    parents: [parent],
    author: { name: "prn_nf-student-amara", email: "prn_nf-student-amara@principals.educateos.invalid", seconds: 1_790_000_000 },
    message: "From my laptop",
  }));
  return { newSha: commit.oid, objects: [...built.objects, commit] };
}

describe("project credentials", () => {
  it("open only the repository they were minted for, within their scope", async () => {
    const { projects, storage, amara, amaraRepo, elenaRepo } = await twoStudents();
    const write = await projects.issueCredential(P.amara, amara.artifact.id, "write");
    const read = await projects.issueCredential(P.amara, amara.artifact.id, "read");
    expect(write).toMatchObject({ remote: amaraRepo.remote, username: "x-access-token", scope: "write", expiresAt: "2026-10-20T12:15:00.000Z" });

    // Amara's write token pushes to her own repository...
    const change = await commitObjects(amaraRepo.head, "print('v2')\n");
    await storage.push(amaraRepo.remote, write.reveal(), { branch: "main", oldSha: amaraRepo.head, ...change }, change.objects);
    expect(storage.branchHead(amaraRepo.name)).toBe(change.newSha);
    // ...but neither reads nor writes Elena's.
    await rejectsWith(storage.readBranch(elenaRepo.remote, write.reveal(), "main"), "forbidden");
    const intrusion = await commitObjects(elenaRepo.head, "print('overwritten')\n");
    await rejectsWith(storage.push(elenaRepo.remote, write.reveal(), { branch: "main", oldSha: elenaRepo.head, ...intrusion }, intrusion.objects), "forbidden");
    expect(storage.branchHead(elenaRepo.name)).toBe(elenaRepo.head);
    // A read token reads, and never writes.
    expect(await storage.readBranch(amaraRepo.remote, read.reveal(), "main")).toBe(change.newSha);
    const next = await commitObjects(change.newSha, "print('v3')\n");
    await rejectsWith(storage.push(amaraRepo.remote, read.reveal(), { branch: "main", oldSha: change.newSha, ...next }, next.objects), "forbidden");
  });

  it("expire after fifteen minutes", async () => {
    const { projects, storage, clock, amara, amaraRepo } = await twoStudents();
    const read = await projects.issueCredential(P.amara, amara.artifact.id, "read");
    clock.now = new Date("2026-10-20T12:14:59Z");
    expect(await storage.readBranch(amaraRepo.remote, read.reveal(), "main")).toBe(amaraRepo.head);
    clock.now = new Date("2026-10-20T12:15:00Z");
    await rejectsWith(storage.readBranch(amaraRepo.remote, read.reveal(), "main"), "forbidden");
  });

  it("let a teacher read course work by policy, but never write it or see personal work", async () => {
    const { projects, workspaces, storage, amara, amaraRepo } = await twoStudents();
    const read = await projects.issueCredential(P.morgan, amara.artifact.id, "read");
    expect(await storage.readBranch(amaraRepo.remote, read.reveal(), "main")).toBe(amaraRepo.head);
    await rejectsWith(projects.issueCredential(P.morgan, amara.artifact.id, "write"), "forbidden");
    // Other students get nothing, and learn nothing about whether the project exists.
    await rejectsWith(projects.issueCredential(P.elena, amara.artifact.id, "read"), "not-found");

    const personal = await workspaces.ensurePersonalWorkspace(P.amara);
    const diary = await projects.createProject(P.amara, notebook(personal.id, files));
    await rejectsWith(projects.issueCredential(P.morgan, diary.artifact.id, "read"), "not-found");
  });

  it("are never handed to an agent or tool, and never stored", async () => {
    const { projects, records, ledger, amara } = await twoStudents();
    await rejectsWith(projects.issueCredential(as("prn_nf-student-amara", "agent"), amara.artifact.id, "read"), "forbidden");
    await rejectsWith(projects.issueCredential(as("prn_nf-student-amara", "mcp-tool"), amara.artifact.id, "read"), "forbidden");

    const credential = await projects.issueCredential(P.amara, amara.artifact.id, "write");
    const secret = credential.reveal();
    expect(JSON.stringify(credential)).not.toContain(secret);
    expect(JSON.stringify({ ...credential })).not.toContain(secret);
    await projects.checkpoint(P.amara, amara.artifact.id, saving([{ path: "lab.py", text: "print('v2')\n" }]));
    expect(JSON.stringify((await records.load()).state)).not.toContain(secret);
    expect(JSON.stringify(ledger.all())).not.toContain(secret);
  });

  it("used by the service itself are revoked as soon as each save is pushed", async () => {
    const { projects, storage, amara, amaraRepo } = await twoStudents();
    await projects.checkpoint(P.amara, amara.artifact.id, saving([{ path: "lab.py", text: "print('v2')\n" }]));
    expect(storage.activeTokenIds(amaraRepo.name)).toEqual([]);
  });

  it("are all revoked when a course workspace closes, and only that workspace's", async () => {
    const { projects, storage, ledger, amara, amaraBio, amaraRepo, elena, elenaRepo } = await twoStudents();
    const second = await projects.createProject(P.amara, notebook(amaraBio.id, files, "Second lab"));
    const tokens = [
      await projects.issueCredential(P.amara, amara.artifact.id, "write"),
      await projects.issueCredential(P.amara, second.artifact.id, "read"),
      await projects.issueCredential(P.morgan, amara.artifact.id, "read"),
    ];
    const elenas = await projects.issueCredential(P.elena, elena.artifact.id, "write");

    expect(await projects.revokeAll(amaraBio.id)).toEqual({ revoked: 3 });

    for (const token of tokens) await rejectsWith(storage.readBranch(token.remote, token.reveal(), "main"), "forbidden");
    expect(await storage.readBranch(elenaRepo.remote, elenas.reveal(), "main")).toBe(elenaRepo.head);
    expect(storage.activeTokenIds(amaraRepo.name)).toEqual([]);
    expect(ledger.all().map((g) => g.workspaceId)).toEqual([elena.artifact.workspaceId]);
    // Revoking again finds nothing left to do.
    expect(await projects.revokeAll(amaraBio.id)).toEqual({ revoked: 0 });
  });

  it("are not issued for writing once the course has closed", async () => {
    const { projects, changeDirectory, amara } = await twoStudents();
    await changeDirectory((d) => {
      for (const term of d.terms) term.state = "completed";
    });
    await rejectsWith(projects.issueCredential(P.amara, amara.artifact.id, "write"), "forbidden");
    // Amara still reads her own work.
    expect(await projects.issueCredential(P.amara, amara.artifact.id, "read")).toMatchObject({ scope: "read" });
  });

  it("are refused by the remote for a stale branch, so a push cannot clobber a newer save", async () => {
    const { projects, storage, amara, amaraRepo } = await twoStudents();
    const write = await projects.issueCredential(P.amara, amara.artifact.id, "write");
    await projects.checkpoint(P.amara, amara.artifact.id, saving([{ path: "lab.py", text: "print('saved')\n" }]));
    const stale = await commitObjects(amaraRepo.head, "print('stale')\n");
    await expect(storage.push(amaraRepo.remote, write.reveal(), { branch: "main", oldSha: amaraRepo.head, ...stale }, stale.objects)).rejects.toThrow(/stale/);
    await expect(storage.push(amaraRepo.remote, write.reveal(), { branch: "main", oldSha: NO_COMMIT, ...stale }, stale.objects)).rejects.toThrow(/stale/);
  });
});
