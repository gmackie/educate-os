// SCHO-187: the gradebook routes, from official grades to CSV, each with who it refuses.
import { describe, expect, it } from "vitest";
import { bootDistrict, expectError, NF, RB, RIVERBEND, studentSubmitsEssay, teacherSetsUpEssay } from "./support.ts";

/** English 9 with Amara's essay graded 7/8 by Rivera, and a co-teacher's waiting proposal for Elena's. */
async function gradedClass() {
  const district = await bootDistrict();
  const { assignment } = await teacherSetsUpEssay(district);
  const amara = await studentSubmitsEssay(district, assignment.id);
  const elena = await studentSubmitsEssay(district, assignment.id, district.tokenFor(NF.elena));
  const rivera = district.tokenFor(NF.rivera);
  await district.ok(rivera, "teacher.recordGrade", { params: { submissionId: amara.receipt.submissionId }, body: { score: { points: 7, maxPoints: 8 } } });
  const proposed = await district.ok(district.tokenFor(NF.chen), "teacher.recordGrade", {
    params: { submissionId: elena.receipt.submissionId },
    body: { score: { points: 8, maxPoints: 8 } },
  });
  expect(proposed.status).toBe("pending-approval");
  return { district, assignment, rivera };
}

describe("teacher.gradebook", () => {
  it("shows the class's official grades, never a waiting proposal", async () => {
    const { district, assignment, rivera } = await gradedClass();
    const view = await district.ok(rivera, "teacher.gradebook", { params: { offeringId: NF.eng9 } });
    expect(view.columns).toStrictEqual([{ offeringId: NF.eng9, assignmentId: assignment.id, title: assignment.title, dueAt: assignment.dueAt, pointsPossible: 8 }]);
    const [amara, elena] = view.rows;
    expect(amara).toMatchObject({ studentPrincipalId: NF.amara, cells: [{ score: { points: 7, maxPoints: 8 }, version: 1 }], totals: { final: 87.5, letter: "B" } });
    expect(elena).toMatchObject({ studentPrincipalId: NF.elena, cells: [{ percent: null, counted: false }], totals: { final: null } });
    expect(elena!.cells[0]).not.toHaveProperty("score");
  });

  it("lets the co-teacher and an administrator read it, and refuses others", async () => {
    const { district } = await gradedClass();
    const target = { params: { offeringId: NF.eng9 } };
    expect((await district.ok(district.tokenFor(NF.chen), "teacher.gradebook", target)).rows).toHaveLength(2);
    expect((await district.ok(district.tokenFor(NF.admin), "teacher.gradebook", target)).rows).toHaveLength(2);
    expectError(await district.call(district.tokenFor(NF.morgan), "teacher.gradebook", target), 404, "not-found");
    // A student never reaches a teacher route, let alone the class grid.
    expectError(await district.call(district.tokenFor(NF.amara), "teacher.gradebook", target), 403, "forbidden");
    const riverbend = await bootDistrict(RIVERBEND);
    expectError(await riverbend.call(riverbend.tokenFor(RB.teacher), "teacher.gradebook", target), 404, "not-found");
  });
});

