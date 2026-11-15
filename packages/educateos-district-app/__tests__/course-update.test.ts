// Read-only cross-version OCS inspection: teacher authorization, verified source identity,
// local edits, incomplete installations and no classroom mutations.
import { describe, expect, it } from "vitest";
import { formatJson, packageDigest } from "@educateos/ocs";
import grade1 from "../../../curriculum/bundles/educateos.io/grade-1-reading-foundations/1.0.0.json" with { type: "json" };
import { bootDistrict, expectError, NF } from "./support.ts";

const PACKAGE_ID = "educateos.io/grade-1-reading-foundations";
const BASE = { packageId: PACKAGE_ID, version: "1.0.0" };
const UPGRADE = { packageId: PACKAGE_ID, fromVersion: "1.0.0", toVersion: "1.0.1" };
const LOCAL_TRUST = { localDomains: ["educateos.io"], publishers: [] };

type TestBundle = {
  course: { id: string; version: string; digest: string };
  packages: Array<{ id: string; version: string; digest: string; files: Record<string, string>; signature?: unknown }>;
  exports: Array<{ id: string; version: string; digest: string; text: string; signature?: unknown }>;
};

function sourceBundle(): TestBundle {
  // A synthetic publisher under a district-local trust fixture; no production
  // signatures or publisher private keys are used in these tests.
  const b = structuredClone(grade1) as TestBundle;
  for (const part of b.packages) delete part.signature;
  for (const part of b.exports) delete part.signature;
  return b;
}

async function updatedBundle(): Promise<TestBundle> {
  const b = sourceBundle();
  const pack = b.packages[0]!;
  const manifest = JSON.parse(pack.files["ocs.json"]!) as Record<string, unknown>;
  pack.files["ocs.json"] = formatJson({ ...manifest, version: "1.0.1" });
  const note = JSON.parse(pack.files["codex/u1-overview.json"]!) as Record<string, unknown>;
  pack.files["codex/u1-overview.json"] = formatJson({
    ...note, body: String(note.body) + "\nTry sounding the example aloud before reading it.",
  });
  const digest = await packageDigest(pack.files);
  const lock = JSON.parse(pack.files["ocs.lock"]!) as { root: Record<string, unknown> };
  pack.files["ocs.lock"] = formatJson({ ...lock, root: { ...lock.root, version: "1.0.1", digest } });
  pack.version = "1.0.1";
  pack.digest = digest;
  b.course.version = "1.0.1";
  b.course.digest = digest;
  return b;
}

async function setup() {
  const district = await bootDistrict(undefined, { courseLibraryTrust: LOCAL_TRUST });
  const admin = district.tokenFor(NF.admin);
  const teacher = district.tokenFor(NF.rivera);
  await district.ok(admin, "admin.importCourseBundle", { body: sourceBundle() as never });
  const params = { offeringId: NF.eng9 };
  return { district, admin, teacher, params };
}

describe("teacher-only OCS course update inspector", () => {
  it("lists changed source items without altering the current classroom", async () => {
    const { district, admin, teacher, params } = await setup();
    const initial = await district.ok(teacher, "teacher.installCourse", { params, body: BASE });
    expect(initial.done).toBe(true);
    await district.ok(admin, "admin.importCourseBundle", { body: (await updatedBundle()) as never });
    const before = await district.ok(teacher, "teacher.listModules", { params });
    const installsBefore = await district.stores.courseLibrary.loadInstalls(params.offeringId);
    const preview = await district.ok(teacher, "teacher.previewCourseUpdate", { params, body: UPGRADE });
    expect(preview).toMatchObject({
      packageId: PACKAGE_ID, fromVersion: "1.0.0", toVersion: "1.0.1",
      requiresTeacherApproval: true, canApply: false,
    });
    const first = preview.units.find((unit) => unit.title === "Short Vowel Sounds");
    expect(first).toBeDefined();
    expect(first!.items.some((item) => item.kind === "page" && item.status === "upstream-changed")).toBe(true);
    expect(preview.units.some((unit) => unit.status === "reconcile")).toBe(false);
    // No install, public student content, assignment or grade changed.
    expect(await district.ok(teacher, "teacher.listModules", { params })).toStrictEqual(before);
    expect(await district.stores.courseLibrary.loadInstalls(params.offeringId)).toStrictEqual(installsBefore);
    const student = district.tokenFor(NF.amara);
    expectError(await district.call(student, "teacher.previewCourseUpdate", { params, body: UPGRADE }), 403, "forbidden");
  });

  it("detects a competing teacher page edit by mapped IDs rather than title similarity", async () => {
    const { district, admin, teacher, params } = await setup();
    await district.ok(teacher, "teacher.installCourse", { params, body: BASE });
    await district.ok(admin, "admin.importCourseBundle", { body: (await updatedBundle()) as never });
    const before = (await district.ok(teacher, "teacher.listModules", { params })).outline;
    const module = before.modules.find((m) => m.title === "Short Vowel Sounds")!;
    const placement = module.items.find((item) => item.kind === "page")!;
    if (placement.kind !== "page") throw new Error("expected a page");
    await district.ok(teacher, "teacher.updatePage", {
      params: { ...params, pageId: placement.pageId },
      body: { body: "A teacher-approved local explanation of vowel sounds." },
    });
    const result = await district.ok(teacher, "teacher.previewCourseUpdate", { params, body: UPGRADE });
    const first = result.units.find((unit) => unit.title === "Short Vowel Sounds")!;
    expect(first.status).toBe("conflict");
    expect(first.items.some((item) => item.status === "conflict")).toBe(true);
    // Comparing does not revert the local edit.
    expect((await district.ok(teacher, "teacher.listModules", { params })).outline.pages
      .find((p) => p.id === placement.pageId)?.body).toBe("A teacher-approved local explanation of vowel sounds.");
  });

  it("fails closed for a missing original installation, unavailable version and reversed update", async () => {
    const { district, admin, teacher, params } = await setup();
    await district.ok(admin, "admin.importCourseBundle", { body: (await updatedBundle()) as never });
    expectError(await district.call(teacher, "teacher.previewCourseUpdate", { params, body: UPGRADE }), 409, "conflict");
    await district.ok(teacher, "teacher.installCourse", { params, body: BASE });
    expectError(await district.call(teacher, "teacher.previewCourseUpdate", {
      params, body: { ...UPGRADE, toVersion: "1.0.2" },
    }), 404, "not-found");
    expectError(await district.call(teacher, "teacher.previewCourseUpdate", {
      params, body: { ...UPGRADE, toVersion: "1.0.0" },
    }), 400, "validation-failed");
  });
});
