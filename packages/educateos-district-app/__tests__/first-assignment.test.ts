// SCHO-220: a teacher can create the first assignment in a brand-new class, by either path. An
// activity needs no learning goals; the goals it may have come from the standards releases a
// district administrator approved; and a quiz published without an assignment gets its own.
import { describe, expect, it } from "vitest";
import { catalogSeedRelease } from "@educateos/catalog";
import type { TemplateInput } from "@educateos/curriculum";
import { bootDistrict, expectError, NF, type TestDistrict } from "./support.ts";

/** The co-op walkthrough's science investigation, with no resources and, unless given, no goals. */
const rockCycle = (alignments?: TemplateInput["alignments"]): TemplateInput => ({
  template: "science-investigation",
  title: "Rock Cycle Investigation",
  subject: "science",
  gradeBand: "9-10",
  overview: "Observe three rock samples and explain which part of the rock cycle formed each one.",
  question: "How can we tell how a rock was formed by looking at it?",
  methodPrompt: "Describe how you examined each sample.",
  dataColumns: [{ name: "Sample" }, { name: "Grain size", unit: "mm" }],
  analysisPrompt: "Classify each sample and justify it with your data.",
  aiHelp: "hints-only",
  due: { kind: "none" },
  ...(alignments === undefined ? {} : { alignments }),
} as TemplateInput);

/** A writing task for English 9 aligned to `alignments`. */
const essay = (alignments: TemplateInput["alignments"]): TemplateInput => ({
  template: "writing-task",
  title: "Should the school day start later?",
  subject: "english-language-arts",
  gradeBand: "9",
  overview: "Write an argument for or against a later start to the school day.",
  prompt: "Take a position.",
  genre: "argument",
  minimumCitations: 0,
  aiHelp: "hints-only",
  due: { kind: "none" },
  alignments,
} as TemplateInput);

/** The CCSS-ELA item with this code, as the catalog ships it. */
async function elaItem(code: string) {
  const node = (await catalogSeedRelease("ccss-ela")).content.nodes!.find((n) => n.humanCodingScheme === code)!;
  return { frameworkKey: "ccss-ela", competencyUri: node.uri };
}

async function createAndAssign(district: TestDistrict, token: string, offeringId: string, activity: TemplateInput) {
  const draft = await district.ok(token, "teacher.createActivity", { params: { offeringId }, body: { activity } });
  await district.ok(token, "teacher.publishActivity", { params: { definitionId: draft.id } });
  const installed = await district.ok(token, "teacher.installActivity", { params: { definitionId: draft.id }, body: { offeringId } });
  return { draft, ...installed };
}

