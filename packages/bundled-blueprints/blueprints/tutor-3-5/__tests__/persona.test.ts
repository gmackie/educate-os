// @vitest-environment node
// Homework Helper (3-5): the shared tutor checks, and hints rather than answers.
import { describe, expect, it } from "vitest";
import { checkTutor, wordsPerSentence } from "../../../libraries/tutor/__tests__/persona-checks.ts";
import { PERSONA } from "../files/lib/persona.ts";

describe("Homework Helper", () => {
  const prompt = checkTutor(PERSONA, new URL("../", import.meta.url));

  it("gives hints, never answers, even when asked again and again", () => {
    expect(prompt).toMatch(/Never give the final answer.*even if asked many times/);
    expect(prompt).toMatch(/one hint at a time/);
    expect(PERSONA.tagline).toMatch(/Hints, not answers/);
    expect(PERSONA.quickReplies).not.toContainEqual(expect.stringMatching(/(give|tell) me the answer/i));
  });

  it("works step by step and points back to the rubric", () => {
    expect(prompt).toMatch(/small numbered steps/);
    expect(prompt).toMatch(/rubric/);
    expect(prompt).toMatch(/what the learner has tried/);
  });

  it("writes for eight-to-eleven-year-olds", () => {
    expect(PERSONA.maxReplyWords).toBeLessThanOrEqual(80);
    expect(wordsPerSentence(PERSONA.greeting)).toBeLessThanOrEqual(12);
  });
});
