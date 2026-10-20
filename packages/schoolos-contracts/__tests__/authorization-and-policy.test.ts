import { describe, expect, it } from "vitest";
import {
  CapabilityManifest,
  ConfigurationScope,
  PolicySettings,
  SchoolOsError,
  precheckAuthorization,
  resolvePolicy,
} from "../src/index";

const request = (overrides: Record<string, unknown> = {}) => ({
  subject: { principalId: "prn_student-a", districtId: "dst_one" },
  action: "read",
  resource: {
    kind: "artifact",
    id: "art_essay",
    scope: { level: "offering", districtId: "dst_one", schoolId: "sch_a", offeringId: "off_1" },
    classification: "course",
    ownerPrincipalId: "prn_student-b",
  },
  context: { channel: "mcp-tool" },
  ...overrides,
});

describe("precheckAuthorization", () => {
  it("passes a well-formed same-district request on to the policy engine", () => {
    expect(precheckAuthorization(request()).ok).toBe(true);
  });

  it("denies an unknown action or resource kind instead of guessing", () => {
    expect(precheckAuthorization(request({ action: "sudo" }))).toEqual({
      ok: false,
      decision: { effect: "deny", reason: "invalid-request" },
    });
    const bad = request();
    (bad.resource as Record<string, unknown>).kind = "everything";
    expect(precheckAuthorization(bad).ok).toBe(false);
  });

  it("denies a request that smuggles extra claims such as a role or readOnlyHint", () => {
    expect(precheckAuthorization(request({ role: "district-admin" })).ok).toBe(false);
    expect(precheckAuthorization(request({ context: { channel: "mcp-tool", readOnlyHint: true } })).ok).toBe(false);
  });

  it("denies a subject reaching into another district", () => {
    expect(precheckAuthorization(request({ subject: { principalId: "prn_student-a", districtId: "dst_two" } })))
      .toEqual({ ok: false, decision: { effect: "deny", reason: "cross-district" } });
  });
});

describe("resolvePolicy", () => {
  const district = PolicySettings.parse({
    aiSpending: "capped",
    promptsInGatewayLogs: "prohibited",
    studentPersonalConversations: "private",
    teacherObservation: "assigned-work-only",
    automatedSelProfiling: "prohibited",
    aiMonthlyCapCentsPerPrincipal: 500,
  });

  it("lets narrower levels tighten the floor", () => {
    const result = resolvePolicy(district, [
      { level: "offering", settings: { aiMonthlyCapCentsPerPrincipal: 100 } },
      { level: "school", settings: { aiMonthlyCapCentsPerPrincipal: 300 } },
      { level: "activity", settings: { aiSpending: "disabled" } },
    ]);
    expect(result).toEqual({
      ok: true,
      effective: { ...district, aiMonthlyCapCentsPerPrincipal: 100, aiSpending: "disabled" },
    });
  });

  it("refuses every loosening, measured against the tightest wider level", () => {
    const result = resolvePolicy(district, [
      { level: "school", settings: { aiMonthlyCapCentsPerPrincipal: 200 } },
      { level: "offering", settings: { aiMonthlyCapCentsPerPrincipal: 400, teacherObservation: "assigned-work-and-shared-conversations" } },
    ]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.violations).toEqual([
      { level: "offering", key: "aiMonthlyCapCentsPerPrincipal", floor: 200, requested: 400 },
      { level: "offering", key: "teacherObservation", floor: "assigned-work-only", requested: "assigned-work-and-shared-conversations" },
    ]);
  });

  it("requires the district floor to be complete", () => {
    expect(PolicySettings.safeParse({ aiSpending: "capped" }).success).toBe(false);
  });
});

describe("capability manifests and configuration scopes", () => {
  const manifest = {
    id: "assessment-ci",
    version: "0.1.0",
    description: "Deterministic assessment evidence for submitted work.",
    dependencies: [{ id: "learning-artifacts", versionRange: "^0.1.0" }],
    configSchema: { type: "object" },
    supportedScopes: ["district", "offering"],
    permissionScopes: ["assessment-run:create", "submission:read"],
    requiredResources: ["durable-object", "r2"],
    migrations: [],
    probes: ["assessment-ci.health"],
    estimatedCostDrivers: ["runs per submission"],
  };

  it("accepts a well-formed manifest", () => {
    expect(CapabilityManifest.safeParse(manifest).success).toBe(true);
  });

  it("rejects unknown scopes, resources and fields", () => {
    expect(CapabilityManifest.safeParse({ ...manifest, supportedScopes: ["planet"] }).success).toBe(false);
    expect(CapabilityManifest.safeParse({ ...manifest, requiredResources: ["mainframe"] }).success).toBe(false);
    expect(CapabilityManifest.safeParse({ ...manifest, installScript: "curl … | sh" }).success).toBe(false);
  });

  it("requires an offering-level configuration to name its school", () => {
    expect(ConfigurationScope.safeParse({ districtId: "dst_one", offeringId: "off_1" }).success).toBe(false);
    expect(ConfigurationScope.safeParse({ districtId: "dst_one", schoolId: "sch_a", offeringId: "off_1" }).success).toBe(true);
  });
});

describe("SchoolOsError", () => {
  it("serializes only its code, message and correlation ID", () => {
    expect(new SchoolOsError("not-found", "No such artifact.", "corr-1").toBody())
      .toEqual({ code: "not-found", message: "No such artifact.", correlationId: "corr-1" });
    expect(new SchoolOsError("forbidden", "No.").toBody()).toEqual({ code: "forbidden", message: "No." });
  });
});
