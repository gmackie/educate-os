// `DurableObjectCatalogMirrorStorage` in workerd, against real Durable Object SQLite storage: state
// survives a restart, concurrent writers on one revision never both commit, releases larger than a
// Durable Object row round-trip intact, unreferenced content is collected, and tampered content is
// refused.

import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { PrincipalId } from "@schoolos/contracts";
import { describe, expect, it } from "vitest";
// Imported module by module: the package index also exports the signature verifier, whose
// dependencies type-check against the web-standard surface rather than Workers' typings (ADR-0009).
import { contentDigest } from "../../src/digest.ts";
import { FrameworkMirrorState } from "../../src/mirror.ts";
import { type CatalogRelease, catalogSeedRelease } from "../../src/release.ts";
import { CatalogKey } from "../../src/vocabulary.ts";
import {
  CATALOG_MIRROR_CONTENT_TABLE,
  CatalogMirrorCorruptionError,
  DurableObjectCatalogMirrorStorage,
} from "../../src/durable-object-storage.ts";

const ADMIN = { by: PrincipalId.parse("prn_nf-district-admin"), at: "2026-10-20T09:00:00Z" };

let mirrors = 0;
const freshMirror = () => env.MIRROR.getByName(`mirror-${mirrors++}`);

async function stateOf(mirror: ReturnType<typeof freshMirror>, key: string): Promise<FrameworkMirrorState> {
  const json = await mirror.state(key);
  if (json === undefined) throw new Error(`${key} is not selected`);
  return FrameworkMirrorState.parse(JSON.parse(json));
}

/** A copy of `release` as `version`, with `edit` applied to its content and its digest recomputed. */
async function revised(release: CatalogRelease, version: string, edit: (content: CatalogRelease["content"]) => void): Promise<CatalogRelease> {
  const content = structuredClone(release.content);
  edit(content);
  return { ...release, version, content, contentDigest: await contentDigest(content) };
}

describe("DurableObjectCatalogMirrorStorage", () => {
  it("keeps selections, installs and approvals across a restart", async () => {
    const mirror = freshMirror();
    const release = await catalogSeedRelease("ccss-math");
    expect(await mirror.select("ccss-math", ADMIN)).toStrictEqual({ ok: true, value: 1 });
    expect(await mirror.install(release, ADMIN)).toStrictEqual({ ok: true, value: "proposed" });
    expect(await mirror.approve("ccss-math", release.version, ADMIN)).toMatchObject({ ok: true });
    const before = await mirror.state("ccss-math");

    await evictDurableObject(mirror);
    expect(await mirror.state("ccss-math")).toBe(before);
    expect(await mirror.approvedDigest("ccss-math")).toBe(release.contentDigest);
  });

  it("lets exactly one of several concurrent approvals of a release commit", async () => {
    const mirror = freshMirror();
    const release = await catalogSeedRelease("ccss-math");
    await mirror.select("ccss-math", ADMIN);
    await mirror.install(release, ADMIN);

    const results = await Promise.all(Array.from({ length: 5 }, () => mirror.approve("ccss-math", release.version, ADMIN)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toStrictEqual(Array.from({ length: 4 }, () => ({ ok: false, code: "conflict" })));
    const state = await stateOf(mirror, "ccss-math");
    expect(state.releases.map((r) => r.status)).toStrictEqual(["approved"]);
    // select, install, approve: three committed writes.
    expect(state.revision).toBe(3);
  });

  it("refuses the second of two writes based on the same revision", async () => {
    const mirror = freshMirror();
    await mirror.select("ngss", ADMIN);
    await runInDurableObject(mirror, async (_instance, state) => {
      const storage = new DurableObjectCatalogMirrorStorage(state.storage);
      const read = (await storage.get(CatalogKey.parse("ngss")))!;
      const writes = await Promise.allSettled([
        storage.put({ ...read, revision: read.revision + 1, selectedAt: "2026-10-20T10:00:00Z" }),
        storage.put({ ...read, revision: read.revision + 1, selectedAt: "2026-10-20T11:00:00Z" }),
      ]);
      expect(writes.map((w) => w.status).toSorted()).toStrictEqual(["fulfilled", "rejected"]);
      expect(writes.find((w) => w.status === "rejected")).toMatchObject({ reason: { code: "conflict" } });
      // A write that skips a revision is refused too.
      await expect(storage.put({ ...read, revision: read.revision + 3 })).rejects.toMatchObject({ code: "conflict" });
    });
  });

  it("stores a release larger than a Durable Object row, and reads it back intact", async () => {
    const mirror = freshMirror();
    const base = await catalogSeedRelease("ccss-ela");
    // Several MB of content, more than the largest row a Durable Object stores.
    const large = await revised(base, "2.0.0", (c) => {
      for (const node of c.nodes!) node.notes = "Synthetic padding. ".repeat(640);
    });
    expect(JSON.stringify(large.content).length).toBeGreaterThan(4 * 1024 * 1024);
    await mirror.select("ccss-ela", ADMIN);
    expect(await mirror.install(large, ADMIN)).toStrictEqual({ ok: true, value: "proposed" });
    await evictDurableObject(mirror);
    const stored = (await stateOf(mirror, "ccss-ela")).releases[0]!.release;
    expect(await contentDigest(stored.content)).toBe(large.contentDigest);
  });

  it("deletes content no state names any more when a proposed release is replaced", async () => {
    const mirror = freshMirror();
    const first = await catalogSeedRelease("ccss-math");
    const replacement = await revised(first, first.version, (c) => void (c.nodes![0]!.notes = "Replaced."));
    await mirror.select("ccss-math", ADMIN);
    await mirror.install(first, ADMIN);
    await mirror.install(replacement, ADMIN);
    const digests = await runInDurableObject(mirror, async (_instance, state) =>
      state.storage.sql.exec(`SELECT DISTINCT content_digest FROM ${CATALOG_MIRROR_CONTENT_TABLE}`).toArray().map((r) => r["content_digest"]));
    expect(digests).toStrictEqual([replacement.contentDigest]);
  });

  it("refuses to read content that no longer matches its digest", async () => {
    const mirror = freshMirror();
    await mirror.select("ccss-math", ADMIN);
    await mirror.install(await catalogSeedRelease("ccss-math"), ADMIN);
    await runInDurableObject(mirror, async (_instance, state) => {
      state.storage.sql.exec(`UPDATE ${CATALOG_MIRROR_CONTENT_TABLE} SET chunk = replace(chunk, '"fullStatement":"', '"fullStatement":"Tampered. ')`);
      const storage = new DurableObjectCatalogMirrorStorage(state.storage);
      await expect(storage.get(CatalogKey.parse("ccss-math"))).rejects.toBeInstanceOf(CatalogMirrorCorruptionError);
    });
  });
});
