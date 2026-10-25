import { describe, expect, it } from "vitest";
import {
  addModule,
  type CourseDraft,
  editCourse,
  hide,
  preview,
  publish,
  removeModule,
  rename,
  reorder,
  serializeLock,
  startCourse,
  updateModules,
} from "../src/index.ts";
import { activity, IDS, libraryOf, packageFiles, resource, unit } from "./helpers.ts";

const safety = (version: string) =>
  packageFiles({
    manifest: { id: IDS.safety, version, outline: [{ kind: "unit", unit: "rules" }] },
    units: [unit("rules", [{ kind: "resource", ref: "goggles" }], `Lab rules ${version}`)],
    resources: [resource("goggles", "embed")],
  });

const bio = (version: string) =>
  packageFiles({
    manifest: { id: IDS.bio, version, outline: [{ kind: "unit", unit: "cells" }, { kind: "unit", unit: "extension" }] },
    units: [unit("cells", [{ kind: "activity", ref: "osmosis-lab" }]), unit("extension", [{ kind: "activity", ref: "osmosis-lab" }])],
    activities: [activity("osmosis-lab", "adf_osmosis-lab")],
  });

const newCourse = () => startCourse({ id: IDS.course, title: "Biology 9", language: "en", subject: "science", gradeBand: "9" });

/** What a teacher does in the composer: pick two modules, arrange them, hide and rename. */
const composeTwoModules = (draft: CourseDraft = newCourse()) => {
  let next = addModule(draft, { packageId: IDS.bio, version: "1.0.0" });
  next = addModule(next, { packageId: IDS.safety, version: "1.0.0" });
  next = reorder(next, ["lab-safety"]);
  next = hide(next, { modules: ["cells-core"], unit: "extension" });
  return rename(next, { modules: ["lab-safety"], unit: "rules" }, "Staying safe in the lab");
};

describe("C06 acceptance: teachers compose courses without Git", () => {
  it("composes, previews and publishes a course from two modules", async () => {
    const library = await libraryOf(safety("1.0.0"), bio("1.0.0"));
    const draft = composeTwoModules();

    const shown = await preview(draft, library);
    expect(shown.course.units.map((u) => [u.key, u.title])).toStrictEqual([
      ["lab-safety:rules", "Staying safe in the lab"],
      ["cells-core:cells", "Unit cells"],
    ]);
    expect(shown.changes).toStrictEqual([
      { kind: "added", packageId: IDS.safety, to: "1.0.0" },
      { kind: "added", packageId: IDS.bio, to: "1.0.0" },
    ].toSorted((a, b) => (a.packageId < b.packageId ? -1 : 1)));

    const published = await publish(draft, library);
    expect(published.version).toBe("1.0.0");
    expect(published.files["ocs.lock"]).toBe(serializeLock(published.lock));
    expect(published.lock).toStrictEqual(shown.lock);
    // The publication is a valid package the library accepts, and the course can include it later.
    await expect(library.publish(published.files)).resolves.toMatchObject({ digest: published.digest });
  });

  it("produces the same package from the same choices, every time", async () => {
    const first = await publish(composeTwoModules(), await libraryOf(safety("1.0.0"), bio("1.0.0")));
    const second = await publish(composeTwoModules(), await libraryOf(bio("1.0.0"), safety("1.0.0")));
    expect(second.files).toStrictEqual(first.files);
    expect(second.digest).toBe(first.digest);
  });

  it("keeps module versions across publications until the teacher asks for updates", async () => {
    const library = await libraryOf(safety("1.0.0"), bio("1.0.0"));
    const first = await publish(composeTwoModules(), library);
    await library.publish(first.files);
    await library.publish(safety("1.1.0"));

    const draft = await editCourse(first.files);
    expect((await preview(draft, library)).changes).toStrictEqual([]);
    const fix = await publish(draft, library, { change: "fix" });
    expect(fix.version).toBe("1.0.1");
    expect(fix.lock.packages.find((entry) => entry.id === IDS.safety)!.version).toBe("1.0.0");

    const updating = updateModules(fix.draft, ["lab-safety"]);
    expect((await preview(updating, library)).changes).toStrictEqual([{ kind: "updated", packageId: IDS.safety, from: "1.0.0", to: "1.1.0" }]);
    const addition = await publish(updating, library);
    expect(addition.version).toBe("1.1.0");
    expect(addition.course.units[0]!.title).toBe("Staying safe in the lab");
  });

  it("removes a module together with the changes the course made to it", async () => {
    const draft = removeModule(composeTwoModules(), "cells-core");
    expect(draft.manifest.modules.map((m) => m.name)).toStrictEqual(["lab-safety"]);
    expect(draft.manifest.outline).toStrictEqual([{ kind: "module", module: "lab-safety" }]);
    expect(draft.manifest.overrides.map((o) => o.target.modules[0])).toStrictEqual(["lab-safety"]);
    const shown = await preview(draft, await libraryOf(safety("1.0.0")));
    expect(shown.course.units.map((u) => u.key)).toStrictEqual(["lab-safety:rules"]);
  });

  it("refuses the same package twice, and gives a second module of the same name a new one", async () => {
    const draft = addModule(newCourse(), { packageId: IDS.bio, version: "1.0.0" });
    expect(() => addModule(draft, { packageId: IDS.bio, version: "1.0.0" })).toThrow(/already part of this course/);
    const other = addModule(draft, { packageId: "otherbio.example/cells-core", version: "1.0.0" });
    expect(other.manifest.modules.map((m) => m.name)).toStrictEqual(["cells-core", "cells-core-2"]);
  });

  it("speaks the teacher's language: no version-control words in the API or in anything it says", async () => {
    const GIT_WORDS = /\b(git|commits?|branch(es)?|merges?|rebase|clone|checkout|push|pull|submodules?|repo(sitory)?|head|fork|stash|diff)\b/i;
    const api = { startCourse, editCourse, addModule, removeModule, updateModules, reorder, hide, rename, preview, publish };
    expect(Object.keys(api).join(" ")).not.toMatch(GIT_WORDS);

    const library = await libraryOf(safety("1.0.0"), safety("2.0.0"), bio("1.0.0"));
    const said: string[] = [];
    const capture = async (attempt: () => unknown) => {
      try {
        await attempt();
      } catch (error) {
        said.push((error as Error).message);
      }
    };
    said.push(JSON.stringify(await preview(composeTwoModules(), library)));
    await capture(() => addModule(addModule(newCourse(), { packageId: IDS.bio, version: "1.0.0" }), { packageId: IDS.bio, version: "1.0.0" }));
    await capture(() => removeModule(newCourse(), "cells-core"));
    await capture(() => reorder(newCourse(), ["missing"]));
    await capture(() => preview(addModule(newCourse(), { packageId: IDS.history, version: "1.0.0" }), library));
    await capture(() => preview(hide(addModule(newCourse(), { packageId: IDS.bio, version: "1.0.0" }), { modules: ["cells-core"], unit: "genetics" }), library));
    const conflicted = { ...addModule(newCourse(), { packageId: IDS.safety, version: "1.0.0" }) };
    await capture(() => preview({ ...conflicted, manifest: { ...conflicted.manifest, modules: [{ ...conflicted.manifest.modules[0]!, range: "^3.0.0" }] } }, library));
    expect(said).toHaveLength(7);
    for (const text of said) expect(text).not.toMatch(GIT_WORDS);
  });
});
