// Course authoring (SCHO-186): a district with no roster builds a class from scratch, its teacher
// writes modules and pages, and a course travels as a Common Cartridge.
import { describe, expect, it } from "vitest";
import type { DistrictDirectorySnapshot } from "@schoolos/contracts";
import { authorityFor, LOCAL_AUTHORITY, ONEROSTER_AUTHORITY } from "../src/index.ts";
import { bootDistrict, expectError, NF, NORTHFIELD, RB, RIVERBEND, teacherSetsUpEssay, type TestDistrict } from "./support.ts";

/** A homeschool co-op: the district and its administrator, and nothing else yet. */
const COOP: DistrictDirectorySnapshot = {
  district: NORTHFIELD.district,
  schools: [],
  terms: [],
  courses: [],
  offerings: [],
  principals: NORTHFIELD.principals.filter((p) => p.id === NF.admin),
  enrollments: [],
  roleAssignments: NORTHFIELD.roleAssignments.filter((r) => r.principalId === NF.admin),
};

const ISSUER = NORTHFIELD.district.trustedIssuers[0]!;

/** The co-op admin builds one class with a teacher and a student, all by hand. */
async function buildCoopClass(district: TestDistrict) {
  const admin = district.tokenFor(NF.admin);
  const school = await district.ok(admin, "admin.createSchool", { body: { name: "Maple Co-op", gradeBands: ["K-8"] } });
  const term = await district.ok(admin, "admin.createTerm", { body: { name: "Fall 2026", startsOn: "2026-09-01", endsOn: "2026-12-18" } });
  await district.ok(admin, "admin.transitionTerm", { params: { termId: term.id }, body: { to: "active" } });
  const course = await district.ok(admin, "admin.createCourse", { body: { title: "Nature Studies", subject: "science", gradeBand: "3-5" } });
  const offering = await district.ok(admin, "admin.createOffering", {
    body: { schoolId: school.id, termId: term.id, courseId: course.id, sectionName: "Tuesday mornings" },
  });
  const teacher = await district.ok(admin, "admin.createPrincipal", {
    body: { kind: "staff", displayName: "Jo Parent-Teacher", email: "jo@coop.example", identity: { issuer: ISSUER, subject: "coop-jo" } },
  });
  const student = await district.ok(admin, "admin.createPrincipal", {
    body: { kind: "student", displayName: "Sky Learner", identity: { issuer: ISSUER, subject: "coop-sky" } },
  });
  await district.ok(admin, "admin.enroll", { params: { offeringId: offering.id }, body: { principalId: teacher.id, role: "teacher" } });
  const enrollment = await district.ok(admin, "admin.enroll", { params: { offeringId: offering.id }, body: { principalId: student.id, role: "student" } });
  return {
    admin,
    school,
    term,
    course,
    offering,
    enrollment,
    teacher: district.idp.issue("coop-jo"),
    student: district.idp.issue("coop-sky"),
  };
}

