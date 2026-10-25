// The theme control in the header: named for the mode in force and the next, reachable and
// operable from the keyboard, announced, kept for the next visit, and in force on the page.
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { fakeDistrict } from "./fakeDistrict.ts";
import { THEME_KEY, announcement, renderApp } from "./render.tsx";

const themeButton = () => within(screen.getByRole("banner")).getByRole("button", { name: /^Theme:/ });

describe("theme", () => {
  it("starts on the system theme and switches from the keyboard, announcing and remembering each choice", async () => {
    const user = userEvent.setup();
    await renderApp(fakeDistrict());
    await screen.findByRole("heading", { level: 1 });
    expect(themeButton().getAttribute("aria-label")).toBe("Theme: system (light). Switch to light.");
    expect(document.documentElement.getAttribute("data-mode")).toBe("light");

    while (document.activeElement !== themeButton()) await user.tab();
    await user.keyboard("{Enter}");
    expect(themeButton().getAttribute("aria-label")).toBe("Theme: light. Switch to dark.");
    await user.keyboard(" ");
    expect(themeButton().getAttribute("aria-label")).toBe("Theme: dark. Switch to system.");
    expect(document.documentElement.getAttribute("data-mode")).toBe("dark");
    await waitFor(() => expect(announcement()).toBe("Theme: dark"));
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
  });

  it("opens in the theme chosen last time", async () => {
    localStorage.setItem(THEME_KEY, "dark");
    await renderApp(fakeDistrict());
    await screen.findByRole("heading", { level: 1 });
    expect(themeButton().getAttribute("aria-label")).toBe("Theme: dark. Switch to system.");
    expect(document.documentElement.getAttribute("data-mode")).toBe("dark");
  });
});
