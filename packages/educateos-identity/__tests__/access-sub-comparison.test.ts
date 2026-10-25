import { describe, expect, it } from "vitest";
import { analyzeStudy, type StudyObservation, type StudyStep } from "../scripts/access-sub-comparison.ts";

const ISS = "https://northfield-test.cloudflareaccess.com";
const A_UPSTREAM = "idp-user-a";
const B_UPSTREAM = "idp-user-b";

const person = (step: StudyStep) => (step === "s4-reassigned" || step === "s5-after-delete" ? "b" : "a");

/** A full recording; `subs` overrides the Access `sub` per step. */
function recording(subs: Partial<Record<StudyStep, string>>): StudyObservation[] {
  const base: Record<StudyStep, string> = {
    "s1-baseline": "sub-1",
    "s2-repeat": "sub-1",
    "s3-rename": "sub-1",
    "s4-reassigned": "sub-2",
    "s5-after-delete": "sub-2",
    ...subs,
  };
  return (Object.keys(base) as StudyStep[]).map((step) => ({
    step,
    person: person(step),
    claims: { iss: ISS, sub: base[step], email: "teacher@northfield.example" },
    identity: { oidc_fields: { sub: person(step) === "a" ? A_UPSTREAM : B_UPSTREAM } },
  }));
}

describe("analyzeStudy", () => {
  it("accepts Access sub as the subject when it follows the IdP account", () => {
    const report = analyzeStudy(recording({}));
    expect(report.outcome).toBe("sub-follows-idp-account");
    expect(report.findings.upstreamSubjectReassigned).toBe("different");
    expect(report.problems).toEqual([]);
  });

  it("flags a reassigned address that inherits the previous holder's sub until the Access user is deleted", () => {
    const report = analyzeStudy(recording({ "s4-reassigned": "sub-1", "s5-after-delete": "sub-3" }));
    expect(report.findings.reassignedSub).toBe("same");
    expect(report.outcome).toBe("sub-keyed-by-email-delete-resets");
  });

  it("flags a sub that survives deleting the Access user", () => {
    const report = analyzeStudy(recording({ "s4-reassigned": "sub-1", "s5-after-delete": "sub-1" }));
    expect(report.outcome).toBe("sub-keyed-by-email-sticky");
  });

  it("reports a rename that splits one person into two", () => {
    expect(analyzeStudy(recording({ "s3-rename": "sub-9" })).outcome).toBe("sub-splits-on-rename");
  });

  it("invalidates the run when sub moves with nothing changed", () => {
    const report = analyzeStudy(recording({ "s2-repeat": "sub-7" }));
    expect(report.outcome).toBe("invalid-run");
    expect(report.problems.join(" ")).toContain("control failed");
  });

  it("invalidates the run when a step is missing, duplicated, or recorded for the wrong person", () => {
    const full = recording({});
    expect(analyzeStudy(full.filter((o) => o.step !== "s5-after-delete")).outcome).toBe("invalid-run");
    expect(analyzeStudy([...full, full[0]!]).outcome).toBe("invalid-run");
    expect(analyzeStudy(full.map((o) => (o.step === "s4-reassigned" ? { ...o, person: "a" } : o))).outcome).toBe("invalid-run");
  });

  it("refuses tokens from two team domains and service tokens with no sub", () => {
    const full = recording({});
    const mixed = full.map((o) => (o.step === "s2-repeat" ? { ...o, claims: { ...o.claims, iss: "https://riverbend-test.cloudflareaccess.com" } } : o));
    expect(analyzeStudy(mixed).problems).toContain("The tokens come from more than one Access team domain.");
    const service = full.map((o) => (o.step === "s1-baseline" ? { ...o, claims: { ...o.claims, sub: "" } } : o));
    expect(analyzeStudy(service).outcome).toBe("invalid-run");
  });

  it("never echoes an email address in its report", () => {
    expect(JSON.stringify(analyzeStudy(recording({})))).not.toContain("@");
  });
});
