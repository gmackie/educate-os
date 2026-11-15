import assert from "node:assert/strict";
import { test } from "node:test";
import { canvasDemoPlan } from "./seed-canvas-demo.ts";
import { approvedGrades, canvasGradeReturn, DistrictError, type CanvasColumns, type DistrictRequest } from "./canvas-grade-return.ts";
import type { ShowcaseClient } from "./seed-showcase.ts";

const plan = canvasDemoPlan();
const course = plan.courses.find((c) => c.offeringId === "off_nf-eng9-fall-p3")!;
const students = course.enrollments.filter((e) => e.role === "student").map((e) => e.principalId);
const CANVAS_COURSE = 21;

test("lists each assignment's approved grades, skipping cells no teacher approved", () => {
  const grades = approvedGrades({
    columns: [{ assignmentId: "asg_a", title: "Essay", pointsPossible: 10 }, { assignmentId: "asg_b", title: "Quiz", pointsPossible: null }],
    rows: [
      { studentPrincipalId: "prn_s1", cells: [{ assignmentId: "asg_a", score: { points: 9, maxPoints: 10 }, version: 2 }, { assignmentId: "asg_b" }] },
      { studentPrincipalId: "prn_s2", cells: [{ assignmentId: "asg_a" }, { assignmentId: "asg_b" }] },
    ],
  });
  assert.deepEqual([...grades.keys()], ["asg_a"]);
  assert.deepEqual(grades.get("asg_a"), [{ assignmentId: "asg_a", title: "Essay", studentId: "prn_s1", version: 2, points: 9, maxPoints: 10 }]);
});

/**
 * English 9 has two teachers: Sam Rivera, Canvas's teacher, and co-teacher Riley Chen, who
 * approved the second student's grade. The 9-12 presenter starts linked to Morgan Lee.
 */
