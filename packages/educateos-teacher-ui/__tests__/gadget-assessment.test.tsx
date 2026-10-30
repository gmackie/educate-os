import { webcrypto } from "node:crypto";
import { screen } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseAssessment } from "@educateos/assessment-sdk";
import { fakeDistrict, IDS } from "./fakeDistrict.ts";
import { renderApp } from "./render.tsx";

const setup = () => {
  const district = fakeDistrict();
  const assignmentId = district.assignStepActivity("Gadget argument", [{ id: "draft", title: "Draft", kind: "writing" }], {
    rubricId: "rbr_gadget", version: 1, title: "Argument", criteria: [{ id: "reason", title: "Reason", levels: [{ id: "met", label: "Met", points: 1 }], checks: [] }],
  });
  return { district, assignmentId, hash: `#/classes/${IDS.offering}/assignments/${assignmentId}/submissions` };
};

const exportFile = async (corrupt = false) => {
  const digest = `sha256:${"a".repeat(64)}`;
  const release = await releaseAssessment({
    format: "educateos.assessment.v1", id: "argument", version: "1.0.0", title: "Argument Gadget", intent: "Support a claim.",
    outcomes: [{ id: "reason", description: "Use evidence." }],
    tasks: [{ id: "write", kind: "gadget", prompt: "Explain your claim.", evidence: [{ id: "draft", description: "A draft", mediaTypes: ["text/plain"], maxBytes: 1000 }], aiAssistance: { allowedUses: [], disclosureRequired: true } }],
    rubric: { id: "public-rubric", version: "1.0.0", digest }, evaluator: { id: "writing", version: "1.0.0", digest },
  });
  const blueprint = {
    format: "educateos.workshop-assessment.v1", definition: release.definition,
    assessmentDigest: corrupt ? digest : release.digest,
    blueprint: { id: "argument-blueprint", commitId: "b".repeat(40), sourceDigest: digest },
  };
  const text = JSON.stringify(blueprint);
  const file = new File([text], "assessment.json", { type: "application/json" });
  // jsdom's File lacks text(), unlike the browser's File API.
  Object.defineProperty(file, "text", { value: async () => text });
  return { file, blueprint };
};

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());

describe("assignment Gadget assessment", () => {
  it("validates an export, waits for teacher confirmation and reloads the real binding route", async () => {
    const { district, assignmentId, hash } = setup();
    const user = await renderApp(district.client, hash);
    const { file, blueprint } = await exportFile();
    await user.upload(await screen.findByLabelText("Workshop assessment export (.json)"), file);
    expect(await screen.findByText("Argument Gadget")).toBeTruthy();
    expect(district.callsTo("teacher.bindGadgetAssessment")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Pin reviewed release to assignment" }));
    expect(await screen.findByText("argument-blueprint")).toBeTruthy();
    expect(screen.getByText("rbr_gadget · version 1")).toBeTruthy();
    expect(screen.getByText("Release verified with the configured Workshop.")).toBeTruthy();
    expect(district.callsTo("teacher.bindGadgetAssessment").map((call) => call.input)).toEqual([{ params: { assignmentId }, body: { blueprint } }]);
    expect(screen.queryByLabelText("Workshop assessment export (.json)")).toBeNull();
  });

  it("refuses a tampered assessment before calling the district", async () => {
    const { district, hash } = setup();
    const user = await renderApp(district.client, hash);
    const { file } = await exportFile(true);
    await user.upload(await screen.findByLabelText("Workshop assessment export (.json)"), file);
    expect(await screen.findByText(/Choose a valid Workshop assessment export/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pin reviewed release to assignment" })).toBeNull();
    expect(district.callsTo("teacher.bindGadgetAssessment")).toHaveLength(0);
  });

  it("withholds verification when the district cannot reach the configured Workshop", async () => {
    const { district, hash } = setup();
    district.fail("teacher.getGadgetAssessment", { status: 503, body: { code: "unavailable", message: "Release unavailable" } });
    await renderApp(district.client, hash);
    expect(await screen.findByRole("button", { name: /retry|try again/i })).toBeTruthy();
    expect(screen.queryByText("Release verified with the configured Workshop.")).toBeNull();
  });

  it("does not offer a pin form when the district denies access", async () => {
    const { district, hash } = setup();
    district.fail("teacher.getGadgetAssessment", { status: 403, body: { code: "forbidden", message: "Class access revoked" } });
    await renderApp(district.client, hash);
    expect(await screen.findByText("You don't have permission to do that in this class.")).toBeTruthy();
    expect(screen.queryByLabelText("Workshop assessment export (.json)")).toBeNull();
  });
});
