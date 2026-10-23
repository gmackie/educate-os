// How the quiz screens put times, points and answers into words.
import type { QuizQuestion, QuizResponse, QuizView } from "../model.ts";

/** Points without float noise: whole numbers plainly, others to two places. */
export const formatPoints = (points: number): string => (Number.isInteger(points) ? String(points) : points.toFixed(2).replace(/0+$/, ""));

/** "1 point" or "3 points". */
export const pointsLabel = (points: number): string => `${formatPoints(points)} point${points === 1 ? "" : "s"}`;

/** What a quiz's availability means for the student. */
export const AVAILABILITY_LABEL: Record<QuizView["availability"], string> = {
  upcoming: "Not open yet",
  open: "Open",
  closed: "Closed",
};

/** Time left as a clock reads it: "12:05", or "1:02:05" past an hour. */
export const formatClock = (ms: number): string => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
};

/** A response in words: the chosen choices' text, true or false, the number or the text written. */
export const responseText = (question: QuizQuestion, response: QuizResponse | undefined): string => {
  if (response === undefined) return "No answer";
  const choice = (id: string) => question.choices?.find((c) => c.id === id)?.text ?? id;
  switch (response.type) {
    case "multiple-choice":
      return choice(response.choiceId);
    case "multiple-select":
      return response.choiceIds.length === 0 ? "None chosen" : response.choiceIds.map(choice).join("; ");
    case "true-false":
      return response.value ? "True" : "False";
    case "numeric":
      return String(response.value);
    default:
      return response.text.trim() === "" ? "No answer" : response.text;
  }
};

/** Whether a response counts as an answer: something chosen or written. */
export const isAnswered = (response: QuizResponse | undefined): boolean => {
  if (response === undefined) return false;
  if (response.type === "multiple-select") return response.choiceIds.length > 0;
  if (response.type === "short-answer" || response.type === "essay") return response.text.trim() !== "";
  return true;
};

/** What a quiz asks of the student, in one line: questions, points, time and attempts. */
export const quizFacts = (quiz: QuizView): string => [
  `${quiz.questionCount} question${quiz.questionCount === 1 ? "" : "s"}`,
  pointsLabel(quiz.totalPoints),
  quiz.timeLimitMinutes === undefined ? "No time limit" : `${quiz.timeLimitMinutes} minute${quiz.timeLimitMinutes === 1 ? "" : "s"} per attempt`,
  `${quiz.attempts.length} of ${quiz.attemptsAllowed} attempt${quiz.attemptsAllowed === 1 ? "" : "s"} used`,
].join(" · ");
