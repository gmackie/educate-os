import { describe, expect, it } from "vitest";
import { OfferingId } from "@educateos/contracts";
import { StudentAttemptResult, StudentAttemptView, StudentQuizView } from "../src/index.ts";
import {
  ADMIN,
  AMARA,
  ASSIGNMENT,
  BIO,
  BIO_SPRING,
  CHEN,
  CHIDI,
  code,
  DMITRI,
  ELENA,
  ENG9,
  ENG_ASSIGNMENT,
  ITEMS,
  KAI,
  message,
  MORGAN,
  publishedQuiz,
  RIGHT,
  RIVERA,
  setup,
  T0,
} from "./helpers.ts";

const MINUTE = 60_000;

describe("building quizzes (SCHO-191)", () => {
  it("lets the teacher build a draft, give its items IDs, and publish it once it is bound to an assignment", async () => {
    const { service, prepared } = setup();
    const draft = await service.createQuiz(MORGAN, BIO, { title: "Cells", items: [{ type: "true-false", prompt: "Cells divide.", points: 1, correct: true }] });
    expect(draft).toMatchObject({ status: "draft", settings: { attemptsAllowed: 1, showAnswers: "after-release", scorePolicy: "best" } });
    expect(draft.items[0]!.id).toMatch(/^qzi_/);
    // Students see no draft.
    expect(await service.listQuizzes(AMARA, BIO)).toEqual({ view: "student", quizzes: [] });
    expect(await message(service.setPublished(MORGAN, BIO, draft.id, { published: true }))).toMatch(/needs an assignment/);
    await service.updateQuiz(MORGAN, BIO, draft.id, { assignmentId: ASSIGNMENT, settings: { attemptsAllowed: 3, shuffleQuestions: true, shuffleChoices: true, showAnswers: "after-submit", scorePolicy: "latest" } });
    const published = await service.setPublished(MORGAN, BIO, draft.id, { published: true });
    expect(published.status).toBe("published");
    // Publishing readies the assignment to take every attempt as a submission.
    expect(prepared).toEqual([{ assignmentId: ASSIGNMENT, attemptsAllowed: 3 }]);
    const listing = await service.listQuizzes(AMARA, BIO);
    expect(listing.view === "student" && listing.quizzes.map((q) => [q.courseTitle, q.title, q.questionCount, q.availability, q.canStart])).toEqual([["Biology I", "Cells", 1, "open", true]]);
  });

  it("binds quizzes only to the class's own assignments and modules, and keeps a draft module's quiz from students", async () => {
    const { service, courseContent } = setup();
    await courseContent.commit({
      offeringId: OfferingId.parse(BIO),
      revision: 1,
      modules: [{ id: "cmod_draft", title: "Unit 2", published: false, items: [] }],
      pages: [],
    }, 0);
    expect(await code(service.createQuiz(MORGAN, BIO, { title: "Q", assignmentId: ENG_ASSIGNMENT }))).toBe("validation-failed");
    expect(await code(service.createQuiz(MORGAN, BIO, { title: "Q", moduleId: "cmod_other" }))).toBe("validation-failed");
    const quiz = await publishedQuiz(service);
    await service.updateQuiz(MORGAN, BIO, quiz.id, { moduleId: "cmod_draft" });
    expect(await service.listQuizzes(AMARA, BIO)).toEqual({ view: "student", quizzes: [] });
    expect(await code(service.startAttempt(AMARA, BIO, quiz.id))).toBe("not-found");
    expect(await code(service.updateQuiz(MORGAN, BIO, quiz.id, { assignmentId: null }))).toBe("validation-failed");
  });

  it("locks the questions once a student starts, but not the settings, and refuses deleting an attempted quiz", async () => {
    const { service } = setup();
    const quiz = await publishedQuiz(service);
    await service.startAttempt(AMARA, BIO, quiz.id);
    // An attempt in progress already locks the questions, and the listing says so.
    expect(await service.listQuizzes(MORGAN, BIO)).toMatchObject({ quizzes: [{ started: 1, submitted: 0 }] });
    expect(await code(service.updateQuiz(MORGAN, BIO, quiz.id, { items: [ITEMS.tf] }))).toBe("conflict");
    const changed = await service.updateQuiz(MORGAN, BIO, quiz.id, { title: "Cells quiz (v2)", settings: { ...quiz.settings, attemptsAllowed: 1 } });
    expect(changed.items).toEqual(quiz.items);
    expect(await code(service.deleteQuiz(MORGAN, BIO, quiz.id))).toBe("conflict");
    const spare = await service.createQuiz(MORGAN, BIO, { title: "Spare" });
    await service.deleteQuiz(MORGAN, BIO, spare.id);
    expect(await code(service.getQuiz(MORGAN, BIO, spare.id))).toBe("not-found");
  });

  it("refuses quiz management to students, other teachers and administrators, who still read it for oversight", async () => {
    const { service } = setup();
    const quiz = await publishedQuiz(service);
    expect(await code(service.createQuiz(AMARA, BIO, { title: "Mine" }))).toBe("forbidden");
    expect(await code(service.updateQuiz(ELENA, BIO, quiz.id, { title: "Mine" }))).toBe("forbidden");
    expect(await code(service.getQuiz(AMARA, BIO, quiz.id))).toBe("not-found");
    expect(await code(service.createQuiz(RIVERA, BIO, { title: "Not my class" }))).toBe("not-found");
    expect(await code(service.createQuiz(ADMIN, BIO, { title: "Oversight" }))).toBe("forbidden");
    expect((await service.getQuiz(ADMIN, BIO, quiz.id)).items).toHaveLength(6);
    expect(await service.listQuizzes(ADMIN, BIO)).toMatchObject({ view: "staff", canManage: false });
    expect(await code(service.results(ADMIN, BIO, quiz.id))).toBe("not-found");
    expect(await code(service.release(ADMIN, BIO, quiz.id))).toBe("forbidden");
    expect(await code(service.listQuizzes(CHIDI, BIO))).toBe("not-found");
    expect(await code(service.listQuizzes(KAI, BIO))).toBe("not-found");
    expect(await code(service.listQuizzes(DMITRI, ENG9))).toBe("not-found");
  });
});

