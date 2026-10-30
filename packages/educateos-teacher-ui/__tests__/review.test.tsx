// SCHO-222: a submission review that reads the same after a reload as it did when the teacher
// graded it: the official grade as it stands, the work named by its steps, and the rubric's
// criteria by title, scored by level.
import { screen, waitFor, within } from "@testing-library/dom";
import { describe, expect, it } from "vitest";
import { fakeDistrict, IDS } from "./fakeDistrict.ts";
import { onScreen, renderApp, settle } from "./render.tsx";

const LEVELS = [
  { id: "beginning", label: "Beginning", points: 1 },
  { id: "developing", label: "Developing", points: 2 },
  { id: "secure", label: "Secure", points: 3 },
];
const ROCKS_RUBRIC = {
  rubricId: "rbr_rocks-1",
  version: 1,
  title: "Rocks",
  criteria: [
    { id: "observations-are-detailed", title: "Observations are detailed", levels: LEVELS, checks: [] },
    { id: "classification-is-justified", title: "Classification is justified with data", levels: LEVELS, checks: [] },
  ],
};
const STEPS = [
  { id: "observe", title: "Observe the samples", kind: "writing" },
  { id: "record", title: "Record your data", kind: "dataset" },
  { id: "classify", title: "Classify each rock", kind: "writing" },
] as const;

const setUp = () => {
  const district = fakeDistrict();
  const assignmentId = district.assignStepActivity("Rock Cycle Investigation", [...STEPS], ROCKS_RUBRIC);
  // Artifact IDs sort in the reverse of step order, so canonical order is not step order.
  const submissionId = district.studentSubmitsWorks(assignmentId, [
    { artifactId: "art_c", title: "Rock Cycle Investigation: Observe the samples", text: "Granite has big crystals." },
    { artifactId: "art_b", title: "Rock Cycle Investigation: Record your data", text: "Sample,Grain size\nGranite,5" },
    { artifactId: "art_a", title: "Rock Cycle Investigation: Classify each rock", text: "Granite is igneous." },
    { artifactId: "art_0", title: "Rock Cycle Investigation: Extra notes", text: "I also found a fossil." },
  ]);
  return { district, assignmentId, submissionId, hash: `#/classes/${IDS.offering}/assignments/${assignmentId}/submissions/${submissionId}` };
};

describe("submitted work", () => {
  it("is named by its activity step, in step order, with other work after it", async () => {
    const { district, hash } = setUp();
    await renderApp(district.client, hash);
    await onScreen(/Amara Okafor’s work/);
    const work = screen.getByRole("region", { name: "Submitted work" });
    const names = within(work).getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(names).toStrictEqual(["Observe the samples", "Record your data", "Classify each rock", "Extra notes"]);
    expect(screen.getByRole("region", { name: "Submitted work: Record your data" }).textContent).toContain("Granite,5");
  });
});

