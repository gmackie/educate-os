// What a teacher sees while waiting, when there is nothing yet, and when the district fails, and
// that the roster shows class records only.
import { screen, waitFor, within } from "@testing-library/dom";
import { describe, expect, it } from "vitest";
import type { DistrictApiClient } from "@schoolos/api-client";
import { fakeDistrict, IDS } from "./fakeDistrict.ts";
import { onScreen, renderApp } from "./render.tsx";

const unavailable = { status: 503, body: { code: "unavailable" as const, message: "down", correlationId: "req-42" } };

describe("loading, empty and error states", () => {
  it("say what they are waiting for", async () => {
    const pending: DistrictApiClient = { call: (() => new Promise(() => {})) as DistrictApiClient["call"] };
    await renderApp(pending);
    // A status, so a screen reader announces the wait.
    expect(screen.getAllByRole("status").some((status) => status.textContent === "Loading your classes…")).toBe(true);
  });

  it("explain an empty class list", async () => {
    await renderApp(fakeDistrict({ offerings: [] }).client);
    expect(await screen.findByText("No classes yet")).toBeTruthy();
  });

  it("explain an empty review queue and an activity with no work turned in", async () => {
    const district = fakeDistrict();
    const user = await renderApp(district.client, `#/classes/${IDS.offering}/resources`);
    expect(await screen.findByText("Nothing to review")).toBeTruthy();
    expect(screen.getByText("No approved resources yet")).toBeTruthy();
    await user.click(screen.getByRole("link", { name: "Submissions" }));
    await user.click(await screen.findByRole("link", { name: /Persuasive paragraph/ }));
    expect(await screen.findByText("No work turned in yet")).toBeTruthy();
  });

  it("show a plain-words error with a reference, and recover on Try again", async () => {
    const district = fakeDistrict({ failures: { "teacher.listOfferings": unavailable } });
    const user = await renderApp(district.client);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The district didn't answer. Try again in a moment.");
    expect(alert.textContent).toContain("Reference: req-42");
    expect(alert.textContent).not.toContain("down");

    district.fail("teacher.listOfferings", undefined);
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: /English 9 · Period 3/ })).toBeTruthy();
  });

  it("keep the teacher's form when an action fails", async () => {
    const district = fakeDistrict({ failures: { "teacher.importResource": { status: 403, body: { code: "forbidden", message: "no" } } } });
    const user = await renderApp(district.client, `#/classes/${IDS.offering}/resources`);
    const address = await screen.findByRole("textbox", { name: /Web address/ });
    await user.type(address, "https://open-lessons.example/osmosis-lab");
    await user.click(screen.getByRole("button", { name: "Send for review" }));
    expect((await screen.findByRole("alert")).textContent).toContain("You don't have permission to do that in this class.");
    expect((address as HTMLInputElement).value).toBe("https://open-lessons.example/osmosis-lab");
  });

  it("refuse a class the teacher doesn't teach", async () => {
    await renderApp(fakeDistrict().client, "#/classes/off_rb-eng10-b/roster");
    expect(await screen.findByText("This class isn't one of yours")).toBeTruthy();
  });
});

describe("the roster", () => {
  it("shows enrollment and work turned in, and never reads or mentions a student's own space", async () => {
    const district = fakeDistrict();
    district.studentSubmits(IDS.existingAssignment, "Sleep matters.");
    await renderApp(district.client, `#/classes/${IDS.offering}/roster`);
    await onScreen(/^Roster/);
    const table = await screen.findByRole("table", { name: "Students in English 9 · Period 3" });
    const rows = within(table).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent));
    expect(rows).toStrictEqual([
      ["Amara Okafor", "Enrolled", "1 of 1 activities"],
      ["Elena Petrova", "No longer enrolled", "0 of 1 activities"],
    ]);
    // Teachers are not listed as students.
    expect(within(table).queryByText("Sam Rivera")).toBeNull();
    await waitFor(() => expect(district.calls.length).toBeGreaterThan(0));
    expect(district.calls.map((c) => c.name).filter((name) => /Workspace|Artifact/.test(name))).toStrictEqual([]);
    expect(document.body.textContent).not.toMatch(/personal|workspace|private/i);
  });
});

describe("someone the school has not added yet", () => {
  const unlinked = {
    status: 401,
    body: {
      code: "unauthenticated" as const,
      message: "This sign-in is not linked to a principal in this district.",
      correlationId: "req-7",
      unlinkedSignIn: { issuer: "https://northfield.cloudflareaccess.com", subject: "a1b2c3-new-teacher" },
    },
  };
  const notAdded = () => fakeDistrict({ failures: { "me.get": unlinked, "teacher.listOfferings": unlinked } });

  it("sees that they are signed in, their sign-in ID, what to do with it, and a way to sign out", async () => {
    await renderApp(notAdded().client, `#/classes/${IDS.offering}/roster`);
    const heading = await onScreen("You're signed in, but you haven't been added to this school yet");
    expect(document.activeElement).toBe(heading);
    const id = screen.getByRole("group", { name: "Your sign-in ID" });
    expect(id.textContent).toContain("a1b2c3-new-teacher");
    expect(id.textContent).toContain("Signed in through northfield.cloudflareaccess.com");
    expect(screen.getByRole("main").textContent).toContain("Send this ID to your school's administrator. They add you, then reload this page.");
    expect(screen.getByRole("link", { name: "Sign out" }).getAttribute("href")).toBe("/cdn-cgi/access/logout");
    // Neither the class screens nor the failed loads behind them.
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("copies the sign-in ID from the keyboard and announces it", async () => {
    const user = await renderApp(notAdded().client);
    const copy = await screen.findByRole("button", { name: "Copy your sign-in ID" });
    while (document.activeElement !== copy) await user.tab();
    await user.keyboard("{Enter}");
    expect(await navigator.clipboard.readText()).toBe("a1b2c3-new-teacher");
    await waitFor(() => expect([...document.querySelectorAll('[aria-live="polite"]')].some((region) => region.textContent === "Sign-in ID copied")).toBe(true));
  });

  it("is not shown for a sign-in that ended, which says to sign in again", async () => {
    const ended = { status: 401, body: { code: "unauthenticated" as const, message: "Sign in with this district's identity provider." } };
    await renderApp(fakeDistrict({ failures: { "me.get": ended, "teacher.listOfferings": ended } }).client);
    expect((await screen.findByRole("alert")).textContent).toContain("Your sign-in has expired. Sign in again to continue.");
    expect(screen.queryByRole("group", { name: "Your sign-in ID" })).toBeNull();
  });
});