describe("the first activity in a new class (SCHO-220)", () => {
  it("needs no learning goals, even where the district has approved no standards", async () => {
    const district = await bootDistrict(undefined, { standards: [] });
    const morgan = district.tokenFor(NF.morgan);
    expect(await district.ok(morgan, "teacher.listAssignments", { params: { offeringId: NF.bio } })).toEqual([]);
    expect(await district.ok(morgan, "teacher.learningGoals", { params: { offeringId: NF.bio } })).toStrictEqual({ goals: [], approvedReleases: 0 });

    const { draft, assignment } = await createAndAssign(district, morgan, NF.bio, rockCycle());
    expect(draft.content.evidence.alignments).toStrictEqual([]);
    expect(draft.evidenceContract.competencies).toStrictEqual([]);
    expect(assignment).toMatchObject({ offeringId: NF.bio, title: "Rock Cycle Investigation" });
    const [listed] = await district.ok(district.tokenFor(NF.amara), "student.listActivities", { params: { offeringId: NF.bio } });
    expect(listed!.assignment.id).toBe(assignment.id);
  });

  it("offers the goals of a release once an administrator approves it, filtered to the course, and accepts them", async () => {
    const district = await bootDistrict(undefined, { standards: [] });
    const admin = district.tokenFor(NF.admin);
    const rivera = district.tokenFor(NF.rivera);

    const before = await district.ok(admin, "admin.listStandards");
    expect(before.map((s) => [s.frameworkKey, s.status])).toEqual([
      ["ccss-math", "not-approved"], ["ccss-ela", "not-approved"], ["c3", "not-approved"], ["casel-5", "not-approved"], ["head-start-elof", "not-approved"],
    ]);
    // No science standards ship, so none is listed.
    expect(before.some((s) => s.subjects.includes("science"))).toBe(false);

    const approved = await district.ok(admin, "admin.approveStandards", { params: { frameworkKey: "ccss-ela" } });
    expect(approved).toMatchObject({ frameworkKey: "ccss-ela", status: "approved", decided: { by: NF.admin } });
    // Approving it again changes nothing.
    expect(await district.ok(admin, "admin.approveStandards", { params: { frameworkKey: "ccss-ela" } })).toStrictEqual(approved);

    // English 9 is offered grade-9 ELA items, not grade-3 ones, and no other subject's.
    const { goals, approvedReleases } = await district.ok(rivera, "teacher.learningGoals", { params: { offeringId: NF.eng9 } });
    expect(approvedReleases).toBe(1);
    const w1 = goals.find((g) => g.code === "W.9-10.1");
    expect(w1).toMatchObject({ frameworkKey: "ccss-ela", statement: expect.stringMatching(/^Write arguments/) });
    expect(goals.some((g) => g.code === "W.3.1")).toBe(false);
    expect(goals.every((g) => g.frameworkKey === "ccss-ela")).toBe(true);
    // Strands such as "Writing" are too broad to choose.
    expect(goals.some((g) => g.code === "W.9-10")).toBe(false);
    // Biology is science, which no approved release covers.
    expect(await district.ok(district.tokenFor(NF.morgan), "teacher.learningGoals", { params: { offeringId: NF.bio } })).toStrictEqual({ goals: [], approvedReleases: 1 });

    const { draft } = await createAndAssign(district, rivera, NF.eng9, essay([{ frameworkKey: w1!.frameworkKey, competencyUri: w1!.competencyUri }]));
    expect(draft.evidenceContract.competencies.map((c) => c.competencyUri)).toEqual([w1!.competencyUri]);

    // Once withdrawn, the release's goals are neither offered nor accepted.
    expect(await district.ok(admin, "admin.withdrawStandards", { params: { frameworkKey: "ccss-ela" } })).toMatchObject({ status: "not-approved" });
    expect((await district.ok(rivera, "teacher.learningGoals", { params: { offeringId: NF.eng9 } })).goals).toEqual([]);
    const refused = await district.call(rivera, "teacher.createActivity", { params: { offeringId: NF.eng9 }, body: { activity: essay([{ frameworkKey: w1!.frameworkKey, competencyUri: w1!.competencyUri }]) } });
    expectError(refused, 400, "validation-failed");
    // ... in words a teacher can act on, without the item's URI.
    expect((refused.body as { message: string }).message).not.toContain("urn:");
    // And an administrator can approve it again.
    expect(await district.ok(admin, "admin.approveStandards", { params: { frameworkKey: "ccss-ela" } })).toMatchObject({ status: "approved" });
  });

  it("refuses goals outside the district's approved releases", async () => {
    const district = await bootDistrict(undefined, { standards: ["ccss-math"] });
    const rivera = district.tokenFor(NF.rivera);
    expectError(await district.call(rivera, "teacher.createActivity", { params: { offeringId: NF.eng9 }, body: { activity: essay([await elaItem("W.9-10.1")]) } }), 400, "validation-failed");
    expectError(await district.call(rivera, "teacher.createActivity", {
      params: { offeringId: NF.eng9 },
      body: { activity: essay([{ frameworkKey: "ccss-math", competencyUri: "urn:educateos:catalog:ccss-math:NOT-AN-ITEM" }]) },
    }), 400, "validation-failed");
  });

  it("lets only district administrators decide which standards are approved, and only built-in ones", async () => {
    const district = await bootDistrict(undefined, { standards: [] });
    for (const who of [NF.rivera, NF.morgan]) {
      expectError(await district.call(district.tokenFor(who), "admin.listStandards"), 403, "forbidden");
      expectError(await district.call(district.tokenFor(who), "admin.approveStandards", { params: { frameworkKey: "ccss-ela" } }), 403, "forbidden");
    }
    expectError(await district.call(district.tokenFor(NF.amara), "admin.approveStandards", { params: { frameworkKey: "ccss-ela" } }), 403, "forbidden");
    expect(await district.app.catalog.approvedRelease("ccss-ela")).toBeUndefined();

    const admin = district.tokenFor(NF.admin);
    // NGSS text does not ship with EducateOS, so there is no built-in release to approve.
    expectError(await district.call(admin, "admin.approveStandards", { params: { frameworkKey: "ngss" } }), 409, "conflict");
    expectError(await district.call(admin, "admin.approveStandards", { params: { frameworkKey: "no-such-framework" } }), 404, "not-found");
    expectError(await district.call(admin, "admin.withdrawStandards", { params: { frameworkKey: "ccss-ela" } }), 409, "conflict");
  });
});

