import { describe, expect, it } from "vitest";
import { ActivityId, type SchoolOsError } from "@schoolos/contracts";
import { NORTHFIELD } from "@schoolos/fixtures";
import { CourseContentService, InMemoryCourseContentStorage, type ActivityInstallation } from "../src/index.ts";
import { AMARA, BIO, BIO_SPRING, CHIDI, D, DMITRI, ENG9, MORGAN, policyEngine, RIVERA, RIVERBEND_TEACHER } from "./helpers.ts";

const BIO_ACTIVITY = ActivityId.parse("act_bio-cells");
const ENG_ACTIVITY = ActivityId.parse("act_eng-essay");

function setup() {
  const { engine, audit } = policyEngine(NORTHFIELD);
  const storage = new InMemoryCourseContentStorage();
  const installed = new Map([
    [BIO_ACTIVITY, { scope: { ...BIO, activityId: BIO_ACTIVITY } }],
    [ENG_ACTIVITY, { scope: { ...ENG9, activityId: ENG_ACTIVITY } }],
  ]);
  const service = new CourseContentService({
    districtId: D,
    directory: NORTHFIELD,
    authorizer: engine,
    storage,
    installations: { getInstallation: async (id) => installed.get(id) as ActivityInstallation | undefined },
    now: () => "2026-10-23T12:00:00.000Z",
  });
  return { service, storage, audit };
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as SchoolOsError).code;
  }
  return "resolved";
}

