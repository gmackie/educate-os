// SCHO-187: a teacher reads a class's gradebook, moves around it by keyboard, marks work, sets how
// it adds up and exports it.
import { screen, waitFor, within } from "@testing-library/dom";
import { describe, expect, it } from "vitest";
import { fakeDistrict, IDS } from "./fakeDistrict.ts";
import { onScreen, renderApp } from "./render.tsx";

const gradebookPage = `#/classes/${IDS.offering}/gradebook`;
const grid = () => screen.getByRole("grid", { name: "Gradebook for English 9 · Period 3" });
const focused = () => document.activeElement as HTMLElement;

describe("the gradebook", () => {
  it("is a class section showing each student's official grades and totals in a labelled grid", async () => {
    const district = fakeDistrict();
    const user = await renderApp(district.client, `#/classes/${IDS.offering}/roster`);
    await user.click(await screen.findByRole("link", { name: "Gradebook" }));
    await onScreen("Gradebook · English 9 · Period 3");
    await waitFor(() => grid());

    const headers = within(grid()).getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toStrictEqual(["Student", "Persuasive paragraphout of 10", "=Claim quizout of 5", "Unweighted", "Final", "Letter"]);
    expect(within(grid()).getAllByRole("rowheader").map((h) => h.textContent)).toStrictEqual(["Amara Okafor", "Noah Brooks"]);
    const amara = within(grid()).getByRole("row", { name: /Amara Okafor/ });
    expect(within(amara).getAllByRole("gridcell").map((c) => c.textContent)).toStrictEqual(["8/10", "5/5", "86.7%", "86.7%", "B"]);
    const noah = within(grid()).getByRole("row", { name: /Noah Brooks/ });
    expect(within(noah).getAllByRole("gridcell")[0]!.textContent).toBe("—Not graded");
    // One tab stop for the whole grid.
    expect(within(grid()).getAllByRole("gridcell").filter((c) => c.tabIndex === 0)).toHaveLength(1);
  });

  it("moves by arrow keys, Home and End, and marks a cell from the keyboard", async () => {
    const district = fakeDistrict();
    const user = await renderApp(district.client, gradebookPage);
    await waitFor(() => grid());
    const cells = () => within(grid()).getAllByRole("gridcell");
    cells()[0]!.focus();

    await user.keyboard("{ArrowRight}");
    expect(focused().textContent).toBe("5/5");
    await user.keyboard("{ArrowDown}");
    expect(focused().textContent).toBe("3/5");
    await user.keyboard("{End}");
    expect(focused().textContent).toBe("D");
    await user.keyboard("{Home}");
    expect(focused().textContent).toBe("—Not graded");
    await user.keyboard("{ArrowDown}");
    expect(focused().textContent).toBe("—Not graded");
    expect(focused().tabIndex).toBe(0);

    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Noah Brooks · Persuasive paragraph" });
    await user.click(within(dialog).getByRole("radio", { name: /Missing/ }));
    await user.click(within(dialog).getByRole("button", { name: "Save mark" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(district.callsTo("teacher.setGradeMarker")[0]!.input).toStrictEqual({
      params: { offeringId: IDS.offering },
      body: { assignmentId: IDS.existingAssignment, studentPrincipalId: IDS.noah, marker: "missing" },
    });
    await waitFor(() => expect(within(within(grid()).getByRole("row", { name: /Noah Brooks/ })).getByText("Missing")).toBeTruthy());
    expect(screen.getByRole("status", { name: "" }).textContent).toBe("Marked Persuasive paragraph missing for Noah Brooks.");

    // Clicking a cell opens it too, and the mark can be cleared.
    await user.click(within(within(grid()).getByRole("row", { name: /Noah Brooks/ })).getAllByRole("gridcell")[0]!);
    const again = await screen.findByRole("dialog", { name: "Noah Brooks · Persuasive paragraph" });
    expect(within(again).getByRole("radio", { name: /Missing/ }).getAttribute("aria-checked")).toBe("true");
    await user.click(within(again).getByRole("radio", { name: /No mark/ }));
    await user.click(within(again).getByRole("button", { name: "Save mark" }));
    await waitFor(() => expect(district.callsTo("teacher.setGradeMarker")).toHaveLength(2));
    expect(district.callsTo("teacher.setGradeMarker")[1]!.input.body).toMatchObject({ marker: null });
  });

  it("saves groups, weights, drop-lowest and the grade scale over the revision it read", async () => {
    const district = fakeDistrict();
    const user = await renderApp(district.client, gradebookPage);
    await waitFor(() => grid());
    await user.click(screen.getByRole("button", { name: "Gradebook settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Gradebook settings" });

    await user.click(within(dialog).getByRole("radio", { name: /Weighted by group/ }));
    await user.click(within(dialog).getByRole("button", { name: "Save settings" }));
    expect(within(dialog).getByRole("alert").textContent).toContain("give at least one group a weight");
    expect(district.callsTo("teacher.updateGradebookSettings")).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "Add group" }));
    const group = within(dialog).getByRole("group", { name: "Group 1" });
    await user.type(within(group).getByRole("textbox", { name: "Group name" }), "Writing");
    const weight = within(dialog).getByRole("spinbutton", { name: "Weight (%)" });
    await user.clear(weight);
    await user.type(weight, "100");
    const drop = within(dialog).getByRole("spinbutton", { name: "Drop lowest" });
    await user.clear(drop);
    await user.type(drop, "1");
    await user.click(within(within(dialog).getByRole("group", { name: "Persuasive paragraph" })).getByRole("radio", { name: "Writing" }));
    await user.click(within(dialog).getByRole("radio", { name: /Percent/ }));
    await user.click(within(dialog).getByRole("switch", { name: "Count work marked missing as zero" }));
    const letter = within(within(dialog).getByRole("group", { name: "Grade 1" })).getByRole("textbox", { name: "Letter" });
    await user.clear(letter);
    await user.type(letter, "A+");
    await user.click(within(dialog).getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const [saved] = district.callsTo("teacher.updateGradebookSettings");
    expect(saved!.input).toStrictEqual({
      params: { offeringId: IDS.offering },
      body: {
        revision: 0,
        settings: {
          weighting: "group-weights",
          calculation: "percent",
          missing: "exclude",
          groups: [{ id: expect.stringMatching(/^grp_[0-9a-f-]{36}$/), name: "Writing", weight: 100, dropLowest: 1, assignmentIds: [IDS.existingAssignment] }],
          scale: [{ letter: "A+", minPercent: 90 }, { letter: "B", minPercent: 80 }, { letter: "C", minPercent: 70 }, { letter: "D", minPercent: 60 }, { letter: "F", minPercent: 0 }],
        },
      },
    });
    expect(screen.getByRole("status", { name: "" }).textContent).toContain("Gradebook settings saved");
  });

  it("reports a settings change someone saved meanwhile instead of overwriting it", async () => {
    const district = fakeDistrict();
    const user = await renderApp(district.client, gradebookPage);
    await waitFor(() => grid());
    await user.click(screen.getByRole("button", { name: "Gradebook settings" }));
    district.gradebook.revision = 3;
    const dialog = await screen.findByRole("dialog", { name: "Gradebook settings" });
    await user.click(within(dialog).getByRole("button", { name: "Save settings" }));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/changed while you were editing/);
  });

  it("exports the gradebook as a CSV download", async () => {
    const district = fakeDistrict();
    const user = await renderApp(district.client, gradebookPage);
    await waitFor(() => grid());
    await user.click(screen.getByRole("button", { name: "Export CSV" }));
    const link = await screen.findByRole("link", { name: "Download english-9-period-3-gradebook.csv" });
    expect(link.getAttribute("download")).toBe("english-9-period-3-gradebook.csv");
    const href = link.getAttribute("href")!;
    expect(href.startsWith("data:text/csv;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(href.slice("data:text/csv;charset=utf-8,".length))).toContain("'=Claim quiz (5 pts)");
  });

  it("is read-only for a co-teacher", async () => {
    const district = fakeDistrict({
      offerings: [{
        offering: { id: IDS.offering, districtId: IDS.district, schoolId: "sch_nf-high", termId: "trm_nf-2026-fall", courseId: "crs_nf-english-9", sectionName: "Period 3" },
        course: { id: "crs_nf-english-9", districtId: IDS.district, title: "English 9", subject: "english-language-arts", gradeBand: "9" },
        role: "co-teacher",
      }],
    });
    const user = await renderApp(district.client, gradebookPage);
    await waitFor(() => grid());
    expect(screen.queryByRole("button", { name: "Gradebook settings" })).toBeNull();
    expect(grid().getAttribute("aria-readonly")).toBe("true");
    within(grid()).getAllByRole("gridcell")[0]!.focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("dialog")).toBeNull();
    // A co-teacher still exports.
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeTruthy();
  });
});
