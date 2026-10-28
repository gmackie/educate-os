// Run through @educateos/integrations/scripts/classroom-connector-live.ts, which mints a teacher
// token privately. Exercises shipped connector APIs against synthetic Classroom data, not a
// deployed Workshop session; queue/approval durability remains a separate acceptance gate.
import { expect, it } from "vitest";
import { ClassroomApi } from "../src/classroom-api";

it("reads the synthetic rubric and grading periods, and returns an approved total", async () => {
  const token = process.env["EDUCATEOS_CLASSROOM_LIVE_TOKEN"];
  if (!token) throw new Error("Use classroom-connector-live.ts to run this explicitly against the synthetic demo tenant.");
  const api = new ClassroomApi(async () => token);
  const courseId = "895811762849";
  const workId = "896231288996";
  const work = await api.getOwnedCourseWork(courseId, workId);
  expect(work.title).toMatch(/^EducateOS live smoke/);
  expect(work.maxPoints).toBe(10);
  const rubrics = await api.listRubrics(courseId, workId);
  expect(rubrics).toHaveLength(1);
  expect(rubrics[0].criteria[0].title).toBe("Scientific explanation");
  expect(rubrics[0].criteria[0].levels.map(l => l.points)).toEqual([10, 0]);
  const settings = await api.getGradingPeriodSettings(courseId);
  expect(settings.gradingPeriods).toBeInstanceOf(Array);
  const roster = await api.getRoster(courseId);
  const submissions = await api.listSubmissions(courseId, workId);
  const graded = submissions.find(s => s.assignedGrade === 8.5);
  if (!graded || !roster.students.some(s => s.userId === graded.userId)) throw new Error("No approved synthetic learner grade to return.");
  await api.gradeAndReturn(courseId, workId, graded.id, 8.5);
  const readback = await api.getSubmission(courseId, workId, graded.id);
  expect(readback.assignedGrade).toBe(8.5);
  expect(readback.state).toBe("RETURNED");
  console.log(JSON.stringify({ evidence: "live connector API only", courseId, workId, rubricId: rubrics[0].id,
    submissionId: readback.id, assignedGrade: readback.assignedGrade, state: readback.state, gradingPeriods: settings.gradingPeriods.length }));
});
