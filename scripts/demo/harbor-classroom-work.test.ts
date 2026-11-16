import assert from "node:assert/strict";
import { test } from "node:test";
import { HARBOR_SCORES, harborClassroomWork } from "./harbor-classroom-work.ts";
import { harborCourseworkPlan } from "./seed-harbor-classroom.ts";

/** A fake Classroom holding Harbor's seeded work, enforcing who may touch which submission. */
function fakeClassroom() {
  const plan = harborCourseworkPlan();
  const learners = new Map(Object.entries(HARBOR_SCORES).map(([offering, scores]) => [offering, Object.keys(scores)]));
  const subs = new Map<string, { id: string; userId: string; state: string; assignedGrade?: number }>();
  const writes: string[] = [];
  let n = 0;
  for (const [c, course] of plan.entries()) {
    for (const [w] of course.lessons.entries()) {
      for (const learner of learners.get(course.fixtureId)!) subs.set(`${c}/${c}${w}/${learner}`, { id: `s${++n}`, userId: learner, state: "CREATED" });
    }
  }
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("authorization")!.slice("Bearer ".length);
    const [actor, scope] = auth.split("|") as [string, string];
    const parts = url.pathname.split("/").slice(3);
    const method = init?.method ?? "GET";
    if (parts.length === 1) return Response.json({ id: String(plan.findIndex((p) => `courses/${encodeURIComponent(p.alias)}` === `courses/${parts[0]}`)) });
    const course = Number(parts[0]);
    if (parts[1] === "students") return Response.json({ students: learners.get(plan[course]!.fixtureId)!.map((l) => ({ userId: l, profile: { emailAddress: `${l}@gedu.example` } })) });
    if (parts.length === 2) return Response.json({ courseWork: plan[course]!.lessons.map((l, w) => ({ id: `${course}${w}`, title: l.title, associatedWithDeveloper: true })) });
    const prefix = `${course}/${parts[2]}/`;
    const all = [...subs.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
    if (parts.length === 4) {
      const user = url.searchParams.get("userId");
      const mine = user === "me" ? all.filter((s) => s.userId === actor) : user === null ? all : all.filter((s) => s.userId === user);
      if (scope === "me" && user !== "me") return new Response(null, { status: 403 });
      return Response.json({ studentSubmissions: mine });
    }
    const [id, verb] = parts[4]!.split(":") as [string, string | undefined];
    const sub = all.find((s) => s.id === id)!;
    if (scope === "me" && sub.userId !== actor) return new Response(null, { status: 403 });
    if (scope === "me" && method === "PATCH") return new Response(null, { status: 403 });
    if (method !== "GET") writes.push(`${actor} ${method} ${verb ?? "grade"} ${id}`);
    if (verb === "turnIn") sub.state = "TURNED_IN";
    if (verb === "return") sub.state = "RETURNED";
    if (method === "PATCH") sub.assignedGrade = JSON.parse(String(init!.body)).assignedGrade;
    return Response.json(sub);
  };
  const student = { token: async (email: string) => `${email.split("@")[0]}|me` };
  const teacher = { token: async (email: string) => { assert.match(email, /^hb-teacher-/); return `${email}|teacher`; } };
  return { transport, student, teacher, subs, writes };
}

test("learners turn in their own work; teachers grade and return only the first activity", async () => {
  const { transport, student, teacher, writes } = fakeClassroom();
  const first = await harborClassroomWork(student, teacher, "run", transport);
  assert.deepEqual(first.problems, []);
  assert.equal(first.rows.length, 20);
  assert.equal(first.rows.filter((r) => r.state === "RETURNED").length, 10);
  assert.equal(first.rows.filter((r) => r.state === "TURNED_IN").length, 10);
  assert.ok(writes.filter((w) => w.includes("turnIn")).every((w) => w.startsWith("hb-student-")));
  assert.ok(writes.filter((w) => w.includes("grade") || w.includes("return")).every((w) => w.startsWith("hb-teacher-")));
  assert.equal(first.rows.find((r) => r.learner === "hb-student-rosa" && r.state === "RETURNED")!.grade, 10);
  assert.ok(first.isolation.length > 0 && first.isolation.every((i) => i.status === 403));
  const count = writes.length;
  assert.deepEqual((await harborClassroomWork(student, teacher, "run", transport)).problems, []);
  assert.deepEqual((await harborClassroomWork(student, teacher, "verify", transport)).problems, []);
  assert.equal(writes.length, count);
});

test("a grade the teacher has since changed is kept, and verify does not write", async () => {
  const { transport, student, teacher, subs, writes } = fakeClassroom();
  await harborClassroomWork(student, teacher, "run", transport);
  const edited = [...subs.values()].find((s) => s.userId === "hb-student-nia" && s.state === "RETURNED")!;
  edited.assignedGrade = 6;
  const count = writes.length;
  const again = await harborClassroomWork(student, teacher, "verify", transport);
  assert.deepEqual(again.problems, []);
  assert.equal(writes.length, count);
  assert.ok(again.rows.some((r) => r.outcome === "teacher grade 6 kept"));
});

test("review work a teacher later graded and returned is kept; returned without a grade is a problem", async () => {
  const { transport, student, teacher, subs } = fakeClassroom();
  await harborClassroomWork(student, teacher, "run", transport);
  const awaiting = [...subs.values()].filter((s) => s.state === "TURNED_IN");
  Object.assign(awaiting[0]!, { state: "RETURNED", assignedGrade: 8 });
  const reviewed = await harborClassroomWork(student, teacher, "verify", transport);
  assert.deepEqual(reviewed.problems, []);
  assert.ok(reviewed.rows.some((r) => r.outcome === "teacher returned 8"));
  awaiting[1]!.state = "RETURNED";
  const ungraded = await harborClassroomWork(student, teacher, "verify", transport);
  assert.equal(ungraded.problems.length, 1);
  assert.match(ungraded.problems[0]!, /is RETURNED, expected TURNED_IN$/);
});
