// SCHO-186: a teacher builds a class's modules, publishes them, and moves content in and out as a
// Common Cartridge.
import { screen, waitFor, within } from "@testing-library/dom";
import { describe, expect, it } from "vitest";
import { fakeDistrict, IDS } from "./fakeDistrict.ts";
import { onScreen, renderApp } from "./render.tsx";

const modulesPage = `#/classes/${IDS.offering}/modules`;

describe("class modules", () => {
  it("adds modules, writes a page, places an activity, publishes and reorders", async () => {
    const district = fakeDistrict();
    const user = await renderApp(district.client, `#/classes/${IDS.offering}/roster`);
    await user.click(await screen.findByRole("link", { name: "Modules" }));
    await onScreen("Modules · English 9 · Period 3");
    expect(await screen.findByText("No modules yet")).toBeTruthy();

    await user.type(screen.getByRole("textbox", { name: "New module" }), "Week 1: Claims");
    await user.click(screen.getByRole("button", { name: "Add module" }));
    const week1 = await screen.findByRole("heading", { level: 2, name: "Week 1: Claims" });
    expect(screen.getByRole("status", { name: "" }).textContent).toContain("Students see it once you publish it");
    await user.type(screen.getByRole("textbox", { name: "New module" }), "Week 2: Evidence");
    await user.click(screen.getByRole("button", { name: "Add module" }));
    await screen.findByRole("heading", { level: 2, name: "Week 2: Evidence" });

    const card = () => week1.closest("li")! as HTMLElement;
    await user.click(within(card()).getByRole("button", { name: "Add page" }));
    await user.type(within(card()).getByRole("textbox", { name: "Page title" }), "What is a claim?");
    await user.type(within(card()).getByRole("textbox", { name: /Page text/ }), "A **claim** is arguable.");
    await user.click(within(card()).getByRole("button", { name: "Add page" }));
    await waitFor(() => expect(within(card()).getByText("What is a claim?")).toBeTruthy());
    expect(district.callsTo("teacher.addPage")[0]!.input.body).toStrictEqual({ title: "What is a claim?", body: "A **claim** is arguable." });

    await user.click(within(card()).getByRole("button", { name: "Add activity" }));
    await user.click(within(card()).getByRole("radio", { name: "Persuasive paragraph" }));
    await user.click(within(card()).getByRole("button", { name: "Add activity" }));
    await waitFor(() => expect(within(card()).getByText("Persuasive paragraph")).toBeTruthy());

    expect(within(card()).getByText("Draft")).toBeTruthy();
    await user.click(within(card()).getByRole("switch", { name: "Visible to students" }));
    await waitFor(() => expect(within(card()).getByText("Published")).toBeTruthy());
    expect(district.callsTo("teacher.updateModule")[0]!.input.body).toStrictEqual({ published: true });

    await user.click(screen.getByRole("button", { name: "Move Week 2: Evidence up" }));
    await waitFor(() => {
      const titles = within(screen.getByRole("list", { name: "Modules" })).getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
      expect(titles).toStrictEqual(["Week 2: Evidence", "Week 1: Claims"]);
    });
    // The first module cannot move further up.
    expect((screen.getByRole("button", { name: "Move Week 2: Evidence up" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("previews a cartridge before importing it as drafts, and exports the class", async () => {
    const district = fakeDistrict();
    const user = await renderApp(district.client, modulesPage);
    await onScreen(/^Modules/);

    const file = new File([new Uint8Array([80, 75, 3, 4])], "ecosystems.imscc", { type: "application/zip" });
    await user.upload(screen.getByLabelText("Import a cartridge (.imscc)"), file);
    const preview = await screen.findByRole("region", { name: "Import preview" });
    expect(within(preview).getByText("ecosystems.imscc would add 1 module with 2 items.")).toBeTruthy();
    expect(within(preview).getByText("1 item won't come across")).toBeTruthy();
    expect(district.callsTo("teacher.importCartridge")).toHaveLength(0);
    expect(district.callsTo("teacher.previewCartridge")[0]!.input.body).toStrictEqual({ fileName: "ecosystems.imscc", base64: "UEsDBA==" });

    await user.click(within(preview).getByRole("button", { name: "Import 1 module" }));
    await screen.findByRole("heading", { level: 2, name: "Week 1: Producers" });
    expect(district.callsTo("teacher.importCartridge")[0]!.input.body).toMatchObject({ packageDigest: expect.stringMatching(/^sha256:/) });
    expect(screen.getByText("Imported")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Import preview" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Export as a cartridge" }));
    const download = await screen.findByRole("link", { name: "Download english-9-period-3.imscc" });
    expect(download.getAttribute("download")).toBe("english-9-period-3.imscc");
  });

  it("refuses a cartridge over the size limit without uploading it, and keeps a failed action's message", async () => {
    const district = fakeDistrict({ failures: { "teacher.createModule": { status: 403, body: { code: "forbidden", message: "no" } } } });
    const user = await renderApp(district.client, modulesPage);
    await onScreen(/^Modules/);
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "huge.imscc");
    await user.upload(screen.getByLabelText("Import a cartridge (.imscc)"), big);
    expect(await screen.findByText("That file is too large")).toBeTruthy();
    expect(district.callsTo("teacher.previewCartridge")).toHaveLength(0);

    const title = screen.getByRole("textbox", { name: "New module" });
    await user.type(title, "Week 1");
    await user.click(screen.getByRole("button", { name: "Add module" }));
    expect((await screen.findByRole("alert")).textContent).toContain("You don't have permission to do that in this class.");
    expect((title as HTMLInputElement).value).toBe("Week 1");
  });
});
