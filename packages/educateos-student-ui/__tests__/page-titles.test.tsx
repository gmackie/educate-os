// Every screen names itself in the document title, uniquely, and moving to a screen moves focus to
// its heading, so keyboard and screen-reader users start at its top (WCAG 2.4.2, 2.4.3; SCHO-382).
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { routeName } from "../src/routeName.ts";
import { OSMOSIS, SCIENCE, fakeDistrict } from "./fakeDistrict.ts";
import { renderApp } from "./render.tsx";

/** Waits for the screen titled `title` to show, and checks its heading took focus. */
const onScreen = async (title: string) => {
  await waitFor(() => expect(document.title).toBe(title));
  const heading = screen.getByRole("heading", { level: 1 });
  expect(document.activeElement).toBe(heading);
};

describe("page titles", () => {
  it("names each route uniquely before its screen loads", () => {
    const paths = [
      "/", "/my-space", "/grades", "/calendar", "/notifications", "/settings", "/courses/a", "/courses/a/activities/b",
      "/courses/a/quizzes/b", "/courses/a/quizzes/b/attempts/c", "/family", "/family/settings", "/family/invitation",
      "/family/children/a", "/family/children/a/courses/b", "/devices", "/devices/connect",
    ];
    const names = paths.map(routeName);
    expect(new Set(names).size).toBe(paths.length);
    expect(routeName("/courses/a/")).toBe("Class");
    expect(routeName("/nowhere")).toBe("Page not found");
  });

  it("titles each screen a student visits and moves focus to its heading", async () => {
    const district = fakeDistrict();
    const user = userEvent.setup();
    await renderApp(district);
    await waitFor(() => expect(document.title).toBe("Home · Learning Home"));

    const main = screen.getByRole("navigation", { name: "Main" });
    await user.click(within(main).getByRole("link", { name: "Grades" }));
    await onScreen("My grades · Learning Home");
    await user.click(within(main).getByRole("link", { name: "My Space" }));
    await onScreen("My space · Learning Home");
    await user.click(within(main).getByRole("link", { name: "Calendar" }));
    await onScreen("Calendar · Learning Home");
    await user.click(within(main).getByRole("link", { name: "Home" }));
    await onScreen("Home · Learning Home");

    await user.click(await screen.findByRole("link", { name: "Biology · Period 1" }));
    await onScreen("Biology · Period 1 · Learning Home");
    await user.click(await screen.findByRole("link", { name: "Osmosis in potato cores" }));
    await onScreen("Osmosis in potato cores · Biology · Period 1 · Learning Home");
  });

  it("titles a screen that cannot load by its route", async () => {
    const district = fakeDistrict();
    await renderApp(district, `/courses/${SCIENCE}/activities/${OSMOSIS}-missing`);
    await screen.findByText("We couldn't find this activity");
    expect(document.title).toBe("Activity · Learning Home");
  });
});
