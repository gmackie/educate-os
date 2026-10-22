import { ResourceDescriptor } from "@schoolos/registry";
import { describe, expect, it } from "vitest";
import { blueprintTreeId, type BlueprintReleaseInput, snapshotReleaseCommit, verifyBlueprintRelease } from "../src/index.ts";
import { BIO_SCOPE, ENG9_SCOPE, MORGAN, RIVERA, rejectsWith, studio } from "./helpers.ts";

// A synthetic gadget. The IDs below were computed by git itself (`git write-tree` and
// `git commit-tree` with the snapshot identity and date), so they pin the encoding to git's.
const CODE_MARKER = "fraction-strips-client-code";
const FILES: Record<string, string> = {
  "README.md": "# Fraction Strips (synthetic)\n\nDrag strips to compare fractions.\n",
  "client.js": `export const MARKER = '${CODE_MARKER}';\n`,
  "lib/protocol.ts": "export type Strip = { numerator: number; denominator: number };\n",
  "lib.md": "Notes on the library.\n",
};
const TREE = "ceff83d3276ac1a90dc88cdce42bc4e3752af3da";
const SNAPSHOT = "296a596abaf1fce22858092014f92d96b1ac5829";
const FILES_V2 = { ...FILES, "client.js": `export const MARKER = "${CODE_MARKER}-v2";\n` };
const SNAPSHOT_V2 = "affe3b80804e3527244999a8cf2ff3a0399cb373";
/** A published release of FILES_V2 whose parent is the first snapshot. */
const PUBLISHED_V2 = "e784d17c41dfbafe46c431a202044f9a52dc90d3";
const PUBLISHED_V2_COMMIT = [
  "tree d134bd1787b11747a15e71fad39a49074839ba45",
  `parent ${SNAPSHOT}`,
  "author Ms Rivera <rivera@northfield.example> 1790000000 +0000",
  "committer Ms Rivera <rivera@northfield.example> 1790000000 +0000",
  "",
  "Release 2: Fraction Strips",
  "",
].join("\n");

const release = (overrides: Partial<BlueprintReleaseInput> = {}): BlueprintReleaseInput => ({
  name: "fraction-strips",
  fileName: "fraction-strips",
  title: "Fraction Strips",
  version: 1,
  commitId: SNAPSHOT,
  files: FILES,
  ...overrides,
});

describe("Blueprint release identity", () => {
  it("computes the tree and snapshot commit git computes", async () => {
    expect(await blueprintTreeId(new Map(Object.entries(FILES)))).toBe(TREE);
    expect(await verifyBlueprintRelease(release())).toStrictEqual({ commitId: SNAPSHOT, treeId: TREE, snapshot: true });
    expect(snapshotReleaseCommit(TREE)).toContain(`tree ${TREE}\n`);
  });

  it("verifies a published release from its commit text, and refuses one whose tree is not its files", async () => {
    expect(await verifyBlueprintRelease(release({ files: FILES_V2, commitId: PUBLISHED_V2, commit: PUBLISHED_V2_COMMIT, version: 2 })))
      .toMatchObject({ commitId: PUBLISHED_V2, snapshot: false });
    await rejectsWith(verifyBlueprintRelease(release({ commitId: PUBLISHED_V2, commit: PUBLISHED_V2_COMMIT })), "validation-failed");
  });

  it("refuses a commit that does not match the files, whatever it claims", async () => {
    await rejectsWith(verifyBlueprintRelease(release({ commitId: SNAPSHOT_V2 })), "validation-failed");
    await rejectsWith(verifyBlueprintRelease(release({ files: { ...FILES, "client.js": "tampered();\n" } })), "validation-failed");
    await rejectsWith(verifyBlueprintRelease(release({ files: { ...FILES, "lib": "a file named like a directory" } })), "validation-failed");
    await rejectsWith(verifyBlueprintRelease(release({ files: { "../escape.js": "x" } })), "validation-failed");
  });
});

