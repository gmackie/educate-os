// `DurableObjectPackageLibrary` in workerd: published versions survive restarts and resolve; a
// version is immutable; and every publication passes the district's policy, whose verdict on a
// signature is kept with the version. The signature checks themselves are in signatures.test.ts.

import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DurableObjectPackageLibrary, OCS_LIBRARY_TABLE } from "../../src/durable-object-library.ts";
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
});
