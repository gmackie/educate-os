import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/dom";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { SCIENCE, OSMOSIS, fakeDistrict } from "./fakeDistrict.ts";
import { renderApp } from "./render.tsx";

/** Presses Tab until `target` has focus, failing if it is not in the Tab order. */
async function tabTo(user: UserEvent, target: HTMLElement): Promise<void> {
  for (let presses = 0; presses < 80; presses++) {
    if (document.activeElement === target) return;
    await user.tab();
  }
  throw new Error(`could not reach ${target.outerHTML.slice(0, 120)} with Tab`);
}

describe("keyboard only", () => {
  it("reaches a class, an activity, writes, saves and submits without a pointer", async () => {
    const district = fakeDistrict();
    const user = userEvent.setup();
    await renderApp(district);

    const course = await screen.findByRole("link", { name: "Science · Grades 9–12" });
    await tabTo(user, course);
    await user.keyboard("{Enter}");

    const activity = await screen.findByRole("link", { name: "Osmosis in potato cores" });
    await tabTo(user, activity);
    await user.keyboard("{Enter}");

    const hypothesis = await screen.findByRole("textbox", { name: "Your work for Your hypothesis" });
    await tabTo(user, hypothesis);
    await user.keyboard("Salt water makes the cores lighter.");
    const saveButtons = screen.getAllByRole("button", { name: "Save" });
    await tabTo(user, saveButtons[0]!);
    await user.keyboard("{Enter}");
    await screen.findByText(/^Saved /);

    await tabTo(user, screen.getByRole("button", { name: "Submit" }));
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Submit your work?" });
    await tabTo(user, within(dialog).getByRole("button", { name: "Submit" }));
    await user.keyboard("{Enter}");
    const receipt = await screen.findByRole("dialog", { name: "Submitted" });
    expect(within(receipt).getByText("Receipt code")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("moves through the lab data grid with the arrow keys, as one stop in the Tab order", async () => {
    const district = fakeDistrict();
    const user = userEvent.setup();
    await renderApp(district, `/courses/${SCIENCE}/activities/${OSMOSIS}`);

    const grid = await screen.findByRole("grid", { name: "Your work for Record your data" });
    const first = within(grid).getByRole("textbox", { name: "Row 1, Concentration (M)" });
    await tabTo(user, first);
    await user.keyboard("0.5");
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(within(grid).getByRole("textbox", { name: "Row 1, Mass change (%)" }));
    await user.keyboard("-4.2");

    await user.click(screen.getByRole("button", { name: "Add row" }));
    await user.click(within(grid).getByRole("textbox", { name: "Row 1, Mass change (%)" }));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(within(grid).getByRole("textbox", { name: "Row 2, Mass change (%)" }));
    await user.keyboard("{ArrowLeft}{ArrowUp}");
    expect(document.activeElement).toBe(first);

    // Only the active cell is a Tab stop, so Tab leaves the grid for the controls after it.
    expect(within(grid).getAllByRole("textbox").filter((cell) => cell.tabIndex === 0)).toStrictEqual([first]);
    await user.tab();
    expect(grid.contains(document.activeElement)).toBe(false);

    const saveButtons = screen.getAllByRole("button", { name: "Save" });
    await user.click(saveButtons[1]!);
    await screen.findByText(/^Saved /);
    const saved = district.calls.find((call) => call.name === "student.createArtifact" && JSON.stringify(call.input).includes("text/csv"));
    expect(saved?.input).toMatchObject({ body: { type: "dataset", content: { mediaType: "text/csv", text: "Concentration (M),Mass change (%)\n0.5,-4.2\n,\n" } } });
  });
});
