// The Clever fake's LMS Connect endpoints, held to Clever's published v3.1 OpenAPI file. These pin
// the fake to the spec; they say nothing about how Clever itself behaves, which was never tested.
import { describe, expect, it } from "vitest";
import { SAMPLE_DISTRICT } from "../src/index.ts";
import { CleverDataFake, type CleverAssignment, type CleverSubmission } from "../src/clever/index.ts";

function setup() {
  let clock = Date.parse("2026-10-20T12:00:00Z");
  const fake = new CleverDataFake({ seed: SAMPLE_DISTRICT, now: () => clock });
  const call = (method: string, path: string, body?: unknown, token: string | null = fake.districtToken) =>
    fake.fetch(`https://api.clever.com${path.startsWith("/v3") ? "" : "/v3.1"}${path}`, {
      method,
      headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
  const section = fake.idOf("sections", "mw-bio-p2");
  const student = fake.userId("mw-s-01");
  const teacher = fake.userId("mw-t-okafor");
  const create = async (body: Record<string, unknown> = { title: "Cell lab", grading_type: "points", points_possible: 10 }) => {
    const response = await call("POST", `/sections/${section}/assignments`, body);
    expect(response.status).toBe(200);
    return ((await response.json()) as { data: CleverAssignment }).data;
  };
  return { fake, call, section, student, teacher, create, tick: (ms: number) => (clock += ms) };
}

describe("Clever LMS Connect fake (built to the v3.1 spec, not tested against Clever)", () => {
  it("creates an assignment in a section and serves it in a data envelope", async () => {
    const { fake, call, section, create } = setup();
    const assignment = await create({ title: "Cell lab", description: "Write it up", grading_type: "points", points_possible: 10, due_date: "2026-11-01T23:59:00Z" });
    expect(assignment).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f]{24}$/),
      title: "Cell lab",
      description: "Write it up",
      grading_type: "points",
      points_possible: 10,
      due_date: "2026-11-01T23:59:00Z",
      state: "open",
      assignee_mode: "all",
      term_id: fake.record("sections", section)!["term_id"],
      created: "2026-10-20T12:00:00.000Z",
    });
    const got = await call("GET", `/sections/${section}/assignments/${assignment.id}`);
    expect(await got.json()).toEqual({ data: assignment });
    expect(fake.assignmentsFor(section)).toEqual([assignment]);
  });

  it("is v3.1 only", async () => {
    const { call, section, create } = setup();
    const assignment = await create();
    expect((await call("POST", `/v3.0/sections/${section}/assignments`, { title: "x" })).status).toBe(404);
    expect((await call("GET", `/v3.0/sections/${section}/assignments/${assignment.id}`)).status).toBe(404);
  });

  it("needs a district token, a real section and a well-formed body", async () => {
    const { call, section } = setup();
    expect((await call("POST", `/sections/${section}/assignments`, { title: "x" }, null)).status).toBe(401);
    expect((await call("POST", `/sections/${"0".repeat(24)}/assignments`, { title: "x" })).status).toBe(404);
    const bad = await call("POST", `/sections/${section}/assignments`, { title: "x", points_possible: "ten" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ message: "invalid value for points_possible" });
    expect((await call("POST", `/sections/${section}/assignments`, { title: "x", grading_type: "stars" })).status).toBe(400);
    expect((await call("POST", `/sections/${section}/assignments`, { title: "x", due_date: "tomorrow" })).status).toBe(400);
    expect((await call("POST", `/sections/${section}/assignments`, { description: "no title" })).status).toBe(400);
    expect((await call("POST", `/sections/${section}/assignments`, "not json")).status).toBe(400);
    expect((await call("POST", `/sections/${section}/assignments`, [])).status).toBe(400);
    // The spec defines no list of a section's assignments.
    expect((await call("GET", `/sections/${section}/assignments`)).status).toBe(405);
  });

  it("drops fields AssignmentRequest does not name, such as the quickstart's state", async () => {
    const { create } = setup();
    const assignment = await create({ title: "Quiz", state: "published", score: 3 });
    expect(assignment.state).toBe("open");
    expect(assignment).not.toHaveProperty("score");
  });

  it("assigns individuals only among the section's students", async () => {
    const { fake, call, section, create, student } = setup();
    const other = fake.userId("mw-s-07");
    expect((await call("POST", `/sections/${section}/assignments`, { title: "x", assignee_mode: "individuals", assignee_ids: [other] })).status).toBe(400);
    expect((await call("POST", `/sections/${section}/assignments`, { title: "x", assignee_mode: "individuals" })).status).toBe(400);
    expect((await call("POST", `/sections/${section}/assignments`, { title: "x", assignee_ids: [student] })).status).toBe(400);
    const assignment = await create({ title: "x", assignee_mode: "individuals", assignee_ids: [student] });
    expect(fake.submissionFor(section, assignment.id, student)).toMatchObject({ state: "created" });
    expect(fake.submissionFor(section, assignment.id, fake.userId("mw-s-02"))).toBeUndefined();
  });

  it("patches and deletes an assignment, and keeps it to its own section", async () => {
    const { fake, call, section, create, tick } = setup();
    const assignment = await create();
    tick(60_000);
    const patched = await call("PATCH", `/sections/${section}/assignments/${assignment.id}`, { points_possible: 20, display_date: "2027-01-01T00:00:00Z" });
    expect(patched.status).toBe(200);
    const updated = ((await patched.json()) as { data: CleverAssignment }).data;
    expect(updated).toMatchObject({ points_possible: 20, title: "Cell lab", state: "scheduled", last_modified: "2026-10-20T12:01:00.000Z", created: assignment.created });
    const elsewhere = fake.idOf("sections", "mw-bio-p4");
    expect((await call("GET", `/sections/${elsewhere}/assignments/${assignment.id}`)).status).toBe(404);
    expect((await call("PATCH", `/sections/${section}/assignments/${assignment.id}`, { title: "" })).status).toBe(400);
    const deleted = await call("DELETE", `/sections/${section}/assignments/${assignment.id}`);
    expect(deleted.status).toBe(200);
    expect((await call("GET", `/sections/${section}/assignments/${assignment.id}`)).status).toBe(404);
    expect(fake.assignmentsFor(section)).toEqual([]);
  });

  it("grades a student's submission with the SubmissionRequest fields", async () => {
    const { fake, call, section, create, student, teacher, tick } = setup();
    const assignment = await create();
    const path = `/sections/${section}/assignments/${assignment.id}/submissions/${student}`;
    const before = (await (await call("GET", path)).json()) as { data: CleverSubmission };
    expect(before.data).toMatchObject({ assignment_id: assignment.id, user_id: student, state: "created", grade: null, grade_comment: null, grader_id: null });
    expect(before.data).not.toHaveProperty("grade_points");
    tick(1000);
    const response = await call("PATCH", path, { grade_points: 8, grade_comment: "Good work", grader_id: teacher, flags: ["late"] });
    expect(response.status).toBe(200);
    const after = ((await response.json()) as { data: CleverSubmission }).data;
    expect(after).toMatchObject({ grade_points: 8, grade_comment: "Good work", grader_id: teacher, flags: ["late"], state: "created", last_modified: "2026-10-20T12:00:01.000Z" });
    expect(fake.submissionFor(section, assignment.id, student)).toEqual(after);
    // The same patch again leaves the same grade.
    expect(((await (await call("PATCH", path, { grade_points: 8, grade_comment: "Good work" })).json()) as { data: CleverSubmission }).data.grade_points).toBe(8);
  });

  it("refuses a malformed grade, a grader who does not teach the section, and anyone not a student of it", async () => {
    const { fake, call, section, create, student, teacher } = setup();
    const assignment = await create();
    const path = (user: string) => `/sections/${section}/assignments/${assignment.id}/submissions/${user}`;
    expect((await call("PATCH", path(student), { grade_points: "8" })).status).toBe(400);
    expect((await call("PATCH", path(student), { state: "graded" })).status).toBe(400);
    expect((await call("PATCH", path(student), { flags: ["absent"] })).status).toBe(400);
    expect((await call("PATCH", path(student), { grader_id: fake.userId("mw-t-quill") })).status).toBe(400);
    const outsider = await call("PATCH", path(fake.userId("mw-s-07")), { grade_points: 8 });
    expect(outsider.status).toBe(404);
    expect(await outsider.json()).toEqual({ message: "submission not found" });
    expect((await call("GET", path(teacher))).status).toBe(404);
    expect((await call("PATCH", `/sections/${section}/assignments/${"f".repeat(24)}/submissions/${student}`, { grade_points: 1 })).status).toBe(404);
    expect(fake.submissionFor(section, assignment.id, student)).not.toHaveProperty("grade_points");
  });

  it("lists submissions with a cursor and a limit of at most 100", async () => {
    const { call, section, create } = setup();
    const assignment = await create();
    const base = `/sections/${section}/assignments/${assignment.id}/submissions`;
    expect((await call("GET", `${base}?limit=101`)).status).toBe(400);
    const first = (await (await call("GET", `${base}?limit=4`)).json()) as { data: CleverSubmission[]; links: { rel: string; uri: string }[] };
    expect(first.data).toHaveLength(4);
    expect(first.links).toEqual([{ rel: "next", uri: expect.stringContaining("cursor=") }]);
    const second = (await (await call("GET", first.links[0]!.uri)).json()) as { data: CleverSubmission[]; links?: unknown };
    expect(second.data).toHaveLength(2);
    expect(second).not.toHaveProperty("links");
    expect(new Set([...first.data, ...second.data].map((s) => s.user_id)).size).toBe(6);
  });
});
