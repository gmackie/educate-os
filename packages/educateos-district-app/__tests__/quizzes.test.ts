// Quizzes (SCHO-191) through the district API: a teacher builds and publishes a quiz bound to an
// assignment, students take it on the server's clock, the teacher grades the essay and releases the
// scores in one action, and only then does the gradebook show them.
import { describe, expect, it } from "vitest";
import type { QuizItemDraft } from "@educateos/quizzes";
import { writeZip } from "@educateos/zip";
import { bootDistrict, expectError, NF, RB, RIVERBEND, teacherSetsUpEssay, type TestDistrict } from "./support.ts";

const ITEMS: QuizItemDraft[] = [
  { type: "multiple-choice", prompt: "Which device compares with *like* or *as*?", points: 2, choices: [{ id: "a", text: "Metaphor" }, { id: "b", text: "Simile" }], correctChoiceId: "b", feedback: "KEY-FEEDBACK" },
  { type: "short-answer", prompt: "Name the repetition of initial consonants.", points: 1, acceptedAnswers: ["alliteration-key"] },
  { type: "essay", prompt: "Explain the poem's turn.", points: 5 },
];

async function classWithQuiz(settings: Record<string, unknown> = {}) {
  const clock = { now: new Date("2026-10-23T12:00:00Z") };
  const district = await bootDistrict(undefined, { now: () => clock.now });
  const rivera = district.tokenFor(NF.rivera);
  const { assignment } = await teacherSetsUpEssay(district, rivera);
  const draft = await district.ok(rivera, "teacher.createQuiz", {
    params: { offeringId: NF.eng9 },
    body: { title: "Poetry terms", assignmentId: assignment.id, items: ITEMS, settings: { attemptsAllowed: 3, shuffleQuestions: false, shuffleChoices: false, showAnswers: "after-release", scorePolicy: "best", ...settings } },
  });
  const quiz = await district.ok(rivera, "teacher.publishQuiz", { params: { offeringId: NF.eng9, quizId: draft.id }, body: { published: true } });
  return { district, clock, rivera, assignment, quiz };
}

async function take(district: TestDistrict, token: string, quizId: string, answers: unknown[]) {
  const attempt = await district.ok(token, "student.startQuizAttempt", { params: { offeringId: NF.eng9, quizId } });
  await district.ok(token, "student.saveQuizAnswers", { params: { offeringId: NF.eng9, attemptId: attempt.attemptId }, body: { answers: answers.slice(0, 1) as never } });
  const result = await district.ok(token, "student.submitQuizAttempt", { params: { offeringId: NF.eng9, attemptId: attempt.attemptId }, body: { answers: answers.slice(1) as never } });
  return { attempt, result };
}

const answersFor = (quiz: { items: readonly { id: string }[] }, choice: string, short: string) => [
  { itemId: quiz.items[0]!.id, response: { type: "multiple-choice", choiceId: choice } },
  { itemId: quiz.items[1]!.id, response: { type: "short-answer", text: short } },
  { itemId: quiz.items[2]!.id, response: { type: "essay", text: "The turn comes at the volta." } },
];

