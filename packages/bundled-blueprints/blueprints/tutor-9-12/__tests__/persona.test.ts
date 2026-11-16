// @vitest-environment node
// Research & Essay Coach (9-12): the shared tutor checks, argument structure, citation checks and
// academic integrity.
import { describe, expect, it } from "vitest";
import { checkTutor } from "../../../libraries/tutor/__tests__/persona-checks.ts";
import { PERSONA } from "../files/lib/persona.ts";

describe("Research & Essay Coach", () => {
  const prompt = checkTutor(PERSONA, new URL("../", import.meta.url));

  it("coaches argument structure: claim, evidence, reasoning, counterargument", () => {
    for (const term of ["claim", "evidence", "reasoning", "counterargument"]) expect(prompt).toContain(term);
    expect(prompt).toMatch(/arguable and specific/);
  });

  it("checks citations, and never invents a source", () => {
    expect(prompt).toMatch(/MLA, APA or Chicago/);
    expect(prompt).toMatch(/quotes are exact and in quotation marks/);
    expect(prompt).toMatch(/Never invent a source, quote, statistic, author or page number/);
    expect(prompt).toMatch(/cannot open links/);
  });

  it("protects academic integrity: it coaches, the learner writes", () => {
    expect(prompt).toMatch(/Never write an essay, paragraph, thesis or conclusion for the learner to submit/);
    expect(prompt).toMatch(/teacher's rules on using AI/);
    expect(PERSONA.helpNote).toMatch(/rules on AI use/);
  });
});
