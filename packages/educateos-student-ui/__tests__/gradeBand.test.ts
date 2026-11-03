// SCHO-323: which classes get the young-learner page, read-aloud and the drawing pad.
import { describe, expect, it } from "vitest";
import { gradeRange, isElementaryBand, isYoungLearnerBand } from "../src/gradeBand.ts";

describe("grade bands", () => {
  it("reads the district's bands and the looser ones teachers type", () => {
    expect(gradeRange("K")).toStrictEqual({ low: 0, high: 0 });
    expect(gradeRange("K-2")).toStrictEqual({ low: 0, high: 2 });
    expect(gradeRange("9-12")).toStrictEqual({ low: 9, high: 12 });
    expect(gradeRange("k – 2")).toStrictEqual({ low: 0, high: 2 });
    expect(gradeRange("Grade 2")).toStrictEqual({ low: 2, high: 2 });
    expect(gradeRange("1 to 3")).toStrictEqual({ low: 1, high: 3 });
    expect(gradeRange("PK-K")).toStrictEqual({ low: 0, high: 0 });
    expect(gradeRange("5-3")).toStrictEqual({ low: 3, high: 5 });
    for (const junk of [undefined, "", "high school", "K-2-4", "13a"]) expect(gradeRange(junk)).toBeUndefined();
  });

  it("gives K-2, and bands reaching only into grade 3, the young-learner page", () => {
    for (const band of ["K", "1", "2", "K-2", "1-2", "K-3", "2-3"]) expect(isYoungLearnerBand(band), band).toBe(true);
    for (const band of ["3", "3-5", "K-5", "6-8", "9-12", "nonsense", undefined]) expect(isYoungLearnerBand(band), String(band)).toBe(false);
  });

  it("offers read-aloud and drawing in any band with elementary grades", () => {
    for (const band of ["K", "3-5", "5", "K-8"]) expect(isElementaryBand(band), band).toBe(true);
    for (const band of ["6", "6-8", "9-12", undefined]) expect(isElementaryBand(band), String(band)).toBe(false);
  });
});
