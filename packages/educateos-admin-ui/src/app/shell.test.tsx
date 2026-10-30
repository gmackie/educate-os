// @vitest-environment jsdom
// The console in the district shell (SCHO-260): the administrator's own places across the origin,
// then the console's sections as the sidebar's Admin group, as hash links that keep the page. A
// host that embeds the console keeps its own frame.
import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/dom";
import { fakeDistrict } from "../testing/fakeDistrict.ts";
import { renderConsole } from "../testing/renderConsole.tsx";
import { SCREENS } from "./useHashRoute.ts";

describe("the console in the district shell", () => {
  it("draws the administrator's own places, then every section of the console as the Admin group", async () => {
    renderConsole(fakeDistrict().client, "roster");
    const admin = await screen.findByRole("list", { name: "Admin" });
    const nav = screen.getByRole("navigation", { name: "Main" });
    const firstGroup = within(nav).getAllByRole("list")[0]!;
    expect(within(firstGroup).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toStrictEqual([
      ["Today", "/teach/"], ["Classes", "/teach/#/classes"], ["Gradebook", "/teach/#/classes"], ["Calendar", "/calendar"], ["Inbox", "/notifications"],
    ]);
    expect(within(nav).getByRole("link", { name: "AI workspace" }).getAttribute("href")).toBe("/ai/");
    expect(within(admin).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toStrictEqual(SCREENS.map((s) => [s.label, `#/${s.path}`]));
    expect(within(admin).getByRole("link", { name: "Roster" }).getAttribute("aria-current")).toBe("page");
    expect(await screen.findByRole("button", { name: /Avery Admin.*account menu/ })).toBeTruthy();
    // One navigation: the console has no section list of its own in the shell.
    expect(screen.queryByRole("navigation", { name: "Admin sections" })).toBeNull();
  });

  it("moves between sections in place, focusing the new screen", async () => {
    const { user } = renderConsole(fakeDistrict().client, "dashboard");
    await user.click(within(await screen.findByRole("list", { name: "Admin" })).getByRole("link", { name: "Guardians" }));
    expect(window.location.hash).toBe("#/guardians");
    expect(await screen.findByRole("heading", { level: 2, name: "Guardians" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });

  it("keeps its own header and section list where a host embeds it", async () => {
    renderConsole(fakeDistrict().client, "dashboard", false);
    expect(await screen.findByRole("navigation", { name: "Admin sections" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
  });
});
