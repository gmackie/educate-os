import { describe, expect, it } from "vitest";
import type { WorkingTree } from "../src/index.ts";
import { notebook, P, rejectsWith, saving, setup } from "./setup.ts";

const RULES = { answerKeyGlobs: ["answers/**", "**/*.key.ipynb"] };

const starter: WorkingTree = [
  { path: "lab.ipynb", text: '{"cells": ["Measure the rate"]}\n' },
  { path: "data/rates.csv", text: "temp,rate\n" },
];
const withKey: WorkingTree = [...starter, { path: "answers/solution.py", text: "RATE_DOUBLES_EVERY = 10\n" }];

type Env = ReturnType<typeof setup>;

function manifestOf(env: Env, revisionId: string) {
  return env.manifestOf(revisionId);
}

/** Morgan's baseline: written with the answer key, which a later version deletes. */
async function baselineWithOldKey(env: Env) {
  const personal = await env.workspaces.ensurePersonalWorkspace(P.morgan);
  const project = await env.projects.createProject(P.morgan, notebook(personal.id, withKey, "Enzyme lab baseline"));
  const cleaned = await env.projects.checkpoint(P.morgan, project.artifact.id, saving(starter, "Remove the answers"));
  return { personal, project, cleaned };
}

describe("forking a baseline", () => {
  for (const artifacts of [true, false]) {
    it(`is blocked when an older version holds the answer key (${artifacts ? "Git" : "bundle"} storage)`, async () => {
      const env = setup({ artifacts });
      const { personal, project, cleaned } = await baselineWithOldKey(env);
      const result = await env.projects.forkFromBaseline(P.morgan, { artifactId: project.artifact.id, revisionId: cleaned.revisionId }, personal.id, RULES, "Enzyme lab");

      expect(result).toEqual({
        status: "blocked",
        report: {
          clean: false,
          versionsChecked: 2,
          findings: [{ path: "answers/solution.py", versionNumber: 1, inChosenVersion: false, reason: { kind: "pattern", pattern: "answers/**" } }],
        },
      });
      // Nothing was created.
      expect((await env.artifacts.listArtifacts(P.morgan, personal.id)).map((v) => v.artifact.id)).toEqual([project.artifact.id]);
    });
  }

  it("is blocked by a file marked teacher-only when it was saved, whatever its name", async () => {
    const env = setup();
    const personal = await env.workspaces.ensurePersonalWorkspace(P.morgan);
    const project = await env.projects.createProject(P.morgan, notebook(personal.id, [...starter, { path: "notes.md", text: "Grade leniently.\n", teacherOnly: true }]));
    const cleaned = await env.projects.checkpoint(P.morgan, project.artifact.id, saving(starter, "Drop my notes"));

    const report = await env.projects.checkBaseline(P.morgan, { artifactId: project.artifact.id, revisionId: cleaned.revisionId }, { answerKeyGlobs: [] });
    expect(report.findings).toEqual([{ path: "notes.md", versionNumber: 1, inChosenVersion: false, reason: { kind: "marked-teacher-only" } }]);
  });

  it("matches answer-key patterns in any directory and in any letter case", async () => {
    const env = setup();
    const personal = await env.workspaces.ensurePersonalWorkspace(P.morgan);
    const project = await env.projects.createProject(P.morgan, notebook(personal.id, [...starter, { path: "week1/Lab.KEY.ipynb", text: "{}\n" }, { path: "Answers/a.txt", text: "42\n" }]));
    const report = await env.projects.checkBaseline(P.morgan, { artifactId: project.artifact.id, revisionId: project.latest.revisionId }, RULES);
    expect(report.findings.map((f) => [f.path, f.inChosenVersion])).toEqual([["Answers/a.txt", true], ["week1/Lab.KEY.ipynb", true]]);
  });

  it("walks the repository's own history, not only the recorded versions", async () => {
    const env = setup();
    const { personal, project, cleaned } = await baselineWithOldKey(env);
    // Drop the first version's record: its commit is still reachable in the repository.
    const { state } = await env.records.load();
    const firstRecord = state.revisions.find((r) => r.artifactId === project.artifact.id && r.number === 1)!;
    const history = env.artifacts.history.bind(env.artifacts);
    env.artifacts.history = async (caller, id) => (await history(caller, id)).filter((r) => r.id !== firstRecord.id);

    const result = await env.projects.forkFromBaseline(P.morgan, { artifactId: project.artifact.id, revisionId: cleaned.revisionId }, personal.id, RULES, "Enzyme lab");
    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") return;
    // The commit is tied to no recorded version, but its file is still found.
    expect(result.report.findings).toEqual([{ path: "answers/solution.py", inChosenVersion: false, reason: { kind: "pattern", pattern: "answers/**" } }]);
  });

  it("can only be made by the baseline's owner", async () => {
    const env = setup();
    const { project, cleaned } = await baselineWithOldKey(env);
    const elenas = await env.workspaces.ensurePersonalWorkspace(P.elena);
    await rejectsWith(env.projects.forkFromBaseline(P.elena, { artifactId: project.artifact.id, revisionId: cleaned.revisionId }, elenas.id, RULES, "Mine"), "not-found");
  });
});

