// @vitest-environment jsdom
// The aggregates never name a minor and never show what anyone wrote: the screens read only the
// count-and-total routes, and nothing they render carries a name or a per-person row.
import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/dom";
import { STUDENT_NAMES, fakeDistrict } from "../testing/fakeDistrict.ts";
import { renderConsole } from "../testing/renderConsole.tsx";

/** The routes whose answers are counts and totals only. */
const AGGREGATE_ROUTES = new Set(["admin.health", "admin.aiUsage", "admin.getConfig", "admin.planConfig"]);

describe("the dashboard", () => {
  it("shows counts and totals for every area, and no student's name", async () => {
    const district = fakeDistrict();
    const { container } = renderConsole(district.client, "dashboard");
    const tiles = await screen.findByRole("list", { name: "District at a glance" });
    const tile = (title: string) => within(tiles).getByRole("heading", { name: title }).parentElement!;

    expect(within(tile("Enrolled users")).getByText("96")).toBeTruthy();
    expect(within(tile("Classes")).getByText("4")).toBeTruthy();
    expect(within(tile("Pending teacher tasks")).getByText("3")).toBeTruthy();
    expect(within(await screen.findByRole("heading", { name: "AI usage and cost" }).then((h) => h.parentElement!)).getByText("$8.60")).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Permission and configuration issues" })).toBeTruthy();
    expect(within(tile("Integration health")).getByText("OneRoster CSV export")).toBeTruthy();

    for (const name of STUDENT_NAMES) expect(container.textContent).not.toContain(name);
    expect(container.textContent).not.toMatch(/prn_/);
    expect(district.calls.every((c) => AGGREGATE_ROUTES.has(c.name))).toBe(true);
  });
});

describe("AI usage", () => {
  it("reports by class, pool and model with a cap status, never per person", async () => {
    const district = fakeDistrict();
    const { container } = renderConsole(district.client, "ai-usage");
    expect(await screen.findByRole("region", { name: "By class" })).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "By funding pool" })).getByText("fpl_fk-courses")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "By model" })).getByText("cloudflare/synthetic-model")).toBeTruthy();
    // The cap is $2.00: one person reached it and one ($1.70) is within 20%.
    expect(screen.getByText(/Of 3 people who used AI, 1 reached it and 1 are within 20% of it/)).toBeTruthy();
    expect(container.textContent).not.toMatch(/prn_/);
    for (const name of STUDENT_NAMES) expect(container.textContent).not.toContain(name);
  });
});
