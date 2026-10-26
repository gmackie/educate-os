// SCHO-222: an activity's grade and feedback as the student reads them: the official grade, each
// comment with the passage of their work it is about, and no request that fails while nothing is
// released.
import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/dom";
import { ENGLISH, ESSAY, fakeDistrict } from "./fakeDistrict.ts";
import { renderApp } from "./render.tsx";

const WORK = "School should start later because teens need more sleep.";

/** Amara's essay, saved and submitted. */
async function submittedEssay() {
  const district = fakeDistrict();
  const artifactId = district.addArtifact("wsp_amara-eng9", "Should the school day start later?: Draft your argument", "document", "text/plain", { kind: "text", text: WORK });
  const { revision } = await district.call("student.getArtifact", { params: { artifactId } });
  await district.call("student.submit", { params: { assignmentId: ESSAY }, body: { revisions: [{ artifactId, revisionId: revision.id }] } });
  return { district, artifactId, revisionId: revision.id };
}

describe("an activity's grade and feedback (SCHO-222)", () => {
  it("shows the official grade, and each comment with the passage it is about, under one heading per part", async () => {
    const { district, artifactId, revisionId } = await submittedEssay();
    const start = WORK.indexOf("teens need more sleep");
    district.releaseFeedback(district.submissions[0]!.id, {
      comments: [{ body: "Cite the study here.", anchor: { artifactId, revisionId, start, end: start + "teens need more sleep".length } }, "Good structure overall."],
      scores: [{ criterionId: "use-of-evidence", points: 3, maxPoints: 4 }],
    });
    district.recordGrade(ESSAY, { points: 5, maxPoints: 6 });
    await renderApp(district, `/courses/${ENGLISH}/activities/${ESSAY}`);

    const section = await screen.findByRole("region", { name: "Grade and feedback" });
    expect(await within(section).findByText("Official grade: 5 out of 6")).toBeTruthy();
    const quoted = within(section).getByText("Cite the study here.").closest("li")!;
    expect(quoted.querySelector("blockquote")?.textContent).toContain("“teens need more sleep”");
    expect(within(section).getByText("Good structure overall.").closest("li")!.querySelector("blockquote")).toBeNull();
    // Named once: by its heading, which also names the table.
    expect(within(section).getAllByText("Criterion results")).toHaveLength(1);
    expect(within(section).getByRole("table", { name: "Criterion results" })).toBeTruthy();
  });

  it("asks for the assignment's released feedback, which is empty right after submitting, never a feedback read that fails", async () => {
    const { district } = await submittedEssay();
    await renderApp(district, `/courses/${ENGLISH}/activities/${ESSAY}`);
    const section = await screen.findByRole("region", { name: "Grade and feedback" });
    expect(await within(section).findByText(/No feedback yet/)).toBeTruthy();
    expect(within(section).queryByText(/Official grade/)).toBeNull();
    expect(district.calls.some((c) => c.name === "student.assignmentFeedback")).toBe(true);
    expect(district.calls.some((c) => c.name === "student.getFeedback")).toBe(false);
  });
});
