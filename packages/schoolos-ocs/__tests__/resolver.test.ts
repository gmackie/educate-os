import { describe, expect, it } from "vitest";
import { type OcsModule, OcsError, packageDigest, type PackageSource, readPackage, resolveCourse, serializeLock } from "../src/index.ts";
import { IDS, libraryOf, packageFiles, rejectsWithProblem, resource, tamperingSource, unit } from "./helpers.ts";

const safety = (version: string) =>
  packageFiles({
    manifest: { id: IDS.safety, version, outline: [{ kind: "unit", unit: "rules" }] },
    units: [unit("rules", [{ kind: "resource", ref: "goggles" }], `Lab rules ${version}`)],
    resources: [resource("goggles", "licensed-copy")],
  });

const bio = (version: string, safetyRange: string) =>
  packageFiles({
    manifest: {
      id: IDS.bio,
      version,
      modules: [{ name: "safety", package: IDS.safety, range: safetyRange }],
      outline: [{ kind: "module", module: "safety" }, { kind: "unit", unit: "cells" }],
    },
    units: [unit("cells", [{ kind: "resource", ref: "membranes" }])],
    resources: [resource("membranes", "embed")],
  });

const course = (modules: OcsModule[]) =>
  packageFiles({
    manifest: { id: IDS.course, version: "1.0.0", modules, outline: modules.map((m) => ({ kind: "module" as const, module: m.name })) },
  });

const PUBLISHED = [safety("1.0.0"), safety("1.1.0"), safety("2.0.0"), bio("1.0.0", "^1.0.0"), bio("1.2.0", "^1.1.0"), bio("2.0.0", "^2.0.0")];

const STANDARD_COURSE = course([
  { name: "bio", package: IDS.bio, range: "^1.0.0" },
  { name: "safety", package: IDS.safety, range: "^1.0.0" },
]);

