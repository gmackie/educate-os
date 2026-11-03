// @vitest-environment node
// Reading Buddy (K-2): the shared tutor checks, and what makes it right for five-to-eight-year-olds.
import { describe, expect, it } from "vitest";
import { checkTutor, wordsPerSentence } from "../../../libraries/tutor/__tests__/persona-checks.ts";
import { PERSONA } from "../files/lib/persona.ts";

describe("Reading Buddy", () => {
  const prompt = checkTutor(PERSONA, new URL("../", import.meta.url));

  it("asks one short question at a time, praises effort and sticks to the story", () => {
    expect(prompt).toMatch(/exactly one short question at a time/);
    expect(prompt).toMatch(/Praise effort/);
    expect(prompt).toMatch(/story or reading topic/);
    expect(prompt).toMatch(/Never ask the child's name, age, school, where they live/);
  });

  it("writes at a young child's reading level, and briefly", () => {
    expect(PERSONA.readingLevel).toMatch(/at most eight words/);
    expect(PERSONA.maxReplyWords).toBeLessThanOrEqual(40);
    for (const line of [PERSONA.greeting, PERSONA.privacyReply, ...PERSONA.quickReplies]) {
      expect(wordsPerSentence(line), line).toBeLessThanOrEqual(8);
    }
  });

  it("reads every reply aloud, with big type and big one-tap buttons", () => {
    expect(PERSONA.readAloud).toBe(true);
    expect(PERSONA.theme.fontSize).toBeGreaterThanOrEqual(22);
    expect(PERSONA.quickReplies.length).toBeGreaterThanOrEqual(4);
  });
});
