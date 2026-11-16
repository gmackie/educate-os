import { ArtifactType, GradeBand, Subject } from "@educateos/contracts";
import { z } from "zod";
import { AiHelpLevel } from "./ai-help.ts";
import {
  type ActivityContent,
  type ActivityStep,
  AlignmentRequest,
  CodexEntry,
  DatasetColumn,
  DueDateRule,
  releaseKey,
  responseArtifactType,
  ResourceReleaseRef,
  RubricRef,
} from "./model.ts";

const Text = (max: number) => z.string().trim().min(1).max(max);

/**
 * What a teacher fills in for every template. Templates are subject-neutral: the subject and grade
 * band are inputs, so a writing task serves English and History alike.
 */
const CommonInput = {
  title: Text(200),
  subject: Subject,
  gradeBand: GradeBand,
  overview: Text(5000),
  resources: z.array(ResourceReleaseRef).max(50).default([]),
  codex: z.array(CodexEntry).max(100).default([]),
  /** Learning goals from the district's approved standards releases. Optional (SCHO-220). */
  alignments: z.array(AlignmentRequest).max(20).default([]),
  aiHelp: AiHelpLevel,
  /** Artifact types allowed beyond those the template's steps require. */
  additionalArtifactTypes: z.array(ArtifactType).max(12).default([]),
  due: DueDateRule,
  collaboration: z.enum(["individual", "group"]).default("individual"),
};

/** A writing task, such as an argumentative essay, with a structure rubric slot and a citation requirement. */
export const WritingTaskInput = z.strictObject({
  template: z.literal("writing-task"),
  ...CommonInput,
  prompt: Text(5000),
  genre: z.enum(["argument", "informative", "narrative", "literary-analysis"]),
  minWords: z.int().min(1).max(20_000).optional(),
  /** How many sources the essay must cite; 0 for none. */
  minimumCitations: z.int().min(0).max(50),
  structureRubric: RubricRef.optional(),
});
/** A writing task's inputs. */
export type WritingTaskInput = z.input<typeof WritingTaskInput>;

/** A science investigation: hypothesis, method, a data table kept as a dataset, and analysis. */
export const ScienceInvestigationInput = z.strictObject({
  template: z.literal("science-investigation"),
  ...CommonInput,
  question: Text(2000),
  methodPrompt: Text(5000),
  dataColumns: z.array(DatasetColumn).min(1).max(30),
  analysisPrompt: Text(5000),
  investigationRubric: RubricRef.optional(),
});
/** A science investigation's inputs. */
export type ScienceInvestigationInput = z.input<typeof ScienceInvestigationInput>;

/** A primary-source analysis: sources, sourcing and contextualization questions, and a claim with evidence. */
export const PrimarySourceAnalysisInput = z.strictObject({
  template: z.literal("primary-source-analysis"),
  ...CommonInput,
  /** The primary sources. They join the activity's resources if not already listed. */
  sources: z.array(ResourceReleaseRef).min(1).max(20),
  sourcingQuestions: z.array(Text(1000)).min(1).max(20),
  contextualizationQuestions: z.array(Text(1000)).min(1).max(20),
  claimPrompt: Text(5000),
  /** How many pieces of evidence from the sources the claim must cite. */
  minimumEvidence: z.int().min(1).max(20),
  analysisRubric: RubricRef.optional(),
});
/** A primary-source analysis's inputs. */
export type PrimarySourceAnalysisInput = z.input<typeof PrimarySourceAnalysisInput>;

/** A mathematics problem set. Answers go only into a teacher-only answer key. */
export const ProblemSetInput = z.strictObject({
  template: z.literal("problem-set"),
  ...CommonInput,
  problems: z.array(z.strictObject({ prompt: Text(5000), answer: Text(5000).optional() })).min(1).max(50),
  /** Whether students must show their reasoning, which also permits a photographed page of working. */
  showWork: z.boolean(),
  solutionRubric: RubricRef.optional(),
});
/** A problem set's inputs. */
export type ProblemSetInput = z.input<typeof ProblemSetInput>;

/** Sentence starters for young learners, such as "I see a ___." */
const SentenceFrames = z.array(Text(200)).max(10).default([]);

