// SCHO-328: the story tour's long screens scroll to what the step is about, and the family step
// opens Mateo's page.
import { describe, expect, it } from "vitest";
import { STORY_STEPS } from "./storyTour.ts";

const step = (id: string) => STORY_STEPS.find((s) => s.id === id)!;

describe("the K-12 story tour", () => {
  it("scrolls to the tutor on the grade 4 activity and to the feedback on the grade 7 and grade 9 ones", () => {
    expect(step("g35-student").reveal).toBe("[data-slot=\"ai-help\"]");
    expect(step("g68-student").reveal).toBe("section[aria-labelledby=\"feedback\"]");
    expect(step("g912-student").reveal).toBe("section[aria-labelledby=\"feedback\"]");
    expect(STORY_STEPS.filter((s) => s.reveal !== undefined).map((s) => s.id)).toStrictEqual(["g35-student", "g68-student", "g912-student"]);
  });

  it("opens the family step at Mateo's page", async () => {
    expect(await step("guardian").route(undefined as never)).toBe("#/family/children/prn_nf-student-mateo");
  });
});
