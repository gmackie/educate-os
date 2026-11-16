import { screen, waitFor, within } from "@testing-library/dom";
import { describe, expect, it } from "vitest";
import { fakeDistrict, IDS } from "../../__tests__/fakeDistrict.ts";
import { onScreen, renderApp, schoolWith } from "../../__tests__/render.tsx";

const setup = `#/classes/${IDS.offering}/setup`;

describe("bringing an existing classroom into EducateOS", () => {
  it("opens setup from My classes, supports keyboard choices and sends a resource to review", async () => {
    const district = fakeDistrict();
    const user = await renderApp(district.client);
    await user.click(await screen.findByRole("link", { name: "Set up this class" }));
    const heading = await onScreen("Classroom setup · English 9 · Period 3");
    expect(document.activeElement).toBe(heading);
    expect(screen.getByRole("link", { name: "Classroom setup" }).getAttribute("aria-current")).toBe("page");
    const material = screen.getByRole("checkbox", { name: "Websites and online resources" });
    material.focus();
    await user.keyboard(" ");
    await user.type(screen.getByRole("textbox", { name: /Web address/ }), "https://open-lessons.example/lesson");
    await user.click(screen.getByRole("button", { name: "Send for review" }));
    await onScreen("Persuasive Writing Models");
    expect(district.callsTo("teacher.importResource")[0]!.input).toStrictEqual({ params: { offeringId: IDS.offering }, body: { url: "https://open-lessons.example/lesson" } });
    expect(district.callsTo("teacher.approveResource")).toHaveLength(0);
    expect(district.callsTo("teacher.installActivity")).toHaveLength(0);
  });

  it("keeps a failed resource import editable and lets the teacher retry", async () => {
    const district = fakeDistrict({ failures: { "teacher.importResource": { status: 503, body: { code: "unavailable", message: "down" } } } });
    const user = await renderApp(district.client, setup);
    await user.click(await screen.findByRole("checkbox", { name: "Websites and online resources" }));
    const address = screen.getByRole("textbox", { name: /Web address/ });
    await user.type(address, "https://open-lessons.example/lesson");
    await user.click(screen.getByRole("button", { name: "Send for review" }));
    expect((await screen.findByRole("alert")).textContent).toContain("The district didn't answer");
    expect((address as HTMLInputElement).value).toBe("https://open-lessons.example/lesson");
    district.fail("teacher.importResource", undefined);
    await user.click(screen.getByRole("button", { name: "Send for review" }));
    await onScreen("Persuasive Writing Models");
  });

  it("stays in setup through course preview and cancellation, then imports only on confirmation", async () => {
    const district = fakeDistrict();
    const user = await renderApp(district.client, setup);
    await user.click(await screen.findByRole("checkbox", { name: "A course export" }));
    const file = new File([new Uint8Array([80, 75, 3, 4])], "ecosystems.imscc", { type: "application/zip" });
    await user.upload(screen.getByLabelText("Import a cartridge (.imscc)"), file);
    const preview = await screen.findByRole("region", { name: "Import preview" });
    expect(window.location.hash).toBe(setup);
    expect(within(preview).getByText("1 item won't come across")).toBeTruthy();
    expect(district.callsTo("teacher.importCartridge")).toHaveLength(0);
    await user.click(within(preview).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("region", { name: "Import preview" })).toBeNull();
    expect(district.callsTo("teacher.importCartridge")).toHaveLength(0);
    await user.upload(screen.getByLabelText("Import a cartridge (.imscc)"), file);
    await user.click(await screen.findByRole("button", { name: "Import 1 module" }));
    await onScreen("Modules · English 9 · Period 3");
    expect(await screen.findByRole("heading", { name: "Week 1: Producers" })).toBeTruthy();
    expect(district.callsTo("teacher.importCartridge")).toHaveLength(1);
    expect(screen.getByRole("switch", { name: "Visible to students" }).getAttribute("aria-checked")).toBe("false");
    expect(district.callsTo("teacher.updateModule")).toHaveLength(0);
  });

  it("retains the preview after an import failure so it can be retried", async () => {
    const district = fakeDistrict({ failures: { "teacher.importCartridge": { status: 503, body: { code: "unavailable", message: "down" } } } });
    const user = await renderApp(district.client, setup);
    await user.click(await screen.findByRole("checkbox", { name: "A course export" }));
    await user.upload(screen.getByLabelText("Import a cartridge (.imscc)"), new File([new Uint8Array([80, 75, 3, 4])], "lesson.imscc", { type: "application/zip" }));
    await user.click(await screen.findByRole("button", { name: "Import 1 module" }));
    expect((await screen.findByRole("alert")).textContent).toContain("The district didn't answer");
    expect(screen.getByRole("region", { name: "Import preview" })).toBeTruthy();
    expect(window.location.hash).toBe(setup);
    district.fail("teacher.importCartridge", undefined);
    await user.click(screen.getByRole("button", { name: "Import 1 module" }));
    await onScreen(/^Modules/);
  });

  it("offers several material sources and activity steps without importing or connecting them", async () => {
    const district = fakeDistrict();
    const user = await renderApp(district.client, setup);
    for (const name of ["Documents, slides and worksheets", "Google Classroom or another learning system", "Other classroom tools"]) {
      await user.click(await screen.findByRole("checkbox", { name }));
    }
    expect(screen.getByText(/Direct document uploads are not available/)).toBeTruthy();
    expect(screen.getByText(/Selecting this option does not import assignments/)).toBeTruthy();
    expect(screen.getByText(/Spreadsheets, forms and question banks do not have a direct importer/)).toBeTruthy();
    const reuse = screen.getByRole("radio", { name: /^Bring my materials/ });
    reuse.focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("radio", { name: /^Build an EducateOS activity/ }).getAttribute("aria-checked")).toBe("true");
    await user.click(screen.getByRole("link", { name: "Create your first activity" }));
    await onScreen(/^Create activity/);
    expect(district.callsTo("teacher.createActivity")).toHaveLength(0);
    expect(district.callsTo("teacher.importResource")).toHaveLength(0);
    expect(district.callsTo("teacher.importCartridge")).toHaveLength(0);
  });

  it.each([false, true])("offers the AI workspace only when the district enables it (%s)", async (ai) => {
    const user = await renderApp(fakeDistrict().client, setup, schoolWith({ ai }));
    await user.click(await screen.findByRole("radio", { name: /^Connect my existing tools/ }));
    const next = screen.getByRole("region", { name: "Your next steps" });
    expect(within(next).queryByRole("link", { name: /Open the AI workspace/ }) !== null).toBe(ai);
    expect(within(next).getByText(/an account connection alone does not enable them/)).toBeTruthy();
  });

  it("keeps embedded hosts in their own frame", async () => {
    const user = await renderApp(fakeDistrict().client, setup, false);
    await user.click(await screen.findByRole("radio", { name: /^Connect my existing tools/ }));
    expect(screen.queryByRole("link", { name: /Open the AI workspace/ })).toBeNull();
  });

  it("requires an assigned class and rejects another teacher's class before offering imports", async () => {
    const district = fakeDistrict();
    await renderApp(district.client, "#/classes/off_another/setup");
    await screen.findByText("This class isn't one of yours");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(district.callsTo("teacher.importResource")).toHaveLength(0);
  });

  it("explains how to get a first class when the roster is empty", async () => {
    await renderApp(fakeDistrict({ offerings: [] }).client);
    expect(await screen.findByText(/Ask your school administrator to add your class and roster/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("link", { name: "Set up this class" })).toBeNull());
  });
});
