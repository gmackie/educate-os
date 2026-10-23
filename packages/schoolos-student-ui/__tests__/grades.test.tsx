import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { ESSAY, fakeDistrict } from "./fakeDistrict.ts";
import { renderApp } from "./render.tsx";

describe("my grades", () => {
  it("lists each class's activities with the latest official grade, reached from the main navigation", async () => {
    const district = fakeDistrict();
    district.recordGrade(ESSAY, { points: 7, maxPoints: 10 });
    district.recordGrade(ESSAY, { points: 9, maxPoints: 10 });
    const user = userEvent.setup();
    await renderApp(district);

    await user.click(await screen.findByRole("link", { name: "Grades" }));
    expect(await screen.findByRole("heading", { level: 1, name: "My grades" })).toBeTruthy();

    const english = await screen.findByRole("table", { name: "Grades for English Language Arts · Grades 9–12" });
    const essay = within(english).getByRole("row", { name: /Should the school day start later\?/ });
    // The latest version, marked as changed since it was first recorded.
    expect(within(essay).getByText("9 out of 10")).toBeTruthy();
    expect(within(essay).getByText("Updated")).toBeTruthy();
    expect(within(essay).queryByText("7 out of 10")).toBeNull();

    const science = screen.getByRole("table", { name: "Grades for Science · Grades 9–12" });
    expect(within(within(science).getByRole("row", { name: /Osmosis in potato cores/ })).getByText("Not graded yet")).toBeTruthy();
    // A finished class keeps its grades, marked as finished.
    const art = screen.getByRole("region", { name: /Art · Grades 9–12/ });
    expect(within(art).getByText("Finished")).toBeTruthy();
    expect(district.calls.filter((call) => call.name === "student.officialGrades").map((call) => (call.input as { params: { assignmentId: string } }).params.assignmentId)).toContain(ESSAY);
  });

  it("says when grades could not load, and loads them again on Try again", async () => {
    const district = fakeDistrict();
    district.failNext("student.officialGrades", "network");
    const user = userEvent.setup();
    await renderApp(district, "/grades");

    const failure = await screen.findByRole("alert");
    expect(within(failure).getByText("We couldn't load your grades")).toBeTruthy();
    await user.click(within(failure).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("table", { name: "Grades for English Language Arts · Grades 9–12" })).toBeTruthy();
  });
});