describe("Blueprint ingest", () => {
  it("quarantines and reviews a release, and an approval releases an interactive resource pinned to its commit", async () => {
    const { studio: s, storage } = await studio();
    const item = await s.submitBlueprint(MORGAN, { release: release(), targetScope: BIO_SCOPE });
    expect(item).toMatchObject({
      state: "reviewed",
      contentType: "blueprint-release",
      title: "Fraction Strips",
      source: { kind: "blueprint", name: "fraction-strips", version: 1, commitId: SNAPSHOT, snapshot: true },
      rights: { current: "link" },
    });
    expect(item.checks?.flags.map((flag) => flag.code)).toContain("gadget-code");
    expect((await s.listQueue(MORGAN, BIO_SCOPE)).map((entry) => entry.itemId)).toStrictEqual([item.id]);
    const audit = await s.listAudit(MORGAN, item.id);
    expect(audit.map((event) => event.to)).toStrictEqual(["discovered", "quarantined", "parsed", "provenance-resolved", "reviewed"]);

    const released = await s.approve(MORGAN, item.id, { alignments: [] });
    const descriptor = ResourceDescriptor.parse(released.descriptor);
    expect(descriptor).toMatchObject({
      kind: "interactive",
      title: "Fraction Strips",
      locator: `urn:schoolos:blueprint:fraction-strips:release:${SNAPSHOT}`,
      release: { version: "1.0.0", contentDigest: item.snapshotDigest },
      provenance: { source: "official", sourceRevision: SNAPSHOT },
      review: { status: "approved", reviewer: MORGAN.principalId },
    });

    // The code is in no record the studio keeps: not the release, the item or the quarantined manifest.
    const manifest = new TextDecoder().decode(await storage.getSnapshot(item.snapshotDigest));
    for (const kept of [JSON.stringify(released), JSON.stringify(await storage.listItems()), manifest]) {
      expect(kept).not.toContain(CODE_MARKER);
    }
    expect(JSON.parse(manifest)).toMatchObject({ commitId: SNAPSHOT, treeId: TREE, files: expect.arrayContaining([expect.objectContaining({ path: "client.js" })]) });
  });

  it("refuses a release that carries a blueprint ID, which is a bearer link to the code", async () => {
    const { studio: s } = await studio();
    await rejectsWith(s.submitBlueprint(MORGAN, { release: { ...release(), blueprintId: "0123456789abcdef0123456789abcdef" }, targetScope: BIO_SCOPE }), "validation-failed");
  });

  it("makes a new blueprint version a new release, leaving the earlier one as it was", async () => {
    const { studio: s } = await studio();
    const first = await s.submitBlueprint(MORGAN, { release: release(), targetScope: BIO_SCOPE });
    const v1 = await s.approve(MORGAN, first.id, { alignments: [] });

    // The same commit again is not a new release.
    await rejectsWith(s.submitBlueprint(MORGAN, { release: release(), targetScope: BIO_SCOPE, updatesResourceId: first.resourceId }), "conflict");

    const second = await s.submitBlueprint(MORGAN, {
      release: release({ version: 2, files: FILES_V2, commitId: PUBLISHED_V2, commit: PUBLISHED_V2_COMMIT }),
      targetScope: BIO_SCOPE,
      updatesResourceId: first.resourceId,
    });
    const v2 = await s.approve(MORGAN, second.id, { alignments: [] });
    expect(v2.descriptor).toMatchObject({ id: v1.descriptor.id, release: { version: "2.0.0" }, locator: `urn:schoolos:blueprint:fraction-strips:release:${PUBLISHED_V2}` });
    const releases = await s.listReleases(MORGAN, BIO_SCOPE, first.resourceId);
    expect(releases.map((r) => r.descriptor.release.version)).toStrictEqual(["1.0.0", "2.0.0"]);
    expect(releases[0]).toStrictEqual(v1);
  });

  it("lets only someone who may create at the scope submit, and keeps a release out of other classes", async () => {
    const { studio: s } = await studio();
    await rejectsWith(s.submitBlueprint(RIVERA, { release: release(), targetScope: BIO_SCOPE }), "forbidden");
    const item = await s.submitBlueprint(MORGAN, { release: release(), targetScope: BIO_SCOPE });
    await s.approve(MORGAN, item.id, { alignments: [] });
    await rejectsWith(s.bindToOffering(RIVERA, { resourceId: item.resourceId, offering: ENG9_SCOPE }), "forbidden");
  });
});