describe("taking a quiz (SCHO-191)", () => {
  it("never sends a student an answer key before the quiz shows it", async () => {
    const { service } = setup();
    const quiz = await publishedQuiz(service, { shuffleQuestions: true, shuffleChoices: true });
    const keys = ["correctChoiceId", "correctChoiceIds", "acceptedAnswers", "pattern", "tolerance", "\"answer\"", "\"correct\"", "SECRET-FEEDBACK", "photosynthesis", "correctResponse", "feedback"];
    const listing = await service.listQuizzes(AMARA, BIO);
    const view = await service.studentQuiz(AMARA, BIO, quiz.id);
    const attempt = await service.startAttempt(AMARA, BIO, quiz.id);
    await service.saveAnswers(AMARA, BIO, attempt.attemptId, { answers: [RIGHT[0]] });
    const resumed = await service.attempt(AMARA, BIO, attempt.attemptId);
    const result = await service.submitAttempt(AMARA, BIO, attempt.attemptId, { answers: RIGHT.slice(1) });
    for (const payload of [listing, view, attempt, resumed, result]) {
      const json = JSON.stringify(payload);
      for (const key of keys) expect(json, key).not.toContain(key);
    }
    // Each is exactly its key-free student schema, with nothing extra.
    expect(StudentQuizView.parse(view)).toEqual(view);
    expect(StudentAttemptView.parse(attempt)).toEqual(attempt);
    expect(StudentAttemptResult.parse(result)).toEqual(result);
    expect(result).toMatchObject({ answersShown: false, released: false });
    expect(result.items.every((i) => i.points === undefined && i.correct === undefined)).toBe(true);
  });

  it("shows each attempt its own deterministic order of questions and choices", async () => {
    const { service } = setup();
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `qzi_q${i}`, type: "multiple-choice" as const, prompt: `Q${i}`, points: 1, choices: ["a", "b", "c", "d", "e"].map((id) => ({ id, text: id })), correctChoiceId: "a" }));
    const quiz = await publishedQuiz(service, { shuffleQuestions: true, shuffleChoices: true }, many);
    const amara = await service.startAttempt(AMARA, BIO, quiz.id);
    const elena = await service.startAttempt(ELENA, BIO, quiz.id);
    const order = (v: typeof amara) => v.questions.map((q) => q.id);
    expect(order(await service.attempt(AMARA, BIO, amara.attemptId))).toEqual(order(amara));
    expect((await service.attempt(AMARA, BIO, amara.attemptId)).questions[0]!.choices).toEqual(amara.questions[0]!.choices);
    expect(order(amara).toSorted()).toEqual(many.map((i) => i.id).toSorted());
    expect([order(amara), amara.questions.map((q) => q.choices!.map((c) => c.id).join(""))]).not.toEqual([order(elena), elena.questions.map((q) => q.choices!.map((c) => c.id).join(""))]);
  });

  it("starts attempts only in the window, fixes the deadline on the server's clock, and refuses saving or submitting after it", async () => {
    const { service, advance, sheets } = setup();
    const opens = new Date(T0 + 60 * MINUTE).toISOString();
    const closes = new Date(T0 + 120 * MINUTE).toISOString();
    const quiz = await publishedQuiz(service, { timeLimitMinutes: 45, availableFrom: opens, availableUntil: closes, attemptsAllowed: 3 });
    expect(await message(service.startAttempt(AMARA, BIO, quiz.id))).toBe("This quiz is not open yet.");
    expect((await service.studentQuiz(AMARA, BIO, quiz.id))).toMatchObject({ availability: "upcoming", canStart: false });

    advance(60 * MINUTE);
    const first = await service.startAttempt(AMARA, BIO, quiz.id);
    expect(first.deadline).toBe(new Date(T0 + 105 * MINUTE).toISOString());
    expect(first.serverNow).toBe(opens);
    // Starting again resumes the attempt in progress.
    expect((await service.startAttempt(AMARA, BIO, quiz.id)).attemptId).toBe(first.attemptId);
    advance(46 * MINUTE);
    expect(await code(service.saveAnswers(AMARA, BIO, first.attemptId, { answers: [RIGHT[0]] }))).toBe("forbidden");
    expect(await message(service.submitAttempt(AMARA, BIO, first.attemptId))).toMatch(/Time is up/);
    expect(sheets).toHaveLength(0);
    expect((await service.studentQuiz(AMARA, BIO, quiz.id)).attempts.map((a) => a.status)).toEqual(["expired"]);

    // A second attempt late in the window ends when the quiz closes, not 45 minutes on.
    const second = await service.startAttempt(AMARA, BIO, quiz.id);
    expect(second.deadline).toBe(closes);
    advance(10 * MINUTE);
    await service.submitAttempt(AMARA, BIO, second.attemptId, { answers: [RIGHT[0]] });
    expect(sheets).toHaveLength(1);
    advance(5 * MINUTE);
    expect(await message(service.startAttempt(AMARA, BIO, quiz.id))).toBe("This quiz is closed.");
  });

  it("caps attempts, counting one whose time ran out", async () => {
    const { service, advance } = setup();
    const quiz = await publishedQuiz(service, { timeLimitMinutes: 10, attemptsAllowed: 2 });
    const first = await service.startAttempt(AMARA, BIO, quiz.id);
    advance(11 * MINUTE);
    const second = await service.startAttempt(AMARA, BIO, quiz.id);
    expect(second.number).toBe(2);
    await service.submitAttempt(AMARA, BIO, second.attemptId, { answers: RIGHT });
    expect(await message(service.startAttempt(AMARA, BIO, quiz.id))).toBe("You have used every attempt this quiz allows.");
    expect((await service.studentQuiz(AMARA, BIO, quiz.id)).canStart).toBe(false);
    expect(await code(service.attemptResult(AMARA, BIO, first.attemptId))).toBe("resolved");
  });

  it("submits the answer sheet as the student's work, and refuses answers that don't fit their questions", async () => {
    const { service, sheets } = setup();
    const quiz = await publishedQuiz(service);
    const attempt = await service.startAttempt(AMARA, BIO, quiz.id);
    expect(await code(service.saveAnswers(AMARA, BIO, attempt.attemptId, { answers: [{ itemId: "qzi_mc", response: { type: "multiple-choice", choiceId: "zzz" } }] }))).toBe("validation-failed");
    expect(await code(service.saveAnswers(AMARA, BIO, attempt.attemptId, { answers: [{ itemId: "qzi_mc", response: { type: "true-false", value: true } }] }))).toBe("validation-failed");
    expect(await code(service.saveAnswers(AMARA, BIO, attempt.attemptId, { answers: [{ itemId: "qzi_nope", response: { type: "true-false", value: true } }] }))).toBe("validation-failed");
    const saved = await service.saveAnswers(AMARA, BIO, attempt.attemptId, { answers: [RIGHT[0], RIGHT[2]] });
    expect(saved.savedAt).toBeDefined();
    await service.saveAnswers(AMARA, BIO, attempt.attemptId, { answers: [{ itemId: "qzi_tf", response: { type: "true-false", value: true } }] });
    expect((await service.attempt(AMARA, BIO, attempt.attemptId)).answers.map((a) => a.itemId)).toEqual(["qzi_mc", "qzi_tf"]);
    const result = await service.submitAttempt(AMARA, BIO, attempt.attemptId);
    expect(result.status).toBe("submitted");
    expect(sheets).toHaveLength(1);
    expect(sheets[0]).toMatchObject({ subject: AMARA.principalId, assignmentId: ASSIGNMENT });
    expect(sheets[0]!.sheet.text).toContain("Mitochondrion");
    expect(sheets[0]!.sheet.text).not.toContain("SECRET-FEEDBACK");
    // Submitting twice returns the same result and submits nothing more.
    expect(await service.submitAttempt(AMARA, BIO, attempt.attemptId)).toEqual(result);
    expect(sheets).toHaveLength(1);
    expect(await code(service.saveAnswers(AMARA, BIO, attempt.attemptId, { answers: [RIGHT[0]] }))).toBe("conflict");
  });

  it("takes no more answers once the teacher takes the quiz back", async () => {
    const { service } = setup();
    const quiz = await publishedQuiz(service);
    const attempt = await service.startAttempt(AMARA, BIO, quiz.id);
    await service.setPublished(MORGAN, BIO, quiz.id, { published: false });
    expect(await code(service.saveAnswers(AMARA, BIO, attempt.attemptId, { answers: [RIGHT[0]] }))).toBe("not-found");
    expect(await code(service.submitAttempt(AMARA, BIO, attempt.attemptId))).toBe("not-found");
    expect(await code(service.attempt(AMARA, BIO, attempt.attemptId))).toBe("not-found");
  });

  it("keeps attempts their student's: another student, another offering or another district finds nothing", async () => {
    const { service } = setup();
    const quiz = await publishedQuiz(service);
    const attempt = await service.startAttempt(AMARA, BIO, quiz.id);
    for (const promise of [
      service.attempt(ELENA, BIO, attempt.attemptId),
      service.saveAnswers(ELENA, BIO, attempt.attemptId, { answers: [RIGHT[0]] }),
      service.submitAttempt(ELENA, BIO, attempt.attemptId),
      service.attemptResult(ELENA, BIO, attempt.attemptId),
      service.startAttempt(CHIDI, BIO, quiz.id),
      service.startAttempt(KAI, BIO, quiz.id),
      service.attempt(AMARA, ENG9, attempt.attemptId),
      service.staffAttempt(RIVERA, BIO, attempt.attemptId),
      service.staffAttempt(ADMIN, BIO, attempt.attemptId),
    ]) expect(await code(promise)).toBe("not-found");
    // Staff never take or submit a student's attempt.
    expect(await code(service.submitAttempt(MORGAN, BIO, attempt.attemptId))).toBe("not-found");
  });

  it("freezes a completed term's quizzes", async () => {
    const { service } = setup();
    expect(await code(service.createQuiz(MORGAN, BIO_SPRING, { title: "Too late" }))).toBe("forbidden");
  });

  it("lets a student who left the class read their finished attempts, but start nothing", async () => {
    const { service, storage } = setup();
    // Dmitri dropped English 9. An attempt he submitted before he left is in the store.
    const quiz = await service.createQuiz(RIVERA, ENG9, { title: "Poetry", assignmentId: ENG_ASSIGNMENT, items: [ITEMS.tf] });
    await service.setPublished(RIVERA, ENG9, quiz.id, { published: true });
    const book = (await storage.load(OfferingId.parse(ENG9)))!;
    const at = new Date(T0).toISOString();
    await storage.commit(OfferingId.parse(ENG9), {
      revision: book.revision + 1,
      quizzes: [],
      deletedQuizIds: [],
      attempts: [{
        id: "qza_dmitri1", quizId: quiz.id, offeringId: OfferingId.parse(ENG9), studentId: DMITRI.principalId, number: 1, seed: "0123456789abcdef",
        startedAt: at, answers: [RIGHT[2]], status: "submitted", submittedAt: at, submissionId: "sub_dmitri1",
        itemScores: [{ itemId: "qzi_tf", points: 1, maxPoints: 1, source: "auto" }],
      }],
      releases: [],
    }, book.revision);
    expect(await code(service.startAttempt(DMITRI, ENG9, quiz.id))).toBe("not-found");
    expect(await code(service.listQuizzes(DMITRI, ENG9))).toBe("not-found");
    expect((await service.attemptResult(DMITRI, ENG9, "qza_dmitri1")).items[0]!.response).toEqual(RIGHT[2].response);
    expect(await code(service.attemptResult(AMARA, ENG9, "qza_dmitri1"))).toBe("not-found");
  });
});

