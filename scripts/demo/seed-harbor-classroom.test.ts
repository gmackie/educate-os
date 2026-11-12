import assert from "node:assert/strict";
import { test } from "node:test";
import { harborCourseworkPlan, seedHarborClassroom } from "./seed-harbor-classroom.ts";

test("only Harbor courses are seeded, with stable lesson titles and their own teachers", () => {
  const plan = harborCourseworkPlan();
  assert.equal(plan.length, 4);
  for (const course of plan) {
    assert.equal(course.district, "harbor");
    assert.match(course.ownerEmail, /^hb-teacher-/);
    assert.equal(course.lessons.length, 2);
    assert.equal(new Set(course.lessons.map(l => l.title)).size, 2);
  }
});

test("teacher-scoped seed is repeatable and verify does not write", async () => {
  const works = new Map<string, Record<string, unknown>[]>();
  let writes = 0;
  const tokens = { token: async (subject: string) => { assert.match(subject, /^hb-teacher-/); return "private"; } };
  const transport: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const id = decodeURIComponent(path.split("/")[3]!);
    if (!path.endsWith("/courseWork")) return Response.json({ id: id.slice(2), courseState: "ACTIVE" });
    const rows = works.get(id) ?? []; works.set(id, rows);
    if (init?.method === "POST") {
      writes++;
      const row = { ...JSON.parse(String(init.body)), id: String(writes), associatedWithDeveloper: true };
      rows.push(row); return Response.json(row);
    }
    return Response.json({ courseWork: rows });
  };
  assert.deepEqual((await seedHarborClassroom(tokens, "run", transport)).problems, []);
  assert.equal(writes, 8);
  assert.deepEqual((await seedHarborClassroom(tokens, "run", transport)).problems, []);
  assert.deepEqual((await seedHarborClassroom(tokens, "verify", transport)).problems, []);
  assert.equal(writes, 8);
});

test("foreign-project coursework with a matching title is refused, never overwritten", async () => {
  const lesson = harborCourseworkPlan()[0]!.lessons[0]!;
  const transport: typeof fetch = async (input) => new URL(String(input)).pathname.endsWith("/courseWork")
    ? Response.json({ courseWork: [{ id: "1", ...lesson, state: "PUBLISHED", associatedWithDeveloper: false }] })
    : Response.json({ id: "2", courseState: "ACTIVE" });
  await assert.rejects(seedHarborClassroom({ token: async () => "private" }, "run", transport), /Unowned Harbor assignment collision/);
});