describe("teacher.updateGradebookSettings and teacher.setGradeMarker", () => {
  it("let the teacher group, weight, drop, rescale and mark, refusing the co-teacher and stale edits", async () => {
    const { district, assignment, rivera } = await gradedClass();
    const settings = {
      weighting: "group-weights" as const,
      calculation: "percent" as const,
      missing: "zero" as const,
      groups: [{ id: "grp_essays", name: "Essays", weight: 100, dropLowest: 0, assignmentIds: [assignment.id] }],
      scale: [{ letter: "Pass", minPercent: 80 }, { letter: "Retry", minPercent: 0 }],
    };
    const target = { params: { offeringId: NF.eng9 }, body: { revision: 0, settings } };
    expectError(await district.call(district.tokenFor(NF.chen), "teacher.updateGradebookSettings", target), 403, "forbidden");
    expectError(await district.call(district.tokenFor(NF.admin), "teacher.updateGradebookSettings", target), 403, "forbidden");
    expectError(await district.call(district.tokenFor(NF.morgan), "teacher.updateGradebookSettings", target), 404, "not-found");
    const saved = await district.ok(rivera, "teacher.updateGradebookSettings", target);
    expect(saved).toMatchObject({ revision: 1, rows: [{ totals: { weighted: 87.5, letter: "Pass" } }, {}] });
    expectError(await district.call(rivera, "teacher.updateGradebookSettings", target), 409, "conflict");
    expectError(await district.call(rivera, "teacher.updateGradebookSettings", {
      ...target,
      body: { revision: 1, settings: { ...settings, scale: [{ letter: "A", minPercent: 50 }] } },
    }), 400, "validation-failed");

    const marked = await district.ok(rivera, "teacher.setGradeMarker", {
      params: { offeringId: NF.eng9 },
      body: { assignmentId: assignment.id, studentPrincipalId: NF.elena, marker: "missing" },
    });
    expect(marked).toMatchObject({ studentPrincipalId: NF.elena, cells: [{ marker: "missing", percent: 0, counted: true }], totals: { final: 0, letter: "Retry" } });
    expectError(await district.call(district.tokenFor(NF.chen), "teacher.setGradeMarker", {
      params: { offeringId: NF.eng9 },
      body: { assignmentId: assignment.id, studentPrincipalId: NF.amara, marker: "excused" },
    }), 403, "forbidden");
  });
});

describe("teacher.exportGradebookCsv", () => {
  it("returns the grid as CSV for the class's teachers", async () => {
    const { district, assignment, rivera } = await gradedClass();
    const exported = await district.ok(rivera, "teacher.exportGradebookCsv", { params: { offeringId: NF.eng9 } });
    expect(exported).toMatchObject({ fileName: "english-9-period-3-gradebook.csv", mediaType: "text/csv" });
    expect(exported.csv.split("\r\n")).toStrictEqual([
      `Student,Student ID,${assignment.title} (8 pts),Points earned,Points possible,Unweighted %,Weighted %,Final %,Letter`,
      "Amara Okafor,prn_nf-student-amara,7,7,8,87.50,,87.50,B",
      "Elena Sato,prn_nf-student-elena,,0,0,,,,",
      "",
    ]);
    expectError(await district.call(district.tokenFor(NF.admin), "teacher.exportGradebookCsv", { params: { offeringId: NF.eng9 } }), 403, "forbidden");
  });
});

describe("student.gradeSummary", () => {
  it("gives a student their own row and totals, and nothing of anyone else's", async () => {
    const { district } = await gradedClass();
    const amara = await district.ok(district.tokenFor(NF.amara), "student.gradeSummary", { params: { offeringId: NF.eng9 } });
    expect(amara.row).toMatchObject({ studentPrincipalId: NF.amara, totals: { final: 87.5, letter: "B" } });
    expect(JSON.stringify(amara)).not.toContain(NF.elena);
    const elena = await district.ok(district.tokenFor(NF.elena), "student.gradeSummary", { params: { offeringId: NF.eng9 } });
    // Her proposed 8/8 waits for the teacher, so she has no grade yet.
    expect(elena.row.totals).toMatchObject({ final: null, letter: null });

    expectError(await district.call(district.tokenFor(NF.amara), "student.gradeSummary", { params: { offeringId: "off_nf-ushist-fall-p5" } }), 404, "not-found");
    expectError(await district.call(district.tokenFor(NF.rivera), "student.gradeSummary", { params: { offeringId: NF.eng9 } }), 403, "forbidden");
    const riverbend = await bootDistrict(RIVERBEND);
    expectError(await riverbend.call(riverbend.tokenFor(RB.student), "student.gradeSummary", { params: { offeringId: NF.eng9 } }), 404, "not-found");
  });
});