describe("a quiz in a class with no assignments (SCHO-220)", () => {
  it("publishes with its own gradebook assignment, which takes the attempt and the released grade", async () => {
    const clock = { now: new Date("2026-10-23T12:00:00Z") };
    const district = await bootDistrict(undefined, { standards: [], now: () => clock.now });
    const morgan = district.tokenFor(NF.morgan);
    const params = { offeringId: NF.bio };
    expect(await district.ok(morgan, "teacher.listAssignments", { params })).toEqual([]);

    const draft = await district.ok(morgan, "teacher.createQuiz", {
      params,
      body: { title: "Rock Cycle Check-in", items: [{ type: "multiple-choice", prompt: "Which rock forms when magma cools?", points: 1, choices: [{ id: "a", text: "Igneous" }, { id: "b", text: "Sedimentary" }], correctChoiceId: "a" }], settings: { attemptsAllowed: 2, shuffleQuestions: false, shuffleChoices: false, showAnswers: "after-release", scorePolicy: "best" } },
    });
    expect(draft.assignmentId).toBeUndefined();
    const quiz = await district.ok(morgan, "teacher.publishQuiz", { params: { ...params, quizId: draft.id }, body: { published: true } });
    expect(quiz).toMatchObject({ status: "published", assignmentId: expect.stringMatching(/^asg_/) });

    const assignments = await district.ok(morgan, "teacher.listAssignments", { params });
    expect(assignments.map((a) => [a.id, a.title, a.attemptsAllowed, a.permittedArtifactTypes])).toEqual([[quiz.assignmentId, "Rock Cycle Check-in", 2, ["evidence"]]]);
    // Due at the end of the fall term, since the quiz sets no close.
    expect(assignments[0]!.dueAt).toBe(`${district.directory.terms.find((t) => t.id === NF.fall)!.endsOn}T23:59:59.000Z`);
    // Unpublishing and publishing again keeps the one assignment.
    await district.ok(morgan, "teacher.publishQuiz", { params: { ...params, quizId: draft.id }, body: { published: false } });
    expect((await district.ok(morgan, "teacher.publishQuiz", { params: { ...params, quizId: draft.id }, body: { published: true } })).assignmentId).toBe(quiz.assignmentId);
    expect(await district.ok(morgan, "teacher.listAssignments", { params })).toHaveLength(1);

    // The student's activity list skips the quiz's assignment, which has no activity behind it.
    const amara = district.tokenFor(NF.amara);
    expect(await district.ok(amara, "student.listActivities", { params })).toEqual([]);
    const attempt = await district.ok(amara, "student.startQuizAttempt", { params: { ...params, quizId: quiz.id } });
    await district.ok(amara, "student.submitQuizAttempt", {
      params: { ...params, attemptId: attempt.attemptId },
      body: { answers: [{ itemId: quiz.items[0]!.id, response: { type: "multiple-choice", choiceId: "a" } }] },
    });
    expect(await district.ok(morgan, "teacher.releaseQuizScores", { params: { ...params, quizId: quiz.id }, body: {} })).toMatchObject({ official: 1 });
    const grades = await district.ok(amara, "student.officialGrades", { params: { assignmentId: quiz.assignmentId! } });
    expect(grades.map((g) => g.score)).toEqual([{ points: 1, maxPoints: 1 }]);
  });
});