describe("the rubric", () => {
  it("shows its criteria by title without running checks, and says when it has no checks", async () => {
    const { district, hash } = setUp();
    await renderApp(district.client, hash);
    expect(await screen.findByRole("group", { name: "Observations are detailed" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Classification is justified with data" })).toBeTruthy();
    expect(screen.getByText("This rubric has no automatic checks. Score each criterion yourself below.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Run checks" })).toBeNull();
    expect(district.callsTo("teacher.runCi")).toStrictEqual([]);
  });

  it("is scored by level, and the saved levels fill in the official grade", async () => {
    const { district, hash } = setUp();
    const user = await renderApp(district.client, hash);
    const observations = await screen.findByRole("group", { name: "Observations are detailed" });
    await user.click(within(observations).getByRole("radio", { name: "Secure (3)" }));
    await user.click(within(observations).getByRole("button", { name: "Save score" }));
    const classification = screen.getByRole("group", { name: "Classification is justified with data" });
    await user.click(within(classification).getByRole("radio", { name: "Developing (2)" }));
    await user.click(within(classification).getByRole("button", { name: "Save score" }));

    expect(district.callsTo("teacher.scoreCriterion").map((c) => c.input.body)).toStrictEqual([
      { criterionId: "observations-are-detailed", points: 3, maxPoints: 3 },
      { criterionId: "classification-is-justified", points: 2, maxPoints: 3 },
    ]);
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Points" }) as HTMLInputElement).value).toBe("5"));
    expect((screen.getByRole("textbox", { name: "Out of" }) as HTMLInputElement).value).toBe("6");
    expect(await within(screen.getByRole("group", { name: "Classification is justified with data" })).findByText("Your score: 2 of 3 (Developing)")).toBeTruthy();
  });
});

describe("the official grade", () => {
  it("shows as it stands after a reload, and changing it is an explicit step", async () => {
    const { district, hash, submissionId } = setUp();
    district.gradedEarlier(submissionId, { points: 5, maxPoints: 6 });
    const user = await renderApp(district.client, hash);

    expect(await screen.findByText("5 out of 6")).toBeTruthy();
    expect(screen.getByText("Official")).toBeTruthy();
    // No empty form inviting a second approval.
    expect(screen.queryByRole("textbox", { name: "Points" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve official grade" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Change the official grade" }));
    expect(screen.getByText("The new grade replaces the official one. Both stay in the grade's history.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Keep the current grade" }));
    expect(screen.queryByRole("textbox", { name: "Points" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Change the official grade" }));
    await user.type(screen.getByRole("textbox", { name: "Points" }), "6");
    await user.type(screen.getByRole("textbox", { name: "Out of" }), "6");
    await user.click(screen.getByRole("button", { name: "Approve official grade" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Yes, approve official grade" }));

    expect(await screen.findByText("6 out of 6")).toBeTruthy();
    expect(screen.getByText(/changed 1 time/)).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Points" })).toBeNull();
    expect(district.callsTo("teacher.officialGrades")[0]!.input.params).toStrictEqual({ assignmentId: expect.any(String), studentId: IDS.amara });
  });
});


describe("assessment review availability", () => {
  it("shows a permission failure when pending approvals cannot be read", async () => {
    const { district, hash } = setUp();
    district.fail("teacher.pendingGrades", { status: 403, body: { code: "forbidden", message: "no longer a teacher" } });
    await renderApp(district.client, hash);
    await onScreen(/Amara Okafor’s work/);
    expect(await screen.findByText("You don't have permission to do that in this class.")).toBeTruthy();
    expect(district.callsTo("teacher.approveGrade")).toStrictEqual([]);
    expect(screen.queryByRole("button", { name: "Approve official grade" })).toBeNull();
  });

  it("makes submitted revision references and declared AI provenance available for review", async () => {
    const { district, hash } = setUp();
    await renderApp(district.client, hash);
    await onScreen(/Amara Okafor’s work/);
    expect(screen.getAllByText("Evidence version")).toHaveLength(4);
    expect(screen.getByText("rev_c")).toBeTruthy();
    expect(screen.getAllByText(/student declared no AI assistance/)).toHaveLength(4);
  });
});


describe("moving between submissions", () => {
  it("does not carry an unsaved grade to another student's attempt", async () => {
    const { district, hash, assignmentId } = setUp();
    const anotherId = district.studentSubmits(assignmentId, "A different answer.", IDS.noah);
    const user = await renderApp(district.client, hash);
    await user.type(await screen.findByRole("textbox", { name: "Points" }), "5");
    await user.type(screen.getByRole("textbox", { name: "Out of" }), "6");
    window.location.hash = `#/classes/${IDS.offering}/assignments/${assignmentId}/submissions/${anotherId}`;
    await settle();
    await onScreen(/This student’s work/);
    expect((await screen.findByRole("textbox", { name: "Points" }) as HTMLInputElement).value).toBe("");
    expect((screen.getByRole("textbox", { name: "Out of" }) as HTMLInputElement).value).toBe("");
    expect(district.callsTo("teacher.recordGrade")).toStrictEqual([]);
  });
});