/**
 * A picture response, for young learners (K-2, and 3-5): look at or listen to a short prompt, draw
 * or photograph an answer, then optionally record themselves telling about it. The activity's
 * resources, such as a picture to look at, are the first step's sources.
 */
export const PictureResponseInput = z.strictObject({
  template: z.literal("picture-response"),
  ...CommonInput,
  /** What students look at or listen to first. One or two short sentences: it is read aloud. */
  lookPrompt: Text(1000),
  /** What to draw or photograph, such as "Draw an animal that lives in a pond." */
  drawPrompt: Text(500),
  /** Whether a last step asks students to record themselves telling about their picture. */
  tellAboutIt: z.boolean().default(true),
  /** Starters for telling about the picture, such as "I drew a ___." */
  sentenceFrames: SentenceFrames,
  pictureRubric: RubricRef.optional(),
});
/** A picture response's inputs. */
export type PictureResponseInput = z.input<typeof PictureResponseInput>;

/** How a young learner answers a question: a recording of their voice, a drawing or photo, or typed words. */
export const AnswerMode = z.enum(["speaking", "drawing", "writing"]);
/** An answer mode. */
export type AnswerMode = z.infer<typeof AnswerMode>;

/**
 * Read and respond, for young learners (K-2, and 3-5): listen to a short text read aloud, then
 * answer one question a step, by speaking, drawing or writing.
 */
export const ReadAndRespondInput = z.strictObject({
  template: z.literal("read-and-respond"),
  ...CommonInput,
  /** The short text students hear. A few sentences suit K-2. */
  passage: Text(3000),
  /** The questions, one a step. A question's `answerBy` overrides the activity's. */
  questions: z.array(z.strictObject({ prompt: Text(500), answerBy: AnswerMode.optional() })).min(1).max(10),
  /** How students answer a question that does not say. */
  answerBy: AnswerMode.default("speaking"),
  /** Starters offered with every question, such as "The story is about ___." */
  sentenceFrames: SentenceFrames,
  responseRubric: RubricRef.optional(),
});
/** Read-and-respond inputs. */
export type ReadAndRespondInput = z.input<typeof ReadAndRespondInput>;

/** The inputs to any template, discriminated by `template`. */
export const TemplateInput = z.discriminatedUnion("template", [
  WritingTaskInput,
  ScienceInvestigationInput,
  PrimarySourceAnalysisInput,
  ProblemSetInput,
  PictureResponseInput,
  ReadAndRespondInput,
]);
/** Template inputs, as a caller writes them. */
export type TemplateInput = z.input<typeof TemplateInput>;
type ParsedInput = z.output<typeof TemplateInput>;

const step = (id: string, title: string, prompt: string, response: ActivityStep["response"], sources: ActivityStep["sources"] = [], sentenceFrames: readonly string[] = []): ActivityStep =>
  ({ id, title, prompt, sources, response, ...(sentenceFrames.length === 0 ? {} : { sentenceFrames: [...sentenceFrames] }) });

const numbered = (lines: readonly string[]) => lines.map((line, index) => `${index + 1}. ${line}`).join("\n");

const slot = (id: string, purpose: string, rubric: z.output<typeof RubricRef> | undefined) =>
  ({ id, purpose, ...(rubric === undefined ? {} : { rubric }) });

/** The parts each template contributes. Everything else comes from the common inputs. */
type Generated = Pick<ActivityContent, "steps" | "rubricSlots" | "citations"> & {
  responseType: ActivityContent["evidence"]["responseType"];
  criteria: ActivityContent["evidence"]["criteria"];
  extraResources?: ActivityContent["resources"];
  extraCodex?: ActivityContent["codex"];
};