describe("a co-op with no roster builds a class from scratch (SCHO-186)", () => {
  it("creates the school, term, course, section and people, and the teacher publishes modules the student reads", async () => {
    const district = await bootDistrict(COOP, { authority: "local" });
    const { admin, offering, course, teacher, student, enrollment } = await buildCoopClass(district);

    const authoring = await district.ok(admin, "admin.authoring");
    expect(authoring.authority).toStrictEqual(LOCAL_AUTHORITY);
    expect(authoring.trustedIssuers).toStrictEqual([ISSUER]);
    expect(authoring.principals.map((p) => p.displayName).toSorted()).toStrictEqual(["Avery Admin", "Jo Parent-Teacher", "Sky Learner"].toSorted());
    expect((await district.ok(admin, "admin.offeringRoster", { params: { offeringId: offering.id } })).map((r) => r.displayName)).toStrictEqual(["Jo Parent-Teacher", "Sky Learner"]);

    // The new teacher signs in and sees the class they were assigned.
    expect((await district.ok(teacher, "teacher.listOfferings")).map((o) => [o.course.title, o.role])).toStrictEqual([[course.title, "teacher"]]);
    const unit = await district.ok(teacher, "teacher.createModule", { params: { offeringId: offering.id }, body: { title: "Week 1: Leaves" } });
    const { page } = await district.ok(teacher, "teacher.addPage", {
      params: { offeringId: offering.id, moduleId: unit.id },
      body: { title: "Leaf walk", body: "## Leaf walk\n\nCollect **five** different leaves." },
    });
    expect((await district.ok(student, "student.listModules", { params: { offeringId: offering.id } })).outline.modules).toStrictEqual([]);
    await district.ok(teacher, "teacher.updateModule", { params: { offeringId: offering.id, moduleId: unit.id }, body: { published: true } });
    const seen = await district.ok(student, "student.listModules", { params: { offeringId: offering.id } });
    expect(seen).toMatchObject({ view: "student", outline: { modules: [{ title: "Week 1: Leaves", published: true }], pages: [page] } });

    // Dropping the student ends their access to the class content; their records stay.
    const dropped = await district.ok(admin, "admin.unenroll", { params: { enrollmentId: enrollment.id } });
    expect(dropped.enrollment.status).toBe("inactive");
    expectError(await district.call(student, "student.listModules", { params: { offeringId: offering.id } }), 404, "not-found");
  });

  it("archives a section and a course, refusing new enrollments and sections until restored", async () => {
    const district = await bootDistrict(COOP, { authority: "local" });
    const { admin, offering, course, school, term } = await buildCoopClass(district);
    const extra = await district.ok(admin, "admin.createPrincipal", { body: { kind: "student", displayName: "River", identity: { issuer: ISSUER, subject: "coop-river" } } });

    const archived = await district.ok(admin, "admin.archiveOffering", { params: { offeringId: offering.id }, body: { archived: true } });
    expect(archived.archivedAt).toBeDefined();
    expectError(await district.call(admin, "admin.enroll", { params: { offeringId: offering.id }, body: { principalId: extra.id, role: "student" } }), 409, "conflict");
    await district.ok(admin, "admin.archiveOffering", { params: { offeringId: offering.id }, body: { archived: false } });
    await district.ok(admin, "admin.enroll", { params: { offeringId: offering.id }, body: { principalId: extra.id, role: "student" } });

    await district.ok(admin, "admin.archiveCourse", { params: { courseId: course.id }, body: { archived: true } });
    expectError(await district.call(admin, "admin.createOffering", {
      body: { schoolId: school.id, termId: term.id, courseId: course.id, sectionName: "Thursdays" },
    }), 409, "conflict");
    expect((await district.ok(admin, "admin.updateCourse", { params: { courseId: course.id }, body: { title: "Nature Studies II" } })).title).toBe("Nature Studies II");
  });

  it("leaves a roster district's records to the roster, naming it", async () => {
    const district = await bootDistrict();
    const admin = district.tokenFor(NF.admin);
    const refused = await district.call(admin, "admin.createCourse", { body: { title: "Robotics", subject: "computer-science", gradeBand: "9-12" } });
    expectError(refused, 409, "conflict");
    expect((refused.body as { message: string }).message).toContain("external:oneroster");
    expectError(await district.call(admin, "admin.enroll", { params: { offeringId: NF.bio }, body: { principalId: NF.dmitri, role: "student" } }), 409, "conflict");
    expect((await district.ok(admin, "admin.authoring")).authority).toStrictEqual(ONEROSTER_AUTHORITY);
  });

  it("keeps directory authoring to administrators", async () => {
    const district = await bootDistrict(COOP, { authority: "local" });
    const { teacher, student, offering } = await buildCoopClass(district);
    expectError(await district.call(teacher, "admin.createCourse", { body: { title: "Mine", subject: "arts", gradeBand: "3" } }), 403, "forbidden");
    expectError(await district.call(teacher, "admin.authoring"), 403, "forbidden");
    expectError(await district.call(student, "admin.enroll", { params: { offeringId: offering.id }, body: { principalId: NF.admin, role: "student" } }), 403, "forbidden");
  });

  it("resolves authority settings by profile or in full", () => {
    expect(authorityFor(undefined)).toStrictEqual(ONEROSTER_AUTHORITY);
    expect(authorityFor("local")).toStrictEqual(LOCAL_AUTHORITY);
    expect(authorityFor({ ...ONEROSTER_AUTHORITY, course: "local" }).course).toBe("local");
  });
});

