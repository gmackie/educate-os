// @vitest-environment jsdom
// Every screen has its landmarks and headings, and every control has an accessible name; the
// acceptance journey works from the keyboard alone, with focus landing where the next step is.
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/dom";
import type { UserEvent } from "@testing-library/user-event";
import { CLASSES, classTitle, fakeDistrict } from "../testing/fakeDistrict.ts";
import { renderConsole } from "../testing/renderConsole.tsx";
import { SCREENS } from "./useHashRoute.ts";

const CONTROL_ROLES = ["button", "link", "checkbox", "radio", "textbox"] as const;

/** Presses Tab until `target` has focus, failing if it is not reachable within `limit` presses. */
async function tabTo(user: UserEvent, target: () => Element | null, limit = 80): Promise<void> {
  for (let i = 0; i < limit; i++) {
    const element = target();
    if (element !== null && document.activeElement === element) return;
    await user.tab();
  }
  throw new Error(`not reachable by Tab: ${target()?.outerHTML.slice(0, 120) ?? "missing"}`);
}

describe("structure and labels", () => {
  it.each(SCREENS.map((s) => [s.path, s.label]))("%s has its landmarks, headings and a name on every control", async (path, label) => {
    renderConsole(fakeDistrict().client, path);
    expect(screen.getByRole("banner")).toBeTruthy();
    expect(await screen.findByRole("navigation", { name: "Admin sections" })).toBeTruthy();
    expect(screen.getByRole("main")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "EducateOS district admin" })).toBeTruthy();
    expect(await screen.findByRole("heading", { level: 2, name: label === "Term rollover" ? "Term rollover preview" : label })).toBeTruthy();
    expect(within(screen.getByRole("navigation")).getByRole("link", { name: label }).getAttribute("aria-current")).toBe("page");
    // Let the screen's loads settle before checking its controls.
    await waitFor(() => expect(screen.queryByText(/^Loading /)).toBeNull());
    for (const role of CONTROL_ROLES) {
      const named = screen.queryAllByRole(role, { name: (name) => name.trim().length > 0 });
      const unnamed = screen.queryAllByRole(role).filter((control) => !named.includes(control));
      expect(unnamed.map((control) => control.outerHTML.slice(0, 120)), `every ${role} has an accessible name`).toStrictEqual([]);
    }
    expect(screen.getByRole("status", { hidden: true })).toBeTruthy();
  });

  it("the skip link moves focus to the content without leaving the screen", async () => {
    const { user } = renderConsole(fakeDistrict().client, "roster");
    await user.tab();
    const skip = screen.getByRole("link", { name: "Skip to content" });
    expect(document.activeElement).toBe(skip);
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(screen.getByRole("main"));
    expect(await screen.findByRole("heading", { level: 2, name: "Roster" })).toBeTruthy();
  });
});

describe("the keyboard-only acceptance journey", () => {
  it("navigates to Modules, turns a module on for three classes, previews and activates, using only the keyboard", async () => {
    const district = fakeDistrict();
    const { user } = renderConsole(district.client, "dashboard");
    await screen.findByRole("list", { name: "District at a glance" });

    await tabTo(user, () => screen.getByRole("link", { name: "Modules and activation" }));
    await user.keyboard("{Enter}");
    await screen.findByRole("heading", { level: 2, name: "Modules and activation" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("main")));

    // Into the module's radio group, then the arrow key chooses On.
    const core = await screen.findByRole("group", { name: "Core learning state" });
    await tabTo(user, () => within(core).getByRole("radio", { name: "Off" }));
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(within(core).getByRole("radio", { name: "On" }).getAttribute("aria-checked")).toBe("true"));

    for (const c of CLASSES.slice(0, 3)) {
      const box = await screen.findByRole("checkbox", { name: new RegExp(`^${classTitle(c)} `) });
      await tabTo(user, () => box);
      await user.keyboard(" ");
    }
    expect(screen.getByText("3 classes selected.")).toBeTruthy();

    await tabTo(user, () => screen.getByRole("button", { name: "Preview changes" }));
    await user.keyboard("{Enter}");
    const review = await screen.findByRole("region", { name: "Preview: modules for 3 classes" });
    // Focus lands on the preview's heading, so the reader starts there.
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Preview: modules for 3 classes"));
    await within(review).findByText(/Core learning turns on/);

    await tabTo(user, () => within(review).getByRole("button", { name: "Activate" }));
    await user.keyboard("{Enter}");
    expect(await screen.findByText("Modules activated. Version 2 of the configuration is now in force.")).toBeTruthy();
    expect(district.revisions).toHaveLength(2);
    expect(screen.getByRole("status", { hidden: true }).textContent).toContain("A new configuration version is in force");
  });
});
