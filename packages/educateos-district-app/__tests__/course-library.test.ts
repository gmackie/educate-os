// SCHO-331: a district administrator imports the reference OCS course from its signed bundle into
// the district's course library, and a teacher previews and installs it in a class: one draft
// module per unit, student notes as pages, teacher guides and answer keys as teacher-only notes,
// and every activity imported, published, installed, assigned and placed. Resumable and add-only.
import { describe, expect, it } from "vitest";
import { SigningIdentity } from "@educateos/fleet";
import { PublisherTrust } from "../src/index.ts";
import bundleJson from "../../../curriculum/bundles/educateos.io/grade-1-reading-foundations/1.0.0.json" with { type: "json" };
import english9 from "../../../curriculum/bundles/educateos.io/english-9/1.0.0.json" with { type: "json" };
import publisher from "../../../curriculum/educateos.io/publisher.json" with { type: "json" };
import { bootDistrict, expectError, NF } from "./support.ts";

const COURSE = { packageId: "educateos.io/grade-1-reading-foundations", version: "1.0.0" } as const;
const TRUST = PublisherTrust.parse({ localDomains: [], publishers: [publisher] });
const bundle = () => structuredClone(bundleJson) as unknown as Record<string, never>;

const UNITS = ["Short Vowel Sounds", "Stories We Love", "Two Letters, One Sound", "Magic E: Long Vowels", "Animal Facts", "Rhymes and Smooth Reading"];

async function districtWithCourse(options: { standards?: readonly string[] } = {}) {
  const district = await bootDistrict(undefined, { courseLibraryTrust: TRUST, ...options });
  const admin = district.tokenFor(NF.admin);
  const imported = await district.ok(admin, "admin.importCourseBundle", { body: bundle() });
  return { district, admin, imported, rivera: district.tokenFor(NF.rivera) };
}

