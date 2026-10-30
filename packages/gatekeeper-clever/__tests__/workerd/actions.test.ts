// Changes: creating an assignment, grading and turning in, each submitted for approval and made in
// LMS Connect (the Data API fake's gradebook) only once applied, shown to reads meanwhile as made;
// grade bounds and the grade comment; the teacher's tools against the typed methods; and the
// district audit log.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog, binding, failure, FakeClever, hooks, unwrap } from "./fake-clever";
import type { GatekeeperProps } from "./worker";

const fake = new FakeClever();

beforeEach(() => {
  fake.install();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type Assignment = { id: string; title: string; pointsPossible: number; pending?: true; dueDate?: Date };
type Submission = { studentId: string; state: string; points?: number; comment?: string; pending?: true };

const BIO_P2 = () => fake.section("mw-bio-p2");

/** Creates and approves an assignment in Biology period 2 through a teacher's section binding. */
async function createdAssignment(title = "Cell lab", pointsPossible = 20): Promise<{ name: string; props: GatekeeperProps; id: string }> {
  const { name, props } = await binding(fake, "mw-t-okafor", { kind: "section", sectionId: BIO_P2() });
  unwrap(await hooks().run(name, props, [["createAssignment", { title, pointsPossible }]]));
  const { submitted } = await hooks().queueLog(name);
  unwrap(await hooks().applyAction(name, props, submitted.at(-1)!.actionId));
  const id = fake.data.assignmentsFor(BIO_P2()).find(a => a.title === title)!.id;
  return { name, props, id };
}

describe("creating an assignment", () => {
  it("is shown as pending until approved, then created in the LMS and listed", async () => {
    const { name, props } = await binding(fake, "mw-t-okafor", { kind: "section", sectionId: BIO_P2() });
    const before = fake.data.assignmentsFor(BIO_P2()).length;
    unwrap(await hooks().run(name, props, [["createAssignment", {
      title: "Photosynthesis quiz", description: "Chapter 4", pointsPossible: 10, dueDate: new Date("2026-11-20T23:59:00Z"),
    }]]));
    const { submitted } = await hooks().queueLog(name);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.description.title).toBe("Create Clever assignment: Photosynthesis quiz");
    expect(fake.data.assignmentsFor(BIO_P2())).toHaveLength(before);

    const pending = unwrap(await hooks().run(name, props, [["listAssignments"]])) as Assignment[];
    const draft = pending.find(a => a.title === "Photosynthesis quiz")!;
    expect(draft).toMatchObject({ id: `pending:create:${submitted[0]!.actionId}`, pointsPossible: 10, pending: true });
    expect(unwrap(await hooks().run(name, props, [["getAssignment", draft.id]]))).toMatchObject({ title: "Photosynthesis quiz" });
    expect(unwrap(await hooks().run(name, props, [["listSubmissions", draft.id]]))).toEqual([]);
    expect(failure(await hooks().run(name, props, [["setGrade", draft.id, fake.user("mw-s-01"), 5]]))).toMatch(/not created yet/);

    unwrap(await hooks().applyAction(name, props, submitted[0]!.actionId));
    const created = fake.data.assignmentsFor(BIO_P2()).at(-1)!;
    expect(created).toMatchObject({
      title: "Photosynthesis quiz", description: "Chapter 4", points_possible: 10, grading_type: "points",
      assignee_mode: "all", due_date: "2026-11-20T23:59:00.000Z",
    });
    const listed = unwrap(await hooks().run(name, props, [["listAssignments"]])) as Assignment[];
    expect(listed.find(a => a.id === created.id)).toMatchObject({ title: "Photosynthesis quiz", pointsPossible: 10 });
    expect(listed.some(a => a.pending)).toBe(false);
  });

  it("drops a rejected creation, and creates nothing", async () => {
    const { name, props } = await binding(fake, "mw-t-okafor", { kind: "section", sectionId: BIO_P2() });
    const before = fake.data.assignmentsFor(BIO_P2()).length;
    unwrap(await hooks().run(name, props, [["createAssignment", { title: "Never", pointsPossible: 5 }]]));
    const { submitted } = await hooks().queueLog(name);
    unwrap(await hooks().rejectAction(name, props, submitted[0]!.actionId));
    const listed = unwrap(await hooks().run(name, props, [["listAssignments"]])) as Assignment[];
    expect(listed.some(a => a.title === "Never")).toBe(false);
    expect(fake.data.assignmentsFor(BIO_P2())).toHaveLength(before);
  });

  it("refuses a draft that is not one", async () => {
    const { name, props } = await binding(fake, "mw-t-okafor", { kind: "section", sectionId: BIO_P2() });
    expect(failure(await hooks().run(name, props, [["createAssignment", { title: "  ", pointsPossible: 5 }]]))).toMatch(/title/);
    expect(failure(await hooks().run(name, props, [["createAssignment", { title: "X", pointsPossible: 0 }]]))).toMatch(/pointsPossible/);
  });

  it("is refused at apply once the teacher no longer teaches the section", async () => {
    const { name, props } = await binding(fake, "mw-t-reyes", { kind: "section", sectionId: fake.section("mw-alg-p3") });
    unwrap(await hooks().run(name, props, [["createAssignment", { title: "Late change", pointsPossible: 5 }]]));
    const { submitted } = await hooks().queueLog(name);
    fake.data.updateSection("mw-alg-p3", { teacherIds: ["mw-t-quill"] });
    try {
      expect(failure(await hooks().applyAction(name, props, submitted[0]!.actionId))).toMatch(/No such section/);
      expect(fake.data.assignmentsFor(fake.section("mw-alg-p3"))).toEqual([]);
    } finally {
      fake.data.updateSection("mw-alg-p3", { teacherIds: ["mw-t-reyes"] });
    }
  });
});

describe("grading", () => {
  it("shows a pending grade as given, then records the points and comment in the LMS", async () => {
    const { name, props, id } = await createdAssignment("Lab A", 20);
    const ada = fake.user("mw-s-01");
    unwrap(await hooks().run(name, props, [["setGrade", id, ada, 17, "Clear method; check your units."]]));
    const { submitted } = await hooks().queueLog(name);
    const grade = submitted.at(-1)!;
    expect(grade.description.title).toBe("Grade Clever assignment: 17 out of 20");
    expect(fake.data.submissionFor(BIO_P2(), id, ada)?.grade_points).toBeUndefined();

    const shown = unwrap(await hooks().run(name, props, [["listSubmissions", id, { studentId: ada }]])) as Submission[];
    expect(shown).toEqual([{ studentId: ada, state: "created", points: 17, comment: "Clear method; check your units.", pending: true }]);

    unwrap(await hooks().applyAction(name, props, grade.actionId));
    expect(fake.data.submissionFor(BIO_P2(), id, ada)).toMatchObject({ grade_points: 17, grade_comment: "Clear method; check your units." });
    const after = unwrap(await hooks().run(name, props, [["listSubmissions", id]])) as Submission[];
    expect(after).toHaveLength(6);
    expect(after.find(s => s.studentId === ada)).toEqual({ studentId: ada, state: "created", points: 17, comment: "Clear method; check your units." });
  });

  it("keeps grades between 0 and the assignment's points", async () => {
    const { name, props, id } = await createdAssignment("Lab B", 20);
    const ada = fake.user("mw-s-01");
    expect(failure(await hooks().run(name, props, [["setGrade", id, ada, 21]]))).toMatch(/between 0 and .* 20/);
    expect(failure(await hooks().run(name, props, [["setGrade", id, ada, -1]]))).toMatch(/between 0/);
    unwrap(await hooks().run(name, props, [["setGrade", id, ada, 20]]));
    unwrap(await hooks().run(name, props, [["setGrade", id, ada, 0]]));
  });

  it("grades only students on the section's roster, and only assignments created here", async () => {
    const { name, props, id } = await createdAssignment("Lab C", 10);
    expect(failure(await hooks().run(name, props, [["setGrade", id, fake.user("mw-s-07"), 5]]))).toMatch(/No such student/);
    expect(failure(await hooks().run(name, props, [["setGrade", "0123456789abcdef01234567", fake.user("mw-s-01"), 5]])))
      .toMatch(/No such assignment/);
  });
});

describe("a student's own work", () => {
  it("lists the assignments EducateOS posted and shows only the student's submission, grade once returned", async () => {
    const { name: teacher, props: teacherProps, id } = await createdAssignment("Lab D", 10);
    const { name, props } = await binding(fake, "mw-s-02", { kind: "studentSection", sectionId: BIO_P2() });
    const listed = unwrap(await hooks().run(name, props, [["listAssignments"]])) as { id: string }[];
    expect(listed.some(a => a.id === id)).toBe(true);

    unwrap(await hooks().run(teacher, teacherProps, [["setGrade", id, fake.user("mw-s-02"), 8, "Good"]]));
    unwrap(await hooks().applyAction(teacher, teacherProps, (await hooks().queueLog(teacher)).submitted.at(-1)!.actionId));
    // Graded, but not returned: the student sees no points yet.
    expect(unwrap(await hooks().run(name, props, [["getMySubmission", id]]))).toEqual({ state: "created" });

    unwrap(await hooks().run(name, props, [["turnIn", id]]));
    const { submitted } = await hooks().queueLog(name);
    expect(submitted.at(-1)!.description.title).toBe("Turn in Clever assignment: Lab D");
    expect(fake.data.submissionFor(BIO_P2(), id, fake.user("mw-s-02"))?.state).toBe("created");
    expect(unwrap(await hooks().run(name, props, [["getMySubmission", id]]))).toEqual({ state: "submitted" });
    expect(failure(await hooks().run(name, props, [["turnIn", id]]))).toMatch(/already turned in/);
    unwrap(await hooks().applyAction(name, props, submitted.at(-1)!.actionId));
    expect(fake.data.submissionFor(BIO_P2(), id, fake.user("mw-s-02"))?.state).toBe("submitted");

    // Once the LMS returns it, the points and comment are the student's to see.
    await fetch(`https://api.clever.com/v3.1/sections/${BIO_P2()}/assignments/${id}/submissions/${fake.user("mw-s-02")}`, {
      method: "PATCH", redirect: "manual",
      headers: { authorization: "Bearer test-district-token", "content-type": "application/json" },
      body: JSON.stringify({ state: "returned" }),
    }).then(response => response.text());
    expect(unwrap(await hooks().run(name, props, [["getMySubmission", id]]))).toEqual({ state: "returned", points: 8, comment: "Good" });
  });

  it("never shows a classmate's submission", async () => {
    const { id } = await createdAssignment("Lab E", 10);
    const { name, props } = await binding(fake, "mw-s-03", { kind: "studentSection", sectionId: BIO_P2() });
    expect(failure(await hooks().run(name, props, [["listSubmissions", id]]))).toBeTruthy();
    const mine = unwrap(await hooks().run(name, props, [["getMySubmission", id]]));
    expect(mine).toEqual({ state: "created" });
    expect(JSON.stringify(mine)).not.toContain(fake.user("mw-s-01"));
  });

  it("does not show the student assignments posted to another section", async () => {
    const { id } = await createdAssignment("Lab F", 10);
    const { name, props } = await binding(fake, "mw-s-07", { kind: "studentSection", sectionId: fake.section("mw-bio-p4") });
    expect(failure(await hooks().run(name, props, [["getMySubmission", id]]))).toMatch(/No such assignment/);
  });
});

describe("the teacher's tools", () => {
  it("answer as the typed methods do, and a change awaits a decision", async () => {
    const { name, props } = await binding(fake, "mw-t-okafor", { kind: "teacher" });
    const tools = unwrap(await hooks().run(name, props, [["listTools"]])) as { name: string }[];
    expect(tools.map(tool => tool.name)).toEqual([
      "list_sections", "get_section", "get_roster", "list_assignments", "get_assignment",
      "create_assignment", "list_submissions", "set_grade",
    ]);
    const typed = unwrap(await hooks().run(name, props, [["section", BIO_P2()], ["getRoster"]]));
    const viaTool = unwrap(await hooks().run(name, props, [["callTool", "get_roster", { sectionId: BIO_P2() }]]));
    expect(viaTool).toEqual({ status: "ok", value: typed });
    const sections = unwrap(await hooks().run(name, props, [["listSections"]]));
    expect(unwrap(await hooks().run(name, props, [["callTool", "list_sections", {}]]))).toEqual({ status: "ok", value: sections });

    const created = unwrap(await hooks().run(name, props, [["callTool", "create_assignment", {
      sectionId: BIO_P2(), title: "Tool-made", pointsPossible: 4, dueDate: "2026-12-01T12:00:00Z",
    }]]));
    expect(created).toEqual({ status: "awaiting-decision" });
    const listed = unwrap(await hooks().run(name, props, [["callTool", "list_assignments", { sectionId: BIO_P2() }]])) as
      { status: string; value: Assignment[] };
    expect(listed.value.find(a => a.title === "Tool-made")).toMatchObject({ pending: true, dueDate: "2026-12-01T12:00:00.000Z" });
  });

  it("refuse bad arguments by name, and a section the teacher does not teach as not found", async () => {
    const { name, props } = await binding(fake, "mw-t-okafor", { kind: "teacher" });
    expect(unwrap(await hooks().run(name, props, [["callTool", "set_grade", { sectionId: BIO_P2(), points: "ten", extra: 1 }]])))
      .toMatchObject({ status: "error", code: "validation-failed", message: expect.stringMatching(/extra.*assignmentId.*points must be a number/s) });
    expect(unwrap(await hooks().run(name, props, [["callTool", "get_roster", { sectionId: fake.section("mw-eng9-p1") }]])))
      .toMatchObject({ status: "error", code: "not-found" });
    expect(unwrap(await hooks().run(name, props, [["callTool", "no_such_tool", {}]])))
      .toMatchObject({ status: "error", code: "validation-failed" });
  });

  it("grade within bounds through set_grade", async () => {
    const { id } = await createdAssignment("Lab G", 10);
    const { name, props } = await binding(fake, "mw-t-okafor", { kind: "teacher" });
    const args = { sectionId: BIO_P2(), assignmentId: id, studentId: fake.user("mw-s-04") };
    expect(unwrap(await hooks().run(name, props, [["callTool", "set_grade", { ...args, points: 11 }]])))
      .toMatchObject({ status: "error", code: "validation-failed" });
    expect(unwrap(await hooks().run(name, props, [["callTool", "set_grade", { ...args, points: 9, comment: "Nice" }]])))
      .toEqual({ status: "awaiting-decision" });
    const shown = unwrap(await hooks().run(name, props, [["callTool", "list_submissions", { ...args, studentId: args.studentId, assignmentId: id }]]));
    expect(shown).toMatchObject({ status: "ok", value: [{ studentId: args.studentId, points: 9, comment: "Nice", pending: true }] });
  });
});

describe("the district audit log", () => {
  it("records every read and change through the district grant, by whom and on what", async () => {
    const { name, props } = await binding(fake, "mw-admin-varga", { kind: "district" });
    const admin = fake.user("mw-admin-varga");
    const section = fake.section("mw-alg-p3");
    const before = (await auditLog())[0]?.seq ?? 0;
    unwrap(await hooks().run(name, props, [["listSchools"]]));
    unwrap(await hooks().run(name, props, [["section", section], ["getRoster"]]));
    unwrap(await hooks().run(name, props, [["section", section], ["createAssignment", { title: "District-made", pointsPossible: 3 }]]));
    const { submitted } = await hooks().queueLog(name);
    unwrap(await hooks().applyAction(name, props, submitted.at(-1)!.actionId));
    const created = fake.data.assignmentsFor(section).find(a => a.title === "District-made")!;
    unwrap(await hooks().run(name, props, [["section", section], ["setGrade", created.id, fake.user("mw-s-06"), 2]]));
    unwrap(await hooks().rejectAction(name, props, (await hooks().queueLog(name)).submitted.at(-1)!.actionId));

    const entries = (await auditLog()).filter(entry => entry.seq > before).toReversed();
    expect(entries.map(({ userId, action, target }) => ({ userId, action, target }))).toEqual([
      { userId: admin, action: "read:schools", target: `district:${fake.data.districtId}` },
      { userId: admin, action: "read:roster", target: `section:${section}` },
      { userId: admin, action: "request:create-assignment", target: `section:${section}` },
      { userId: admin, action: "applied:create-assignment", target: `section:${section}/assignment:${created.id}` },
      { userId: admin, action: "request:set-grade", target: `section:${section}/assignment:${created.id}/student:${fake.user("mw-s-06")}` },
      { userId: admin, action: "rejected:set-grade", target: `section:${section}/assignment:${created.id}/student:${fake.user("mw-s-06")}` },
    ]);
    for (const entry of entries) expect(entry.at).toBeGreaterThan(0);
  });

  it("records nothing for a teacher's own connection", async () => {
    const before = (await auditLog())[0]?.seq ?? 0;
    const { name, props } = await binding(fake, "mw-t-okafor", { kind: "section", sectionId: BIO_P2() });
    unwrap(await hooks().run(name, props, [["getRoster"]]));
    expect((await auditLog()).filter(entry => entry.seq > before)).toEqual([]);
  });
});
