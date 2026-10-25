import type { AiHelpLevel, ClassNote, LearningGoal, ResourceRelease, RubricRef, TemplateInput, TemplateKind } from "../types.ts";

/** The four templates, each in the words a teacher would use. */
export const TEMPLATES: readonly { kind: TemplateKind; label: string; description: string }[] = [
  { kind: "writing-task", label: "Writing task", description: "An essay or written piece, planned, drafted and revised." },
  { kind: "science-investigation", label: "Science investigation", description: "A hypothesis, a method, a data table and an analysis." },
  { kind: "primary-source-analysis", label: "Primary-source analysis", description: "Students source and contextualize documents, then make a claim." },
  { kind: "problem-set", label: "Problem set", description: "Problems with an answer key only you can see." },
];

/** The AI help choices, from none to full. The district may allow less than the activity asks. */
export const AI_HELP: readonly { level: AiHelpLevel; label: string; explanation: string }[] = [
  { level: "none", label: "None", explanation: "Students work without an AI helper." },
  { level: "hints-only", label: "Hints only", explanation: "The helper may point the way but won't do the work." },
  { level: "full", label: "Full", explanation: "The helper may help with the work itself." },
];

/** A note in the class context as the teacher drafts it. */
export interface NoteDraft {
  id: string;
  title: string;
  body: string;
  teacherOnly: boolean;
}

/** One problem of a problem set. Its answer goes only into a teacher-only answer key. */
export interface ProblemDraft {
  prompt: string;
  answer: string;
}

/**
 * Everything the create-activity form holds. Every template's fields are kept, so switching
 * templates and back loses nothing the teacher typed.
 */
export interface ActivityForm {
  template: TemplateKind;
  title: string;
  overview: string;
  goals: readonly string[];
  resources: readonly string[];
  notes: readonly NoteDraft[];
  aiHelp: AiHelpLevel;
  rubric: RubricRef | undefined;
  writing: { prompt: string; genre: "argument" | "informative" | "narrative" | "literary-analysis"; minWords: string; minimumCitations: string };
  science: { question: string; methodPrompt: string; dataColumns: string; analysisPrompt: string };
  sources: { sourcingQuestions: string; contextualizationQuestions: string; claimPrompt: string; minimumEvidence: string };
  problems: { items: readonly ProblemDraft[]; showWork: boolean };
}

/** A blank form for a new activity. */
export const emptyActivityForm = (): ActivityForm => ({
  template: "writing-task",
  title: "",
  overview: "",
  goals: [],
  resources: [],
  notes: [],
  aiHelp: "hints-only",
  rubric: undefined,
  writing: { prompt: "", genre: "argument", minWords: "", minimumCitations: "0" },
  science: { question: "", methodPrompt: "", dataColumns: "", analysisPrompt: "" },
  sources: { sourcingQuestions: "", contextualizationQuestions: "", claimPrompt: "", minimumEvidence: "1" },
  problems: { items: [{ prompt: "", answer: "" }], showWork: true },
});

/** The key a learning goal is chosen by. */
export const goalKey = (goal: Pick<LearningGoal, "frameworkKey" | "competencyUri">): string => `${goal.frameworkKey} ${goal.competencyUri}`;

/** A learning goal's short name: its framework and code, such as "CCSS-ELA W.9-10.1". */
export const goalLabel = (goal: LearningGoal): string => `${goal.frameworkKey.toUpperCase()} ${goal.code}`;

/** The key an approved resource is chosen by. */
export const releaseKey = (release: ResourceRelease): string => `${release.descriptor.id}@${release.descriptor.release.version}`;

const lines = (text: string) => text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
const wholeNumber = (text: string): number | undefined => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : undefined);

/** What the class and the course contribute to every activity. */
export interface ActivityContext {
  subject: TemplateInput["subject"];
  gradeBand: string;
  goals: readonly LearningGoal[];
  releases: readonly ResourceRelease[];
}

/**
 * The template input the form describes, or what is still missing in plain words. The district
 * checks everything again; this only catches what a teacher can fix before sending.
 */
