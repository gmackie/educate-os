// SCHO-222: the student preview shows everything a student will be asked for: a data table's
// columns, and the rubric they are assessed against, even one saved in an earlier session.
import { screen, within } from "@testing-library/dom";
import { describe, expect, it } from "vitest";
import { fakeDistrict, IDS } from "./fakeDistrict.ts";
import { onScreen, renderApp } from "./render.tsx";

const LEVELS = [
  { id: "beginning", label: "Beginning", points: 1 },
  { id: "developing", label: "Developing", points: 2 },
  { id: "secure", label: "Secure", points: 3 },
];

describe("the student preview", () => {
  it("lists a data table's columns and an earlier activity's rubric", async () => {
    const district = fakeDistrict();
    district.assignStepActivity("Minerals", [{ id: "observe", title: "Observe", kind: "writing" }], {
      rubricId: "rbr_observations-1", version: 1, title: "Observations",
      criteria: [{ id: "detail", title: "Observations are detailed", levels: LEVELS, checks: [] }],
    });
    const user = await renderApp(district.client, `#/classes/${IDS.offering}/create`);
    await onScreen(/^Create activity/);
    await user.click(await screen.findByRole("radio", { name: /Science investigation/ }));
    await user.type(screen.getByRole("textbox", { name: "Title" }), "Rock Cycle Investigation");
    await user.type(screen.getByRole("textbox", { name: "Overview for students" }), "Classify three rocks.");
    await user.type(screen.getByRole("textbox", { name: "Investigation question" }), "How did each rock form?");
    await user.type(screen.getByRole("textbox", { name: "What students describe about their method" }), "How you tested each sample.");
    await user.type(screen.getByRole("textbox", { name: /Data table columns/ }), "Sample\nGrain size, mm");
    await user.type(screen.getByRole("textbox", { name: "Analysis prompt" }), "Classify each rock.");
    await user.click(screen.getByRole("radio", { name: "The rubric from “Minerals”" }));
    await user.click(screen.getByRole("button", { name: "Preview as student" }));

    const preview = await screen.findByRole("region", { name: "Preview as a student" });
    expect(within(preview).getByText("A table with columns: Sample, Grain size (mm).")).toBeTruthy();
    // Not saved in this session, so it is read back from the district.
    expect(await within(preview).findByText("How your work is assessed: Observations")).toBeTruthy();
    expect(within(preview).getByText("Observations are detailed: Beginning (1), Developing (2), Secure (3)")).toBeTruthy();
    expect(district.callsTo("teacher.getRubric")[0]!.input.params).toStrictEqual({ offeringId: IDS.offering, rubricId: "rbr_observations-1", version: "1" });
  });
});
