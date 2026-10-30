// @vitest-environment jsdom
// SCHO-277: a district administrator sees where the roster comes from and how its syncs have gone,
// runs a complete or delta sync and reads what it changed and found, and approves a held removal.
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/dom";
import { fakeDistrict } from "../testing/fakeDistrict.ts";
import { renderConsole } from "../testing/renderConsole.tsx";

const history = () => screen.findByRole("table", { name: "Recent roster syncs, newest first" });

describe("the Roster sync page", () => {
  it("is in the console's navigation", async () => {
    renderConsole(fakeDistrict().client, "roster-sync");
    const nav = await screen.findByRole("list", { name: "Admin" });
    expect(within(nav).getByRole("link", { name: "Roster sync" }).getAttribute("aria-current")).toBe("page");
  });

  it("shows the provider, its health and the recent runs, newest first", async () => {
    renderConsole(fakeDistrict().client, "roster-sync");
    const runs = await history();
    const source = screen.getByRole("region", { name: "Source" });
    expect(within(source).getByText("Clever")).toBeTruthy();
    expect(within(source).getByText("Healthy")).toBeTruthy();
    expect(within(source).getByText("0 syncs")).toBeTruthy();

    const [, newest, oldest] = within(runs).getAllByRole("row");
    expect(within(newest!).getByText("Delta sync")).toBeTruthy();
    expect(within(newest!).getByText("1 updated")).toBeTruthy();
    expect(within(oldest!).getByText("Complete sync")).toBeTruthy();
    // People, classes, enrollments, then schools, terms and courses together.
    expect(within(oldest!).getAllByRole("cell").slice(3).map((cell) => cell.textContent)).toStrictEqual(["96 added", "4 added", "96 added", "7 added", "0"]);
    expect(screen.getByRole("button", { name: "Run complete sync" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "Run delta sync" }).hasAttribute("disabled")).toBe(false);
  });

  it("runs a complete sync and shows what it changed, the issues it found and the new run", async () => {
    const district = fakeDistrict();
    const { user } = renderConsole(district.client, "roster-sync");
    await history();
    await user.click(screen.getByRole("button", { name: "Run complete sync" }));

    const result = await screen.findByRole("region", { name: "Complete sync just now" });
    expect(district.calls.find((c) => c.name === "admin.runRosterSync")?.input).toStrictEqual({ body: { mode: "complete" } });
    expect(within(result).getByText("The roster is up to date")).toBeTruthy();
    expect(within(result).getByText(/10 changes applied\. 1 person held for review\. 1 course access grant revoked/)).toBeTruthy();
    const changes = within(result).getByRole("table", { name: /Records the sync added/ });
    expect(within(changes).getByRole("row", { name: "People 1 2 1" })).toBeTruthy();
    expect(within(changes).getByRole("row", { name: "Enrollments 2 0 3" })).toBeTruthy();

    const issues = within(result).getByRole("table", { name: "Issues the sync found in the roster" });
    const issue = within(issues).getAllByRole("row")[1]!;
    expect(within(issue).getByText("Warning")).toBeTruthy();
    expect(within(issue).getByText("users.csv, row 12, column grades")).toBeTruthy();
    expect(within(issue).getByText("u-312")).toBeTruthy();
    expect(within(issue).getByText(/is not a grade level/)).toBeTruthy();

    // The status reloads, so the new run heads the history.
    await waitFor(async () => expect(within(await history()).getAllByRole("row")).toHaveLength(4));
    const newest = within(await history()).getAllByRole("row")[1]!;
    expect(within(newest).getByText("Complete sync")).toBeTruthy();
    expect(within(newest).getByText("1 added, 2 updated, 1 deactivated")).toBeTruthy();
    expect(screen.getByTestId("announcer").textContent).toContain("Complete sync finished. 10 changes applied.");
  });

  it("runs a delta sync when asked", async () => {
    const district = fakeDistrict();
    const { user } = renderConsole(district.client, "roster-sync");
    await history();
    await user.click(screen.getByRole("button", { name: "Run delta sync" }));
    expect(await screen.findByRole("region", { name: "Delta sync just now" })).toBeTruthy();
    expect(district.calls.find((c) => c.name === "admin.runRosterSync")?.input).toStrictEqual({ body: { mode: "delta" } });
  });

  it("shows a sync the roster's errors stopped, with each error's file, row and column", async () => {
    const { user } = renderConsole(fakeDistrict({ rosterSync: "feed-rejected" }).client, "roster-sync");
    await history();
    await user.click(screen.getByRole("button", { name: "Run complete sync" }));

    const result = await screen.findByRole("region", { name: "Complete sync just now" });
    expect(within(result).getByText("The sync failed")).toBeTruthy();
    expect(within(result).getByText(/nothing was applied/)).toBeTruthy();
    const issues = within(result).getByRole("table", { name: "Issues the sync found in the roster" });
    const error = within(issues).getByRole("row", { name: /enrollments\.csv, row 14, column classSourcedId/ });
    expect(within(error).getByText("Error")).toBeTruthy();
    expect(within(error).getByText("The enrollment names a class the feed does not list.")).toBeTruthy();
    expect(within(issues).getByRole("row", { name: /demographics\.csv/ })).toBeTruthy();

    const newest = await waitFor(async () => {
      const row = within(await history()).getAllByRole("row")[1]!;
      expect(within(row).getByText("Failed")).toBeTruthy();
      return row;
    });
    expect(within(newest).getByText(/would break the directory/)).toBeTruthy();
    const source = screen.getByRole("region", { name: "Source" });
    expect(within(source).getByText("Last sync failed")).toBeTruthy();
    expect(within(source).getByText("1 sync")).toBeTruthy();
  });

  it("holds a large removal until an administrator approves it", async () => {
    const district = fakeDistrict({ rosterSync: "removal-held" });
    const { user } = renderConsole(district.client, "roster-sync");
    await history();
    await user.click(screen.getByRole("button", { name: "Run complete sync" }));
    expect(await screen.findByText("This sync is waiting for approval")).toBeTruthy();

    await user.click(await screen.findByRole("button", { name: "Review removal" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/deactivate 60 people and 60 enrollments/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Approve removal" }));
    await waitFor(() => expect(district.calls.some((c) => c.name === "admin.approveRosterRemoval")).toBe(true));
    expect(district.calls.find((c) => c.name === "admin.approveRosterRemoval")?.input).toStrictEqual({ body: { fingerprint: "a".repeat(64) } });
    expect(await screen.findByText(/A removal is approved/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Review removal" })).toBeNull();

    // The next sync applies it.
    await user.click(screen.getByRole("button", { name: "Run complete sync" }));
    expect(await screen.findByText("The roster is up to date")).toBeTruthy();
  });

  it("says why a roster that cannot sync cannot, and offers no sync", async () => {
    renderConsole(fakeDistrict({ rosterSync: "not-runnable" }).client, "roster-sync");
    expect(await screen.findByText("The roster cannot sync")).toBeTruthy();
    expect(screen.getByText(/This deployment has no roster source for oneroster-api\./)).toBeTruthy();
    expect(screen.getByText("OneRoster connection")).toBeTruthy();
    expect(screen.getByText("No schedule")).toBeTruthy();
    expect(screen.getByText("No roster sync has run yet.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run complete sync" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Run delta sync" }).hasAttribute("disabled")).toBe(true);
  });

  it("reports a status it could not load, and loads it again on request", async () => {
    const district = fakeDistrict({ rosterSync: "unreadable" });
    const { user } = renderConsole(district.client, "roster-sync");
    expect(await screen.findByText("Could not load the roster sync")).toBeTruthy();
    expect(screen.getByText("The roster sync record could not be read. (reference req-sync)")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(district.calls.filter((c) => c.name === "admin.rosterSyncStatus")).toHaveLength(2));
  });
});
