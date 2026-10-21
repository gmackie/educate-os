import { describe, expect, it } from "vitest";
import { type ComposedCourse, composeCourse, type OcsManifest, type OcsModule, readPackage, resolveCourse, serializeLock } from "../src/index.ts";
import { activity, IDS, libraryOf, packageFiles, rejectsWithProblem, resource, unit } from "./helpers.ts";

const safety = (modules: OcsModule[] = [], extra: Partial<OcsManifest> = {}) =>
  packageFiles({
    manifest: { id: IDS.safety, version: "1.0.0", modules, outline: [{ kind: "unit", unit: "rules" }, { kind: "unit", unit: "spills" }], ...extra },
    units: [
      unit("rules", [{ kind: "resource", ref: "goggles" }, { kind: "codex", ref: "ppe" }, { kind: "activity", ref: "quiz" }], "Lab rules"),
      unit("spills", [{ kind: "resource", ref: "spill-kit" }], "Spills"),
    ],
    resources: [resource("goggles", "licensed-copy"), resource("spill-kit", "link")],
    activities: [activity("quiz", "adf_safety-quiz", 3, "assessment")],
    codex: [{ id: "ppe", title: "Protective equipment", body: "Goggles stay on until every bench is clear.", purpose: "context", visibility: "students" }],
  });

const bio = (modules: OcsModule[] = [], extra: Partial<OcsManifest> = {}) =>
  packageFiles({
    manifest: {
      id: IDS.bio,
      version: "1.0.0",
      modules,
      outline: [{ kind: "unit", unit: "cells" }, ...modules.map((m) => ({ kind: "module" as const, module: m.name })), { kind: "unit", unit: "transport" }, { kind: "unit", unit: "extension" }],
      ...extra,
    },
    units: [
      unit("cells", [{ kind: "activity", ref: "osmosis-lab" }, { kind: "resource", ref: "membranes" }], "Cells"),
      unit("transport", [{ kind: "activity", ref: "diffusion-essay" }, { kind: "resource", ref: "diagrams" }], "Transport"),
      unit("extension", [{ kind: "resource", ref: "diagrams" }], "Extension"),
    ],
    activities: [activity("osmosis-lab", "adf_osmosis-lab", 2), activity("diffusion-essay", "adf_diffusion-essay", 1)],
    resources: [resource("membranes", "licensed-copy"), resource("diagrams", "link")],
  });

const course = (modules: OcsModule[], extra: Partial<OcsManifest> = {}) =>
  packageFiles({
    manifest: {
      id: IDS.course,
      version: "1.0.0",
      modules,
      outline: [{ kind: "unit", unit: "intro" }, ...modules.map((m) => ({ kind: "module" as const, module: m.name }))],
      ...extra,
    },
    units: [unit("intro", [{ kind: "resource", ref: "syllabus" }], "Welcome")],
    resources: [resource("syllabus", "licensed-copy")],
  });

const compose = async (root: Record<string, string>, ...published: Record<string, string>[]) =>
  composeCourse(await resolveCourse(await readPackage(root), await libraryOf(...published)));

const resolveAndCompose = async (root: Record<string, string>, published: Record<string, string>[]) => {
  const resolution = await resolveCourse(await readPackage(root), await libraryOf(...published));
  return { lock: serializeLock(resolution.lock), course: JSON.stringify(composeCourse(resolution)) };
};

const keys = (composed: ComposedCourse) => composed.units.map((u) => u.key);
const item = (composed: ComposedCourse, key: string) => composed.units.flatMap((u) => u.items).find((i) => i.key === key);

describe("C06 acceptance: two course packages combine deterministically", () => {
  const root = course([
    { name: "safety", package: IDS.safety, range: "^1.0.0" },
    { name: "bio", package: IDS.bio, range: "^1.0.0" },
  ]);

  it("flattens both packages into one outline in manifest order, with provenance on every item", async () => {
    const composed = await compose(root, safety(), bio());
    expect(keys(composed)).toStrictEqual(["intro", "safety:rules", "safety:spills", "bio:cells", "bio:transport", "bio:extension"]);
    const lab = item(composed, "bio:cells#osmosis-lab");
    expect(lab).toMatchObject({ kind: "activity", activity: { definition: { definitionId: "adf_osmosis-lab", version: 2 } } });
    const bioPackage = await readPackage(bio());
    expect(lab!.provenance).toStrictEqual({ packageId: IDS.bio, version: "1.0.0", digest: bioPackage.digest, modules: ["bio"] });
    expect(item(composed, "intro#syllabus")!.provenance.modules).toStrictEqual([]);
    expect(item(composed, "safety:rules#ppe")).toMatchObject({ kind: "codex", note: { visibility: "students" } });
  });

  it("composes byte-identically from the same inputs, whatever order the library holds them in", async () => {
    const first = await resolveAndCompose(root, [safety(), bio()]);
    const second = await resolveAndCompose(root, [bio(), safety()]);
    expect(second).toStrictEqual(first);
  });
});

