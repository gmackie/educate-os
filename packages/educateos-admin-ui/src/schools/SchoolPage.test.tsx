// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/dom";
import { fakeDistrict } from "../testing/fakeDistrict.ts";
import { renderConsole } from "../testing/renderConsole.tsx";

describe("a school's page", () => {
  it("shows the school's terms and its classes with their teachers and student counts", async () => {
    const district = fakeDistrict();
    renderConsole(district.client, "schools/sch_fk-high");
    expect(await screen.findByRole("heading", { name: "Fake High School" })).toBeTruthy();
    expect(screen.getByText("Grades 9-12")).toBeTruthy();

    const terms = screen.getByRole("table", { name: "Terms with classes at this school" });
    expect(within(terms).getAllByRole("row").slice(1).map((row) => row.textContent)).toStrictEqual(["Fall 2026Aug 24, 2026 to Dec 18, 2026In session"]);

    const classes = screen.getByRole("table", { name: "This school's classes" });
    expect(within(classes).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent))).toStrictEqual([
      ["Biology · Section A", "Fall 2026", "Sam Rivera", "24"],
      ["English 9 · Section B", "Fall 2026", "Sam Rivera, Wen Chen", "27"],
    ]);
    expect(screen.getByText("2 classes")).toBeTruthy();
    expect(screen.queryByText(/Math 7/)).toBeNull();
    // Only this school's classes' rosters are read.
    expect(district.calls.filter((c) => c.name === "admin.offeringRoster")).toHaveLength(2);
  });

  it("is reached from the school's name, and is no section of the console's own", async () => {
    const { user } = renderConsole(fakeDistrict().client, "classes-people");
    await user.click(await screen.findByRole("link", { name: "Fake Middle School" }));
    expect(await screen.findByRole("heading", { name: "Fake Middle School" })).toBeTruthy();
    expect(window.location.hash).toBe("#/schools/sch_fk-middle");
    const sections = screen.getByRole("list", { name: "Admin" });
    expect(within(sections).queryByRole("link", { current: "page" })).toBeNull();
  });

  it("offers no edit where a roster system owns the district's schools", async () => {
    renderConsole(fakeDistrict().client, "schools/sch_fk-high");
    await screen.findByRole("heading", { name: "Fake High School" });
    expect(screen.queryByRole("button", { name: "Edit school" })).toBeNull();
  });

  it("says so for a school the district does not have", async () => {
    renderConsole(fakeDistrict().client, "schools/sch_nowhere");
    expect(await screen.findByText("There's no such school")).toBeTruthy();
  });
});
