import type { ShowcaseQuizItem } from "../../packages/educateos-fixtures/src/index.ts";

/** Converts a fixture item to Canvas Classic Quiz input; keys stay in teacher-only question fields. */
export function canvasQuizQuestion(item: ShowcaseQuizItem, position: number) {
  const base = { question_name: `educateos-demo-question-${position}`, question_text: html(item.prompt), points_possible: item.points, position };
  switch (item.type) {
    case "multiple-choice": return { ...base, question_type: "multiple_choice_question", answers: item.choices.map(c => ({ answer_text: c.text, answer_weight: c.id === item.correctChoiceId ? 100 : 0 })) };
    case "multiple-select":
      if (item.scoring === "all-or-nothing") return { ...base, question_type: "essay_question", question_text: html(item.prompt + "\n" + item.choices.map(c => `${c.id}: ${c.text}`).join("\n") + "\nList all selected choices. Your teacher will score this response as all-or-nothing.") };
      return { ...base, question_type: "multiple_answers_question", answers: item.choices.map(c => ({ answer_text: c.text, answer_weight: item.correctChoiceIds.includes(c.id) ? 100 : 0 })) };
    case "true-false": return { ...base, question_type: "true_false_question", answers: [true, false].map(value => ({ answer_text: value ? "True" : "False", answer_weight: value === item.correct ? 100 : 0 })) };
    case "numeric": return { ...base, question_type: "numerical_question", answers: [{ numerical_answer_type: "exact_answer", answer_exact: item.answer, answer_error_margin: item.tolerance, answer_weight: 100 }] };
    case "short-answer": return { ...base, question_type: "short_answer_question", answers: item.acceptedAnswers.map(answer => ({ answer_text: answer, answer_weight: 100 })) };
    case "essay": return { ...base, question_type: "essay_question" };
  }
}

function html(text: string): string {
  return `<p>${text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("\n", "</p><p>")}</p>`;
}