export const buildActivity = (form: ActivityForm, context: ActivityContext): { ok: true; input: TemplateInput } | { ok: false; problems: string[] } => {
  const problems: string[] = [];
  const need = (value: string, what: string) => {
    if (value.trim() === "") problems.push(what);
    return value.trim();
  };
  const title = need(form.title, "Give the activity a title.");
  const overview = need(form.overview, "Write an overview for students.");
  const goals = context.goals.filter((goal) => form.goals.includes(goalKey(goal)));
  const resources = context.releases
    .filter((release) => form.resources.includes(releaseKey(release)))
    .map((release) => ({ resourceId: release.descriptor.id, version: release.descriptor.release.version }));
  const notes: ClassNote[] = form.notes
    .filter((note) => note.title.trim() !== "" || note.body.trim() !== "")
    .map((note) => ({ kind: "note", id: note.id, title: note.title.trim() || "Note", body: note.body.trim(), purpose: "context", visibility: note.teacherOnly ? "teacher-only" : "students" }));
  if (notes.some((note) => note.body === "")) problems.push("Every class note needs some text.");
  const common = {
    title,
    subject: context.subject,
    gradeBand: context.gradeBand,
    overview,
    resources,
    codex: [...resources.map((resource) => ({ kind: "resource" as const, resource, visibility: "students" as const })), ...notes],
    alignments: goals.map((goal) => ({ frameworkKey: goal.frameworkKey, competencyUri: goal.competencyUri })),
    aiHelp: form.aiHelp,
    due: { kind: "none" as const },
  };
  const rubric = form.rubric;

  let input: TemplateInput | undefined;
  switch (form.template) {
    case "writing-task": {
      const prompt = need(form.writing.prompt, "Write the prompt students respond to.");
      const minimumCitations = wholeNumber(form.writing.minimumCitations);
      if (minimumCitations === undefined) problems.push("Say how many sources students must cite (0 for none).");
      const minWords = form.writing.minWords.trim() === "" ? undefined : wholeNumber(form.writing.minWords);
      if (form.writing.minWords.trim() !== "" && (minWords === undefined || minWords < 1)) problems.push("The minimum length must be a whole number of words.");
      input = {
        ...common,
        template: "writing-task",
        prompt,
        genre: form.writing.genre,
        minimumCitations: minimumCitations ?? 0,
        ...(minWords === undefined ? {} : { minWords }),
        ...(rubric === undefined ? {} : { structureRubric: rubric }),
      };
      break;
    }
    case "science-investigation": {
      const dataColumns = lines(form.science.dataColumns).map((line) => {
        const [name = "", unit = ""] = line.split(",").map((part) => part.trim());
        return unit === "" ? { name } : { name, unit };
      });
      if (dataColumns.length === 0) problems.push("Name at least one column for the data table.");
      input = {
        ...common,
        template: "science-investigation",
        question: need(form.science.question, "Write the investigation question."),
        methodPrompt: need(form.science.methodPrompt, "Say what students should describe about their method."),
        dataColumns,
        analysisPrompt: need(form.science.analysisPrompt, "Write the analysis prompt."),
        ...(rubric === undefined ? {} : { investigationRubric: rubric }),
      };
      break;
    }
    case "primary-source-analysis": {
      if (resources.length === 0) problems.push("Attach at least one approved resource as a primary source.");
      const sourcingQuestions = lines(form.sources.sourcingQuestions);
      const contextualizationQuestions = lines(form.sources.contextualizationQuestions);
      if (sourcingQuestions.length === 0) problems.push("Add at least one sourcing question.");
      if (contextualizationQuestions.length === 0) problems.push("Add at least one context question.");
      const minimumEvidence = wholeNumber(form.sources.minimumEvidence);
      if (minimumEvidence === undefined || minimumEvidence < 1) problems.push("Say how many pieces of evidence the claim must use (at least 1).");
      input = {
        ...common,
        template: "primary-source-analysis",
        sources: resources,
        sourcingQuestions,
        contextualizationQuestions,
        claimPrompt: need(form.sources.claimPrompt, "Write the claim prompt."),
        minimumEvidence: minimumEvidence ?? 1,
        ...(rubric === undefined ? {} : { analysisRubric: rubric }),
      };
      break;
    }
    case "problem-set": {
      const problemsList = form.problems.items
        .filter((problem) => problem.prompt.trim() !== "")
        .map((problem) => (problem.answer.trim() === "" ? { prompt: problem.prompt.trim() } : { prompt: problem.prompt.trim(), answer: problem.answer.trim() }));
      if (problemsList.length === 0) problems.push("Add at least one problem.");
      input = {
        ...common,
        template: "problem-set",
        problems: problemsList,
        showWork: form.problems.showWork,
        ...(rubric === undefined ? {} : { solutionRubric: rubric }),
      };
      break;
    }
  }
  return problems.length === 0 ? { ok: true, input } : { ok: false, problems };
};
