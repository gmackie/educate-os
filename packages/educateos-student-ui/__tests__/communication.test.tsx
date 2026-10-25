// SCHO-189: announcements on a class page and Home, notifications, the calendar's week and agenda
// views, and email and calendar-link settings.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { ENGLISH, ESSAY, fakeDistrict, SCIENCE } from "./fakeDistrict.ts";
import { announcement, renderApp } from "./render.tsx";

const dayHeading = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });

describe("announcements", () => {
  it("are shown on their class's page as the teacher typed them, never as markup", async () => {
    const { container } = await renderApp(fakeDistrict({ announcements: true }), `/courses/${ENGLISH}`);
    const section = await screen.findByRole("region", { name: "Announcements" });
    const item = within(section).getByRole("article", { name: "Library visit <Friday>" });
    expect(within(item).getByRole("heading", { level: 3 }).textContent).toBe("Library visit <Friday>");
    expect(within(item).getByText(/Bring your card/).textContent).toBe("Bring your card.\nWe meet at the door.");
    expect(container.querySelector("friday")).toBeNull();
  });

  it("are left out of a class with none, and shown with their class on Home", async () => {
    await renderApp(fakeDistrict({ announcements: true }), `/courses/${SCIENCE}`);
    await screen.findByRole("heading", { level: 2, name: "Activities" });
    expect(screen.queryByRole("region", { name: "Announcements" })).toBeNull();
  });

  it("show the newest across classes on Home", async () => {
    await renderApp(fakeDistrict({ announcements: true }));
    const section = await screen.findByRole("region", { name: "Announcements" });
    expect(within(section).getByText(/English 9 \(Period 3\)/)).toBeTruthy();
  });
});

describe("notifications", () => {
  it("are counted in the header, listed newest first, and marked read one at a time or all together", async () => {
    const district = fakeDistrict();
    const user = userEvent.setup();
    await renderApp(district);
    await user.click(await screen.findByRole("link", { name: "Notifications, 1 unread" }));
    await screen.findByRole("heading", { level: 1, name: "Notifications" });
    const links = screen.getAllByRole("link", { name: /announcement|Due soon/ });
    expect(links.map((l) => l.textContent)).toStrictEqual([
      "Unread: New announcement in English 9 (Period 3): Library visit <Friday>",
      "Due soon in Biology (Period 1): Osmosis in potato cores",
    ]);
    expect(links[1]!.getAttribute("href")).toContain("asg_osmosis-lab");

    await user.click(screen.getByRole("button", { name: 'Mark "New announcement in English 9 (Period 3): Library visit <Friday>" as read' }));
    await waitFor(() => expect(announcement()).toBe("Marked as read"));
    expect(district.calls.filter((c) => c.name === "me.markNotificationsRead").map((c) => c.input)).toStrictEqual([{ body: { ids: [`ntf_${"1".repeat(32)}`] } }]);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Mark all as read" })).toBeNull());
    // The header catches up on the next navigation.
    await user.click(screen.getByRole("link", { name: "Home" }));
    await screen.findByRole("link", { name: "Notifications" });
  });
});

describe("calendar", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T15:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows this week day by day, moves between weeks, and lists what is ahead as an agenda", async () => {
    const user = userEvent.setup();
    await renderApp(fakeDistrict(), "/calendar");
    await screen.findByRole("heading", { level: 1, name: "Calendar" });
    const dueDay = dayHeading.format(new Date("2026-10-22T21:00:00.000Z"));
    const day = await screen.findByRole("region", { name: dueDay });
    const due = within(day).getByRole("link", { name: "Due: Should the school day start later? — English 9 (Period 3)" });
    expect(due.getAttribute("href")).toContain(ESSAY);
    expect(within(screen.getByRole("region", { name: dayHeading.format(new Date(2026, 9, 19)) })).getByText("All day")).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(7);
    expect((screen.getByRole("button", { name: "Week" })).getAttribute("aria-pressed")).toBe("true");

    await user.click(screen.getByRole("button", { name: "Next week" }));
    await waitFor(() => expect(screen.getAllByText("Nothing scheduled")).toHaveLength(7));

    await user.click(screen.getByRole("button", { name: "Agenda" }));
    const lab = await screen.findByRole("link", { name: "Due: Osmosis lab report — Biology (Period 1)" });
    expect(lab.closest("section")?.getAttribute("aria-labelledby")).toMatch(/^day-2026-11-1[23]$/);
    expect(screen.queryByText("Nothing scheduled")).toBeNull();
  });
});

describe("settings", () => {
  it("turns an email kind off at once", async () => {
    const district = fakeDistrict();
    const user = userEvent.setup();
    await renderApp(district, "/settings");
    const toggle = await screen.findByRole("switch", { name: "New announcements" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await user.click(toggle);
    await waitFor(() => expect(screen.getByRole("switch", { name: "New announcements" }).getAttribute("aria-checked")).toBe("false"));
    expect(district.calls.filter((c) => c.name === "me.updatePreferences").map((c) => c.input)).toStrictEqual([{ body: { email: { announcements: false } } }]);
    expect(announcement()).toBe("Email turned off");
  });

  it("makes a calendar link shown once, replaces it, and turns it off", async () => {
    const district = fakeDistrict();
    const user = userEvent.setup();
    await renderApp(district, "/settings");
    await user.click(await screen.findByRole("button", { name: "Make a calendar link" }));
    const first = (await screen.findByRole("textbox", { name: "Your calendar link" }) as HTMLInputElement).value;
    expect(first).toMatch(new RegExp(`^${window.location.origin}/api/calendar/[A-Za-z0-9]+\\.ics$`));
    expect(screen.getByText("Copy it now: it won't be shown again")).toBeTruthy();

    await user.click(await screen.findByRole("button", { name: "Replace link" }));
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Your calendar link" }) as HTMLInputElement).value).not.toBe(first));
    expect(announcement()).toBe("New calendar link made. Earlier links no longer work.");

    await user.click(screen.getByRole("button", { name: "Turn off link" }));
    await screen.findByRole("button", { name: "Make a calendar link" });
    expect(screen.queryByRole("textbox", { name: "Your calendar link" })).toBeNull();
    expect(district.calls.filter((c) => c.name === "me.revokeCalendarFeed")).toHaveLength(1);
  });
});
