// @vitest-environment jsdom
// SCHO-376: a district administrator reviews the safety decision log (the policy engine's decisions,
// filtered and paged, and Hall Monitor's discussion screening) and the admin audit log, read-only.
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/dom";
import { chooseOption } from "../testing/chooseOption.ts";
import { fakeDistrict } from "../testing/fakeDistrict.ts";
import { renderConsole } from "../testing/renderConsole.tsx";

const rowsOf = (table: HTMLElement) => within(table).getAllByRole("row").slice(1);

describe("the Safety decisions page", () => {
  it("lists policy decisions newest first and pages back through them", async () => {
    const district = fakeDistrict();
    const { user } = renderConsole(district.client, "safety-decisions");
    const table = await screen.findByRole("table", { name: "Policy decisions, newest first" });
    expect(rowsOf(table)).toHaveLength(25);
    expect(within(rowsOf(table)[0]!).getByText("req-60")).toBeTruthy();
    expect(within(rowsOf(table)[0]!).getByText("Refused")).toBeTruthy();

    // The pager is drawn again with each page.
    const pages = () => screen.getByRole("navigation", { name: /Policy decisions, newest first: pages/ });
    expect(within(pages()).getByRole("button", { name: "Newer" }).hasAttribute("disabled")).toBe(true);
    await user.click(within(pages()).getByRole("button", { name: "Older" }));
    await waitFor(() => expect(within(screen.getByRole("table", { name: "Policy decisions, newest first" })).getByText("req-35")).toBeTruthy());
    expect(district.calls.filter((c) => c.name === "admin.decisionLog").at(-1)?.input).toStrictEqual({ query: { before: "36" } });
    expect(within(pages()).getByText("Page 2")).toBeTruthy();
    await user.click(within(pages()).getByRole("button", { name: "Newer" }));
    await waitFor(() => expect(within(screen.getByRole("table", { name: "Policy decisions, newest first" })).getByText("req-60")).toBeTruthy());
  });

  it("filters by outcome, record and rule, starting again from the newest", async () => {
    const district = fakeDistrict();
    const { user } = renderConsole(district.client, "safety-decisions");
    await screen.findByRole("table", { name: "Policy decisions, newest first" });
    await chooseOption(user, "Outcome", "Refused");
    await waitFor(() => expect(rowsOf(screen.getByRole("table", { name: "Policy decisions, newest first" }))).toHaveLength(12));
    expect(district.calls.at(-1)?.input).toStrictEqual({ query: { outcome: "refused" } });
    for (const row of rowsOf(screen.getByRole("table", { name: "Policy decisions, newest first" }))) {
      expect(within(row).getByText("Refused")).toBeTruthy();
      expect(within(row).getByText("Only its owner")).toBeTruthy();
    }

    await chooseOption(user, "Outcome", "Every decision");
    // A rule filter applies when submitted, as each search is itself logged.
    const rule = screen.getByRole("textbox", { name: /^Rule/ });
    await user.type(rule, "Admin!");
    expect(await screen.findByText(/Use lowercase letters/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Filter" }).hasAttribute("disabled")).toBe(true);
    const searches = () => district.calls.filter((c) => c.name === "admin.decisionLog").length;
    const before = searches();
    await user.clear(rule);
    await user.type(rule, "admin.");
    expect(searches()).toBe(before);
    await user.click(screen.getByRole("button", { name: "Filter" }));
    await waitFor(() => expect(district.calls.filter((c) => c.name === "admin.decisionLog").at(-1)?.input).toStrictEqual({ query: { rule: "admin." } }));
    await waitFor(() => expect(rowsOf(screen.getByRole("table", { name: "Policy decisions, newest first" }))).toHaveLength(7));
  });

  it("shows Hall Monitor's decisions with their reason codes, and says what it does not cover", async () => {
    renderConsole(fakeDistrict().client, "safety-decisions");
    const table = await screen.findByRole("table", { name: "Hall Monitor decisions, newest first" });
    const [refused, held] = rowsOf(table);
    expect(within(refused!).getByText("Refused")).toBeTruthy();
    expect(within(refused!).getByText("Never shared")).toBeTruthy();
    expect(within(held!).getByText("Held for a teacher")).toBeTruthy();
    expect(within(held!).getByText("moderation.self-harm")).toBeTruthy();
    expect(screen.getByText(/Hall Monitor screens every student post/)).toBeTruthy();
    expect(screen.getByText(/not listed here/)).toBeTruthy();
  });
});

describe("the Admin audit log page", () => {
  it("lists only administrators' allowed changes, and filters them by record", async () => {
    const district = fakeDistrict();
    const { user } = renderConsole(district.client, "audit-log");
    const table = await screen.findByRole("table", { name: "Administrators' changes, newest first" });
    expect(rowsOf(table)).toHaveLength(7);
    for (const row of rowsOf(table)) {
      expect(within(row).getByText("Avery Admin")).toBeTruthy();
      expect(within(row).getByText("admin.district.directory")).toBeTruthy();
    }
    // Under 25 changes: one page, no pager.
    expect(screen.queryByRole("navigation", { name: /pages/ })).toBeNull();
    await chooseOption(user, "Record", "Enrollment");
    expect(await screen.findByText("No administrator has changed anything yet.")).toBeTruthy();
    expect(district.calls.at(-1)).toStrictEqual({ name: "admin.auditLog", input: { query: { resourceKind: "enrollment" } } });
  });

  it("is refused to someone who is not an administrator", async () => {
    renderConsole(fakeDistrict({ caller: "not-administrator" }).client, "audit-log");
    expect(await screen.findByText(/The admin console is for the school.s administrators/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