describe("quizzes over HTTP (SCHO-191)", () => {
  it("readies the assignment, keeps keys from students, and shows scores in the gradebook only once released", async () => {
    const { district, rivera, assignment, quiz } = await classWithQuiz();
    // Publishing let the assignment take quiz answer sheets for every attempt.
    const { assignment: readied } = await district.ok(rivera, "teacher.getAssignment", { params: { assignmentId: assignment.id } });
    expect(readied.permittedArtifactTypes).toContain("evidence");
    expect(readied.attemptsAllowed).toBeGreaterThanOrEqual(3);

    const amara = district.tokenFor(NF.amara);
    const listed = await district.ok(amara, "student.listQuizzes", { params: { offeringId: NF.eng9 } });
    expect(listed.map((q) => [q.title, q.questionCount, q.totalPoints, q.canStart])).toEqual([["Poetry terms", 3, 8, true]]);
    const { attempt, result } = await take(district, amara, quiz.id, answersFor(quiz, "b", "Alliteration-KEY"));
    for (const body of [listed, attempt, result]) {
      expect(JSON.stringify(body)).not.toMatch(/correctChoiceId|acceptedAnswers|alliteration-key|KEY-FEEDBACK|correctResponse/);
    }
    expect(result).toMatchObject({ status: "submitted", answersShown: false, released: false });

    // The answer sheet is Amara's submission to the assignment; its score is not a grade yet.
    const submissions = await district.ok(rivera, "teacher.listSubmissions", { params: { assignmentId: assignment.id } });
    expect(submissions.map((s) => [s.studentPrincipalId, s.items[0]!.artifactType])).toEqual([[NF.amara, "evidence"]]);
    const column = (view: Awaited<ReturnType<typeof gradebook>>) => view.rows.find((r) => r.studentPrincipalId === NF.amara)!.cells.find((c) => c.assignmentId === assignment.id)!;
    const gradebook = () => district.ok(rivera, "teacher.gradebook", { params: { offeringId: NF.eng9 } });
    expect(column(await gradebook())).not.toHaveProperty("score");
    expect(await district.ok(amara, "student.officialGrades", { params: { assignmentId: assignment.id } })).toEqual([]);

    // The essay waits; nothing is released until it is graded.
    let results = await district.ok(rivera, "teacher.quizResults", { params: { offeringId: NF.eng9, quizId: quiz.id } });
    expect(results.students[0]).toMatchObject({ studentId: NF.amara, needsGrading: true });
    expect(results.names).toEqual([{ principalId: NF.amara, displayName: expect.any(String) }]);
    expect(await district.ok(rivera, "teacher.releaseQuizScores", { params: { offeringId: NF.eng9, quizId: quiz.id }, body: {} })).toMatchObject({ official: 0, waitingForGrading: 1 });
    const graded = await district.ok(rivera, "teacher.gradeQuizItem", { params: { offeringId: NF.eng9, attemptId: attempt.attemptId, itemId: quiz.items[2]!.id }, body: { points: 4 } });
    expect(graded.attempt.itemScores!.map((s) => s.points)).toEqual([2, 1, 4]);
    results = await district.ok(rivera, "teacher.quizResults", { params: { offeringId: NF.eng9, quizId: quiz.id } });
    expect(results.items.map((i) => i.percentCorrect)).toEqual([100, 100, 0]);

    // Release: one action, and the gradebook and the student now see 7/8.
    const released = await district.ok(rivera, "teacher.releaseQuizScores", { params: { offeringId: NF.eng9, quizId: quiz.id }, body: {} });
    expect(released).toMatchObject({ official: 1, pendingApproval: 0 });
    expect(column(await gradebook())).toMatchObject({ score: { points: 7, maxPoints: 8 }, version: 1 });
    const grades = await district.ok(amara, "student.officialGrades", { params: { assignmentId: assignment.id } });
    expect(grades.map((g) => [g.version, g.score, g.approval.approvedBy])).toEqual([[1, { points: 7, maxPoints: 8 }, NF.rivera]]);
    const shown = await district.ok(amara, "student.quizAttemptResult", { params: { offeringId: NF.eng9, attemptId: attempt.attemptId } });
    expect(shown).toMatchObject({ answersShown: true, released: true, releasedScore: { points: 7, maxPoints: 8 } });
    expect(shown.items[0]).toMatchObject({ correct: true, feedback: "KEY-FEEDBACK" });

    // A regrade is released again, as the next official version.
    await district.ok(rivera, "teacher.gradeQuizItem", { params: { offeringId: NF.eng9, attemptId: attempt.attemptId, itemId: quiz.items[2]!.id }, body: { points: 5, comment: "Full marks on review." } });
    await district.ok(rivera, "teacher.releaseQuizScores", { params: { offeringId: NF.eng9, quizId: quiz.id }, body: {} });
    expect(column(await gradebook())).toMatchObject({ score: { points: 8, maxPoints: 8 }, version: 2 });
  });

  it("sends a co-teacher's release to the teacher for approval, through the existing proposals", async () => {
    const { district, rivera, assignment, quiz } = await classWithQuiz();
    const { attempt } = await take(district, district.tokenFor(NF.amara), quiz.id, answersFor(quiz, "a", "rhyme"));
    const chen = district.tokenFor(NF.chen);
    await district.ok(chen, "teacher.gradeQuizItem", { params: { offeringId: NF.eng9, attemptId: attempt.attemptId, itemId: quiz.items[2]!.id }, body: { points: 3 } });
    expect(await district.ok(chen, "teacher.releaseQuizScores", { params: { offeringId: NF.eng9, quizId: quiz.id }, body: {} })).toMatchObject({ official: 0, pendingApproval: 1 });
    const [proposal] = await district.ok(rivera, "teacher.pendingGrades", { params: { assignmentId: assignment.id } });
    expect(proposal).toMatchObject({ studentPrincipalId: NF.amara, score: { points: 3, maxPoints: 8 }, proposedBy: NF.chen });
    await district.ok(rivera, "teacher.approveGrade", { params: { proposalId: proposal!.id } });
    expect((await district.ok(district.tokenFor(NF.amara), "student.officialGrades", { params: { assignmentId: assignment.id } })).map((g) => g.score.points)).toEqual([3]);
  });

  it("refuses a late submission on the server's clock, and an attempt beyond the limit", async () => {
    const { district, clock, quiz } = await classWithQuiz({ timeLimitMinutes: 5, attemptsAllowed: 1 });
    const amara = district.tokenFor(NF.amara);
    const attempt = await district.ok(amara, "student.startQuizAttempt", { params: { offeringId: NF.eng9, quizId: quiz.id } });
    expect(attempt.deadline).toBe("2026-10-23T12:05:00.000Z");
    clock.now = new Date("2026-10-23T12:05:01Z");
    expectError(await district.call(amara, "student.submitQuizAttempt", { params: { offeringId: NF.eng9, attemptId: attempt.attemptId }, body: { answers: [] } }), 403, "forbidden");
    expectError(await district.call(amara, "student.startQuizAttempt", { params: { offeringId: NF.eng9, quizId: quiz.id } }), 403, "forbidden");
    expect((await district.ok(amara, "student.getQuiz", { params: { offeringId: NF.eng9, quizId: quiz.id } })).attempts.map((a) => a.status)).toEqual(["expired"]);
  });

  it("keeps attempts to their student and quizzes to their class and district", async () => {
    const { district, quiz } = await classWithQuiz();
    const { attempt } = await take(district, district.tokenFor(NF.amara), quiz.id, answersFor(quiz, "b", "x"));
    const elena = district.tokenFor(NF.elena);
    const at = { offeringId: NF.eng9, attemptId: attempt.attemptId };
    expectError(await district.call(elena, "student.quizAttemptResult", { params: at }), 404, "not-found");
    expectError(await district.call(elena, "student.saveQuizAnswers", { params: at, body: { answers: [] } }), 404, "not-found");
    // Morgan teaches Biology, not English 9; an administrator oversees the quiz but not the attempt.
    expectError(await district.call(district.tokenFor(NF.morgan), "teacher.quizAttempt", { params: at }), 404, "not-found");
    expectError(await district.call(district.tokenFor(NF.morgan), "teacher.getQuiz", { params: { offeringId: NF.eng9, quizId: quiz.id } }), 404, "not-found");
    expectError(await district.call(district.tokenFor(NF.admin), "teacher.quizAttempt", { params: at }), 404, "not-found");
    expect((await district.ok(district.tokenFor(NF.admin), "teacher.getQuiz", { params: { offeringId: NF.eng9, quizId: quiz.id } })).id).toBe(quiz.id);
    expectError(await district.call(district.tokenFor(NF.admin), "teacher.releaseQuizScores", { params: { offeringId: NF.eng9, quizId: quiz.id }, body: {} }), 403, "forbidden");
    // A student never reaches the teacher's results.
    expectError(await district.call(elena, "teacher.quizResults", { params: { offeringId: NF.eng9, quizId: quiz.id } }), 403, "forbidden");
    const riverbend = await bootDistrict(RIVERBEND);
    expectError(await riverbend.call(riverbend.tokenFor(RB.student), "student.listQuizzes", { params: { offeringId: NF.eng9 } }), 404, "not-found");
    expectError(await riverbend.call(riverbend.tokenFor(RB.teacher), "teacher.getQuiz", { params: { offeringId: NF.eng9, quizId: quiz.id } }), 404, "not-found");
  });

  it("imports a cartridge's QTI assessment as a draft quiz in its module, listing the items it could not carry", async () => {
    const { district, rivera, assignment } = await classWithQuiz();
    const text = (content: string) => new TextEncoder().encode(content);
    const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="M1" xmlns="http://www.imsglobal.org/xsd/imsccv1p3/imscp_v1p1">
  <metadata><schema>IMS Common Cartridge</schema><schemaversion>1.3.0</schemaversion></metadata>
  <organizations><organization identifier="O1" structure="rooted-hierarchy"><item identifier="root">
    <item identifier="W1"><title>Week 1</title><item identifier="Q1" identifierref="R1"><title>Check-in</title></item></item>
  </item></organization></organizations>
  <resources><resource identifier="R1" type="imsqti_test_xmlv3p0"><file href="qti/test.xml"/></resource></resources>
</manifest>`;
    const test = `<qti-assessment-test identifier="T" title="Poetry check-in"><qti-test-part identifier="P"><qti-assessment-section identifier="S" title="S">
  <qti-assessment-item-ref identifier="tf" href="tf.xml"/><qti-assessment-item-ref identifier="order" href="order.xml"/>
</qti-assessment-section></qti-test-part></qti-assessment-test>`;
    const tf = `<qti-assessment-item identifier="tf" title="Sonnet"><qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="identifier"><qti-correct-response><qti-value>t</qti-value></qti-correct-response></qti-response-declaration>
<qti-item-body><qti-choice-interaction response-identifier="RESPONSE" max-choices="1"><qti-prompt>A sonnet has fourteen lines.</qti-prompt><qti-simple-choice identifier="t">True</qti-simple-choice><qti-simple-choice identifier="f">False</qti-simple-choice></qti-choice-interaction></qti-item-body></qti-assessment-item>`;
    const order = `<qti-assessment-item identifier="order" title="Order"><qti-item-body><qti-order-interaction response-identifier="RESPONSE"><qti-simple-choice identifier="a">A</qti-simple-choice><qti-simple-choice identifier="b">B</qti-simple-choice></qti-order-interaction></qti-item-body></qti-assessment-item>`;
    const bytes = await writeZip([
      { path: "imsmanifest.xml", bytes: text(manifest) },
      { path: "qti/test.xml", bytes: text(test) },
      { path: "qti/tf.xml", bytes: text(tf) },
      { path: "qti/order.xml", bytes: text(order) },
    ]);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const upload = { fileName: "poetry.imscc", base64: btoa(binary) };
    const preview = await district.ok(rivera, "teacher.previewCartridge", { params: { offeringId: NF.eng9 }, body: upload });
    expect(preview.modules).toEqual([{ title: "Week 1", items: [], quizzes: [{ title: "Poetry check-in", questions: 1 }] }]);
    expect(preview.skipped).toEqual([{ identifier: "Q1/order", reason: "unsupported-qti-item", type: "orderInteraction" }]);
    const imported = await district.ok(rivera, "teacher.importCartridge", { params: { offeringId: NF.eng9 }, body: { ...upload, packageDigest: preview.packageDigest } });
    expect(imported.quizzes).toMatchObject([{ title: "Poetry check-in", status: "draft", moduleId: imported.modules[0]!.id, items: [{ type: "true-false", correct: true }], source: { kind: "cartridge", identifier: "Q1" } }]);
    // A draft until the teacher binds it to an assignment and publishes it; students see nothing yet.
    const quizId = imported.quizzes![0]!.id;
    expect((await district.ok(district.tokenFor(NF.amara), "student.listQuizzes", { params: { offeringId: NF.eng9 } })).map((q) => q.id)).not.toContain(quizId);
    await district.ok(rivera, "teacher.updateQuiz", { params: { offeringId: NF.eng9, quizId }, body: { assignmentId: assignment.id } });
    expect((await district.ok(rivera, "teacher.publishQuiz", { params: { offeringId: NF.eng9, quizId }, body: { published: true } })).status).toBe("published");
    // An export says the quiz stayed behind: cartridges carry no quizzes yet.
    const exported = await district.ok(rivera, "teacher.exportCartridge", { params: { offeringId: NF.eng9 } });
    expect(exported.losses).toContainEqual({ kind: "quiz", module: imported.modules[0]!.id, item: quizId });
  });
});