function writingTask(input: Extract<ParsedInput, { template: "writing-task" }>): Generated {
  const cites = input.minimumCitations > 0;
  return {
    steps: [
      step("plan", "Plan", `${input.prompt}\n\nOutline your main idea and how each part of the piece supports it.`, { kind: "writing" }),
      step("draft", "Draft", "Write the full piece from your plan.", { kind: "writing", ...(input.minWords === undefined ? {} : { minWords: input.minWords }) }),
      step("revise", "Revise", "Reread your draft against the rubric and revise it.", { kind: "writing" }),
    ],
    rubricSlots: [slot("structure", "Structure: a clear central idea, logical organization, support and conventions.", input.structureRubric)],
    ...(cites ? { citations: { minimum: input.minimumCitations, from: input.resources.length > 0 ? "activity-resources" : "any-source" } } : {}),
    responseType: "text",
    criteria: [
      { id: "central-idea", description: input.genre === "narrative" ? "Establishes a clear situation and point of view." : "States a clear central claim or thesis." },
      { id: "organization", description: "Organizes ideas so each part builds on the last." },
      ...(cites ? [{ id: "cites-sources", description: `Cites at least ${input.minimumCitations} source(s) accurately.` }] : []),
      { id: "conventions", description: "Uses conventions of standard written language." },
    ],
  };
}

function scienceInvestigation(input: Extract<ParsedInput, { template: "science-investigation" }>): Generated {
  return {
    steps: [
      step("hypothesis", "Hypothesis", `${input.question}\n\nWrite a testable hypothesis and explain your reasoning.`, { kind: "writing" }),
      step("method", "Method", input.methodPrompt, { kind: "writing" }),
      step("data", "Data", "Record your observations in the data table.", { kind: "dataset", columns: input.dataColumns }),
      step("analysis", "Analysis", input.analysisPrompt, { kind: "writing" }),
    ],
    rubricSlots: [slot("investigation", "Investigation: hypothesis, method, data quality and analysis.", input.investigationRubric)],
    responseType: "artifact",
    criteria: [
      { id: "testable-hypothesis", description: "States a hypothesis that the investigation can test." },
      { id: "controlled-method", description: "Describes a method that controls variables and can be repeated." },
      { id: "recorded-data", description: "Records data completely, with units." },
      { id: "evidence-based-analysis", description: "Draws a conclusion the recorded data supports." },
    ],
  };
}

function primarySourceAnalysis(input: Extract<ParsedInput, { template: "primary-source-analysis" }>): Generated {
  return {
    steps: [
      step("sourcing", "Sourcing", `Answer about each source:\n${numbered(input.sourcingQuestions)}`, { kind: "writing" }, input.sources),
      step("contextualization", "Context", `Place the sources in their time:\n${numbered(input.contextualizationQuestions)}`, { kind: "writing" }, input.sources),
      step("claim", "Claim and evidence", input.claimPrompt, { kind: "writing" }, input.sources),
    ],
    rubricSlots: [slot("analysis", "Analysis: sourcing, contextualization, claim and use of evidence.", input.analysisRubric)],
    citations: { minimum: input.minimumEvidence, from: "activity-resources" },
    responseType: "text",
    criteria: [
      { id: "sourcing", description: "Identifies each source's author, purpose and audience." },
      { id: "contextualization", description: "Places the sources in their historical context." },
      { id: "claim", description: "Makes a defensible claim that answers the question." },
      { id: "evidence", description: `Supports the claim with at least ${input.minimumEvidence} piece(s) of evidence from the sources.` },
    ],
    extraResources: input.sources,
  };
}

function problemSet(input: Extract<ParsedInput, { template: "problem-set" }>): Generated {
  const answers = input.problems.flatMap((problem, index) => (problem.answer === undefined ? [] : [`${index + 1}. ${problem.answer}`]));
  return {
    steps: input.problems.map((problem, index) =>
      step(`problem-${index + 1}`, `Problem ${index + 1}`, input.showWork ? `${problem.prompt}\n\nShow your reasoning.` : problem.prompt, { kind: "writing" })),
    rubricSlots: [slot("solutions", "Solutions: correctness and reasoning.", input.solutionRubric)],
    responseType: "text",
    criteria: [
      { id: "correct-solutions", description: "Reaches correct solutions." },
      ...(input.showWork ? [{ id: "shows-reasoning", description: "Shows reasoning that justifies each solution." }] : []),
    ],
    extraCodex: answers.length === 0 ? [] : [{
      kind: "note",
      id: "answer-key",
      title: "Answer key",
      body: answers.join("\n"),
      purpose: "answer-key",
      visibility: "teacher-only",
    }],
  };
}

