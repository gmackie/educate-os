import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { ART_SPRING, COLOR, fakeDistrict } from "./fakeDistrict.ts";
import { announcement, renderApp } from "./render.tsx";

describe("My space", () => {
  it("says only the student can see it, and saves a private note", async () => {
    const district = fakeDistrict();
    const user = userEvent.setup();
    await renderApp(district, "/my-space");
    expect(await screen.findByRole("heading", { level: 1, name: "My space" })).toBeTruthy();
    expect(screen.getByText("Only you can see this")).toBeTruthy();
    expect(await screen.findByText("Nothing here yet")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "New note" }));
    await user.type(screen.getByRole("textbox", { name: "Note title" }), "Ideas");
    await user.type(screen.getByRole("textbox", { name: "Note" }), "Start with sleep research.");
    await user.click(screen.getByRole("button", { name: "Save note" }));
    expect(await screen.findByText("Ideas")).toBeTruthy();
    expect(announcement()).toMatch(/Note saved/);
    expect(district.calls.find((call) => call.name === "student.createArtifact")?.input).toMatchObject({ body: { workspaceId: "wsp_amara-personal", title: "Ideas" } });
  });

  it("keeps a copy of work from a finished class", async () => {
    const district = fakeDistrict();
    district.addArtifact("wsp_amara-art", "Color in a painting you love: Describe the colors", "document", "text/plain", { kind: "text", text: "Blue makes it calm." });
    const user = userEvent.setup();
    await renderApp(district, "/my-space");

    const finished = await screen.findByRole("region", { name: "Keep work from finished classes" });
    const art = await within(finished).findByRole("region", { name: "Art · Grades 9–12" });
    await user.click(within(art).getByRole("button", { name: "Keep a copy of Color in a painting you love: Describe the colors" }));
    expect(await within(art).findByText("Kept in My space")).toBeTruthy();
    expect(district.calls.find((call) => call.name === "student.keepArtifact")?.input).toMatchObject({ params: { workspaceId: "wsp_amara-art" } });

    const mine = screen.getByRole("region", { name: "My work" });
    const kept = await within(mine).findByText("Color in a painting you love: Describe the colors");
    await user.click(within(kept.closest("li")!).getByRole("button", { name: /^Open / }));
    expect(await within(mine).findByText("Blue makes it calm.")).toBeTruthy();
  });

  it("shows why work could not be kept", async () => {
    const district = fakeDistrict();
    district.addArtifact("wsp_amara-art", "Old sketch notes", "document", "text/plain", { kind: "text", text: "notes" });
    district.failNext("student.keepArtifact", { code: "forbidden", message: "internal detail" });
    const user = userEvent.setup();
    await renderApp(district, "/my-space");
    await user.click(await screen.findByRole("button", { name: "Keep a copy of Old sketch notes" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("You don't have access to this.");
  });
});

describe("a finished class", () => {
  it("shows work read-only, without Save or Submit", async () => {
    const district = fakeDistrict();
    district.addArtifact("wsp_amara-art", "Color in a painting you love: Describe the colors", "document", "text/plain", { kind: "text", text: "Blue makes it calm." });
    await renderApp(district, `/courses/${ART_SPRING}/activities/${COLOR}`);
    expect(await screen.findByText("This class has finished")).toBeTruthy();
    const editor = await screen.findByRole("textbox", { name: "Your work for Describe the colors" });
    expect(editor).toHaveProperty("readOnly", true);
    expect(editor).toHaveProperty("value", "Blue makes it calm.");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
    expect(screen.getByRole("button", { name: "History" })).toHaveProperty("disabled", false);
  });
});
