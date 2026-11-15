import assert from "node:assert/strict";
import { test } from "node:test";
import { DistrictError, type DistrictRequest } from "./canvas-grade-return.ts";
import { HARBOR_ASSIGNMENT, harborGradeReturn, type ClassroomAs } from "./harbor-grade-return.ts";

const OFFERING = "off_or-marine";
const NIA = "prn_or-nia";
const TITLE = `[educateos-approved] ${HARBOR_ASSIGNMENT.title}`;

/** Harbor and its Classroom, enforcing who may do what, and recording every write. */
function world() {
  const writes: string[] = [];
  const people: Record<string, { principalId: string; displayName: string }> = {
    admin: { principalId: "prn_hb-school-admin", displayName: "Marisol Vega" },
    teacher: { principalId: "prn_or-kwame", displayName: "Kwame Asante" },
    student: { principalId: NIA, displayName: "Nia Fontaine" },
  };
  let assignment: { id: string; title: string } | undefined;
  let submitted = false;
  let grade: { version: number; score: { points: number; maxPoints: number } } | undefined;
  let routed = false;
  const coursework: { id: string; title: string; associatedWithDeveloper: boolean }[] = [];
  const classroomGrade = { state: "CREATED", assignedGrade: undefined as number | undefined };
  const posted = new Set<string>();

  const district: DistrictRequest = async <T>(who: string, method: string, path: string, body?: unknown) => {
    if (method === "POST") writes.push(`${who} ${path}`);
    const b = body as Record<string, unknown> | undefined;
    const surface = path.split("/")[2];
    if (surface === "teacher" && who !== "teacher" && who !== "admin") throw new DistrictError(403, "forbidden");
    if (surface === "student" && who !== "student") throw new DistrictError(403, "forbidden");
    if (path === "/api/me") return people[who] as T;
    if (path === "/api/teacher/offerings") return [{ offering: { id: OFFERING }, course: { title: "Marine Science" } }] as T;
    if (path === `/api/teacher/offerings/${OFFERING}/assignments`) return (assignment ? [assignment] : []) as T;
    if (path === `/api/teacher/offerings/${OFFERING}/activities`) return { id: "def_1" } as T;
    if (path === "/api/teacher/activity-definitions/def_1/publish") return {} as T;
    if (path === "/api/teacher/activity-definitions/def_1/install") { assignment = { id: "asg_1", title: HARBOR_ASSIGNMENT.title }; return { assignment } as T; }
    if (path === "/api/student/assignments/asg_1/submissions") {
      if (method === "POST") { submitted = true; return {} as T; }
      return (submitted ? [{ id: "sub_1" }] : []) as T;
    }
    if (path === `/api/student/offerings/${OFFERING}/workspace`) return { id: "ws_1" } as T;
    if (path === "/api/student/artifacts") return { artifact: { id: "art_1" }, head: { id: "rev_1" } } as T;
    if (path === `/api/teacher/assignments/asg_1/students/${NIA}/grades`) return (grade ? [grade] : []) as T;
    if (path === "/api/teacher/submissions/sub_1/grade") { grade = { version: 1, score: b!.score as never }; return { status: "official" } as T; }
    if (path === "/api/lti/classroom/grade-routes") { assert.equal(who, "admin"); routed = true; return {} as T; }
    if (path === "/api/lti/classroom/columns") {
      assert.equal(who, "admin");
      assert.ok(routed);
      let work = coursework.find((w) => w.title === TITLE);
      const created = work === undefined;
      if (work === undefined) coursework.push(work = { id: "cw_1", title: TITLE, associatedWithDeveloper: true });
      return { courseWork: work, created } as T;
    }
    if (path === "/api/lti/passback") {
      // Only the approving teacher publishes.
      if (who !== "teacher") throw new DistrictError(403, "forbidden");
      const key = `${String(b!.studentId)}:${String(b!.column)}`;
      const status = posted.has(key) ? "already-posted" : "posted";
      posted.add(key);
      classroomGrade.assignedGrade = grade!.score.points;
      return { status } as T;
    }
    if (path === `/api/student/offerings/${OFFERING}/classroom-grades`) {
      return { status: "ready", grades: classroomGrade.state === "RETURNED" ? [{ title: TITLE, assignedGrade: classroomGrade.assignedGrade }] : [] } as T;
    }
    throw new Error(`unexpected ${who} ${method} ${path}`);
  };
  const owner: ClassroomAs = async <T>(_email: string, method: string, path: string) => {
    if (method === "POST") writes.push(`owner ${path}`);
    if (path.startsWith("courses/d%3Aoff_hb-marine-b1")) return { id: "896" } as T;
    if (path.startsWith("courses/896/courseWork?")) return { courseWork: coursework } as T;
    if (path.startsWith("courses/896/students")) return { students: [{ userId: "g-nia", profile: { emailAddress: "hb-student-nia@gedu.example" } }] } as T;
    if (path === "courses/896/courseWork/cw_1/studentSubmissions?userId=g-nia") return { studentSubmissions: [{ id: "s1", ...classroomGrade }] } as T;
    if (path === "courses/896/courseWork/cw_1/studentSubmissions/s1:return") {
      // As Classroom: only turned-in work can be returned.
      if (classroomGrade.state !== "TURNED_IN") throw new Error("HTTP 400 (FAILED_PRECONDITION)");
      classroomGrade.state = "RETURNED"; return {} as T;
    }
    throw new Error(`unexpected Classroom ${method} ${path}`);
  };
  const student: ClassroomAs = async <T>(email: string, method: string, path: string) => {
    assert.equal(email, "hb-student-nia@gedu.example");
    if (method === "POST") {
      writes.push(`nia ${path}`);
      assert.equal(path, "courses/896/courseWork/cw_1/studentSubmissions/s1:turnIn");
      classroomGrade.state = "TURNED_IN";
      return {} as T;
    }
    assert.equal(path, "courses/896/courseWork/cw_1/studentSubmissions?userId=me");
    return { studentSubmissions: [{ ...classroomGrade }] } as T;
  };
  const options = { district, cookies: { admin: "admin", teacher: "teacher", student: "student" }, classroom: { owner, student } };
  return { writes, options };
}

