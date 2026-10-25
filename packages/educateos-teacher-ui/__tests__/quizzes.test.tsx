// SCHO-191: a teacher builds a quiz from items, binds it to an assignment and publishes it, reads
// the results with item analysis, grades an essay, and releases the scores once, after confirming.
import { screen, waitFor, within } from "@testing-library/dom";
import { describe, expect, it } from "vitest";
import { DistrictApiError, type DistrictApiClient, type RouteName } from "@educateos/api-client";
import { fakeDistrict, IDS } from "./fakeDistrict.ts";
import { onScreen, renderApp, settle } from "./render.tsx";

const AT = "2026-10-21T15:00:00.000Z";
const QUIZ = "qz_poetry";
const ATTEMPT = "qza_amara1";

type Body = Record<string, unknown>;
type Input = { params?: Record<string, string>; body?: Body };

const SETTINGS = { attemptsAllowed: 1, shuffleQuestions: false, shuffleChoices: false, showAnswers: "after-release", scorePolicy: "best" };
const ITEMS = [
  { id: "qzi_mc", type: "multiple-choice", prompt: "Which compares with like or as?", points: 2, choices: [{ id: "c1", text: "Metaphor" }, { id: "c2", text: "Simile" }], correctChoiceId: "c2" },
  { id: "qzi_essay", type: "essay", prompt: "Explain the poem's turn.", points: 5 },
];

/** The base fake district with quizzes: one published quiz with a submitted attempt whose essay waits. */
function withQuizzes() {
  const base = fakeDistrict();
  let counter = 0;
  const quizzes: Body[] = [{
    id: QUIZ, offeringId: IDS.offering, title: "Poetry terms", description: "", assignmentId: IDS.existingAssignment, items: ITEMS, settings: SETTINGS,
    status: "published", createdBy: IDS.teacher, createdAt: AT, updatedAt: AT,
  }];
  const scores = [
    { itemId: "qzi_mc", points: 2, maxPoints: 2, source: "auto" },
    { itemId: "qzi_essay", points: null as number | null, maxPoints: 5, source: "auto" } as Body & { points: number | null },
  ];
  const attempt = {
    id: ATTEMPT, quizId: QUIZ, offeringId: IDS.offering, studentId: IDS.amara, number: 1, seed: "0123456789abcdef", startedAt: AT,
    answers: [{ itemId: "qzi_mc", response: { type: "multiple-choice", choiceId: "c2" } }, { itemId: "qzi_essay", response: { type: "essay", text: "The volta turns it." } }],
    status: "submitted", submittedAt: AT, submissionId: "sub_1", itemScores: scores,
  };
  const releases: Body[] = [];
  const graded = () => scores.every((s) => s.points !== null);
  const total = () => scores.reduce((sum, s) => sum + (s.points ?? 0), 0);
  const handlers: Partial<Record<RouteName, (input: Input) => unknown>> = {
    "teacher.listQuizzes": () => ({ canManage: true, quizzes: quizzes.map((quiz) => ({ quiz, started: quiz.id === QUIZ ? 1 : 0, submitted: quiz.id === QUIZ ? 1 : 0, needsGrading: quiz.id === QUIZ && !graded() ? 1 : 0 })) }),
    "teacher.createQuiz": ({ body }) => {
      const quiz = { id: `qz_new${++counter}`, offeringId: IDS.offering, description: "", items: [], settings: SETTINGS, status: "draft", createdBy: IDS.teacher, createdAt: AT, updatedAt: AT, ...body };
      quizzes.push(quiz);
      return quiz;
    },
    "teacher.getQuiz": ({ params }) => quizzes.find((q) => q.id === params!.quizId),
    "teacher.updateQuiz": ({ params, body }) => {
      const quiz = quizzes.find((q) => q.id === params!.quizId)!;
      const { items, assignmentId, moduleId, ...rest } = body!;
      Object.assign(quiz, rest, { updatedAt: `2026-10-21T15:0${++counter}:00.000Z` });
      if (items !== undefined) quiz.items = (items as Body[]).map((item, i) => ({ id: `qzi_${i}`, ...item }));
      if (assignmentId === null) delete quiz.assignmentId;
      else if (assignmentId !== undefined) quiz.assignmentId = assignmentId;
      if (moduleId !== null && moduleId !== undefined) quiz.moduleId = moduleId;
      return quiz;
    },
    "teacher.publishQuiz": ({ params, body }) => Object.assign(quizzes.find((q) => q.id === params!.quizId)!, { status: body!.published ? "published" : "draft" }),
    "teacher.deleteQuiz": ({ params }) => {
      quizzes.splice(quizzes.findIndex((q) => q.id === params!.quizId), 1);
      return { deleted: true };
    },
    "teacher.quizResults": () => {
      const last = releases.at(-1) as { at: string; grades: Body[] } | undefined;
      const released = last?.grades[0] as { points: number } | undefined;
      return {
        quiz: quizzes[0],
        students: [{
          studentId: IDS.amara,
          attempts: [{ id: ATTEMPT, number: 1, status: "submitted", submittedAt: AT, points: graded() ? total() : null, maxPoints: 7 }],
          ...(graded() ? { gradedAttemptId: ATTEMPT, score: { points: total(), maxPoints: 7 } } : {}),
          needsGrading: !graded(),
          ...(released === undefined ? {} : { released: { points: released.points, maxPoints: 7, outcome: "official", at: last!.at, current: released.points === total() } }),
        }],
        items: [
          { itemId: "qzi_mc", responses: 2, correct: 1, graded: 2, percentCorrect: 50, meanPoints: 1 },
          { itemId: "qzi_essay", responses: 1, correct: 0, graded: graded() ? 1 : 0, percentCorrect: graded() ? 0 : null, meanPoints: graded() ? scores[1]!.points : null },
        ],
        releases,
        releasable: graded() && released?.points !== total() ? 1 : 0,
        names: [{ principalId: IDS.amara, displayName: "Amara Okafor" }],
      };
    },
    "teacher.quizAttempt": () => ({ quiz: quizzes[0], attempt, studentName: "Amara Okafor" }),
    "teacher.gradeQuizItem": ({ params, body }) => {
      Object.assign(scores.find((s) => s.itemId === params!.itemId)!, { points: body!.points, source: "teacher", ...(body!.comment === undefined ? {} : { comment: body!.comment }) });
      return { quiz: quizzes[0], attempt, studentName: "Amara Okafor" };
    },
    "teacher.releaseQuizScores": () => {
      const release = { id: `qzr_${++counter}`, quizId: QUIZ, by: IDS.teacher, at: AT, grades: [{ studentId: IDS.amara, attemptId: ATTEMPT, submissionId: "sub_1", points: total(), maxPoints: 7, outcome: "official", version: releases.length + 1 }] };
      releases.push(release);
      return { release, official: 1, pendingApproval: 0, unchanged: 0, waitingForGrading: 0 };
    },
  };
  const failures = new Map<RouteName, { status: number; body: ConstructorParameters<typeof DistrictApiError>[1] }>();
  const client: DistrictApiClient = {
    call: (async (name: RouteName, input: Input = {}) => {
      const handler = handlers[name];
      if (handler === undefined) return base.client.call(name as never, input as never);
      base.calls.push({ name, input });
      const failure = failures.get(name);
      if (failure !== undefined) throw new DistrictApiError(failure.status, failure.body);
      return structuredClone(handler(input));
    }) as DistrictApiClient["call"],
  };
  /** Makes a quiz route fail from now on. */
  const fail = (name: RouteName, failure: { status: number; body: ConstructorParameters<typeof DistrictApiError>[1] }) => void failures.set(name, failure);
  return { ...base, client, quizzes, scores, fail };
}