describe("resolution", () => {
  it("picks the highest version every requirement accepts, and locks its digest", async () => {
    const { lock } = await resolveCourse(await readPackage(STANDARD_COURSE), await libraryOf(...PUBLISHED));
    expect(lock.packages.map((entry) => `${entry.id}@${entry.version}`)).toStrictEqual([`${IDS.safety}@1.1.0`, `${IDS.bio}@1.2.0`].toSorted());
    expect(lock.packages.find((entry) => entry.id === IDS.safety)!.digest).toBe(await packageDigest(safety("1.1.0")));
    expect(lock.root.modules).toStrictEqual([
      { name: "bio", package: IDS.bio, version: "1.2.0" },
      { name: "safety", package: IDS.safety, version: "1.1.0" },
    ]);
  });

  it("produces a byte-identical lockfile across runs, whatever order the library was filled in", async () => {
    const root = await readPackage(STANDARD_COURSE);
    const first = serializeLock((await resolveCourse(root, await libraryOf(...PUBLISHED))).lock);
    const second = serializeLock((await resolveCourse(await readPackage(STANDARD_COURSE), await libraryOf(...PUBLISHED.toReversed()))).lock);
    expect(second).toBe(first);
    // The lockfile records versions and digests only: nothing about when or where it was made.
    expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("keeps locked versions while they still fit, so adding a newer version changes nothing", async () => {
    const root = await readPackage(STANDARD_COURSE);
    const before = (await resolveCourse(root, await libraryOf(safety("1.0.0"), bio("1.0.0", "^1.0.0")))).lock;
    const library = await libraryOf(...PUBLISHED);
    const kept = await resolveCourse(root, library, { locked: before });
    expect(serializeLock(kept.lock)).toBe(serializeLock(before));
    const fresh = await resolveCourse(root, library);
    expect(fresh.lock.packages.map((entry) => entry.version)).toStrictEqual(["1.1.0", "1.2.0"].toSorted());
  });

  it("reports a version conflict with every requirement and the available versions", async () => {
    const root = await readPackage(course([
      { name: "bio", package: IDS.bio, range: "2.0.0" },
      { name: "safety", package: IDS.safety, range: "~1.0.0" },
    ]));
    const error = await resolveCourse(root, await libraryOf(...PUBLISHED)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OcsError);
    const { problem, code, message } = error as OcsError;
    expect(code).toBe("conflict");
    expect(problem).toStrictEqual({
      kind: "version-conflict",
      packageId: IDS.safety,
      requirements: [
        { requiredBy: IDS.course, range: "~1.0.0" },
        { requiredBy: `${IDS.bio}@2.0.0`, range: "^2.0.0" },
      ],
      available: ["1.0.0", "1.1.0", "2.0.0"],
    });
    expect(message).toBe(
      `No version of ${IDS.safety} fits every module that uses it: ${IDS.course} needs ~1.0.0, ${IDS.bio}@2.0.0 needs ^2.0.0. Available versions: 1.0.0, 1.1.0, 2.0.0.`,
    );
  });

  it("rejects modules that include each other in a loop", async () => {
    const a = packageFiles({ manifest: { id: "loop.example/a", version: "1.0.0", modules: [{ name: "b", package: "loop.example/b", range: "^1.0.0" }], outline: [{ kind: "module", module: "b" }] } });
    const b = packageFiles({ manifest: { id: "loop.example/b", version: "1.0.0", modules: [{ name: "a", package: "loop.example/a", range: "^1.0.0" }], outline: [{ kind: "module", module: "a" }] } });
    const root = await readPackage(course([{ name: "a", package: "loop.example/a", range: "^1.0.0" }]));
    await rejectsWithProblem(resolveCourse(root, await libraryOf(a, b)), "cycle", /loop\.example\/a -> loop\.example\/b -> loop\.example\/a/);
  });

  it("rejects a module that includes the course itself", async () => {
    const back = packageFiles({ manifest: { id: "loop.example/back", version: "1.0.0", modules: [{ name: "course", package: IDS.course, range: "^1.0.0" }], outline: [{ kind: "module", module: "course" }] } });
    const root = await readPackage(course([{ name: "back", package: "loop.example/back", range: "^1.0.0" }]));
    await rejectsWithProblem(resolveCourse(root, await libraryOf(back)), "cycle", new RegExp(`${IDS.course} -> loop\\.example/back -> ${IDS.course}`));
  });

  it("rejects a package whose content does not match its published digest", async () => {
    const library = await libraryOf(...PUBLISHED);
    const source = tamperingSource(library, (id, _version, files) =>
      id === IDS.safety ? { ...files, "units/rules.json": files["units/rules.json"]!.replace("Lab rules", "Altered rules") } : files);
    await rejectsWithProblem(resolveCourse(await readPackage(STANDARD_COURSE), source), "digest-mismatch", /does not match its recorded fingerprint/);
  });

  it("rejects a package whose digest differs from the one a module pins", async () => {
    const pinned = course([{ name: "safety", package: IDS.safety, range: "1.1.0", digest: await packageDigest(safety("1.0.0")) }]);
    await rejectsWithProblem(resolveCourse(await readPackage(pinned), await libraryOf(...PUBLISHED)), "digest-mismatch");
    const correct = course([{ name: "safety", package: IDS.safety, range: "1.1.0", digest: await packageDigest(safety("1.1.0")) }]);
    await expect(resolveCourse(await readPackage(correct), await libraryOf(...PUBLISHED))).resolves.toBeDefined();
  });

  it("rejects a locked version whose content changed since it was locked, even with a matching published digest", async () => {
    const root = await readPackage(STANDARD_COURSE);
    const { lock } = await resolveCourse(root, await libraryOf(...PUBLISHED));
    // Another library re-published safety 1.1.0 with different content, consistently with its own digest.
    const altered = { ...safety("1.1.0"), "units/rules.json": safety("1.1.0")["units/rules.json"]!.replace("Lab rules", "Different rules") };
    const other = await libraryOf(safety("1.0.0"), altered, bio("1.0.0", "^1.0.0"), bio("1.2.0", "^1.1.0"));
    await rejectsWithProblem(resolveCourse(root, other, { locked: lock }), "digest-mismatch");
  });

  it("rejects a source that answers with a different package than the one asked for", async () => {
    const library = await libraryOf(...PUBLISHED);
    const substitute = safety("2.0.0");
    const source: PackageSource = {
      listVersions: (id) => library.listVersions(id),
      async getPackage(id, version) {
        if (id === IDS.safety) return { files: substitute, digest: await packageDigest(substitute) };
        return library.getPackage(id, version);
      },
    };
    await rejectsWithProblem(resolveCourse(await readPackage(STANDARD_COURSE), source), "identity-mismatch");
  });

  it("reports a module nobody has published", async () => {
    const root = await readPackage(course([{ name: "missing", package: "nowhere.example/missing", range: "^1.0.0" }]));
    await rejectsWithProblem(resolveCourse(root, await libraryOf()), "unknown-package", /No published versions of nowhere\.example\/missing/);
  });
});
