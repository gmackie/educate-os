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
    // Each item's controls name the item they act on.
    expect(within(card()).getByRole("button", { name: "Edit What is a claim?" })).toBeTruthy();
    expect(within(card()).getByRole("button", { name: "Move What is a claim? down" })).toBeTruthy();

    await user.click(within(card()).getByRole("button", { name: "Add activity" }));
    await user.click(within(card()).getByRole("radio", { name: "Persuasive paragraph" }));
    await user.click(within(card()).getByRole("button", { name: "Add activity" }));
    await waitFor(() => expect(within(card()).getByText("Persuasive paragraph")).toBeTruthy());

    // The switch is the one status indicator.
    expect(within(card()).getByRole("switch", { name: "Visible to students" }).getAttribute("aria-checked")).toBe("false");
    expect(within(card()).queryByText("Draft")).toBeNull();
    await user.click(within(card()).getByRole("switch", { name: "Visible to students" }));
    await waitFor(() => expect(within(card()).getByRole("switch", { name: "Visible to students" }).getAttribute("aria-checked")).toBe("true"));
    expect(within(card()).queryByText("Published")).toBeNull();
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

  it("previews a library course, installs it unit by unit as drafts beside what the class has, and shows teacher notes as teachers-only (SCHO-331)", async () => {
    const district = fakeDistrict({ courseLibrary: {} });
    const user = await renderApp(district.client, modulesPage);
    await onScreen(/^Modules/);
    // The class already has the course's first unit.
    await user.type(screen.getByRole("textbox", { name: "New module" }), "Week 1: Claims");
    await user.click(screen.getByRole("button", { name: "Add module" }));
    await screen.findByRole("heading", { level: 2, name: "Week 1: Claims" });

    const courses = await screen.findByRole("list", { name: "Courses" });
    expect(within(courses).getByText("Fits this class")).toBeTruthy();
    expect(within(courses).getByText("3 units · 3 activities · from educateos.io · version 1.0.0")).toBeTruthy();
    await user.click(within(courses).getByRole("button", { name: "Preview Grade 9 Argument Writing" }));
    const preview = await screen.findByRole("region", { name: "Course preview" });
    expect(within(preview).getByText("Grade 9 Argument Writing would add 2 draft modules to this class. Nothing it already has changes.")).toBeTruthy();
    expect(within(preview).getByText(/Already in this class; left as it is/)).toBeTruthy();
    expect(district.callsTo("teacher.installCourse")).toHaveLength(0);

    await user.click(within(preview).getByRole("button", { name: "Add 2 modules" }));
    await screen.findByRole("heading", { level: 2, name: "Counterclaims" });
    // One unit a request, until done.
    expect(district.callsTo("teacher.installCourse").map((call) => call.input.body)).toStrictEqual([
      { packageId: "educateos.io/grade-9-argument", version: "1.0.0", maxUnits: 1 },
      { packageId: "educateos.io/grade-9-argument", version: "1.0.0", maxUnits: 1 },
    ]);
    await waitFor(() => expect(screen.getByRole("status", { name: "" }).textContent).toContain("Added Grade 9 Argument Writing as 2 draft modules, leaving 1 module this class already had."));
    expect(screen.queryByRole("region", { name: "Course preview" })).toBeNull();

    const unit = screen.getByRole("heading", { level: 2, name: "Reasons and Evidence" }).closest("li")! as HTMLElement;
    expect(within(unit).getByText("From a course")).toBeTruthy();
    expect(within(unit).getByText("Teacher note · teachers only")).toBeTruthy();
    expect(within(unit).getByRole("button", { name: "Edit Reasons and Evidence: teacher guide" })).toBeTruthy();
    expect(within(unit).getByRole("switch", { name: "Visible to students" }).getAttribute("aria-checked")).toBe("false");
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Courses" })).getByText("Added")).toBeTruthy());
  });

  it("says why a library course can't be added, and offers nothing to press (SCHO-331)", async () => {
    const problem = "The course's activities align to ccss-ela learning goals your district has not approved (W.9-10.1). Ask a district administrator to approve the ccss-ela standards.";
    const district = fakeDistrict({ courseLibrary: { problems: [problem] } });
    const user = await renderApp(district.client, modulesPage);
    await onScreen(/^Modules/);
    await user.click(await screen.findByRole("button", { name: "Preview Grade 9 Argument Writing" }));
    const preview = await screen.findByRole("region", { name: "Course preview" });
    expect(within(preview).getByText("This course can't be added yet")).toBeTruthy();
    expect(within(preview).getByText(problem)).toBeTruthy();
    expect((within(preview).getByRole("button", { name: "Add 3 modules" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("tells the teacher when the district's course library is empty (SCHO-331)", async () => {
    const district = fakeDistrict();
    await renderApp(district.client, modulesPage);
    expect(await screen.findByText("Your district hasn't added any courses to its course library yet.")).toBeTruthy();
  });
});
