// Who may observe a workspace that reads Clever (docs/observers.md): a one-section binding admits a
// collaborator who teaches that section too; a teacher's all-sections binding admits one who
// teaches every section it has read, and excludes them from reads of a section they do not teach;
// profile, student and district bindings admit nobody.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { binding, failure, FakeClever, hooks, seedAccount, unwrap } from "./fake-clever";

const fake = new FakeClever();

beforeEach(() => {
  fake.install();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a one-section binding", () => {
  it("admits a co-teacher of the section and refuses anyone else", async () => {
    const eng9 = fake.section("mw-eng9-p1");
    const { name, props } = await binding(fake, "mw-t-quill", { kind: "section", sectionId: eng9 });
    unwrap(await hooks().run(name, props, [["getRoster"]]));
    unwrap(await hooks().addObserver(name, props, "reyes", await seedAccount(fake, "mw-t-reyes")));
    expect(failure(await hooks().addObserver(name, props, "okafor", await seedAccount(fake, "mw-t-okafor"))))
      .toMatch(/does not teach the bound Clever section/);
    expect(failure(await hooks().addObserver(name, props, "student", await seedAccount(fake, "mw-s-01"))))
      .toMatch(/does not teach/);
  });
});

describe("a teacher's all-sections binding", () => {
  it("admits a co-teacher of what was read, and withholds a section they do not teach", async () => {
    const { name, props } = await binding(fake, "mw-t-reyes", { kind: "teacher" });
    const eng9 = fake.section("mw-eng9-p1");
    const algebra = fake.section("mw-alg-p3");
    unwrap(await hooks().run(name, props, [["section", eng9], ["getRoster"]]));
    // Quill co-teaches English 9, so they may observe it.
    unwrap(await hooks().addObserver(name, props, "quill", await seedAccount(fake, "mw-t-quill")));
    // Algebra is Reyes's alone: reading it names Quill to be excluded.
    unwrap(await hooks().run(name, props, [["section", algebra], ["getSection"]]));
    const { observations } = await hooks().queueLog(name);
    expect(observations.at(-1)!.excludeObservers).toEqual(["quill"]);
    // And having read Algebra, Quill is no longer admitted afresh.
    expect(failure(await hooks().addObserver(name, props, "quill", await seedAccount(fake, "mw-t-quill"))))
      .toMatch(/does not teach every Clever section/);
  });
});

describe("private bindings", () => {
  it.each([
    ["profile", "mw-t-okafor", { kind: "profile" as const }],
    ["student", "mw-s-01", { kind: "student" as const }],
    ["district", "mw-admin-varga", { kind: "district" as const }],
  ])("a %s binding admits no observer", async (_label, person, target) => {
    const { name, props } = await binding(fake, person, target);
    expect(failure(await hooks().addObserver(name, props, "anyone", await seedAccount(fake, person))))
      .toMatch(/cannot be shared/);
  });

  it("a student's one-class binding admits no observer, not even the teacher", async () => {
    const { name, props } = await binding(fake, "mw-s-01", { kind: "studentSection", sectionId: fake.section("mw-bio-p2") });
    expect(failure(await hooks().addObserver(name, props, "teacher", await seedAccount(fake, "mw-t-okafor"))))
      .toMatch(/cannot be shared/);
  });
});

describe("the verifier", () => {
  it("answers from the district's records, one verdict per section", async () => {
    const reyes = await seedAccount(fake, "mw-t-reyes");
    expect(unwrap(await hooks().verifier(reyes, "teachesSections", [
      fake.section("mw-alg-p3"), fake.section("mw-bio-p2"), "not-an-id",
    ]))).toEqual([true, false, false]);
  });
});
