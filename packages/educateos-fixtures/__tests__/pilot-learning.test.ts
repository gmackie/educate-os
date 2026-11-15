import { describe, expect, it } from "vitest";
import { checkDirectoryIntegrity } from "@educateos/contracts";
import { PILOT_LEARNING, PILOT_PERSONAS, PL } from "../src/index.ts";

describe("Pilot Lakes (synthetic)", () => {
  it("is internally consistent and shares nothing with the demo districts", () => {
    expect(checkDirectoryIntegrity(PILOT_LEARNING)).toEqual([]);
    expect(PILOT_LEARNING.principals.every((p) => p.externalIdentities.every((i) => i.issuer.endsWith(".example")))).toBe(true);
  });

  it("scripts every persona against a real class and an active student", () => {
    const active = new Set(PILOT_LEARNING.enrollments.filter((e) => e.status === "active" && e.role === "student").map((e) => `${e.offeringId}/${e.principalId}`));
    for (const persona of PILOT_PERSONAS) expect(active.has(`${persona.offeringId}/${persona.principalId}`), persona.key).toBe(true);
    expect(PILOT_PERSONAS.filter((p) => p.expectedCodes.length === 0).map((p) => p.key)).toEqual(["no-alignment", "grade-five"]);
  });

  it("keeps a dropped student and a K-5 class available for refusal checks", () => {
    expect(PILOT_LEARNING.enrollments.find((e) => e.principalId === PL.quinn)!.status).toBe("inactive");
    expect(PILOT_LEARNING.courses.find((c) => c.id === "crs_pl-science-5")!.gradeBand).toBe("5");
  });
});
