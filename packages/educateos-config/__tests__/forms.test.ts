import { CapabilityId, EducateOsError } from "@educateos/contracts";
import { describe, expect, it } from "vitest";
import { SHIPPED_REGISTRY, formFields } from "../src/index.ts";

const schemaOf = (name: string) => SHIPPED_REGISTRY.packs.get(CapabilityId.parse(name))!.manifest.configSchema;

describe("formFields", () => {
  it("covers every shipped pack's schema", () => {
    for (const [packId, pack] of SHIPPED_REGISTRY.packs) {
      expect(() => formFields(pack.manifest.configSchema), packId).not.toThrow();
    }
  });

  it("describes each setting from the manifest schema alone", () => {
    expect(formFields(schemaOf("assessment-ci"))).toEqual([
      {
        path: "evaluators",
        label: "Evaluators",
        type: "multi-select",
        options: ["presence", "structure", "citation-format", "spreadsheet-assertions", "dataset-structure"],
        required: false,
        default: ["presence", "structure"],
      },
      {
        path: "aiFeedback",
        label: "AI writing feedback",
        description: "Add AI feedback with excerpt-level evidence that a teacher can override.",
        type: "boolean",
        required: false,
        default: false,
        governance: "ai",
      },
      {
        path: "sandboxExecution",
        label: "Sandboxed code execution",
        description: "Run executable checks in isolated CI with restricted egress.",
        type: "boolean",
        required: false,
        default: false,
      },
      { path: "maxRunSeconds", label: "Max run seconds", type: "integer", required: false, default: 60, minimum: 5, maximum: 600 },
    ]);
  });

  it("flattens a list of objects, marking item fields required inside each item", () => {
    expect(formFields(schemaOf("educateos-lti"))).toEqual([
      { path: "platforms", label: "LMS platforms", type: "list", required: false, default: [] },
      { path: "platforms[].issuer", label: "Issuer", type: "url", required: true },
      { path: "platforms[].clientId", label: "Client id", type: "string", required: true },
      { path: "platforms[].deploymentId", label: "Deployment id", type: "string", required: true },
    ]);
  });

  it("refuses schema features it cannot render rather than dropping the field", () => {
    const schema = { type: "object", properties: { anything: { anyOf: [{ type: "string" }, { type: "integer" }] } } };
    expect(() => formFields(schema)).toThrow(EducateOsError);
    const governedText = { type: "object", properties: { note: { type: "string", "x-educateos-governance": "ai" } } };
    expect(() => formFields(governedText)).toThrow(/governance/);
  });
});
