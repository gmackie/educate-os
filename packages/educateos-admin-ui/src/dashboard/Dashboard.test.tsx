// @vitest-environment jsdom
// The aggregates never name a minor and never show what anyone wrote: the screens read only the
// count-and-total routes, and nothing they render carries a name or a per-person row.
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/dom";
import { STUDENT_NAMES, fakeDistrict } from "../testing/fakeDistrict.ts";
import { renderConsole } from "../testing/renderConsole.tsx";

/** The routes whose answers are counts and totals only. */
// `me.get` is the shell asking who is signed in, to name them and draw their navigation (SCHO-260).
// `admin.productAnalytics` is the district's own on/off setting, never anything about a person (SCHO-350).
const AGGREGATE_ROUTES = new Set(["admin.health", "admin.aiUsage", "admin.getConfig", "admin.planConfig", "admin.productAnalytics", "me.get"]);

describe("the dashboard", () => {
  it("shows counts and totals for every area, and no student's name", async () => {
    const district = fakeDistrict();
    const { container } = renderConsole(district.client, "dashboard");
    const tiles = await screen.findByRole("list", { name: "District at a glance" });
    const tile = (title: string) => within(tiles).getByRole("heading", { name: title }).parentElement!;

    // Everyone added counts, administrators included, so the tile does not claim they are enrolled (SCHO-221).
    expect(within(tile("Students and staff")).getByText("96")).toBeTruthy();
    expect(within(tile("Students and staff")).getByText(/administrators included; 96 active class enrollments/)).toBeTruthy();
    expect(within(tile("Classes")).getByText("4")).toBeTruthy();
    // Every module is off in the fake's configuration, whatever its rollout says.
    expect(within(tile("Classes")).getByText("No module is on in the configuration.")).toBeTruthy();
    expect(within(tile("Pending teacher tasks")).getByText("3")).toBeTruthy();
    expect(within(await screen.findByRole("heading", { name: "AI usage and cost" }).then((h) => h.parentElement!)).getByText("$8.60")).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Permission and configuration issues" })).toBeTruthy();
    expect(within(tile("Roster integration")).getByText("OneRoster CSV export")).toBeTruthy();

    for (const name of STUDENT_NAMES) expect(container.textContent).not.toContain(name);
    expect(container.textContent).not.toMatch(/prn_/);
    expect(district.calls.every((c) => AGGREGATE_ROUTES.has(c.name))).toBe(true);
  });

  it("names no roster integration for a district managed by hand", async () => {
    renderConsole(fakeDistrict({ authority: "local" }).client, "dashboard");
    const tiles = await screen.findByRole("list", { name: "District at a glance" });
    const roster = within(tiles).getByRole("heading", { name: "Roster integration" }).parentElement!;
    expect(within(roster).getByText("None")).toBeTruthy();
    expect(within(roster).getByText(/managed by hand/)).toBeTruthy();
    expect(within(roster).queryByText("OneRoster CSV export")).toBeNull();
  });
});

describe("the district's name", () => {
  it("renames the district, trimmed, and offers no rename until the name changes (SCHO-344)", async () => {
    const district = fakeDistrict();
    const { user } = renderConsole(district.client, "dashboard");
    const form = await screen.findByRole("form", { name: "Rename the district" });
    const name = within(form).getByRole("textbox", { name: /Name/ });
    const rename = within(form).getByRole("button", { name: "Rename" }) as HTMLButtonElement;
    expect((name as HTMLInputElement).value).toBe("Fake Unified");
    expect(rename.disabled).toBe(true);

    await user.clear(name);
    expect(rename.disabled).toBe(true);
    await user.type(name, "  Northfield Co-op ");
    await user.click(rename);
    expect(await screen.findByText("The district is now named Northfield Co-op.", { selector: "*:not([data-testid=announcer])" })).toBeTruthy();
    expect(district.calls.find((c) => c.name === "admin.renameDistrict")!.input).toStrictEqual({ body: { name: "Northfield Co-op" } });
    // The dashboard reloads the district, whose name now matches what was typed.
    await waitFor(() => expect(rename.disabled).toBe(true));
  });

  it("turns product analytics on and off, saying what it sends and that a privacy review comes first (SCHO-350)", async () => {
    const district = fakeDistrict();
    const { user } = renderConsole(district.client, "dashboard");
    const card = (await screen.findByRole("heading", { name: "Product analytics" })).parentElement!;
    const toggle = (await within(card).findByRole("switch", { name: "Count visits to this district's pages" })) as HTMLButtonElement;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(within(card).getByText("Turn this on only after your district's student-privacy review approves it.")).toBeTruthy();
    expect(within(card).getByText(/never sends a name, an id, what anyone wrote/)).toBeTruthy();
    expect(within(card).getByText("Off since the district was set up.")).toBeTruthy();

    await user.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    expect(district.calls.find((c) => c.name === "admin.setProductAnalytics")!.input).toStrictEqual({ body: { enabled: true } });
    expect(within(card).getByText(/^Turned on on /)).toBeTruthy();
    expect(card.textContent).not.toMatch(/prn_/);

    await user.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(district.calls.filter((c) => c.name === "admin.setProductAnalytics").map((c) => c.input)).toStrictEqual([{ body: { enabled: true } }, { body: { enabled: false } }]);
  });

  it("offers no switch to flip where the deployment names no analytics service (SCHO-350)", async () => {
    const district = fakeDistrict({ productAnalyticsConfigured: false });
    renderConsole(district.client, "dashboard");
    const card = (await screen.findByRole("heading", { name: "Product analytics" })).parentElement!;
    const toggle = (await within(card).findByRole("switch", { name: "Count visits to this district's pages" })) as HTMLButtonElement;
    expect(toggle.disabled || toggle.getAttribute("aria-disabled") === "true").toBe(true);
    expect(within(card).getByText("This deployment has no analytics service, so it cannot be turned on.")).toBeTruthy();
    expect(district.calls.some((c) => c.name === "admin.setProductAnalytics")).toBe(false);
  });
});

describe("AI usage", () => {
  it("reports by class, pool and model with a cap status, never per person", async () => {
    const district = fakeDistrict();
    const { container } = renderConsole(district.client, "ai-usage");
    expect(await screen.findByRole("region", { name: "By class" })).toBeTruthy();
    // Classes are named by their course and section, from routes that name no person.
    expect(await within(screen.getByRole("region", { name: "By class" })).findByText("Biology · Section A")).toBeTruthy();
    expect(district.calls.every((c) => ["admin.aiUsage", "admin.directoryNames", "admin.getConfig", "me.get"].includes(c.name))).toBe(true);
    expect(within(screen.getByRole("region", { name: "By funding pool" })).getByText("fpl_fk-courses")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "By model" })).getByText("cloudflare/synthetic-model")).toBeTruthy();
    // The cap is $2.00: one person reached it and one ($1.70) is within 20%.
    expect(screen.getByText(/Of 3 people who used AI, 1 reached it and 1 are within 20% of it/)).toBeTruthy();
    expect(container.textContent).not.toMatch(/prn_/);
    for (const name of STUDENT_NAMES) expect(container.textContent).not.toContain(name);
  });
});
