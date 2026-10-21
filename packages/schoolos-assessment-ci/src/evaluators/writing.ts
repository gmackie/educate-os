// Built-in writing evaluators: required content, and word count and section structure.
import { z } from "zod";
import { defineEvaluator, type CriterionEvidence, type EvaluationArtifact, type Excerpt, type TextRange } from "../sdk.ts";
import { countWords, findPhrase, findSection, sections } from "../text.ts";

/** Text a teacher wrote into a config: a phrase or a heading. */
const ConfigText = z.string().trim().min(1).max(200);

/** The text documents the writing evaluators read. */
export const WRITTEN_WORK = { artifactTypes: ["document"], mediaTypes: ["text/markdown", "text/plain"] } as const;

/** An excerpt of `artifact` at `range`. */
export function excerptOf(artifact: EvaluationArtifact, range: TextRange): Excerpt {
  return { artifact: artifact.artifactId, revision: artifact.revisionId, range };
}

/**
 * `content.required`: each listed item appears in the work, as any one of its phrases (matched
 * literally, ignoring case and spacing), optionally within a named section.
 */
export const contentRequired = defineEvaluator({
  id: "content.required",
  release: "1.0.0",
  accepts: WRITTEN_WORK,
  answerKeyed: false,
  config: z.strictObject({
    items: z.array(z.strictObject({
      label: ConfigText,
      anyOf: z.array(ConfigText).min(1).max(20),
      section: ConfigText.optional(),
    })).min(1).max(50),
  }),
  evaluate(input, config, kit) {
    return config.items.map((item) => {
      for (const artifact of input.artifacts) {
        const all = sections(artifact.text, kit);
        const section = item.section === undefined ? undefined : findSection(all, item.section);
        if (item.section !== undefined && section === undefined) continue;
        const range = section?.body ?? { start: 0, end: artifact.text.length };
        for (const phrase of item.anyOf) {
          const found = findPhrase(artifact.text, phrase, range, kit);
          if (found !== undefined) {
            return {
              criterionId: input.criterionId,
              observation: `${item.label}: present`,
              passed: true,
              excerpts: [excerptOf(artifact, found)],
              explanation: `The work contains "${artifact.text.slice(found.start, found.end)}"${item.section === undefined ? "" : ` in the ${item.section} section`}.`,
            };
          }
        }
      }
      return {
        criterionId: input.criterionId,
        observation: `${item.label}: missing`,
        passed: false,
        excerpts: [],
        explanation: `None of ${item.anyOf.map((p) => `"${p}"`).join(", ")} appears${item.section === undefined ? "" : ` in a section titled ${item.section}`}.`,
      };
    });
  },
});

/**
 * `writing.structure`: the word count is within bounds, not counting headings or the sections
 * named in `countExcludes` (such as the works cited), and each required section has a heading.
 */
export const writingStructure = defineEvaluator({
  id: "writing.structure",
  release: "1.0.0",
  accepts: WRITTEN_WORK,
  answerKeyed: false,
  config: z.strictObject({
    minWords: z.int().nonnegative().max(1_000_000).optional(),
    maxWords: z.int().positive().max(1_000_000).optional(),
    countExcludes: z.array(ConfigText).max(20).default([]),
    requiredSections: z.array(ConfigText).max(50).default([]),
  }).refine((c) => c.minWords === undefined || c.maxWords === undefined || c.minWords <= c.maxWords, "minWords is at most maxWords")
    .refine((c) => c.minWords !== undefined || c.maxWords !== undefined || c.requiredSections.length > 0, "check a word count or at least one section"),
  evaluate(input, config, kit) {
    const evidence: CriterionEvidence[] = [];
    if (config.minWords !== undefined || config.maxWords !== undefined) {
      let words = 0;
      for (const artifact of input.artifacts) {
        const all = sections(artifact.text, kit);
        words += countWords(artifact.text, { start: 0, end: artifact.text.length }, kit);
        for (const title of config.countExcludes) {
          const excluded = findSection(all, title);
          if (excluded !== undefined) words -= countWords(artifact.text, excluded.body, kit);
        }
      }
      const min = config.minWords ?? 0;
      const max = config.maxWords ?? Number.POSITIVE_INFINITY;
      const bounds = config.maxWords === undefined ? `at least ${min}` : config.minWords === undefined ? `at most ${max}` : `${min} to ${max}`;
      const excluded = config.countExcludes.length === 0 ? "" : `, not counting ${config.countExcludes.join(", ")}`;
      evidence.push({
        criterionId: input.criterionId,
        observation: `${words} words${excluded}`,
        passed: words >= min && words <= max,
        score: words < min ? words / min : words > max ? max / words : 1,
        excerpts: [],
        explanation: `The work has ${words} words; ${bounds} are expected.`,
      });
    }
    for (const title of config.requiredSections) {
      const found = input.artifacts.flatMap((artifact) => {
        const section = findSection(sections(artifact.text, kit), title);
        return section === undefined ? [] : [{ artifact, section }];
      })[0];
      evidence.push(found === undefined
        ? { criterionId: input.criterionId, observation: `No ${title} section`, passed: false, excerpts: [], explanation: `No heading titled "${title}" was found.` }
        : {
            criterionId: input.criterionId,
            observation: `${title} section present`,
            passed: true,
            excerpts: [excerptOf(found.artifact, found.section.heading)],
            explanation: `The heading "${found.section.title}" starts the ${title} section.`,
          });
    }
    return evidence;
  },
});
