// @vitest-environment node
// Study Coach (6-8): the shared tutor checks, Socratic math, and draft feedback without rewriting.
import { describe, expect, it } from "vitest";
import { checkTutor } from "../../../libraries/tutor/__tests__/persona-checks.ts";
import { PERSONA } from "../files/lib/persona.ts";

describe("Study Coach", () => {
  const prompt = checkTutor(PERSONA, new URL("../", import.meta.url));

  it("teaches math with questions instead of solving", () => {
    expect(prompt).toMatch(/Socratically/);
    expect(prompt).toMatch(/do not solve the problem/);
    expect(prompt).toMatch(/one guiding question at a time/);
    expect(prompt).toMatch(/help them spot the error themselves/);
    expect(prompt).toMatch(/worked example only for a different, simpler problem/);
  });

  it("gives feedback on a draft without rewriting it", () => {
    expect(prompt).toMatch(/one specific strength, then at most two next steps/);
    expect(prompt).toMatch(/Never rewrite their sentences/);
    expect(prompt).toMatch(/thinking and writing must be their own/);
  });
});