const list = `#/classes/${IDS.offering}/quizzes`;

describe("class quizzes", () => {
  it("lists the class's quizzes with what needs the teacher", async () => {
    await renderApp(withQuizzes().client, list);
    await onScreen("Quizzes · English 9 · Period 3");
    const table = await screen.findByRole("table", { name: "Quizzes" });
    const row = within(table).getByRole("row", { name: /Poetry terms/ });
    expect(within(row).getByText("Published")).toBeTruthy();
    expect(within(row).getByRole("link", { name: "Results for Poetry terms" }).getAttribute("href")).toBe(`${list}/${QUIZ}/results`);
  });

  it("builds a quiz from items, binds it to an assignment, and publishes it", async () => {
    const district = withQuizzes();
    const user = await renderApp(district.client, list);
    const form = await screen.findByRole("form", { name: "New quiz" });
    await user.type(within(form).getByRole("textbox", { name: "Quiz title" }), "Figurative language");
    await user.click(within(form).getByRole("button", { name: "Create quiz" }));
    await settle();
    await onScreen("Figurative language · English 9 · Period 3");

    const details = screen.getByRole("form", { name: "Quiz details" });
    await user.click(within(details).getByRole("radio", { name: "Persuasive paragraph" }));
    await user.click(within(details).getByRole("button", { name: "Add multiple choice" }));
    const question = within(details).getByRole("group", { name: "Question 1: Multiple choice" });
    await user.type(within(question).getByRole("textbox", { name: "Question 1 prompt" }), "Which compares with like or as?");
    await user.type(within(question).getByRole("textbox", { name: "Question 1, choice 1" }), "Metaphor");
    await user.type(within(question).getByRole("textbox", { name: "Question 1, choice 2" }), "Simile");
    await user.click(within(question).getByRole("radio", { name: "Simile" }));
    await user.click(within(details).getByRole("button", { name: "Add essay" }));
    await user.type(within(within(details).getByRole("group", { name: "Question 2: Essay" })).getByRole("textbox", { name: "Question 2 prompt" }), "Explain a metaphor you love.");
    await user.click(within(details).getByRole("checkbox", { name: "Show each student the questions in their own order" }));
    await user.click(within(details).getByRole("button", { name: "Save quiz" }));

    await waitFor(() => expect(district.callsTo("teacher.updateQuiz")).toHaveLength(1));
    expect(district.callsTo("teacher.updateQuiz")[0]!.input.body).toStrictEqual({
      title: "Figurative language",
      description: "",
      settings: { ...SETTINGS, shuffleQuestions: true },
      assignmentId: IDS.existingAssignment,
      moduleId: null,
      items: [
        { type: "multiple-choice", prompt: "Which compares with like or as?", points: 1, choices: [{ id: "c1", text: "Metaphor" }, { id: "c2", text: "Simile" }], correctChoiceId: "c2" },
        { type: "essay", prompt: "Explain a metaphor you love.", points: 5 },
      ],
    });
    await user.click(await screen.findByRole("button", { name: "Publish" }));
    await screen.findByRole("button", { name: "Unpublish" });
    expect(district.callsTo("teacher.publishQuiz")[0]!.input.body).toStrictEqual({ published: true });
  });

  it("sends no question changes for a quiz students started, and shows the district's refusal", async () => {
    const district = withQuizzes();
    const user = await renderApp(district.client, `${list}/${QUIZ}`);
    await onScreen("Poetry terms · English 9 · Period 3");
    expect(screen.getByText("Students have started this quiz")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Add a question" })).toBeNull();
    const details = screen.getByRole("form", { name: "Quiz details" });
    await user.click(within(details).getByRole("radio", { name: "As soon as they submit" }));
    district.fail("teacher.updateQuiz", { status: 409, body: { code: "conflict", message: "Students have started this quiz, so its questions can no longer change." } });
    await user.click(within(details).getByRole("button", { name: "Save quiz" }));
    await within(details).findByRole("alert");
    expect(district.callsTo("teacher.updateQuiz")[0]!.input.body).not.toHaveProperty("items");
    expect(within(details).getByRole("alert").textContent).toContain("its questions can no longer change");
  });

  it("shows item analysis, grades an essay, and releases scores once, after confirming", async () => {
    const district = withQuizzes();
    const user = await renderApp(district.client, `${list}/${QUIZ}/results`);
    await onScreen("Results: Poetry terms · English 9 · Period 3");
    const analysis = screen.getByRole("table", { name: "Item analysis" });
    expect(within(within(analysis).getByRole("row", { name: /Which compares/ })).getByText("50%")).toBeTruthy();
    expect(within(within(analysis).getByRole("row", { name: /poem's turn/ })).getByText("Not graded yet")).toBeTruthy();
    expect(within(screen.getByRole("table", { name: "Students' results" })).getByText("Needs grading")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Release scores" }) as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole("button", { name: "Grade Amara Okafor, attempt 1" }));
    const grader = await screen.findByRole("region", { name: "Amara Okafor, attempt 1" });
    expect(within(grader).getByText("Answer: The volta turns it.")).toBeTruthy();
    expect(within(grader).getByText("Key: Simile")).toBeTruthy();
    const essay = within(grader).getByRole("form", { name: "Grade question 2" });
    await user.type(within(essay).getByRole("spinbutton", { name: "Points for question 2 (out of 5)" }), "4");
    await user.type(within(essay).getByRole("textbox", { name: "Comment on question 2 (optional)" }), "Name the volta's line.");
    await user.click(within(essay).getByRole("button", { name: "Save grade" }));
    await waitFor(() => expect(district.callsTo("teacher.gradeQuizItem")).toHaveLength(1));
    expect(district.callsTo("teacher.gradeQuizItem")[0]!.input).toMatchObject({ params: { attemptId: ATTEMPT, itemId: "qzi_essay" }, body: { points: 4, comment: "Name the volta's line." } });

    const release = await screen.findByRole("button", { name: "Release scores" });
    await waitFor(() => expect((release as HTMLButtonElement).disabled).toBe(false));
    await user.click(release);
    expect(district.callsTo("teacher.releaseQuizScores")).toHaveLength(0);
    expect(screen.getByText("Release 1 score as official grades? Students and the gradebook will see them.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Release now" }));
    await waitFor(() => expect(within(screen.getByRole("table", { name: "Students' results" })).getByText("Released")).toBeTruthy());
    expect(district.callsTo("teacher.releaseQuizScores")).toHaveLength(1);
    expect(screen.getByRole("status", { name: "" }).textContent).toContain("1 score released as official grades.");
  });

  it("shows a refused release beside the button", async () => {
    const district = withQuizzes();
    district.scores[1]!.points = 3;
    district.fail("teacher.releaseQuizScores", { status: 403, body: { code: "forbidden", message: "Only the class's teachers can release its quiz scores." } });
    const user = await renderApp(district.client, `${list}/${QUIZ}/results`);
    await user.click(await screen.findByRole("button", { name: "Release scores" }));
    await user.click(screen.getByRole("button", { name: "Release now" }));
    expect((await screen.findByRole("alert")).textContent).toContain("You don't have permission");
  });
});
