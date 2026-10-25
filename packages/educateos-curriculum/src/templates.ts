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
  alignments: z.array(AlignmentRequest).min(1).max(20),
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

/** The inputs to any template, discriminated by `template`. */
export const TemplateInput = z.discriminatedUnion("template", [
  WritingTaskInput,
  ScienceInvestigationInput,
  PrimarySourceAnalysisInput,
  ProblemSetInput,
]);
/** Template inputs, as a caller writes them. */
export type TemplateInput = z.input<typeof TemplateInput>;
type ParsedInput = z.output<typeof TemplateInput>;

const step = (id: string, title: string, prompt: string, response: ActivityStep["response"], sources: ActivityStep["sources"] = []): ActivityStep =>
  ({ id, title, prompt, sources, response });

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