function world() {
  const calls: string[] = [];
  const posted = new Set<string>();
  const scores = new Map<string, number>();
  let linked = "prn_nf-morgan-lee";
  const links: string[] = [];
  let columns: { lineItemId: number; canvasAssignmentId: number } | undefined;
  const approver = (studentId: string) => (studentId === students[1] ? "prn_nf-teacher-chen" : "prn_nf-teacher-rivera");
  const district: DistrictRequest = async <T>(cookie: string, method: string, path: string, body?: unknown) => {
    const who = cookie === "admin" ? "admin" : linked;
    calls.push(`${who} ${method} ${path}`);
    const b = body as Record<string, unknown> | undefined;
    switch (path) {
      case "/api/me": return { principalId: linked } as T;
      case "/api/lti/registrations": return { registrations: [{ issuer: "https://canvas.mackie.house", clientId: "4", offerings: [{ offeringId: course.offeringId, contextId: "ctx-eng9" }] }] } as T;
      case `/api/teacher/offerings/${course.offeringId}/gradebook`:
        assert.ok(who.startsWith("prn_nf-teacher"), "only a teacher reads the gradebook");
        return {
          columns: [{ assignmentId: "asg_essay", title: "Argument Essay", pointsPossible: 20 }],
          rows: students.slice(0, 2).map((s, i) => ({ studentPrincipalId: s, cells: [{ assignmentId: "asg_essay", score: { points: 15 + i, maxPoints: 20 }, version: 1 }] })),
        } as T;
      case "/api/lti/grade-routes": case "/api/lti/grade-columns": assert.equal(who, "admin"); return {} as T;
      case "/api/lti/line-items": assert.equal(who, "admin"); columns = { lineItemId: 7, canvasAssignmentId: 70 }; return { id: "li" } as T;
      case "/api/lti/passback": {
        const student = String(b!.studentId);
        if (who !== approver(student)) throw new DistrictError(403, "forbidden");
        const key = `${student}:${String(b!.column)}`;
        const status = posted.has(key) ? "already-posted" : "posted";
        posted.add(key);
        scores.set(student, student === students[1] ? 16 : 15);
        return { status, route: "lti-ags" } as T;
      }
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  const showcase = {
    exportDistrict: async () => ({ directory: { offerings: [], enrollments: [
      { offeringId: course.offeringId, principalId: "prn_nf-teacher-rivera", role: "teacher", status: "active" },
      { offeringId: course.offeringId, principalId: "prn_nf-teacher-chen", role: "teacher", status: "active" },
    ] } }),
    link: async (_subject: string, persona: string | null) => { links.push(persona!); const previousPersonaId = linked; linked = persona!; return { personaId: persona, previousPersonaId, changed: true }; },
  } as unknown as ShowcaseClient;
  const canvasColumns: CanvasColumns = { find: async () => columns, forget: () => {} };
  const tokens = new Map(students.map((s, i) => [s, { principalId: s, userId: i, token: `tok-${s}` }]));
  return {
    calls, links, posted, linked: () => linked,
    options: {
      adminCookie: "admin", presenters: { "9-12": "presenter" }, district, showcase,
      subjectOf: async () => "subject-912",
      canvas: { list: async <T>() => [{ id: CANVAS_COURSE, sis_course_id: course.sisId }] as T[] },
      canvasClient: (token: string) => ({
        request: async <T>(_m: string, path: string) => {
          const student = token.slice(4);
          assert.equal(path, `courses/${CANVAS_COURSE}/assignments/70/submissions/self`);
          return { value: { score: scores.get(student) ?? null } as T };
        },
      }),
      actors: { credentials: async (ids: readonly string[]) => new Map([...tokens].filter(([s]) => ids.includes(s))), session: async () => "", expire: async () => 0 },
      columns: canvasColumns,
    },
  };
}

test("each approved grade is published by its approving teacher and read back by its learner", async () => {
  const w = world();
  const result = await canvasGradeReturn({ ...w.options, mode: "run" });
  const mine = result.rows.filter((r) => r.offeringId === course.offeringId);
  assert.deepEqual(mine.map((r) => [r.studentId, r.publishedBy, r.outcome, r.readback]), [
    [students[0], "prn_nf-teacher-rivera", "posted", 15],
    [students[1], "prn_nf-teacher-chen", "posted", 16],
  ]);
  assert.equal(mine[0]!.column, `https://canvas.mackie.house/api/lti/courses/${CANVAS_COURSE}/line_items/7`);
  // The administrator set it up but could not publish a teacher's grade.
  assert.deepEqual(result.refusals, [{ offeringId: course.offeringId, status: 403 }]);
  // The presenter is linked back to who it was.
  assert.equal(w.linked(), "prn_nf-morgan-lee");
  // Other courses have no presenter here; only those are problems.
  assert.ok(result.problems.every((p) => p.endsWith("no presenter sign-in for its band") || p.endsWith("not connected to a Canvas course")), result.problems.join("; "));
});

test("a rerun publishes nothing twice and creates no second column", async () => {
  const w = world();
  await canvasGradeReturn({ ...w.options, mode: "run" });
  const before = w.calls.filter((c) => c.endsWith("/api/lti/line-items")).length;
  const again = await canvasGradeReturn({ ...w.options, mode: "run" });
  assert.equal(w.calls.filter((c) => c.endsWith("/api/lti/line-items")).length, before);
  assert.deepEqual(again.rows.map((r) => r.outcome), ["already-posted", "already-posted"]);
});

test("verify writes nothing and reports grades not yet returned", async () => {
  const w = world();
  const result = await canvasGradeReturn({ ...w.options, mode: "verify" });
  assert.ok(!w.calls.some((c) => / POST \/api\/lti\/(grade-routes|line-items|grade-columns)/.test(c)));
  assert.ok(!w.calls.some((c) => !c.startsWith("admin") && c.includes("/api/lti/passback")));
  assert.ok(result.problems.some((p) => p.includes("no Canvas column for asg_essay")));
  assert.equal(w.linked(), "prn_nf-morgan-lee");
});