describe("course content (SCHO-186)", () => {
  it("lets a teacher build ordered modules of pages and activities, and shows students only published modules", async () => {
    const { service } = setup();
    const intro = await service.createModule(MORGAN, BIO.offeringId, { title: "Unit 1: Cells" });
    const lab = await service.createModule(MORGAN, BIO.offeringId, { title: "Unit 2: Osmosis" });
    const { page } = await service.addPage(MORGAN, BIO.offeringId, intro.id, { title: "Welcome", body: "# Welcome\n\nRead **chapter 1**." });
    await service.placeActivity(MORGAN, BIO.offeringId, intro.id, { activityId: BIO_ACTIVITY });
    await service.addPage(MORGAN, BIO.offeringId, lab.id, { title: "Lab safety", body: "Goggles on." });

    const reordered = await service.reorderModules(MORGAN, BIO.offeringId, { moduleIds: [lab.id, intro.id] });
    expect(reordered.modules.map((m) => m.title)).toStrictEqual(["Unit 2: Osmosis", "Unit 1: Cells"]);

    expect((await service.outline(AMARA, BIO.offeringId)).outline.modules).toStrictEqual([]);
    await service.updateModule(MORGAN, BIO.offeringId, intro.id, { published: true });

    const student = await service.outline(AMARA, BIO.offeringId);
    expect(student.view).toBe("student");
    expect(student.outline.modules.map((m) => m.title)).toStrictEqual(["Unit 1: Cells"]);
    expect(student.outline.modules[0]!.items.map((i) => i.kind)).toStrictEqual(["page", "activity"]);
    expect(student.outline.pages).toStrictEqual([page]);

    const teacher = await service.outline(MORGAN, BIO.offeringId);
    expect(teacher.view).toBe("teacher");
    expect(teacher.outline.pages).toHaveLength(2);
    expect(teacher.outline.revision).toBe(7);
  });

  it("edits, reorders and removes items, removing a page with its placement", async () => {
    const { service } = setup();
    const module = await service.createModule(MORGAN, BIO.offeringId, { title: "Unit 1" });
    const first = await service.addPage(MORGAN, BIO.offeringId, module.id, { title: "One", body: "first" });
    const second = await service.addPage(MORGAN, BIO.offeringId, module.id, { title: "Two", body: "second" });
    expect((await service.updatePage(MORGAN, BIO.offeringId, first.page.id, { body: "edited" })).body).toBe("edited");
    const moved = await service.reorderItems(MORGAN, BIO.offeringId, module.id, { itemIds: [second.item.id, first.item.id] });
    expect(moved.items.map((i) => i.id)).toStrictEqual([second.item.id, first.item.id]);
    expect(await code(service.reorderItems(MORGAN, BIO.offeringId, module.id, { itemIds: [second.item.id] }))).toBe("validation-failed");

    await service.removeItem(MORGAN, BIO.offeringId, module.id, first.item.id);
    const { outline } = await service.outline(MORGAN, BIO.offeringId);
    expect(outline.pages.map((p) => p.title)).toStrictEqual(["Two"]);
    await service.deleteModule(MORGAN, BIO.offeringId, module.id);
    expect((await service.outline(MORGAN, BIO.offeringId)).outline).toMatchObject({ modules: [], pages: [] });
  });

  it("places only activities installed in the same class, once per module", async () => {
    const { service } = setup();
    const module = await service.createModule(MORGAN, BIO.offeringId, { title: "Unit 1" });
    expect(await code(service.placeActivity(MORGAN, BIO.offeringId, module.id, { activityId: ENG_ACTIVITY }))).toBe("validation-failed");
    await service.placeActivity(MORGAN, BIO.offeringId, module.id, { activityId: BIO_ACTIVITY });
    expect(await code(service.placeActivity(MORGAN, BIO.offeringId, module.id, { activityId: BIO_ACTIVITY }))).toBe("conflict");
  });

  it("refuses scripts and active markup in pages and titles, and non-https links", async () => {
    const { service } = setup();
    const module = await service.createModule(MORGAN, BIO.offeringId, { title: "Unit 1" });
    expect(await code(service.addPage(MORGAN, BIO.offeringId, module.id, { title: "x", body: "<script>alert(1)</script>" }))).toBe("validation-failed");
    expect(await code(service.addPage(MORGAN, BIO.offeringId, module.id, { title: "x", body: "[click](javascript:alert(1))" }))).toBe("validation-failed");
    expect(await code(service.createModule(MORGAN, BIO.offeringId, { title: "<iframe src=x>" }))).toBe("validation-failed");
    const source = { kind: "cartridge" as const, fileName: "c.imscc", packageDigest: `sha256:${"0".repeat(64)}` };
    expect(await code(service.importModules(MORGAN, BIO.offeringId, [{ title: "M", items: [{ kind: "link", title: "L", url: "http://plain.example/" }] }], source))).toBe("validation-failed");
    expect((await service.outline(MORGAN, BIO.offeringId)).outline.modules).toHaveLength(1);
  });

  it("denies the wrong teacher, students, another district and a completed term", async () => {
    const { service } = setup();
    const module = await service.createModule(MORGAN, BIO.offeringId, { title: "Unit 1" });
    await service.updateModule(MORGAN, BIO.offeringId, module.id, { published: true });

    // A teacher of another class cannot even see it.
    expect(await code(service.createModule(RIVERA, BIO.offeringId, { title: "Mine" }))).toBe("not-found");
    expect(await code(service.outline(RIVERA, BIO.offeringId))).toBe("not-found");
    // An enrolled student reads but may not write.
    expect(await code(service.addPage(AMARA, BIO.offeringId, module.id, { title: "x", body: "y" }))).toBe("forbidden");
    expect(await code(service.updateModule(AMARA, BIO.offeringId, module.id, { published: false }))).toBe("forbidden");
    // A student of another class, or one dropped from this one, sees nothing.
    expect(await code(service.outline(CHIDI, BIO.offeringId))).toBe("not-found");
    expect(await code(service.outline(DMITRI, ENG9.offeringId))).toBe("not-found");
    // Another district's teacher, and an offering of another district.
    expect(await code(service.outline(RIVERBEND_TEACHER, BIO.offeringId))).toBe("not-found");
    expect(await code(service.outline(MORGAN, "off_rb-eng10-b"))).toBe("not-found");
    // A completed term is read-only, even for its teacher.
    expect(await code(service.createModule(MORGAN, BIO_SPRING.offeringId, { title: "Late" }))).toBe("forbidden");
  });

  it("refuses a commit made over a revision that has since changed", async () => {
    const { storage } = setup();
    const outline = { offeringId: BIO.offeringId, revision: 1, modules: [], pages: [] };
    await storage.commit(outline, 0);
    await expect(storage.commit({ ...outline, revision: 2 }, 0)).rejects.toMatchObject({ code: "conflict" });
  });
});
