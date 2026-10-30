import { describe, expect, it } from "vitest";
import { demoDefinition, demoProvider } from "../examples/demo.ts";
import { digestJson } from "./canonical.ts";
import {
  exportWorkshopAssessmentBlueprint, importWorkshopAssessmentBlueprint,
  pinWorkshopAssessmentBlueprint, WORKSHOP_ASSESSMENT_FILE,
} from "./workshop.ts";

async function release() {
  const files: [string, string][] = [
    [WORKSHOP_ASSESSMENT_FILE, JSON.stringify(demoDefinition(await demoProvider()))],
    ["main.ts", "export default {}"],
  ];
  return { commitId: "a".repeat(40), files, sourceDigest: await digestJson(files) };
}

describe("Workshop public assessment pins", () => {
  it("extracts, freezes and roundtrips a public definition without local records", async () => {
    const source = await release();
    const pin = await pinWorkshopAssessmentBlueprint("blueprint-one", source);
    expect(pin.blueprint.commitId).toBe(source.commitId);
    expect(Object.isFrozen(pin.definition.tasks)).toBe(true);
    expect(await importWorkshopAssessmentBlueprint(JSON.parse(await exportWorkshopAssessmentBlueprint(pin)))).toEqual(pin);
    await expect(exportWorkshopAssessmentBlueprint({ ...pin, student: "private" })).rejects.toThrow();
    await expect(exportWorkshopAssessmentBlueprint({ ...pin, blueprint: { ...pin.blueprint, credentials: "secret" } })).rejects.toThrow();
  });

  it("fails closed for modified content, missing definitions and altered assessment pins", async () => {
    const source = await release();
    await expect(pinWorkshopAssessmentBlueprint("one", { ...source, files: [...source.files, ["new.ts", "changed"]] })).rejects.toThrow("source digest mismatch");
    await expect(pinWorkshopAssessmentBlueprint("one", { ...source, files: [...source.files, source.files[0]] })).rejects.toThrow("Duplicate");
    await expect(pinWorkshopAssessmentBlueprint("one", { ...source, files: [], sourceDigest: await digestJson([]) })).rejects.toThrow("no public assessment");
    const pin = await pinWorkshopAssessmentBlueprint("one", source);
    await expect(importWorkshopAssessmentBlueprint({ ...pin, definition: { ...pin.definition, title: "Changed" } })).rejects.toThrow("digest mismatch");
    await expect(pinWorkshopAssessmentBlueprint("one", { ...source, commitId: "latest" })).rejects.toThrow();
  });

  it("refuses keys hidden inside the public definition and keeps pins stable across updates", async () => {
    const source = await release();
    const first = await pinWorkshopAssessmentBlueprint("one", source);
    const definition = { ...first.definition, answerKey: "private" };
    const files = [[WORKSHOP_ASSESSMENT_FILE, JSON.stringify(definition)]];
    await expect(pinWorkshopAssessmentBlueprint("one", { ...source, files, sourceDigest: await digestJson(files) })).rejects.toThrow();
    const next = await pinWorkshopAssessmentBlueprint("one", { ...source, commitId: "b".repeat(40) });
    expect(first.blueprint.commitId).toBe("a".repeat(40));
    expect(next.blueprint.commitId).not.toBe(first.blueprint.commitId);
  });
});
