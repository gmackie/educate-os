// SCHO-191: a class's quizzes on its page, taking one (accessible questions, autosave, the district's
// clock announced at intervals, confirming before submitting), and results that show answers only
// when the quiz does.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { screen, waitFor, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { DistrictApiError, type RouteInput, type RouteName } from "@schoolos/api-client";
import { ENGLISH, fakeDistrict, type FakeDistrict } from "./fakeDistrict.ts";
import { announcement, renderApp } from "./render.tsx";

const QUIZ = "qz_poetry";
const ATTEMPT = "qza_amara1";
const SERVER_NOW = "2026-10-21T15:00:00.000Z";
const MINUTE = 60_000;

const QUESTIONS = [
  { id: "qzi_mc", type: "multiple-choice", prompt: "Which compares with like or as?", points: 2, choices: [{ id: "c1", text: "Metaphor" }, { id: "c2", text: "Simile" }] },
  { id: "qzi_ms", type: "multiple-select", prompt: "Which are sound devices?", points: 3, choices: [{ id: "c1", text: "Alliteration" }, { id: "c2", text: "Rhyme" }, { id: "c3", text: "Plot" }] },
  { id: "qzi_num", type: "numeric", prompt: "How many lines in a sonnet?", points: 1 },
  { id: "qzi_essay", type: "essay", prompt: "Explain the turn.", points: 5, maxLength: 20000 },
];

const quizView = (extra: Record<string, unknown> = {}) => ({
  id: QUIZ, offeringId: ENGLISH, courseTitle: "English 9", title: "Poetry terms", description: "Read each question **carefully**.", assignmentId: "asg_poetry",
  questionCount: 4, totalPoints: 11, attemptsAllowed: 2, timeLimitMinutes: 15, availableUntil: "2026-10-30T21:00:00.000Z",
  showAnswers: "after-release", availability: "open", attempts: [], canStart: true, ...extra,
});

type Result = Record<string, unknown>;

/** The fake district with one quiz in English, whose attempt lasts `minutes` on the district's clock. */
function withQuiz(options: { minutes?: number; result?: Result; submitFails?: boolean } = {}) {
  const base = fakeDistrict();
  const deadline = new Date(Date.parse(SERVER_NOW) + (options.minutes ?? 15) * MINUTE).toISOString();
  const saved: unknown[] = [];
  const attemptView = { attemptId: ATTEMPT, quizId: QUIZ, title: "Poetry terms", number: 1, questions: QUESTIONS, answers: [], startedAt: SERVER_NOW, deadline, serverNow: SERVER_NOW };
  const hiddenResult = {
    attemptId: ATTEMPT, quizId: QUIZ, courseTitle: "English 9", title: "Poetry terms", number: 1, status: "submitted", submittedAt: SERVER_NOW, answersShown: false, released: false,
    items: QUESTIONS.map((question) => ({ question, ...(question.id === "qzi_mc" ? { response: { type: "multiple-choice", choiceId: "c2" } } : {}) })),
  };
  const handlers: Partial<Record<RouteName, (input: never) => unknown>> = {
    "student.listQuizzes": () => [quizView()],
    "student.getQuiz": () => quizView(),
    "student.startQuizAttempt": () => attemptView,
    "student.saveQuizAnswers": ({ body }: RouteInput<"student.saveQuizAnswers">) => {
      saved.push(body.answers);
      return { savedAt: SERVER_NOW, deadline, serverNow: SERVER_NOW };
    },
    "student.submitQuizAttempt": () => {
      if (options.submitFails === true) throw new DistrictApiError(403, { code: "forbidden", message: "Time is up: this attempt can no longer be changed or submitted." });
      return hiddenResult;
    },
    "student.quizAttemptResult": () => options.result ?? hiddenResult,
  };
  const district: FakeDistrict = {
    ...base,
    async call(name, ...args) {
      const handler = handlers[name];
      if (handler === undefined) return base.call(name, ...args);
      base.calls.push({ name, input: args[0] });
      await Promise.resolve();
      return structuredClone(handler((args[0] ?? {}) as never)) as never;
    },
  };
  const callsTo = (name: RouteName) => base.calls.filter((c) => c.name === name);
  return { district, saved, callsTo };
}

afterEach(() => {
  vi.useRealTimers();
});

/** Moves the faked clock and its intervals on by `ms`. */
const tick = async (ms: number) => act(async () => {
  vi.advanceTimersByTime(ms);
});

