// The built-in citation format evaluator. It checks the *form* of citations only, never whether a
// source exists or says what the work claims: that is the teacher's judgement.
import { z } from "zod";
import { defineEvaluator, type CriterionEvidence, type EvaluationArtifact, type EvaluationKit, type Excerpt } from "../sdk.ts";
import { findSection, lines, sections } from "../text.ts";
import { WRITTEN_WORK, excerptOf } from "./writing.ts";

/** A citation style whose form can be checked. */
export const CitationStyle = z.enum(["mla", "apa"]);
/** A citation style. */
export type CitationStyle = z.infer<typeof CitationStyle>;

const STYLE_NAMES: Record<CitationStyle, string> = { mla: "MLA", apa: "APA" };

// None of these patterns nests a quantifier over characters a neighbour can also match, so each
// runs in linear time on a line.
const AUTHOR = String.raw`\p{Lu}[\p{L}'’-]+`;
const IN_TEXT: Record<CitationStyle, readonly RegExp[]> = {
  // (Smith 23), (Smith and Lee 23-25), (Smith et al. 4)
  mla: [new RegExp(String.raw`\(${AUTHOR}(?: and ${AUTHOR}| et al\.)? \d+(?:[-–]\d+)?\)`, "gu")],
  // (Smith, 2020), (Smith & Lee, 2020, p. 4), and narrative Smith (2020)
  apa: [
    new RegExp(String.raw`\(${AUTHOR}(?: (?:&|and) ${AUTHOR}| et al\.)?, (?:\d{4}[a-z]?|n\.d\.)(?:, pp?\. \d+(?:[-–]\d+)?)?\)`, "gu"),
    new RegExp(String.raw`${AUTHOR}(?: (?:&|and) ${AUTHOR}| et al\.)? \((?:\d{4}[a-z]?|n\.d\.)\)`, "gu"),
  ],
};
const ENTRY: Record<CitationStyle, RegExp> = {
  // Smith, Jane. Title of Work. Publisher, 2019.
  mla: new RegExp(String.raw`^${AUTHOR}, \p{L}[\p{L}.'’ -]*\. .+\.$`, "u"),
  // Smith, J. (2019). Title of work. Publisher.  /  Smith, J., & Lee, K. (2019). ...
  apa: new RegExp(String.raw`^${AUTHOR}, (?:\p{Lu}\.\s?)+(?:, .+?)? \((?:\d{4}[a-z]?|n\.d\.)\)\. .+$`, "u"),
};
/** Longer reference lines are reported as malformed rather than matched. */
const MAX_ENTRY_LENGTH = 500;
const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/;

interface Found {
  artifact: EvaluationArtifact;
  start: number;
  end: number;
}

function inTextCitations(style: CitationStyle, artifact: EvaluationArtifact, skip: { start: number; end: number } | undefined, kit: EvaluationKit): Found[] {
  const found: Found[] = [];
  for (const pattern of IN_TEXT[style]) {
    kit.step(Math.ceil(artifact.text.length / 64) + 1);
    for (const match of artifact.text.matchAll(pattern)) {
      kit.step();
      const start = match.index;
      if (skip !== undefined && start >= skip.start && start < skip.end) continue;
      if (found.some((f) => start < f.end && f.start < start + match[0].length)) continue;
      found.push({ artifact, start, end: start + match[0].length });
    }
  }
  return found.toSorted((a, b) => a.start - b.start);
}

function excerpts(found: readonly Found[]): Excerpt[] {
  return found.slice(0, 5).map((f) => excerptOf(f.artifact, { start: f.start, end: f.end }));
}

function quoted(found: readonly Found[]): string {
  const shown = found.slice(0, 3).map((f) => f.artifact.text.slice(f.start, f.end)).join(", ");
  return found.length > 3 ? `${shown} and ${found.length - 3} more` : shown;
}

/**
 * `citation.format`: in-text citations and the reference list follow MLA or APA form. It reports
 * how many in-text citations have the style's form, any in the other style's form, and whether each
 * reference-list entry is well formed.
 */