test("each step is done by its own person, and Nia reads her approved grade in Classroom and Harbor", async () => {
  const w = world();
  const result = await harborGradeReturn({ ...w.options, mode: "run" });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(w.writes, [
    `teacher /api/teacher/offerings/${OFFERING}/activities`,
    "teacher /api/teacher/activity-definitions/def_1/publish",
    "teacher /api/teacher/activity-definitions/def_1/install",
    `student /api/student/offerings/${OFFERING}/workspace`,
    "student /api/student/artifacts",
    "student /api/student/assignments/asg_1/submissions",
    "teacher /api/teacher/submissions/sub_1/grade",
    "admin /api/lti/classroom/grade-routes",
    "admin /api/lti/classroom/columns",
    "teacher /api/lti/passback",
    "admin /api/lti/passback",
    "nia courses/896/courseWork/cw_1/studentSubmissions/s1:turnIn",
    "owner courses/896/courseWork/cw_1/studentSubmissions/s1:return",
  ]);
  assert.equal(result.adminPublish, 403);
  assert.deepEqual(result.readback, { classroom: { state: "RETURNED", assignedGrade: HARBOR_ASSIGNMENT.points }, harbor: HARBOR_ASSIGNMENT.points });
});

test("a rerun makes nothing new, and verify writes nothing but the refused administrator attempt", async () => {
  const w = world();
  await harborGradeReturn({ ...w.options, mode: "run" });
  const before = w.writes.length;
  const again = await harborGradeReturn({ ...w.options, mode: "run" });
  assert.deepEqual(again.problems, []);
  assert.ok(again.steps.some((s) => s.step === "publish" && s.outcome.startsWith("already-posted")));
  assert.deepEqual(w.writes.slice(before).filter((x) => !x.includes("/api/lti/")), []);
  const mark = w.writes.length;
  const verified = await harborGradeReturn({ ...w.options, mode: "verify" });
  assert.deepEqual(verified.problems, []);
  assert.deepEqual(w.writes.slice(mark), ["admin /api/lti/passback"]);
});

test("verify before any run reports what is missing, and writes nothing", async () => {
  const w = world();
  const result = await harborGradeReturn({ ...w.options, mode: "verify" });
  assert.deepEqual(w.writes, []);
  assert.deepEqual(result.problems, [`Marine Science has no "${HARBOR_ASSIGNMENT.title}" assignment`]);
});
