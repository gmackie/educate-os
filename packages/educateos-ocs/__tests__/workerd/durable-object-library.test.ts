// `DurableObjectPackageLibrary` in workerd: published versions survive restarts and resolve; a
// version is immutable; and every publication passes the district's policy, whose verdict on a
// signature is kept with the version. The signature checks themselves are in signatures.test.ts.

import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { activityExportDigest } from "../../src/activity-export.ts";
import { DurableObjectPackageLibrary, OCS_EXPORT_TABLE, OCS_LIBRARY_TABLE } from "../../src/durable-object-library.ts";
import { formatJson, packageDigest, readPackage } from "../../src/package.ts";
import { resolveCourse } from "../../src/resolver.ts";
import { TEST_POLICY } from "./worker.ts";

let libraries = 0;
const fresh = () => env.LIBRARY.getByName(`dst_northfield-${libraries++}`);

/** A one-unit package with one resource. */
function files(id: string, version = "1.0.0", title = "Cells"): Record<string, string> {
  return {
    "ocs.json": formatJson({ specVersion: "1.0", id, version, title: `Course ${id}`, language: "en", standards: [], modules: [], outline: [{ kind: "unit", unit: "cells" }], overrides: [] }),
    "units/cells.json": formatJson({ id: "cells", title, standards: [], items: [{ kind: "resource", ref: "reading" }] }),
    "resources/reading.json": formatJson({ kind: "release", id: "reading", title: "Reading", release: { resourceId: "rsc_reading", version: "1.0.0" }, use: "link" }),
  };
}

/** A one-step picture-response export. */
const exported = (id: string, language = "en"): string => formatJson({
  specVersion: "1.1", id, version: "1.0.0", language, alignments: [],
  activity: {
    template: "picture-response", title: "Pond", subject: "science", gradeBand: "K", overview: "Draw a pond.", aiHelp: "none", due: { kind: "none" },
    lookPrompt: "Look at the pond.", drawPrompt: "Draw an animal that lives there.", tellAboutIt: false, sentenceFrames: [],
  },
});

const COURSE = "northfield.example/biology-9";
const EXTERNAL = "openbio.example/cells-core";

describe("DurableObjectPackageLibrary", () => {
  it("keeps published versions across restarts, and resolves courses from them", async () => {
    const library = fresh();
    expect(await library.publish(files(COURSE))).toMatchObject({ ok: true });
    expect(await library.publish(files(COURSE, "1.1.0"))).toMatchObject({ ok: true });
    await evictDurableObject(library);
    expect([...(await library.versions(COURSE))].toSorted()).toStrictEqual(["1.0.0", "1.1.0"]);
    const entry = (await library.entry(COURSE, "1.0.0"))!;
    expect(entry.digest).toBe(await packageDigest(files(COURSE)));
    expect(entry.signature).toBeUndefined();

    const root = await readPackage({
      "ocs.json": formatJson({
        specVersion: "1.0", id: "northfield.example/biology-9-p2", version: "1.0.0", title: "Period 2", language: "en", standards: [],
        modules: [{ name: "core", package: COURSE, range: "^1.0.0" }], outline: [{ kind: "module", module: "core" }], overrides: [],
      }),
    });
    await runInDurableObject(library, async (_, state) => {
      const resolution = await resolveCourse(root, new DurableObjectPackageLibrary(state.storage, { policy: TEST_POLICY }));
      expect(resolution.lock.packages.map((p) => [p.id, p.version])).toStrictEqual([[COURSE, "1.1.0"]]);
    });
  });

  it("never changes a published version", async () => {
    const library = fresh();
    expect(await library.publish(files(COURSE))).toMatchObject({ ok: true });
    expect(await library.publish(files(COURSE))).toMatchObject({ ok: true });
    expect(await library.publish(files(COURSE, "1.0.0", "Different"))).toStrictEqual({ ok: false, code: "conflict" });
    await runInDurableObject(library, (_, state) => {
      expect(() => state.storage.sql.exec(`UPDATE ${OCS_LIBRARY_TABLE} SET digest = 'x'`)).toThrow(/immutable/);
      expect(() => state.storage.sql.exec(`DELETE FROM ${OCS_LIBRARY_TABLE}`)).toThrow(/immutable/);
    });
    expect((await library.entry(COURSE, "1.0.0"))?.digest).toBe(await packageDigest(files(COURSE)));
  });

  it("publishes only what the policy admits, and keeps the accepted signature", async () => {
    const library = fresh();
    expect(await library.publish(files(EXTERNAL))).toStrictEqual({ ok: false, code: "unauthenticated" });
    expect(await library.versions(EXTERNAL)).toStrictEqual([]);
    const signature = { accepted: true, keyId: "synthetic" };
    expect(await library.publish(files(EXTERNAL), signature)).toMatchObject({ ok: true });
    await evictDurableObject(library);
    expect(JSON.parse((await library.entry(EXTERNAL, "1.0.0"))!.signature!)).toStrictEqual(signature);
  });

  it("keeps activity exports immutable and admits them only by its export policy (OCS 1.1)", async () => {
    const library = fresh();
    const own = exported("northfield.example/pond");
    expect(await library.publishExport(own)).toMatchObject({ ok: true, value: { digest: await activityExportDigest(own) } });
    expect(await library.publishExport(own)).toMatchObject({ ok: true });
    expect(await library.publishExport(exported("northfield.example/pond", "es"))).toStrictEqual({ ok: false, code: "conflict" });
    expect(await library.publishExport(exported(EXTERNAL))).toStrictEqual({ ok: false, code: "unauthenticated" });
    expect(await library.publishExport(exported(EXTERNAL), { accepted: true })).toMatchObject({ ok: true });
    expect(await library.publishExport("{")).toStrictEqual({ ok: false, code: "validation-failed" });
    await evictDurableObject(library);
    expect(await library.exportVersions("northfield.example/pond")).toStrictEqual(["1.0.0"]);
    expect(await library.exportEntry("northfield.example/pond", "1.0.0")).toMatchObject({ signature: undefined, verified: true });
    expect(JSON.parse((await library.exportEntry(EXTERNAL, "1.0.0"))!.signature!)).toStrictEqual({ accepted: true });
    await runInDurableObject(library, (_, state) => {
      expect(() => state.storage.sql.exec(`UPDATE ${OCS_EXPORT_TABLE} SET digest = 'x'`)).toThrow(/immutable/);
      expect(() => state.storage.sql.exec(`DELETE FROM ${OCS_EXPORT_TABLE}`)).toThrow(/immutable/);
    });
  });

  it("refuses every activity export without an export policy", async () => {
    await runInDurableObject(fresh(), async (_, state) => {
      const plain = new DurableObjectPackageLibrary(state.storage, { policy: TEST_POLICY });
      await expect(plain.publishExport(exported("northfield.example/pond"))).rejects.toMatchObject({ code: "policy-violation" });
    });
  });
});