function pictureResponse(input: Extract<ParsedInput, { template: "picture-response" }>): Generated {
  const tell = input.tellAboutIt;
  return {
    steps: [
      step("look", "Look and listen", input.lookPrompt, { kind: "none" }, input.resources),
      // Without a telling step, the starters help students talk about the drawing itself.
      step("draw", "Draw it", input.drawPrompt, { kind: "artifact", artifactType: "image" }, [], tell ? [] : input.sentenceFrames),
      ...(tell ? [step("tell", "Tell about it", "Tell about your picture.", { kind: "artifact", artifactType: "audio" }, [], input.sentenceFrames)] : []),
    ],
    rubricSlots: [slot("picture", "Picture: answers the prompt, with details that show what the student noticed.", input.pictureRubric)],
    responseType: "artifact",
    criteria: [
      { id: "answers-prompt", description: "The picture answers the prompt." },
      { id: "shows-detail", description: "The picture includes details that show what the student noticed." },
      ...(tell ? [{ id: "tells-about-it", description: "Tells about the picture in their own words." }] : []),
    ],
  };
}

const ANSWER_RESPONSES: Record<AnswerMode, ActivityStep["response"]> = {
  speaking: { kind: "artifact", artifactType: "audio" },
  drawing: { kind: "artifact", artifactType: "image" },
  writing: { kind: "writing" },
};

function readAndRespond(input: Extract<ParsedInput, { template: "read-and-respond" }>): Generated {
  const modes = new Set(input.questions.map((question) => question.answerBy ?? input.answerBy));
  const only = modes.size === 1 ? [...modes][0] : undefined;
  return {
    steps: [
      step("listen", "Listen", input.passage, { kind: "none" }, input.resources),
      ...input.questions.map((question, index) =>
        step(`question-${index + 1}`, `Question ${index + 1}`, question.prompt, ANSWER_RESPONSES[question.answerBy ?? input.answerBy], [], input.sentenceFrames)),
    ],
    rubricSlots: [slot("response", "Response: recalls key details and answers each question about the text.", input.responseRubric)],
    responseType: only === "speaking" ? "audio" : only === "writing" ? "text" : "artifact",
    criteria: [
      { id: "recalls-details", description: "Recalls key details from the text." },
      { id: "answers-questions", description: "Answers each question about the text." },
    ],
  };
}

/**
 * Generates activity content from a template's inputs. Templates only generate: the content they
 * return is the same runtime model whatever the template, and is validated and installed by the
 * same code.
 *
 * @throws z.ZodError if `input` is not a template's inputs.
 */
export function generateActivity(input: unknown): ActivityContent {
  const parsed = TemplateInput.parse(input);
  const generated = (() => {
    switch (parsed.template) {
      case "writing-task":
        return writingTask(parsed);
      case "science-investigation":
        return scienceInvestigation(parsed);
      case "primary-source-analysis":
        return primarySourceAnalysis(parsed);
      case "problem-set":
        return problemSet(parsed);
      case "picture-response":
        return pictureResponse(parsed);
      case "read-and-respond":
        return readAndRespond(parsed);
    }
  })();
  const resources = [...parsed.resources];
  for (const extra of generated.extraResources ?? []) {
    if (!resources.some((ref) => releaseKey(ref) === releaseKey(extra))) resources.push(extra);
  }
  const required = generated.steps.flatMap((s) => responseArtifactType(s.response) ?? []);
  const showWork: ArtifactType[] = parsed.template === "problem-set" && parsed.showWork ? ["image"] : [];
  return {
    template: parsed.template,
    title: parsed.title,
    subject: parsed.subject,
    gradeBand: parsed.gradeBand,
    overview: parsed.overview,
    steps: generated.steps,
    resources,
    codex: [...parsed.codex, ...(generated.extraCodex ?? [])],
    rubricSlots: generated.rubricSlots,
    aiHelp: parsed.aiHelp,
    permittedArtifactTypes: [...new Set([...required, ...showWork, ...parsed.additionalArtifactTypes])],
    ...(generated.citations === undefined ? {} : { citations: generated.citations }),
    due: parsed.due,
    evidence: {
      responseType: generated.responseType,
      criteria: generated.criteria,
      collaboration: parsed.collaboration,
      alignments: parsed.alignments,
    },
  };
}