describe("grading and releasing scores (SCHO-191)", () => {
  async function submittedBy(service: ReturnType<typeof setup>["service"], quizId: string, who: typeof AMARA, answers: readonly unknown[] = RIGHT) {
    const attempt = await service.startAttempt(who, BIO, quizId);
    await service.submitAttempt(who, BIO, attempt.attemptId, { answers });
    return attempt.attemptId;
  }

  it("scores on submission, queues essays, and shows item analysis to staff only", async () => {
    const { service } = setup();
    const quiz = await publishedQuiz(service);
    const amara = await submittedBy(service, quiz.id, AMARA);
    await submittedBy(service, quiz.id, ELENA, [{ itemId: "qzi_mc", response: { type: "multiple-choice", choiceId: "a" } }, RIGHT[1]]);
    const results = await service.results(MORGAN, BIO, quiz.id);
    expect(results.students.map((s) => [s.studentId, s.attempts[0]!.points, s.needsGrading, s.score])).toEqual([
      [AMARA.principalId, null, true, undefined],
      [ELENA.principalId, null, true, undefined],
    ]);
    expect(results.items.map((i) => [i.itemId, i.percentCorrect, i.graded])).toEqual([
      ["qzi_mc", 50, 2], ["qzi_ms", 100, 2], ["qzi_tf", 50, 2], ["qzi_num", 50, 2], ["qzi_short", 50, 2], ["qzi_essay", null, 0],
    ]);
    expect(results.releasable).toBe(0);
    const { attempt } = await service.staffAttempt(MORGAN, BIO, amara);
    expect(attempt.itemScores!.map((s) => s.points)).toEqual([2, 3, 1, 1, 1, null]);
    expect(await code(service.results(AMARA, BIO, quiz.id))).toBe("not-found");
    expect(await code(service.staffAttempt(AMARA, BIO, amara))).toBe("not-found");
  });

  it("releases fully graded scores as one action, and releases a regrade as a new version", async () => {
    const { service, recorded } = setup();
    const quiz = await publishedQuiz(service);
    const amara = await submittedBy(service, quiz.id, AMARA);
    const elena = await submittedBy(service, quiz.id, ELENA);
    expect(await code(service.gradeItem(AMARA, BIO, amara, "qzi_essay", { points: 5 }))).toBe("forbidden");
    expect(await code(service.gradeItem(MORGAN, BIO, amara, "qzi_essay", { points: 6 }))).toBe("validation-failed");
    await service.gradeItem(MORGAN, BIO, amara, "qzi_essay", { points: 4, comment: "Name the membrane." });

    // Elena's essay still waits, so only Amara's score goes out.
    const first = await service.release(MORGAN, BIO, quiz.id);
    expect(first).toMatchObject({ official: 1, pendingApproval: 0, unchanged: 0, waitingForGrading: 1 });
    expect(recorded).toEqual([{ subject: MORGAN.principalId, grades: [{ submissionId: `sub_${amara.slice(4)}`, points: 12, maxPoints: 13 }] }]);

    await service.gradeItem(MORGAN, BIO, elena, "qzi_essay", { points: 5 });
    const second = await service.release(MORGAN, BIO, quiz.id);
    expect(second).toMatchObject({ official: 1, unchanged: 1, waitingForGrading: 0 });
    expect(recorded[1]!.grades.map((g) => g.points)).toEqual([13]);

    // Nothing new: no release at all.
    expect(await service.release(MORGAN, BIO, quiz.id)).toEqual({ official: 0, pendingApproval: 0, unchanged: 2, waitingForGrading: 0 });
    // A rescore is released again, as the next version.
    await service.gradeItem(MORGAN, BIO, amara, "qzi_essay", { points: 5 });
    const third = await service.release(MORGAN, BIO, quiz.id);
    expect(third.release!.grades).toEqual([expect.objectContaining({ studentId: AMARA.principalId, points: 13, outcome: "official", version: 2 })]);
    expect((await service.results(MORGAN, BIO, quiz.id)).releases).toHaveLength(3);
  });

  it("picks each student's best or latest attempt by the quiz's policy", async () => {
    const { service, recorded } = setup();
    const quiz = await publishedQuiz(service, { attemptsAllowed: 2 }, [ITEMS.mc, ITEMS.tf]);
    await submittedBy(service, quiz.id, AMARA, [RIGHT[0], RIGHT[2]]);
    await submittedBy(service, quiz.id, AMARA, [RIGHT[0]]);
    await service.release(MORGAN, BIO, quiz.id);
    expect(recorded[0]!.grades.map((g) => g.points)).toEqual([3]);
    await service.updateQuiz(MORGAN, BIO, quiz.id, { settings: { ...quiz.settings, scorePolicy: "latest" } });
    await service.release(MORGAN, BIO, quiz.id);
    expect(recorded[1]!.grades.map((g) => g.points)).toEqual([2]);
  });

  it("shows answers after submission, after release, or never, as the quiz says", async () => {
    for (const [showAnswers, afterSubmit, afterRelease] of [["after-submit", true, true], ["after-release", false, true], ["never", false, false]] as const) {
      const { service } = setup();
      const quiz = await publishedQuiz(service, { showAnswers }, [ITEMS.mc, ITEMS.short]);
      const attemptId = await submittedBy(service, quiz.id, AMARA, [{ itemId: "qzi_mc", response: { type: "multiple-choice", choiceId: "a" } }]);
      const submitted = await service.attemptResult(AMARA, BIO, attemptId);
      expect(submitted.answersShown, showAnswers).toBe(afterSubmit);
      await service.release(MORGAN, BIO, quiz.id);
      const released = await service.attemptResult(AMARA, BIO, attemptId);
      expect(released.answersShown, showAnswers).toBe(afterRelease);
      expect(released.releasedScore).toEqual({ points: 0, maxPoints: 3 });
      if (afterRelease) {
        expect(released.items[0]).toMatchObject({ points: 0, correct: false, correctResponse: { type: "multiple-choice", choiceId: "b" }, feedback: "SECRET-FEEDBACK: the powerhouse." });
      } else {
        expect(JSON.stringify(released)).not.toContain("SECRET-FEEDBACK");
      }
    }
  });

  it("sends a co-teacher's release to the gate, which holds it for the teacher; the next release sends it again", async () => {
    const { service, recorded } = setup();
    const quiz = await service.createQuiz(RIVERA, ENG9, { title: "Poetry", assignmentId: ENG_ASSIGNMENT, items: [ITEMS.tf] });
    await service.setPublished(CHEN, ENG9, quiz.id, { published: true });
    const attempt = await service.startAttempt(AMARA, ENG9, quiz.id);
    await service.submitAttempt(AMARA, ENG9, attempt.attemptId, { answers: [RIGHT[2]] });
    expect(await service.release(CHEN, ENG9, quiz.id)).toMatchObject({ official: 0, pendingApproval: 1 });
    expect((await service.attemptResult(AMARA, ENG9, attempt.attemptId)).released).toBe(false);
    expect(await service.release(RIVERA, ENG9, quiz.id)).toMatchObject({ official: 1, pendingApproval: 0 });
    expect(recorded.map((r) => r.subject)).toEqual([CHEN.principalId, RIVERA.principalId]);
  });
});
