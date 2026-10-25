// SCHO-222: what a teacher's submission review reads back after a reload: the signed rubric, the
// student's official grade, and the title that names each piece of submitted work.
import { describe, expect, it } from "vitest";
import { bootDistrict, ESSAY_RUBRIC, expectError, NF, studentSubmitsEssay, teacherSetsUpEssay } from "./support.ts";

describe("teacher.getRubric", () => {
  it("reads back a rubric the class uses, criteria and all", async () => {
    const district = await bootDistrict();
    const { rubric } = await teacherSetsUpEssay(district);
    const params = { offeringId: NF.eng9, rubricId: rubric.rubricId, version: String(rubric.version) };
    const read = await district.ok(district.tokenFor(NF.rivera), "teacher.getRubric", { params });
    expect(read).toStrictEqual(rubric);
    expect(read.criteria.map((c) => c.title)).toStrictEqual(["Length", "Evidence"]);
    // A co-teacher reads it too.
    await district.ok(district.tokenFor(NF.chen), "teacher.getRubric", { params });
  });

  it("refuses students, other classes and rubrics no class assignment uses", async () => {
    const district = await bootDistrict();
    const { rubric } = await teacherSetsUpEssay(district);
    const params = { offeringId: NF.eng9, rubricId: rubric.rubricId, version: String(rubric.version) };
    // Its checks can hold answer keys.
    expectError(await district.call(district.tokenFor(NF.amara), "teacher.getRubric", { params }), 403, "forbidden");
    // Nor a teacher of another class, through the class they teach or through this one.
    const morgan = district.tokenFor(NF.morgan);
    expectError(await district.call(morgan, "teacher.getRubric", { params: { ...params, offeringId: NF.bio } }), 404, "not-found");
    expectError(await district.call(morgan, "teacher.getRubric", { params }), 403, "forbidden");
    const rivera = district.tokenFor(NF.rivera);
    // Signed but never assigned: nothing ties it to the class yet.
    const loose = await district.ok(rivera, "teacher.signRubric", { params: { offeringId: NF.eng9 }, body: { rubric: { ...ESSAY_RUBRIC, rubricId: "rbr_unused" as typeof ESSAY_RUBRIC.rubricId } } });
    expectError(await district.call(rivera, "teacher.getRubric", { params: { ...params, rubricId: loose.rubricId } }), 404, "not-found");
    expectError(await district.call(rivera, "teacher.getRubric", { params: { ...params, version: "2" } }), 404, "not-found");
  });
});

describe("teacher.officialGrades", () => {
  it("returns a student's official grade versions to the class's teachers", async () => {
    const district = await bootDistrict();
    const { assignment } = await teacherSetsUpEssay(district);
    const { receipt } = await studentSubmitsEssay(district, assignment.id);
    const rivera = district.tokenFor(NF.rivera);
    const params = { assignmentId: assignment.id, studentId: NF.amara };
    expect(await district.ok(rivera, "teacher.officialGrades", { params })).toStrictEqual([]);

    await district.ok(rivera, "teacher.recordGrade", { params: { submissionId: receipt.submissionId }, body: { score: { points: 5, maxPoints: 6 } } });
    const grades = await district.ok(rivera, "teacher.officialGrades", { params });
    expect(grades.map((g) => [g.version, g.score])).toStrictEqual([[1, { points: 5, maxPoints: 6 }]]);
    expect(grades[0]!.submissionId).toBe(receipt.submissionId);
  });

  it("is refused to students and to staff outside the class", async () => {
    const district = await bootDistrict();
    const { assignment } = await teacherSetsUpEssay(district);
    await studentSubmitsEssay(district, assignment.id);
    const params = { assignmentId: assignment.id, studentId: NF.amara };
    expect((await district.call(district.tokenFor(NF.amara), "teacher.officialGrades", { params })).status).toBeGreaterThanOrEqual(400);
    expectError(await district.call(district.tokenFor(NF.morgan), "teacher.officialGrades", { params }), 404, "not-found");
  });
});

describe("teacher.submittedContent", () => {
  it("names the submitted work by its title", async () => {
    const district = await bootDistrict();
    const { assignment } = await teacherSetsUpEssay(district);
    const { receipt, artifact } = await studentSubmitsEssay(district, assignment.id);
    const read = await district.ok(district.tokenFor(NF.rivera), "teacher.submittedContent", { params: { submissionId: receipt.submissionId, artifactId: artifact.id } });
    expect(read.title).toBe("Later start essay");
    expect(read.content).toMatchObject({ kind: "text" });
  });
});
