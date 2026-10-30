// @vitest-environment jsdom
// Who may use the console: someone signed in whom the school has not added gets their sign-in ID to
// pass on, a person who is not a district administrator is pointed to the apps that are theirs, and
// neither sees the admin sections. An administrator gets the console, each section named for what
// it is.
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/dom";
import { DistrictApiError, type DistrictApiClient } from "@educateos/api-client";
import { fakeDistrict } from "../testing/fakeDistrict.ts";
import { renderConsole } from "../testing/renderConsole.tsx";
import { SCREENS } from "./useHashRoute.ts";

describe("someone the school has not added yet", () => {
  it("sees that they are signed in, their sign-in ID, what to do with it, and a way to sign out", async () => {
    renderConsole(fakeDistrict({ caller: "unlinked" }).client);
    const heading = await screen.findByRole("heading", { level: 2, name: "You're signed in, but you haven't been added to this school yet" });
    const section = heading.closest("section")!;
    const id = within(section).getByRole("group", { name: "Your sign-in ID" });
    expect(id.textContent).toContain("a1b2c3-new-person");
    expect(id.textContent).toContain("Signed in through fake.cloudflareaccess.com");
    expect(section.textContent).toContain("Send this ID to your school's administrator. They add you, then reload this page.");
    expect(within(section).getByRole("link", { name: "Sign out" }).getAttribute("href")).toBe("/cdn-cgi/access/logout");
    expect(screen.queryByRole("list", { name: "Admin" })).toBeNull();
    expect(document.body.textContent).not.toContain("not linked to a principal");
  });

  it("copies the sign-in ID from the keyboard and announces it", async () => {
    const { user } = renderConsole(fakeDistrict({ caller: "unlinked" }).client);
    const copy = await screen.findByRole("button", { name: "Copy your sign-in ID" });
    while (document.activeElement !== copy) await user.tab();
    await user.keyboard("{Enter}");
    expect(await navigator.clipboard.readText()).toBe("a1b2c3-new-person");
    await waitFor(() => expect([...document.querySelectorAll('[aria-live="polite"]')].some((region) => region.textContent === "Sign-in ID copied")).toBe(true));
  });
});

describe("a person who is not a district administrator", () => {
  it("is told so and offered Learning Home and Teacher Studio, without the admin sections", async () => {
    const { user } = renderConsole(fakeDistrict({ caller: "not-administrator" }).client, "classes-people");
    const heading = await screen.findByRole("heading", { level: 2, name: "You're not an administrator of this school" });
    const apps = within(heading.closest("section")!).getByRole("navigation", { name: "Other EducateOS apps" });
    expect(within(apps).getByRole("link", { name: "Learning Home" }).getAttribute("href")).toBe("/");
    expect(within(apps).getByRole("link", { name: "Teacher Studio" }).getAttribute("href")).toBe("/teach/");
    expect(screen.queryByRole("list", { name: "Admin" })).toBeNull();
    expect(document.body.textContent).not.toMatch(/Could not load|reference req-fake/);
    // Both links are reachable from the keyboard, after the skip link and the shell's sidebar, which
    // offers their own places and the theme control (SCHO-260).
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Skip to content" }));
    const learningHome = within(apps).getByRole("link", { name: "Learning Home" });
    const sidebar = screen.getByRole("banner");
    for (let presses = 0; presses < 30 && document.activeElement !== learningHome; presses++) {
      await user.tab();
      if (document.activeElement !== learningHome) expect(sidebar.contains(document.activeElement)).toBe(true);
    }
    expect(document.activeElement).toBe(learningHome);
    await user.tab();
    expect(document.activeElement).toBe(within(apps).getByRole("link", { name: "Teacher Studio" }));
  });
});

describe("a district administrator", () => {
  it("waits for their access to be checked, then gets the console with a distinct name for every section", async () => {
    renderConsole(fakeDistrict().client);
    expect(screen.getByText("Checking your access...")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Admin" })).toBeNull();
    const nav = await screen.findByRole("list", { name: "Admin" });
    const labels = within(nav).getAllByRole("link").map((link) => link.textContent);
    expect(labels).toStrictEqual(SCREENS.map((s) => s.label));
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toContain("All classes");
    expect(labels).toContain("Manage classes and people");
    expect(screen.queryByText("Checking your access...")).toBeNull();
  });

  it("keeps the console when the district fails for another reason, so each screen reports it", async () => {
    const { client } = fakeDistrict();
    const failing: DistrictApiClient = {
      call: ((name: Parameters<DistrictApiClient["call"]>[0], ...args: unknown[]) => name === "admin.getConfig"
        ? Promise.reject(new DistrictApiError(503, { code: "unavailable", message: "The request could not be completed." }))
        : (client.call as (...a: unknown[]) => Promise<unknown>)(name, ...args)) as DistrictApiClient["call"],
    };
    renderConsole(failing, "modules");
    expect(await screen.findByRole("list", { name: "Admin" })).toBeTruthy();
    expect(await screen.findByText(/Could not load/)).toBeTruthy();
  });
});
