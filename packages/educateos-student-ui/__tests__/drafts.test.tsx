import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { ENGLISH, ESSAY, fakeDistrict } from "./fakeDistrict.ts";
import { announcement, renderApp } from "./render.tsx";

const ACTIVITY = `/courses/${ENGLISH}/activities/${ESSAY}`;
const EDITOR = { name: "Your work for Draft your argument" };

describe("unsaved work", () => {
  it("keeps typed text on screen and in the tab when a save fails, and restores it after a reload", async () => {
    const district = fakeDistrict();
    const user = userEvent.setup();
    const first = await renderApp(district, ACTIVITY);

    await user.type(await screen.findByRole("textbox", EDITOR), "My first paragraph.");
    district.failNext("student.createArtifact", "network");
    await user.click(screen.getByRole("button", { name: "Save" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Not saved yet")).toBeTruthy();
    expect(alert.textContent).toMatch(/kept on this device/);
    expect(announcement()).toMatch(/was not saved/);
    expect(screen.getByRole("textbox", EDITOR)).toHaveProperty("value", "My first paragraph.");
    expect(Object.values(sessionStorage)).toContain("My first paragraph.");
    // Unsaved work cannot be submitted: a submission captures saved versions only.
    expect(screen.getByRole("button", { name: "Submit" })).toHaveProperty("disabled", true);
    expect(screen.getByText("Save your changes before you submit.")).toBeTruthy();

    // A reload (or the tab coming back) finds the draft.
    first.unmount();
    await renderApp(district, ACTIVITY);
    expect(await screen.findByRole("textbox", EDITOR)).toHaveProperty("value", "My first paragraph.");
    expect(screen.getByText("We kept your unsaved changes")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/^Saved /)).toBeTruthy();
    expect(Object.values(sessionStorage)).not.toContain("My first paragraph.");
    expect(screen.getByRole("button", { name: "Submit" })).toHaveProperty("disabled", false);
  });

  it("keeps the draft when the district refuses a later save", async () => {
    const district = fakeDistrict();
    const user = userEvent.setup();
    await renderApp(district, ACTIVITY);
    const editor = await screen.findByRole("textbox", EDITOR);
    await user.type(editor, "First part.");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/^Saved /);

    await user.type(editor, " Unsaved part.");
    district.failNext("student.saveRevision", { code: "unavailable" });
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(editor).toHaveProperty("value", "First part. Unsaved part.");
    expect(Object.values(sessionStorage)).toContain("First part. Unsaved part.");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
  });

  it("restores a draft kept before the EducateOS rename, and drops it once saved (SCHO-232)", async () => {
    const district = fakeDistrict();
    const user = userEvent.setup();
    const first = await renderApp(district, ACTIVITY);
    await user.type(await screen.findByRole("textbox", EDITOR), "Typed before the rename.");
    // Re-key the draft as the code before the rename kept it.
    const key = Object.keys(sessionStorage).find((k) => k.startsWith("educateos.student.draft:"))!;
    sessionStorage.setItem(key.replace("educateos.", "schoolos."), sessionStorage.getItem(key)!); // rename-educateos: keep
    sessionStorage.removeItem(key);
    first.unmount();

    await renderApp(district, ACTIVITY);
    expect(await screen.findByRole("textbox", EDITOR)).toHaveProperty("value", "Typed before the rename.");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/^Saved /)).toBeTruthy();
    expect(sessionStorage.length).toBe(0);
  });

  it("drops the draft when the text goes back to what was saved", async () => {
    const district = fakeDistrict();
    const user = userEvent.setup();
    await renderApp(district, ACTIVITY);
    const editor = await screen.findByRole("textbox", EDITOR);
    await user.type(editor, "x");
    expect(sessionStorage.length).toBe(1);
    await user.clear(editor);
    expect(sessionStorage.length).toBe(0);
  });
});