describe("class quizzes", () => {
  it("lists the class's quizzes with what each asks", async () => {
    await renderApp(withQuiz().district, `/courses/${ENGLISH}`);
    const section = await screen.findByRole("region", { name: "Quizzes" });
    expect(within(section).getByRole("link", { name: "Poetry terms" }).getAttribute("href")).toBe(`/courses/${ENGLISH}/quizzes/${QUIZ}`);
    expect(within(section).getByText("4 questions · 11 points · 15 minutes per attempt · 0 of 2 attempts used")).toBeTruthy();
    expect(within(section).getByText("Open")).toBeTruthy();
  });

  it("asks each question in a labelled group, saves answers as the student works, and submits after confirming", async () => {
    const { district, saved, callsTo } = withQuiz();
    await renderApp(district, `/courses/${ENGLISH}/quizzes/${QUIZ}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Start quiz" }));

    const first = await screen.findByRole("group", { name: "Question 1 (2 points): Which compares with like or as?" });
    await user.click(within(first).getByRole("radio", { name: "Simile" }));
    const second = screen.getByRole("group", { name: "Question 2 (3 points): Which are sound devices?" });
    expect(within(second).getByRole("group", { name: "Choose all that apply" })).toBeTruthy();
    // Leaving a question saves what changed in it.
    await user.click(within(second).getByRole("checkbox", { name: "Alliteration" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toStrictEqual([{ itemId: "qzi_mc", response: { type: "multiple-choice", choiceId: "c2" } }]);
    await user.click(within(second).getByRole("checkbox", { name: "Rhyme" }));
    // A pause saves too.
    await waitFor(() => expect(saved).toHaveLength(2), { timeout: 4000 });
    expect(saved[1]).toStrictEqual([{ itemId: "qzi_ms", response: { type: "multiple-select", choiceIds: ["c1", "c2"] } }]);
    expect(await screen.findByText(/^Saved at/)).toBeTruthy();
    expect(within(screen.getByRole("group", { name: /Question 3/ })).getByRole("spinbutton", { name: "Your answer (a number)" })).toBeTruthy();
    expect(within(screen.getByRole("group", { name: /Question 4/ })).getByRole("textbox", { name: "Your answer" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Submit quiz" }));
    expect(callsTo("student.submitQuizAttempt")).toHaveLength(0);
    const confirm = screen.getByRole("group", { name: "Confirm submitting" });
    expect(within(confirm).getByText("You have 2 unanswered questions. Submit now? You can't change your answers after.")).toBeTruthy();
    await user.click(within(confirm).getByRole("button", { name: "Submit answers" }));
    await screen.findByRole("heading", { name: "Attempt 1 submitted" });
    expect(callsTo("student.submitQuizAttempt")).toHaveLength(1);
    expect((callsTo("student.submitQuizAttempt")[0]!.input as { body: { answers: unknown[] } }).body.answers).toHaveLength(2);
    expect(announcement()).toBe("Your quiz was submitted.");
    // Scores and answers wait for the teacher's release.
    expect(screen.getByText("Your score isn't released yet")).toBeTruthy();
    expect(screen.queryByText(/^Correct answer:/)).toBeNull();
    expect(screen.getByText("Your answer: Simile")).toBeTruthy();
  });

  it("counts down on the district's clock and announces the time left only at intervals", async () => {
    // The device's clock is an hour fast; only the district's counts.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date(Date.parse(SERVER_NOW) + 60 * MINUTE));
    await renderApp(withQuiz({ minutes: 11 }).district, `/courses/${ENGLISH}/quizzes/${QUIZ}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Start quiz" }));
    const timer = await screen.findByRole("timer", { name: "Time left" });
    expect(timer.textContent).toBe("11:00");

    await tick(30_000);
    expect(timer.textContent).toBe("10:30");
    expect(announcement()).toBe("");
    await tick(31_000);
    expect(announcement()).toBe("10 minutes left in this quiz.");
    // Nothing more until five minutes are left, however many seconds pass.
    await tick(4 * MINUTE);
    expect(announcement()).toBe("10 minutes left in this quiz.");
    await tick(MINUTE);
    expect(announcement()).toBe("5 minutes left in this quiz.");
    await tick(4 * MINUTE);
    expect(announcement()).toBe("1 minute left in this quiz.");
    await tick(MINUTE + 1000);
    expect(announcement()).toBe("Time is up. This attempt can no longer be changed or submitted.");
    expect(screen.getByRole("alert").textContent).toContain("Time is up");
    expect((screen.getByRole("button", { name: "Submit quiz" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows that time ran out when the district refuses a late submission", async () => {
    await renderApp(withQuiz({ submitFails: true }).district, `/courses/${ENGLISH}/quizzes/${QUIZ}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Start quiz" }));
    await user.click(await screen.findByRole("button", { name: "Submit quiz" }));
    await user.click(screen.getByRole("button", { name: "Submit answers" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Time is up");
  });

  it("shows the key, points, feedback and the released score once the quiz shows answers", async () => {
    const result = {
      attemptId: ATTEMPT, quizId: QUIZ, courseTitle: "English 9", title: "Poetry terms", number: 1, status: "submitted", submittedAt: SERVER_NOW, answersShown: true, released: true,
      releasedScore: { points: 6, maxPoints: 11 },
      items: [
        { question: QUESTIONS[0], response: { type: "multiple-choice", choiceId: "c1" }, points: 0, correct: false, correctResponse: { type: "multiple-choice", choiceId: "c2" }, feedback: "A simile says like or as." },
        { question: QUESTIONS[3], response: { type: "essay", text: "The volta." }, points: 4, correct: false, comment: "Name the line." },
      ],
    };
    await renderApp(withQuiz({ result }).district, `/courses/${ENGLISH}/quizzes/${QUIZ}/attempts/${ATTEMPT}`);
    await screen.findByRole("heading", { level: 1, name: "Poetry terms: attempt 1" });
    expect(screen.getByText("Your score: 6 out of 11")).toBeTruthy();
    const first = screen.getByRole("article", { name: "Question 1" });
    expect(within(first).getByText("Your answer: Metaphor")).toBeTruthy();
    expect(within(first).getByText("Correct answer: Simile")).toBeTruthy();
    expect(within(first).getByText("A simile says like or as.")).toBeTruthy();
    expect(within(screen.getByRole("article", { name: "Question 2" })).getByText("Your teacher: Name the line.")).toBeTruthy();
  });

  it("shows only the student's own answers while the quiz keeps its key", async () => {
    await renderApp(withQuiz().district, `/courses/${ENGLISH}/quizzes/${QUIZ}/attempts/${ATTEMPT}`);
    const first = await screen.findByRole("article", { name: "Question 1" });
    expect(within(first).getByText("Your answer: Simile")).toBeTruthy();
    expect(within(first).queryByText(/Correct/)).toBeNull();
    expect(screen.getByText("Correct answers aren't shown for this quiz yet.")).toBeTruthy();
  });
});