describe("a co-op administrator manages its people (SCHO-212)", () => {
  it("corrects someone added as a student, makes them an administrator, and they then manage people", async () => {
    const district = await bootDistrict(COOP, { authority: "local" });
    const admin = district.tokenFor(NF.admin);
    const added = await district.ok(admin, "admin.createPrincipal", {
      body: { kind: "student", displayName: "Second Admin", identity: { issuer: ISSUER, subject: "coop-second" } },
    });
    expect(added).toMatchObject({ kind: "student", districtAdmin: false });
    // A student cannot be an administrator; correct their kind first.
    expectError(await district.call(admin, "admin.grantDistrictAdmin", { params: { principalId: added.id }, body: {} }), 409, "conflict");
    const fixed = await district.ok(admin, "admin.updatePrincipal", { params: { principalId: added.id }, body: { kind: "staff", email: "second@coop.example" } });
    expect(fixed).toMatchObject({ kind: "staff", email: "second@coop.example", districtAdmin: false });
    expect(await district.ok(admin, "admin.grantDistrictAdmin", { params: { principalId: added.id }, body: {} })).toMatchObject({ districtAdmin: true });

    const second = district.idp.issue("coop-second");
    const authoring = await district.ok(second, "admin.authoring");
    expect(authoring.principals.filter((p) => p.districtAdmin).map((p) => p.displayName).toSorted()).toStrictEqual(["Avery Admin", "Second Admin"]);
    // The new administrator can take the original's role away, but not their own.
    expect(await district.ok(second, "admin.revokeDistrictAdmin", { params: { principalId: NF.admin }, body: {} })).toMatchObject({ districtAdmin: false });
    expectError(await district.call(second, "admin.revokeDistrictAdmin", { params: { principalId: added.id }, body: {} }), 409, "conflict");
    expectError(await district.call(admin, "admin.authoring"), 403, "forbidden");
  });

  it("deactivates and reactivates a student, ending and restoring their class access", async () => {
    const district = await bootDistrict(COOP, { authority: "local" });
    const { admin, offering, student } = await buildCoopClass(district);
    const sky = (await district.ok(admin, "admin.authoring")).principals.find((p) => p.displayName === "Sky Learner")!;
    const left = await district.ok(admin, "admin.setPrincipalStatus", { params: { principalId: sky.id }, body: { status: "inactive" } });
    expect(left.principal.status).toBe("inactive");
    expectError(await district.call(student, "student.listModules", { params: { offeringId: offering.id } }), 404, "not-found");
    const back = await district.ok(admin, "admin.setPrincipalStatus", { params: { principalId: sky.id }, body: { status: "active" } });
    expect(back.principal.status).toBe("active");
    await district.ok(student, "student.listModules", { params: { offeringId: offering.id } });
    // The only administrator cannot deactivate themself.
    expectError(await district.call(admin, "admin.setPrincipalStatus", { params: { principalId: NF.admin }, body: { status: "inactive" } }), 409, "conflict");
  });

  it("keeps managing people to administrators", async () => {
    const district = await bootDistrict(COOP, { authority: "local" });
    const { teacher } = await buildCoopClass(district);
    // They learn nothing about people they cannot see.
    expectError(await district.call(teacher, "admin.grantDistrictAdmin", { params: { principalId: NF.admin }, body: {} }), 404, "not-found");
    expectError(await district.call(teacher, "admin.updatePrincipal", { params: { principalId: NF.admin }, body: { displayName: "X" } }), 404, "not-found");
  });
});

describe("modules and pages in a roster district", () => {
  it("places an installed activity in a module, and denies the wrong teacher, students' writes and another district", async () => {
    const district = await bootDistrict();
    const { assignment } = await teacherSetsUpEssay(district);
    const rivera = district.tokenFor(NF.rivera);
    const unit = await district.ok(rivera, "teacher.createModule", { params: { offeringId: NF.eng9 }, body: { title: "Argument" } });
    await district.ok(rivera, "teacher.placeActivity", { params: { offeringId: NF.eng9, moduleId: unit.id }, body: { activityId: assignment.activityId } });
    await district.ok(rivera, "teacher.updateModule", { params: { offeringId: NF.eng9, moduleId: unit.id }, body: { published: true } });

    const amara = district.tokenFor(NF.amara);
    const seen = await district.ok(amara, "student.listModules", { params: { offeringId: NF.eng9 } });
    expect(seen.outline.modules[0]!.items).toMatchObject([{ kind: "activity", activityId: assignment.activityId }]);

    const morgan = district.tokenFor(NF.morgan);
    expectError(await district.call(morgan, "teacher.listModules", { params: { offeringId: NF.eng9 } }), 404, "not-found");
    expectError(await district.call(morgan, "teacher.createModule", { params: { offeringId: NF.eng9 }, body: { title: "Mine" } }), 404, "not-found");
    // A student's token never reaches the teacher surface at all.
    expectError(await district.call(amara, "teacher.createModule", { params: { offeringId: NF.eng9 }, body: { title: "Mine" } }), 403, "forbidden");

    const riverbend = await bootDistrict(RIVERBEND);
    expectError(await riverbend.call(riverbend.tokenFor(RB.teacher), "teacher.listModules", { params: { offeringId: NF.eng9 } }), 404, "not-found");
    expectError(await riverbend.call(riverbend.tokenFor(RB.student), "student.listModules", { params: { offeringId: NF.eng9 } }), 404, "not-found");
  });
});