describe("overrides", () => {
  // Biology includes lab safety and renames its spills unit; the course then adjusts biology.
  const bioWithSafety = bio([{ name: "safety", package: IDS.safety, range: "^1.0.0" }], {
    overrides: [{ kind: "rename", target: { modules: ["safety"], unit: "spills" }, title: "Cleaning up spills" }],
  });

  it("hides, renames and reorders what modules contribute, the including package last", async () => {
    const root = course([{ name: "bio", package: IDS.bio, range: "^1.0.0" }], {
      overrides: [
        { kind: "hide", target: { modules: ["bio", "safety"], unit: "rules", item: "ppe" } },
        { kind: "hide", target: { modules: ["bio"], unit: "extension" } },
        { kind: "rename", target: { modules: ["bio"], unit: "cells" }, title: "Cell biology" },
        { kind: "rename", target: { modules: ["bio"], unit: "transport", item: "diffusion-essay" }, title: "Why does diffusion matter?" },
        { kind: "reorder", target: { modules: ["bio"] }, order: ["transport"] },
        { kind: "reorder", target: { modules: ["bio"], unit: "cells" }, order: ["membranes"] },
      ],
    });
    const composed = await compose(root, safety(), bioWithSafety);

    // Biology's own units swap places; the units it takes from lab safety stay where biology put them.
    expect(keys(composed)).toStrictEqual(["intro", "bio:transport", "bio/safety:rules", "bio/safety:spills", "bio:cells"]);
    expect(composed.hidden).toStrictEqual(["bio/safety:rules#ppe", "bio:extension"]);
    expect(composed.units.find((u) => u.key === "bio:cells")).toMatchObject({ title: "Cell biology", renamed: true });
    expect(composed.units.find((u) => u.key === "bio/safety:spills")).toMatchObject({ title: "Cleaning up spills", renamed: true });
    expect(item(composed, "bio:transport#diffusion-essay")).toMatchObject({ title: "Why does diffusion matter?", renamed: true });
    expect(composed.units.find((u) => u.key === "bio:cells")!.items.map((i) => i.key)).toStrictEqual(["bio:cells#membranes", "bio:cells#osmosis-lab"]);
    expect(item(composed, "bio/safety:rules#ppe")).toBeUndefined();
  });

  it("reports an override that no longer matches anything in the module", async () => {
    const root = course([{ name: "bio", package: IDS.bio, range: "^1.0.0" }], {
      overrides: [{ kind: "rename", target: { modules: ["bio"], unit: "genetics" }, title: "Heredity" }],
    });
    await rejectsWithProblem(compose(root, bio()), "invalid-change", /bio:genetics cannot be applied: there is no such unit/);
  });

  it("shows a unit two modules both include once, at its first place", async () => {
    const root = course([
      { name: "bio", package: IDS.bio, range: "^1.0.0" },
      { name: "safety", package: IDS.safety, range: "^1.0.0" },
    ]);
    const composed = await compose(root, safety(), bioWithSafety);
    expect(keys(composed)).toStrictEqual(["intro", "bio:cells", "bio/safety:rules", "bio/safety:spills", "bio:transport", "bio:extension"]);
    expect(composed.repeated).toStrictEqual(["safety:rules", "safety:spills"]);
  });
});

describe("rights propagation", () => {
  it("only narrows a resource's use through each module on the way up, and never widens it", async () => {
    // The course caps biology at excerpt; biology caps lab safety at embed.
    const root = course([{ name: "bio", package: IDS.bio, range: "^1.0.0", rights: "excerpt" }]);
    const composed = await compose(root, safety(), bio([{ name: "safety", package: IDS.safety, range: "^1.0.0", rights: "embed" }]));
    const use = (key: string) => {
      const found = item(composed, key);
      return found?.kind === "resource" ? found.use : undefined;
    };
    expect(use("intro#syllabus")).toBe("licensed-copy");
    expect(use("bio:cells#membranes")).toBe("excerpt");
    expect(use("bio/safety:rules#goggles")).toBe("embed");
    // Declared as link only: no cap above it can widen it.
    expect(use("bio/safety:spills#spill-kit")).toBe("link");
    expect(use("bio:transport#diagrams")).toBe("link");
  });

  it("keeps the narrowest cap when the course is wider than the module", async () => {
    const root = course([{ name: "bio", package: IDS.bio, range: "^1.0.0", rights: "licensed-copy" }]);
    const composed = await compose(root, safety(), bio([{ name: "safety", package: IDS.safety, range: "^1.0.0", rights: "link" }]));
    const goggles = item(composed, "bio/safety:rules#goggles");
    expect(goggles?.kind === "resource" ? goggles.use : undefined).toBe("link");
  });
});
