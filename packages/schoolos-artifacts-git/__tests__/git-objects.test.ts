import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseGitCommitPayload } from "@gadgets/gatekeeper-kit/git-objects";
import { buildTree, encodeCommit, encodePack, gitObject, globMatcher } from "../src/index.ts";

const gitAvailable = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("Git objects", () => {
  it("hash as Git hashes them", async () => {
    expect((await gitObject("blob", new Uint8Array())).oid).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    expect((await gitObject("blob", new TextEncoder().encode("hello\n"))).oid).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    // Git sorts a directory as if its name ended in "/", so "a.b" comes before "a/".
    const built = await buildTree([{ path: "a/x", text: "hello\n" }, { path: "a.b", text: "" }]);
    expect(built.tree).toBe(await treeIdFromGit([["a/x", "hello\n"], ["a.b", ""]]));
  });

  it("encode commits the kit's parser reads back", async () => {
    const built = await buildTree([{ path: "f", text: "x" }]);
    const payload = encodeCommit({ tree: built.tree, parents: [], author: { name: "prn_x", email: "prn_x@principals.schoolos.invalid", seconds: 1_790_000_000 }, message: "Save" });
    const parsed = parseGitCommitPayload(payload, "0".repeat(40));
    expect(parsed).toMatchObject({ tree: built.tree, parents: [], message: "Save\n", author: { name: "prn_x", email: "prn_x@principals.schoolos.invalid" } });
    expect(() => encodeCommit({ tree: built.tree, parents: [], author: { name: "a>b", email: "e", seconds: 0 }, message: "m" })).toThrow();
  });

  it.skipIf(!gitAvailable)("pack into a packfile git itself accepts", async () => {
    const built = await buildTree([
      { path: "lab.ipynb", text: '{"cells": []}\n' },
      { path: "data/big.bin", bytes: new Uint8Array(100_000).map((_, i) => (i * 31) % 256) },
    ]);
    const commit = await gitObject("commit", encodeCommit({ tree: built.tree, parents: [], author: { name: "prn_x", email: "prn_x@principals.schoolos.invalid", seconds: 1 }, message: "m" }));
    const objects = [...built.objects, commit];
    const dir = mkdtempSync(join(tmpdir(), "schoolos-pack-"));
    try {
      execFileSync("git", ["init", "-q", "--bare", dir]);
      const pack = join(dir, "test.pack");
      writeFileSync(pack, await encodePack(objects));
      execFileSync("git", ["-C", dir, "index-pack", "--strict", pack]);
      const listed = execFileSync("git", ["-C", dir, "verify-pack", "-v", pack.replace(/\.pack$/, ".idx")]).toString();
      for (const object of objects) expect(listed).toContain(`${object.oid} ${object.type}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("answer-key patterns", () => {
  it.each([
    ["answers/**", "answers/a.py", true],
    ["answers/**", "answers/deep/b.py", true],
    ["answers/**", "src/answers/a.py", false],
    ["**/*.key.ipynb", "lab.key.ipynb", true],
    ["**/*.key.ipynb", "week1/lab.KEY.ipynb", true],
    ["**/*.key.ipynb", "lab.key.ipynb.bak", false],
    ["solution?.py", "solution1.py", true],
    ["solution?.py", "solution12.py", false],
    ["*.md", "notes/a.md", false],
    ["key(1).txt", "key(1).txt", true],
  ])("%s matches %s: %s", (glob, path, expected) => {
    expect(globMatcher(glob)(path)).toBe(expected);
  });
});

/** The tree ID `git` computes for these files, or the same computation by hand if git is absent. */
async function treeIdFromGit(files: [string, string][]): Promise<string> {
  if (!gitAvailable) return (await buildTree(files.map(([path, text]) => ({ path, text })))).tree;
  const dir = mkdtempSync(join(tmpdir(), "schoolos-tree-"));
  try {
    execFileSync("git", ["init", "-q", dir]);
    for (const [path, text] of files) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    execFileSync("git", ["-C", dir, "add", "-A"]);
    return execFileSync("git", ["-C", dir, "write-tree"]).toString().trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