export const citationFormat = defineEvaluator({
  id: "citation.format",
  release: "1.0.0",
  accepts: WRITTEN_WORK,
  answerKeyed: false,
  config: z.strictObject({
    style: CitationStyle,
    minInText: z.int().nonnegative().max(1000).default(1),
    /** The heading of the reference list: "Works Cited" for MLA, "References" for APA. */
    referenceSection: z.string().trim().min(1).max(200),
    minReferences: z.int().nonnegative().max(1000).default(1),
  }),
  evaluate(input, config, kit) {
    const name = STYLE_NAMES[config.style];
    const other: CitationStyle = config.style === "mla" ? "apa" : "mla";
    const citations: Found[] = [];
    const otherStyle: Found[] = [];
    const entries: Found[] = [];
    const malformed: Found[] = [];
    let referenceList: { artifact: EvaluationArtifact; start: number; end: number } | undefined;

    for (const artifact of input.artifacts) {
      const list = findSection(sections(artifact.text, kit), config.referenceSection);
      citations.push(...inTextCitations(config.style, artifact, list?.body, kit));
      otherStyle.push(...inTextCitations(other, artifact, list?.body, kit));
      if (list === undefined) continue;
      referenceList ??= { artifact, ...list.heading };
      for (const line of lines(artifact.text.slice(list.body.start, list.body.end), kit)) {
        const entry = line.text.replace(LIST_MARKER, "").trim();
        if (entry === "") continue;
        kit.step(Math.ceil(entry.length / 16));
        const at = { artifact, start: list.body.start + line.start, end: list.body.start + line.end };
        entries.push(at);
        if (entry.length > MAX_ENTRY_LENGTH || !ENTRY[config.style].test(entry)) malformed.push(at);
      }
    }

    const evidence: CriterionEvidence[] = [
      {
        criterionId: input.criterionId,
        observation: `${citations.length} in-text ${name} citation${citations.length === 1 ? "" : "s"}`,
        passed: citations.length >= config.minInText,
        excerpts: excerpts(citations),
        explanation: citations.length === 0
          ? `No in-text citation has ${name} form; at least ${config.minInText} expected.`
          : `Found ${quoted(citations)}; at least ${config.minInText} expected.`,
      },
      otherStyle.length === 0
        ? { criterionId: input.criterionId, observation: `No citations in ${STYLE_NAMES[other]} form`, passed: true, excerpts: [], explanation: `Every in-text citation found uses ${name} form.` }
        : {
            criterionId: input.criterionId,
            observation: `${otherStyle.length} in-text citation${otherStyle.length === 1 ? "" : "s"} in ${STYLE_NAMES[other]} form`,
            passed: false,
            excerpts: excerpts(otherStyle),
            explanation: `${quoted(otherStyle)} ${otherStyle.length === 1 ? "has" : "have"} ${STYLE_NAMES[other]} form, but this work uses ${name}.`,
          },
    ];
    if (referenceList === undefined) {
      evidence.push({
        criterionId: input.criterionId,
        observation: `No ${config.referenceSection} section`,
        passed: false,
        excerpts: [],
        explanation: `No heading titled "${config.referenceSection}" was found, so there is no reference list to check.`,
      });
    } else {
      const wellFormed = entries.length - malformed.length;
      evidence.push({
        criterionId: input.criterionId,
        observation: `${wellFormed} of ${entries.length} ${config.referenceSection} entries in ${name} form`,
        passed: entries.length >= config.minReferences && malformed.length === 0,
        score: entries.length === 0 ? 0 : wellFormed / entries.length,
        excerpts: malformed.length === 0 ? [excerptOf(referenceList.artifact, { start: referenceList.start, end: referenceList.end })] : excerpts(malformed),
        explanation: malformed.length === 0
          ? `Every entry has ${name} form; at least ${config.minReferences} expected.`
          : `${malformed.length} entr${malformed.length === 1 ? "y does" : "ies do"} not have ${name} form (author, then ${config.style === "mla" ? "title and publication details ending in a period" : "initials, the year in parentheses and the title"}).`,
      });
    }
    return evidence;
  },
});