describe("Common Cartridge import and export", () => {
  it("exports a course and imports it into another class after a preview, its pages intact", async () => {
    const district = await bootDistrict();
    const { assignment } = await teacherSetsUpEssay(district);
    const rivera = district.tokenFor(NF.rivera);
    const unit = await district.ok(rivera, "teacher.createModule", { params: { offeringId: NF.eng9 }, body: { title: "Unit 1: Claims" } });
    await district.ok(rivera, "teacher.addPage", {
      params: { offeringId: NF.eng9, moduleId: unit.id },
      body: { title: "What is a claim?", body: "A **claim** is <arguable> & specific.\n\n- one\n- two" },
    });
    await district.ok(rivera, "teacher.placeActivity", { params: { offeringId: NF.eng9, moduleId: unit.id }, body: { activityId: assignment.activityId } });

    const exported = await district.ok(rivera, "teacher.exportCartridge", { params: { offeringId: NF.eng9 } });
    expect(exported.fileName).toMatch(/\.imscc$/);
    expect(exported.losses).toMatchObject([{ kind: "activity", module: unit.id }]);

    // Morgan imports it into Biology. Rivera's class is unchanged.
    const morgan = district.tokenFor(NF.morgan);
    const upload = { fileName: exported.fileName, base64: exported.base64 };
    const preview = await district.ok(morgan, "teacher.previewCartridge", { params: { offeringId: NF.bio }, body: upload });
    expect(preview.modules).toStrictEqual([{ title: "Unit 1: Claims", items: [{ kind: "page", title: "What is a claim?", characters: "A **claim** is <arguable> & specific.\n\n- one\n- two".length }] }]);
    expect((await district.ok(morgan, "teacher.listModules", { params: { offeringId: NF.bio } })).outline.modules).toStrictEqual([]);

    expectError(await district.call(morgan, "teacher.importCartridge", {
      params: { offeringId: NF.bio }, body: { ...upload, packageDigest: `sha256:${"0".repeat(64)}` },
    }), 409, "conflict");
    const imported = await district.ok(morgan, "teacher.importCartridge", { params: { offeringId: NF.bio }, body: { ...upload, packageDigest: preview.packageDigest } });
    expect(imported.modules).toMatchObject([{ title: "Unit 1: Claims", published: false, source: { kind: "cartridge", packageDigest: preview.packageDigest } }]);
    const bio = await district.ok(morgan, "teacher.listModules", { params: { offeringId: NF.bio } });
    expect(bio.outline.pages.map(({ title, body }) => ({ title, body }))).toStrictEqual([{ title: "What is a claim?", body: "A **claim** is <arguable> & specific.\n\n- one\n- two" }]);
  });

  it("refuses an upload that is not a cartridge, and keeps preview and import to the class's teachers", async () => {
    const district = await bootDistrict();
    const rivera = district.tokenFor(NF.rivera);
    const junk = { fileName: "notes.imscc", base64: btoa("not a zip file") };
    expectError(await district.call(rivera, "teacher.previewCartridge", { params: { offeringId: NF.eng9 }, body: junk }), 403, "policy-violation");
    const exported = await district.ok(rivera, "teacher.exportCartridge", { params: { offeringId: NF.eng9 } });
    const upload = { fileName: "c.imscc", base64: exported.base64 };
    expectError(await district.call(district.tokenFor(NF.morgan), "teacher.previewCartridge", { params: { offeringId: NF.eng9 }, body: upload }), 404, "not-found");
    expectError(await district.call(district.tokenFor(NF.amara), "teacher.previewCartridge", { params: { offeringId: NF.eng9 }, body: upload }), 403, "forbidden");
    expectError(await district.call(district.tokenFor(NF.amara), "teacher.exportCartridge", { params: { offeringId: NF.eng9 } }), 403, "forbidden");
  });
});
