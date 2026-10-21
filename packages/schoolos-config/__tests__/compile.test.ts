import { CapabilityId } from "@schoolos/contracts";
import { describe, expect, it } from "vitest";
import { SHIPPED_REGISTRY, compileDistrictConfig, isCredentialKey, type CompileResult } from "../src/index.ts";
import { NF, northfieldDocument } from "./support.ts";

const id = (value: string) => CapabilityId.parse(value);

function problemsOf(result: CompileResult) {
  if (result.ok) throw new Error("expected the document to be rejected");
  return result.problems;
}

describe("compileDistrictConfig", () => {
  it("compiles the roadmap §4.1 document, pulling in dependencies and pinning versions", () => {
    const result = compileDistrictConfig(northfieldDocument(), SHIPPED_REGISTRY);
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    const { desired, installOrder } = result.compiled;

    expect(desired.modules[id("assessment-ci")]).toMatchObject({ state: "advisory", version: "0.9.0" });
    // Disabled means installed but off.
    expect(desired.modules[id("playtrek")]).toMatchObject({ state: "disabled" });
    // Not listed, but teacher-studio, content-studio, assessment-ci and playtrek need it.
    expect(desired.modules[id("learning-artifacts")]).toEqual({
      state: "enabled",
      version: "1.0.0",
      config: { storage: "r2", maxUploadMegabytes: 50, allowedTypes: ["document", "spreadsheet", "presentation", "image"] },
      requiredBy: ["assessment-ci", "content-studio", "playtrek", "teacher-studio"],
    });
    expect(installOrder.indexOf(id("learning-artifacts"))).toBeLessThan(installOrder.indexOf(id("assessment-ci")));
    expect(desired.policies).toEqual({
      aiSpending: "capped",
      promptsInGatewayLogs: "prohibited",
      studentPersonalConversations: "private",
      teacherObservation: "assigned-work-only",
      automatedSelProfiling: "prohibited",
      aiHelp: "hints-only",
      aiMonthlyCapCentsPerPrincipal: 200,
    });
  });

  it("refuses credentials by location without echoing them", () => {
    const document = northfieldDocument();
    // Assembled at runtime so the repository holds no token-shaped literal for scanners to flag.
    const token = ["ghp", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4"].join("_");
    document.modules["schoolos-lti"] = {
      state: "enabled",
      config: {
        platforms: [{ issuer: "https://lms.northfield.example", clientId: "nf-lms", deploymentId: "1", clientSecret: "hunter2-but-longer" }],
      },
    };
    document.modules["content-studio"] = { state: "enabled", config: { approver: token } };
    const problems = problemsOf(compileDistrictConfig(document, SHIPPED_REGISTRY));

    const secretProblems = problems.filter((p) => p.code === "secret-in-config");
    expect(secretProblems.map((p) => p.path)).toEqual([
      "/modules/content-studio/config/approver",
      "/modules/schoolos-lti/config/platforms/0/clientSecret",
    ]);
    const serialized = JSON.stringify(problems);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("hunter2");
  });

  it("does not mistake ordinary settings for credentials", () => {
    for (const key of ["clientId", "deploymentId", "promptsInGatewayLogs", "maxTokensPerRun", "keyStage", "tokenBudget"]) {
      expect(isCredentialKey(key), key).toBe(false);
    }
    for (const key of ["apiKey", "api_key", "client-secret", "password", "accessToken", "privateKey", "signingKey", "credentials"]) {
      expect(isCredentialKey(key), key).toBe(true);
    }
  });

  it("reports an unknown pack, bad pack config, unsupported advisory and a disabled dependency together", () => {
    const document = northfieldDocument();
    document.modules["learning-artifacts"] = "disabled";
    document.modules["core-learning"] = { state: "advisory", config: { closedCourseRetentionDays: 5 } };
    document.modules["ai-grader"] = "enabled";
    const problems = problemsOf(compileDistrictConfig(document, SHIPPED_REGISTRY));

    expect(problems.map((p) => [p.code, p.path])).toEqual(expect.arrayContaining([
      ["advisory-unsupported", "/modules/core-learning"],
      ["invalid-pack-config", "/modules/core-learning/config/closedCourseRetentionDays"],
      ["unknown-capability", "/modules/ai-grader"],
      ["dependency-disabled", "/modules/learning-artifacts"],
    ]));
    const disabled = problems.find((p) => p.code === "dependency-disabled")!;
    expect(disabled.message).toBe("learning-artifacts is disabled but assessment-ci, content-studio, teacher-studio depend on it");
  });

  it("allows a disabled dependency when everything that needs it is disabled too", () => {
    const document = northfieldDocument();
    document.modules = { "core-learning": "enabled", "learning-registry": "enabled", playtrek: "disabled", "learning-artifacts": "disabled" };
    expect(compileDistrictConfig(document, SHIPPED_REGISTRY).ok).toBe(true);
  });

  it("requires learning-registry for curriculum frameworks", () => {
    const document = northfieldDocument();
    document.modules = { "core-learning": "enabled" };
    expect(problemsOf(compileDistrictConfig(document, SHIPPED_REGISTRY)).map((p) => p.code)).toEqual([
      "curriculum-needs-learning-registry",
    ]);
  });

  it("lets narrower scopes tighten the floor and reports each loosening once, where it was attempted", () => {
    const document = northfieldDocument();
    document.overrides = [
      // Loosens: reported here, not again for the offering and activity beneath it.
      { scope: NF.high, policies: { teacherObservation: "assigned-work-and-shared-conversations", ai: { monthlyCapCentsPerPrincipal: 150 } } },
      { scope: NF.eng9, policies: { ai: { monthlyCapCentsPerPrincipal: 900, spending: "disabled" } } },
      { scope: NF.eng9Essay, policies: { automatedSelProfiling: "permitted-with-review" } },
    ];
    const problems = problemsOf(compileDistrictConfig(document, SHIPPED_REGISTRY));
    expect(problems).toEqual([
      {
        code: "policy-violation",
        path: "/overrides/0/policies",
        message: "a school override cannot loosen teacherObservation from assigned-work-only to assigned-work-and-shared-conversations",
      },
      {
        code: "policy-violation",
        path: "/overrides/1/policies",
        message: "a offering override cannot loosen aiMonthlyCapCentsPerPrincipal from 150 to 900",
      },
      {
        code: "policy-violation",
        path: "/overrides/2/policies",
        message: "a activity override cannot loosen automatedSelProfiling from prohibited to permitted-with-review",
      },
    ]);
  });

  it("resolves the effective policy at every override scope", () => {
    const document = northfieldDocument();
    document.overrides = [
      { scope: NF.high, policies: { ai: { monthlyCapCentsPerPrincipal: 150 } } },
      { scope: NF.eng9Essay, policies: { ai: { spending: "disabled" } } },
    ];
    const result = compileDistrictConfig(document, SHIPPED_REGISTRY);
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    const essay = result.compiled.effectivePolicies.find((p) => p.scope.level === "activity")!;
    expect(essay.effective).toMatchObject({ aiSpending: "disabled", aiMonthlyCapCentsPerPrincipal: 150 });
  });

  it("refuses an override in another district and a scope named twice", () => {
    const document = northfieldDocument();
    document.overrides = [
      { scope: { level: "school", districtId: "dst_riverbend", schoolId: "sch_rb-high" }, policies: {} },
      { scope: NF.middle, policies: {} },
      { scope: NF.middle, policies: { ai: { spending: "disabled" } } },
    ];
    expect(problemsOf(compileDistrictConfig(document, SHIPPED_REGISTRY)).map((p) => [p.code, p.path])).toEqual([
      ["scope-outside-district", "/overrides/0/scope"],
      ["duplicate-override", "/overrides/2/scope"],
    ]);
  });

  it("rejects unknown fields and a wrong apiVersion", () => {
    const document = northfieldDocument();
    document.apiVersion = "schoolos.dev/v2";
    document.rollout.autoApprove = true;
    const problems = problemsOf(compileDistrictConfig(document, SHIPPED_REGISTRY));
    expect(problems.map((p) => p.path)).toEqual(expect.arrayContaining(["/apiVersion", "/rollout"]));
    expect(problems.every((p) => p.code === "invalid-document")).toBe(true);
  });
});