describe("course library (SCHO-331)", () => {
  it("imports the signed reference course once and lists it to administrators and the class's teachers", async () => {
    const { district, admin, imported, rivera } = await districtWithCourse();
    expect(imported).toMatchObject({
      ...COURSE,
      title: "Grade 1 Reading Foundations",
      subject: "english-language-arts",
      gradeBand: "1",
      publisher: { domain: "educateos.io", signed: true },
      activities: 22,
      imported: { by: NF.admin },
    });
    expect(imported.units.map((unit) => unit.title)).toStrictEqual(UNITS);
    expect(imported.units[0]).toMatchObject({ activities: 3, pages: 1, teacherNotes: 2, resources: 0 });
    // Importing it again changes nothing.
    expect(await district.ok(admin, "admin.importCourseBundle", { body: bundle() })).toStrictEqual(imported);
    expect(await district.ok(admin, "admin.listLibraryCourses")).toStrictEqual([imported]);

    const [offered] = await district.ok(rivera, "teacher.libraryCourses", { params: { offeringId: NF.eng9 } });
    // English 9 is not a Grade 1 class.
    expect(offered).toStrictEqual({ ...imported, matchesClass: false });
  });

  it("refuses a tampered bundle, a bundle no pinned key signed, and any bundle without a pin, importing nothing", async () => {
    const district = await bootDistrict(undefined, { courseLibraryTrust: TRUST });
    const admin = district.tokenFor(NF.admin);
    const tampered = bundle() as unknown as { packages: { files: Record<string, string> }[] };
    const unit = "units/short-vowel-sounds.json";
    tampered.packages[0]!.files[unit] = tampered.packages[0]!.files[unit]!.replace("Short Vowel Sounds", "Something Else");
    expectError(await district.call(admin, "admin.importCourseBundle", { body: tampered as never }), 400, "validation-failed");

    const stranger = await SigningIdentity.generate();
    const otherKey = await bootDistrict(undefined, { courseLibraryTrust: { localDomains: [], publishers: [{ domain: "educateos.io", keys: [{ keyId: stranger.keyId, publicKey: stranger.publicKey }] }] } });
    expectError(await otherKey.call(otherKey.tokenFor(NF.admin), "admin.importCourseBundle", { body: bundle() }), 401, "unauthenticated");
    expect(await otherKey.ok(otherKey.tokenFor(NF.admin), "admin.listLibraryCourses")).toStrictEqual([]);

    const unpinned = await bootDistrict();
    expectError(await unpinned.call(unpinned.tokenFor(NF.admin), "admin.importCourseBundle", { body: bundle() }), 503, "unavailable");
    expect(await district.ok(admin, "admin.listLibraryCourses")).toStrictEqual([]);
  });

  it("previews, then installs unit by unit into draft modules, resuming where it stopped and adding nothing twice", async () => {
    const { district, rivera } = await districtWithCourse();
    const params = { offeringId: NF.eng9 };
    const preview = await district.ok(rivera, "teacher.previewCourseInstall", { params, body: COURSE });
    expect(preview).toMatchObject({ ...COURSE, problems: [], done: false, reusedDefinitions: 0 });
    expect(preview.units.map((unit) => [unit.title, unit.status])).toStrictEqual(UNITS.map((title) => [title, "new"]));
    expect(preview.standards.every((standard) => standard.approved)).toBe(true);
    // Nothing is stored by a preview.
    expect((await district.ok(rivera, "teacher.listModules", { params })).outline.modules).toStrictEqual([]);

    const first = await district.ok(rivera, "teacher.installCourse", { params, body: { ...COURSE, maxUnits: 2 } });
    expect(first.units.map((unit) => unit.status)).toStrictEqual(["installed", "installed", "new", "new", "new", "new"]);
    expect(first.done).toBe(false);
    expect(first.units[0]!.items.every((item) => item.done)).toBe(true);
    const [library] = await district.ok(rivera, "teacher.libraryCourses", { params });
    expect(library!.installed).toStrictEqual({ version: "1.0.0", done: false });

    const rest = await district.ok(rivera, "teacher.installCourse", { params, body: COURSE });
    expect(rest.units.map((unit) => unit.status)).toStrictEqual(UNITS.map(() => "installed"));
    expect(rest.done).toBe(true);
    // Again: nothing more to do, nothing added.
    const again = await district.ok(rivera, "teacher.installCourse", { params, body: COURSE });
    expect(again).toStrictEqual(rest);

    const { outline } = await district.ok(rivera, "teacher.listModules", { params });
    expect(outline.modules.map((module) => module.title)).toStrictEqual(UNITS);
    expect(outline.modules.every((module) => !module.published)).toBe(true);
    const [unit1] = outline.modules;
    expect(unit1!.source).toMatchObject({ kind: "course", ...COURSE, unitKey: rest.units[0]!.key });
    expect(unit1!.items.map((item) => item.kind)).toStrictEqual(["page", "teacher-note", "activity", "activity", "activity", "teacher-note"]);
    expect(unit1!.items.filter((item) => item.kind === "teacher-note").map((item) => item.purpose)).toStrictEqual(["context", "answer-key"]);
    const assignments = await district.ok(rivera, "teacher.listAssignments", { params });
    expect(assignments).toHaveLength(22);
    const [library2] = await district.ok(rivera, "teacher.libraryCourses", { params });
    expect(library2!.installed).toStrictEqual({ version: "1.0.0", done: true });

    // Published, the module shows students its page and activities, never the teacher's notes.
    await district.ok(rivera, "teacher.updateModule", { params: { ...params, moduleId: unit1!.id }, body: { published: true } });
    const { outline: student } = await district.ok(district.tokenFor(NF.amara), "student.listModules", { params });
    expect(student.modules).toHaveLength(1);
    expect(student.modules[0]!.items.map((item) => item.kind)).toStrictEqual(["page", "activity", "activity", "activity"]);
    const notePages = new Set(unit1!.items.flatMap((item) => (item.kind === "teacher-note" ? [item.pageId] : [])));
    expect(student.pages.some((page) => notePages.has(page.id))).toBe(false);

    // A cartridge leaves the teacher's notes behind rather than handing them to another system's students.
    const exported = await district.ok(rivera, "teacher.exportCartridge", { params });
    expect(exported.losses.filter((loss) => loss.kind === "teacher-note")).toHaveLength(12);
  });

  it("skips a unit the class already has a module of the same title for, and changes nothing in it", async () => {
    const { district, rivera } = await districtWithCourse();
    const params = { offeringId: NF.eng9 };
    const mine = await district.ok(rivera, "teacher.createModule", { params, body: { title: "short vowel sounds" } });
    const preview = await district.ok(rivera, "teacher.previewCourseInstall", { params, body: COURSE });
    expect(preview.units[0]).toMatchObject({ status: "exists", moduleId: mine.id });
    const done = await district.ok(rivera, "teacher.installCourse", { params, body: COURSE });
    expect(done.units.map((unit) => unit.status)).toStrictEqual(["exists", ...UNITS.slice(1).map(() => "installed")]);
    expect(done.done).toBe(true);
    const { outline } = await district.ok(rivera, "teacher.listModules", { params });
    expect(outline.modules.map((module) => module.title)).toStrictEqual(["short vowel sounds", ...UNITS.slice(1)]);
    expect(outline.modules[0]!.items).toStrictEqual([]);
  });

  it("refuses to install, writing nothing, when the district has not approved the course's standards", async () => {
    const { district, rivera } = await districtWithCourse({ standards: ["ccss-math"] });
    const params = { offeringId: NF.eng9 };
    const preview = await district.ok(rivera, "teacher.previewCourseInstall", { params, body: COURSE });
    expect(preview.problems).toHaveLength(1);
    expect(preview.problems[0]).toContain("ccss-ela");
    expectError(await district.call(rivera, "teacher.installCourse", { params, body: COURSE }), 400, "validation-failed");
    expect((await district.ok(rivera, "teacher.listModules", { params })).outline.modules).toStrictEqual([]);
    expect(await district.ok(rivera, "teacher.listAssignments", { params })).toStrictEqual([]);
  });

  it("installs a semester course late in its term: work the course sets due after the term ends is due when it ends", async () => {
    // A week before Fall 2026 ends, English 9's activities due ten days after install cannot be.
    const at = new Date("2027-01-15T15:00:00Z");
    const district = await bootDistrict(undefined, { courseLibraryTrust: TRUST, now: () => at });
    const admin = district.tokenFor(NF.admin), rivera = district.tokenFor(NF.rivera);
    await district.ok(admin, "admin.importCourseBundle", { body: structuredClone(english9) as never });
    const course = { packageId: "educateos.io/english-9", version: "1.0.0" };
    const params = { offeringId: NF.eng9 };
    expect((await district.ok(rivera, "teacher.installCourse", { params, body: course })).done).toBe(true);
    const due = (await district.ok(rivera, "teacher.listAssignments", { params })).map((a) => a.dueAt);
    expect(due.every((d) => Date.parse(d) > at.getTime() && d <= "2027-01-22T23:59:59.000Z")).toBe(true);
    expect(due).toContain("2027-01-22T23:59:59.000Z");
    // A reading the checks flagged (its "who you are now" reads as addressed to an AI) is approved by
    // the teacher's install, with the flag acknowledged on the decision.
    const flagged = (await district.stores.contentStudio.listItems()).filter((item) => item.checks?.flags.some((f) => f.code === "instruction-like-text"));
    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged.every((item) => item.decision?.outcome === "approved" && item.decision.acknowledgedFlags?.includes("instruction-like-text"))).toBe(true);
  });

  it("answers not-found for a course the library does not hold", async () => {
    const { district, rivera } = await districtWithCourse();
    expectError(await district.call(rivera, "teacher.previewCourseInstall", { params: { offeringId: NF.eng9 }, body: { ...COURSE, version: "9.9.9" } }), 404, "not-found");
    expectError(await district.call(rivera, "teacher.installCourse", { params: { offeringId: NF.eng9 }, body: { packageId: "educateos.io/no-such-course", version: "1.0.0" } }), 404, "not-found");
  });

  it("lets only administrators import and list the library, and only a class's teachers browse and install into it", async () => {
    const { district, rivera } = await districtWithCourse();
    const params = { offeringId: NF.eng9 };
    expectError(await district.call(rivera, "admin.importCourseBundle", { body: bundle() }), 403, "forbidden");
    expectError(await district.call(rivera, "admin.listLibraryCourses"), 403, "forbidden");
    for (const token of [district.tokenFor(NF.amara), district.tokenFor(NF.chen)]) {
      expectError(await district.call(token, "teacher.libraryCourses", { params }), 403, "forbidden");
      expectError(await district.call(token, "teacher.previewCourseInstall", { params, body: COURSE }), 403, "forbidden");
      expectError(await district.call(token, "teacher.installCourse", { params, body: COURSE }), 403, "forbidden");
    }
    expect((await district.ok(rivera, "teacher.listModules", { params })).outline.modules).toStrictEqual([]);
  });
});