describe("a sanitized fork", () => {
  it("starts from a fresh snapshot: one parentless commit holding only the chosen files", async () => {
    const env = setup();
    const { personal, project, cleaned } = await baselineWithOldKey(env);
    const baseline = { artifactId: project.artifact.id, revisionId: cleaned.revisionId };

    const snapshot = await env.projects.recreateBaseline(P.morgan, baseline, RULES, "Enzyme lab (clean)");
    if (snapshot.status !== "forked") throw new Error("expected a fresh snapshot");
    expect(snapshot.project.artifact.workspaceId).toBe(personal.id);
    const fork = await env.projects.forkFromBaseline(P.morgan, { artifactId: snapshot.project.artifact.id, revisionId: snapshot.project.latest.revisionId }, personal.id, RULES, "Enzyme lab, period 2");
    if (fork.status !== "forked") throw new Error(`expected a fork, got ${JSON.stringify(fork)}`);

    const source = await manifestOf(env, cleaned.revisionId);
    const forked = await manifestOf(env, fork.project.latest.revisionId);
    if (forked.storage.kind !== "artifacts-git" || source.storage.kind !== "artifacts-git") throw new Error("expected Git storage");
    expect(forked.storage.repository).not.toBe(source.storage.repository);
    const commits = env.storage.reachableCommits(forked.storage.repository);
    expect(commits).toHaveLength(1);
    expect(commits[0]!.parents).toEqual([]);
    expect(commits[0]!.treeHash).toBe(source.tree);
    expect(fork.project.latest.contentDigest).toBe(cleaned.contentDigest);

    // The new repository holds the chosen tree's objects, its commit and the version commit holding
    // the manifest (which lists only the chosen files), and not one object more.
    const answerKey = (await manifestOf(env, project.latest.revisionId)).files.find((f) => f.path === "answers/solution.py")!;
    const objects = env.storage.objectIds(forked.storage.repository);
    expect(objects).not.toContain(answerKey.blob);
    expect(objects).toHaveLength(source.files.length + 2 /* trees: root, data/ */ + 1 /* commit */ + 3 /* manifest, its tree, the version commit */);
    expect((await env.projects.history(P.morgan, fork.project.artifact.id)).map((v) => v.number)).toEqual([1]);
  });

  it("is refused when the chosen version itself holds the answer key", async () => {
    const env = setup();
    const personal = await env.workspaces.ensurePersonalWorkspace(P.morgan);
    const project = await env.projects.createProject(P.morgan, notebook(personal.id, withKey));
    const baseline = { artifactId: project.artifact.id, revisionId: project.latest.revisionId };
    for (const result of [
      await env.projects.recreateBaseline(P.morgan, baseline, RULES, "Still has the key"),
      await env.projects.forkFromBaseline(P.morgan, baseline, personal.id, RULES, "Still has the key"),
    ]) {
      expect(result).toMatchObject({ status: "blocked", report: { clean: false, findings: [{ path: "answers/solution.py", inChosenVersion: true }] } });
    }
  });
});
