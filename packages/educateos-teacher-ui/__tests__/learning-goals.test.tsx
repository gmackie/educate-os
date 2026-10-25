// SCHO-220: learning goals are optional, come from the standards the district approved, and say
// where to approve them when there are none.
import { screen, within } from "@testing-library/dom";
import { describe, expect, it } from "vitest";
import { fakeDistrict, GOALS, IDS } from "./fakeDistrict.ts";
import { onScreen, renderApp } from "./render.tsx";

const create = `#/classes/${IDS.offering}/create`;

/** Fills in a writing task's required fields. */
async function fillEssay(user: Awaited<ReturnType<typeof renderApp>>) {
  await user.type(await screen.findByRole("textbox", { name: "Title" }), "Rock Cycle Investigation");
  await user.type(screen.getByRole("textbox", { name: "Overview for students" }), "Explain how each rock formed.");
  await user.type(screen.getByRole("textbox", { name: "Prompt" }), "Explain.");
}

describe("learning goals on Create activity", () => {
  it("lets a teacher create the first activity with none, and points to where standards are approved", async () => {
    const district = fakeDistrict({ learningGoals: { goals: [], approvedReleases: 0 } });
    const user = await renderApp(district.client, create);
    await onScreen(/^Create activity/);
    const goals = screen.getByRole("group", { name: "Learning goals" });
    expect(goals.textContent).toContain("Your district hasn't approved any learning standards yet.");
    expect(within(goals).getByRole("link", { name: "Learning standards page" }).getAttribute("href")).toBe("/admin/#/learning-standards");
    expect(goals.textContent).not.toContain("Ask your curriculum admin");

    await fillEssay(user);
    await user.click(screen.getByRole("button", { name: "Preview as student" }));
    await screen.findByRole("region", { name: "Preview as a student" });
    expect(district.callsTo("teacher.createActivity")[0]!.input.body!.activity).toMatchObject({ alignments: [] });
  });

  it("says when the approved standards don't fit the course", async () => {
    const district = fakeDistrict({ learningGoals: { goals: [], approvedReleases: 2 } });
    await renderApp(district.client, create);
    await onScreen(/^Create activity/);
    expect(screen.getByRole("group", { name: "Learning goals" }).textContent).toContain("None of the learning standards your district approved cover this course's subject and grades.");
  });

  it("finds goals by code or words, keeps chosen ones in view, and sends only those", async () => {
    const district = fakeDistrict();
    const user = await renderApp(district.client, create);
    await onScreen(/^Create activity/);
    const goals = screen.getByRole("group", { name: "Learning goals" });
    expect(within(goals).getAllByRole("checkbox")).toHaveLength(2);

    await user.type(within(goals).getByRole("textbox", { name: "Find a learning goal" }), "informative");
    expect(within(goals).getAllByRole("checkbox")).toHaveLength(1);
    await user.click(within(goals).getByRole("checkbox", { name: /^CCSS-ELA W\.9-10\.2 Write informative/ }));
    await user.type(within(goals).getByRole("textbox", { name: "Find a learning goal" }), " nothing-matches");
    expect(within(goals).getByText("No other learning goals match.")).toBeTruthy();
    // The chosen goal stays in view, still chosen, whatever the search.
    expect(within(goals).getByRole("checkbox", { name: /^CCSS-ELA W\.9-10\.2/ }).getAttribute("aria-checked")).toBe("true");

    await fillEssay(user);
    await user.click(screen.getByRole("button", { name: "Preview as student" }));
    await screen.findByRole("region", { name: "Preview as a student" });
    const [chosen] = GOALS.slice(1);
    expect(district.callsTo("teacher.createActivity")[0]!.input.body!.activity).toMatchObject({
      alignments: [{ frameworkKey: chosen!.frameworkKey, competencyUri: chosen!.competencyUri }],
    });
  });
});
