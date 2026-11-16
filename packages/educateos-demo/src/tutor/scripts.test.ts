import { describe, expect, it } from "vitest";
import { NORTHFIELD_SHOWCASE } from "@educateos/fixtures";
import { answer, scriptFor, TUTORS } from "./scripts.ts";

describe("the simulated tutors", () => {
  it("are the bundled blueprints' four tutors, one a band", () => {
    expect(Object.fromEntries(Object.entries(TUTORS).map(([band, t]) => [band, [t.name, t.band]]))).toStrictEqual({
      "K-2": ["Reading Buddy", "K-2"],
      "3-5": ["Homework Helper", "3-5"],
      "6-8": ["Study Coach", "6-8"],
      "9-12": ["Research & Essay Coach", "9-12"],
    });
  });

  it("script every showcase activity that allows help, with something allowed and something Hall Monitor redirects", () => {
    for (const course of NORTHFIELD_SHOWCASE.courses) {
      for (const activity of course.activities) {
        if (activity.aiHelp === "none") continue;
        const { exchanges } = scriptFor(course.band, activity.title);
        expect(exchanges.some((e) => e.screening.verdict === "allowed"), activity.title).toBe(true);
        expect(exchanges.some((e) => e.screening.verdict === "redirected"), activity.title).toBe(true);
      }
    }
  });

  it("answer a one-tap reply from the script, whatever its case", () => {
    expect(answer("K-2", "Retell The Little Seed", "give me a HINT").reply).toMatch(/starts with r-r-r/);
  });

  it("keep contact details and addresses out, with the tutor's own privacy reply", () => {
    const held = answer("6-8", "Ideas on the Move", "email me at chidi@example.com");
    expect(held.screening.verdict).toBe("held");
    expect(held.reply).toBe(TUTORS["6-8"].privacyReply);
  });

  it("say they follow a script when asked something off it", () => {
    const off = answer("9-12", "Anything", "What is the meaning of life?");
    expect(off.screening.verdict).toBe("unscripted");
    expect(off.reply).toMatch(/follows a script/);
  });
});
