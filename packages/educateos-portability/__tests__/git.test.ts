import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitFastImport, UNCONFIGURED_CLR_ISSUER, validateArchive } from "../src/index.ts";
import { amarasYear } from "./scenario.ts";
import { P, rejectsWith, setup } from "./setup.ts";

const decoder = new TextDecoder();

interface ParsedCommit {
  mark: number;
  author: string;
  committer: string;
  message: string;
  from?: number;
  files: { mode: string; blob: number; path: string }[];
}

/**
 * Parses the subset of the fast-import grammar the exporter writes, strictly: every `data` block
 * is read by its exact byte count, every mark is defined before use, and the stream ends in `done`.
 */
function parseFastImport(bytes: Uint8Array): { blobs: Map<number, Uint8Array>; commits: ParsedCommit[] } {
  let at = 0;
  const line = (): string => {
    const end = bytes.indexOf(10, at);
    if (end < 0) throw new Error(`unterminated line at ${at}`);
    const value = decoder.decode(bytes.subarray(at, end));
    at = end + 1;
    return value;
  };
  const data = (): Uint8Array => {
    const header = /^data (\d+)$/.exec(line());
    if (header === null) throw new Error("expected data");
    const length = Number(header[1]);
    const value = bytes.subarray(at, at + length);
    if (value.byteLength !== length) throw new Error("data runs past the stream");
    at += length;
    if (bytes[at] === 10) at += 1;
    return value;
  };
  const mark = (): number => {
    const m = /^mark :(\d+)$/.exec(line());
    if (m === null) throw new Error("expected mark");
    return Number(m[1]);
  };

  expect(line()).toBe("feature done");
  const blobs = new Map<number, Uint8Array>();
  const commits: ParsedCommit[] = [];
  for (;;) {
    const command = line();
    if (command === "done") break;
    if (command === "") continue;
    if (command === "blob") {
      const id = mark();
      blobs.set(id, data());
    } else if (command === "commit refs/heads/main") {
      const id = mark();
      const author = line();
      const committer = line();
      const message = decoder.decode(data());
      const commit: ParsedCommit = { mark: id, author, committer, message, files: [] };
      for (let next = line(); next !== ""; next = line()) {
        const from = /^from :(\d+)$/.exec(next);
        const modify = /^M (100644) :(\d+) ([a-z0-9-]+\.[a-z0-9]+)$/.exec(next);
        if (from !== null) commit.from = Number(from[1]);
        else if (next === "deleteall") continue;
        else if (modify !== null) {
          if (!blobs.has(Number(modify[2]))) throw new Error(`commit :${id} uses undefined blob :${modify[2]}`);
          commit.files.push({ mode: modify[1]!, blob: Number(modify[2]), path: modify[3]! });
        } else throw new Error(`unexpected line ${JSON.stringify(next)}`);
      }
      commits.push(commit);
    } else {
      throw new Error(`unexpected command ${JSON.stringify(command)}`);
    }
  }
  if (at !== bytes.byteLength) throw new Error("bytes after done");
  return { blobs, commits };
}

async function amarasArchive() {
  const env = setup();
  await amarasYear(env);
  return validateArchive((await env.exporter.exportStudentArchive(P.amara)).bytes);
}

describe("the git fast-import export", () => {
  it("writes one linear commit per revision, authored by the export pseudonym", async () => {
    const archive = await amarasArchive();
    const essay = archive.artifacts.find((a) => a.title === "Cell membranes essay")!;
    const stream = gitFastImport(archive, essay.id);
    const { blobs, commits } = parseFastImport(stream);

    expect(commits).toHaveLength(2);
    expect(commits[0]!.from).toBeUndefined();
    expect(commits[1]!.from).toBe(commits[0]!.mark);
    const author = `${archive.manifest.subject} <${archive.manifest.subject}@export.educateos.invalid>`;
    for (const commit of commits) {
      expect(commit.author).toMatch(new RegExp(`^author ${author} \\d+ \\+0000$`));
      expect(commit.committer).toBe(commit.author.replace(/^author /, "committer "));
      expect(commit.files.map((f) => f.path)).toEqual(["cell-membranes-essay.md"]);
    }
    expect(commits.map((c) => c.message)).toEqual(["Revision 1\n", "Revision 2\n\nAI assistance: assisted (workers-ai/example-model)\n"]);
    expect(commits.map((c) => decoder.decode(blobs.get(c.files[0]!.blob)))).toEqual([
      "Cells are small.",
      "Cells are small.\n\nMembranes control what enters.",
    ]);
    expect(decoder.decode(stream)).not.toMatch(/\bprn_|\bart_|\brev_/);
  });

  it("imports into a fresh repository with git, when git is available", async (context) => {
    if (spawnSync("git", ["--version"]).status !== 0) {
      context.skip();
      return;
    }
    const archive = await amarasArchive();
    const essay = archive.artifacts.find((a) => a.title === "Cell membranes essay")!;
    const dir = mkdtempSync(join(tmpdir(), "educateos-git-export-"));
    try {
      const git = (args: string[], input?: Uint8Array) => {
        const result = spawnSync("git", ["-C", dir, ...args], { input, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
        expect(result.status, decoder.decode(result.stderr)).toBe(0);
        return decoder.decode(result.stdout);
      };
      git(["init", "-q"]);
      git(["fast-import", "--quiet"], gitFastImport(archive, essay.id));
      expect(git(["log", "--format=%an|%s", "main"]).trim().split("\n")).toEqual([
        `${archive.manifest.subject}|Revision 2`,
        `${archive.manifest.subject}|Revision 1`,
      ]);
      expect(git(["show", "main:cell-membranes-essay.md"])).toBe("Cells are small.\n\nMembranes control what enters.");
      expect(git(["show", "main~1:cell-membranes-essay.md"])).toBe("Cells are small.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a link, which has no content, and an artifact the archive does not hold", async () => {
    const archive = await amarasArchive();
    const link = archive.artifacts.find((a) => a.type === "external-ref")!;
    expect(() => gitFastImport(archive, link.id)).toThrow(expect.objectContaining({ code: "validation-failed" }));
    expect(() => gitFastImport(archive, "a99")).toThrow(expect.objectContaining({ code: "not-found" }));
  });
});

describe("CLR export", () => {
  it("is unavailable until a district configures an issuer, and invents nothing", async () => {
    const archive = await amarasArchive();
    await rejectsWith(UNCONFIGURED_CLR_ISSUER.issue(archive, archive.manifest.subject), "unavailable");
  });
});
