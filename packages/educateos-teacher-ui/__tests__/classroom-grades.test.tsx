// SCHO-403: a class's gradebook shows its grades as Google Classroom holds them, read-only, below
// the official grid, and nothing at all for a class with no Classroom connection.
import { screen, waitFor, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { fakeDistrict, IDS } from "./fakeDistrict.ts";
import { onScreen, renderApp } from "./render.tsx";

const gradebookPage = `#/classes/${IDS.offering}/gradebook`;
const LINK = "https://classroom.google.com/c/ODgw";

const READY = {
  status: "ready",
  offeringId: IDS.offering,
  courseLink: LINK,
  courseWork: [
    { courseWorkId: "501", title: "Tide quiz", maxPoints: 10, link: `${LINK}/a/NTAx/details` },
    { courseWorkId: "502", title: "Reflection" },
  ],
  rows: [
    { studentPrincipalId: IDS.amara, displayName: "Amara Okafor", cells: [{ courseWorkId: "501", state: "returned", assignedGrade: 8 }, { courseWorkId: "502", state: "returned" }] },
    { studentPrincipalId: IDS.noah, displayName: "Noah Brooks", cells: [{ courseWorkId: "501", state: "turned-in", assignedGrade: 6 }] },
  ],
  truncated: false,
};

const panel = () => screen.findByRole("region", { name: "From Google Classroom" });

describe("grades from Google Classroom in the gradebook", () => {
  it("shows each student's Classroom grade and whether it was returned, read-only", async () => {
    const district = fakeDistrict({ classroomGrades: [READY] });
    await renderApp(district.client, gradebookPage);
    await onScreen("Gradebook · English 9 · Period 3");
    const table = within(await panel()).getByRole("table", { name: "Google Classroom grades for English 9 · Period 3" });

    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toStrictEqual([
      "Student", "Tide quiz (opens in a new tab)out of 10", "ReflectionUngraded",
    ]);
    expect(within(table).getAllByRole("rowheader").map((h) => h.textContent)).toStrictEqual(["Amara Okafor", "Noah Brooks"]);
    const amara = within(table).getByRole("row", { name: /Amara Okafor/ });
    expect(within(amara).getAllByRole("cell").map((c) => c.textContent)).toStrictEqual(["8/10Returned", "Returned"]);
    // Graded but not yet returned, and nothing turned in for the reflection.
    const noah = within(table).getByRole("row", { name: /Noah Brooks/ });
    expect(within(noah).getAllByRole("cell").map((c) => c.textContent)).toStrictEqual(["6/10Turned in", "—No submission"]);
    expect(within(table).getByRole("link", { name: /Tide quiz/ }).getAttribute("href")).toBe(`${LINK}/a/NTAx/details`);
    // Nothing in the panel changes anything.
    expect(within(await panel()).queryAllByRole("button")).toStrictEqual([]);
    expect(district.callsTo("teacher.classroomGrades")[0]!.input).toStrictEqual({ params: { offeringId: IDS.offering } });
  });

  it("says Classroom can't be reached, keeps the official gradebook, and tries again", async () => {
    const district = fakeDistrict({ classroomGrades: [{ status: "unavailable" }, READY] });
    const user = userEvent.setup();
    await renderApp(district.client, gradebookPage);
    const section = await panel();
    expect(within(section).getByText("Google Classroom can't be reached right now")).toBeTruthy();
    expect(screen.getByRole("grid", { name: "Gradebook for English 9 · Period 3" })).toBeTruthy();
    await user.click(within(section).getByRole("button", { name: "Try again" }));
    await waitFor(async () => expect(within(await panel()).getByRole("table")).toBeTruthy());
  });

  it("shows nothing for a class with no Classroom connection", async () => {
    const district = fakeDistrict();
    await renderApp(district.client, gradebookPage);
    await waitFor(() => screen.getByRole("grid", { name: "Gradebook for English 9 · Period 3" }));
    await waitFor(() => expect(district.callsTo("teacher.classroomGrades")).toHaveLength(1));
    expect(screen.queryByText("From Google Classroom")).toBeNull();
  });
});
