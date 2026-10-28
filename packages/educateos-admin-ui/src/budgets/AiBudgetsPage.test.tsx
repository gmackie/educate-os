// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/dom";
import type { UserEvent } from "@testing-library/user-event";
import { STUDENT_NAMES, fakeDistrict } from "../testing/fakeDistrict.ts";
import { renderConsole } from "../testing/renderConsole.tsx";
import { formatUsdNanoExact, parseDollarsToCents } from "./budgetFormat.ts";

// `me.get` is the shell asking who is signed in, to name them and draw their navigation (SCHO-260).
const BUDGET_ROUTES = new Set(["admin.directoryNames", "admin.aiFunding", "admin.aiCostSummary", "admin.aiProjection", "admin.updateFundingPools", "admin.getConfig", "me.get"]);

/** The value shown for one figure of the cost summary. */
async function figure(term: string): Promise<string> {
  const summary = await screen.findByRole("region", { name: "This month's cost (October 2026)" });
  return within(summary).getByText(term).closest("dt")!.nextElementSibling!.textContent ?? "";
}

async function setAmount(user: UserEvent, pool: string, dollars: string): Promise<void> {
  const input = await screen.findByRole("textbox", { name: `${pool} (US dollars a month)` });
  await user.clear(input);
  await user.type(input, dollars);
}

describe("AI budgets", () => {
  it("tells the gross model cost, free allowance, net estimated bill, safety reserve and remaining funds apart", async () => {
    renderConsole(fakeDistrict({ netEstimate: true }).client, "ai-budgets");
    expect(await figure("Gross model cost")).toMatch(/^\$8\.100114/);
    expect(await figure("Free allowance applied")).toMatch(/^\$0\.11Usage the district's Cloudflare account includes/);
    expect(await figure("Net estimated bill")).toMatch(/^\$12\.990114An estimate .* including the \$5\.00 monthly plan fee\. It is not an invoice\./);
    expect(await figure("Safety reserve spend")).toMatch(/^\$0\.000114Paid from the safety reserve only, which has \$2\.999886 remaining\./);
    // $10 - $7.60 - $0.20 held, and $5 - $0.50.
    expect(await figure("Remaining in class and personal pools")).toMatch(/^\$6\.70/);
  });

  it("says why there is no net estimate when the account is not configured", async () => {
    renderConsole(fakeDistrict().client, "ai-budgets");
    expect(await figure("Net estimated bill")).toMatch(/^Not available/);
    expect(await figure("Free allowance applied")).toMatch(/No Cloudflare account is configured for this district/);
    expect(await figure("Gross model cost")).toMatch(/^\$8\.100114/);
  });

  it("shows each pool's allocation, charged, held and remaining amounts with its threshold", async () => {
    renderConsole(fakeDistrict().client, "ai-budgets");
    const pools = await screen.findByRole("region", { name: "Class and personal pools" });
    const course = within(pools).getByRole("row", { name: /Course AI/ });
    for (const text of ["$10.00", "$7.60", "$0.20", "$2.20", "78%", "70% used"]) expect(within(course).getByText(text)).toBeTruthy();
    expect(within(course).getByRole("meter", { name: "Course AI used" })).toBeTruthy();
    expect(within(within(pools).getByRole("row", { name: /Personal AI/ })).getByText("On track")).toBeTruthy();
  });

  it("keeps the safety reserve apart, and says safety spend never comes from anyone's allowance", async () => {
    renderConsole(fakeDistrict().client, "ai-budgets");
    const safety = await screen.findByRole("region", { name: "Safety reserve" });
    expect(within(safety).getByText(/Safety spend never comes from a student's or teacher's AI allowance/)).toBeTruthy();
    expect(within(safety).getByText("$0.000114")).toBeTruthy();
    expect(within(safety).getByText(/Recommended minimum: \$9\.60 a month.*5 active teachers and 91 AI-enabled students/)).toBeTruthy();
    expect(within(safety).getByText("The safety reserve is below the recommended minimum")).toBeTruthy();
    // The reserve is not one of the pools that fund classes and personal spaces.
    expect(within(screen.getByRole("region", { name: "Class and personal pools" })).queryByText("Safety reserve")).toBeNull();
  });

  it("warns about each pool projected to use more than 80% of its allocation", async () => {
    renderConsole(fakeDistrict().client, "ai-budgets");
    const projection = await screen.findByRole("region", { name: "Month-end projection" });
    expect(within(projection).getByText("Course AI is projected to use 522.81% of its allocation")).toBeTruthy();
    expect(within(projection).getByText(/over the 80% warning level/)).toBeTruthy();
    expect(within(projection).queryByText(/Personal AI is projected/)).toBeNull();
    expect(within(projection).getByText(/continued at the same daily rate to the end of the month/)).toBeTruthy();
  });

  it("validates amounts and the district cap before anything is sent", async () => {
    const district = fakeDistrict();
    const { user } = renderConsole(district.client, "ai-budgets");
    const review = await screen.findByRole("button", { name: "Review allocation changes" }) as HTMLButtonElement;
    expect(review.disabled).toBe(true);

    await setAmount(user, "Personal AI", "five");
    expect(screen.getByText("Enter an amount from 0.00 to 1,000,000.00, with at most two decimal places.")).toBeTruthy();
    expect(review.disabled).toBe(true);

    await setAmount(user, "Personal AI", "5.00");
    await setAmount(user, "Course AI", "16.00");
    expect(screen.getByText("Over the district's cap")).toBeTruthy();
    expect(screen.getByText(/would total \$21\.00 a month, more than the district's cap of \$20\.00/)).toBeTruthy();
    expect(review.disabled).toBe(true);
    expect(district.calls.some((c) => c.name === "admin.updateFundingPools")).toBe(false);
  });

  it("confirms the changes, saves them over the revision it read, and announces the result", async () => {
    const district = fakeDistrict();
    const { user } = renderConsole(district.client, "ai-budgets");
    await setAmount(user, "Course AI", "12.00");
    await setAmount(user, "Safety reserve", "5");
    expect(screen.getByText("Safety reserve below the recommended minimum")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Review allocation changes" }));

    const confirm = await screen.findByRole("alertdialog", { name: "Change monthly allocations?" });
    expect(within(confirm).getByText("Course AI: from $10.00 to $12.00")).toBeTruthy();
    expect(within(confirm).getByText("Safety reserve: from $3.00 to $5.00")).toBeTruthy();
    expect(within(confirm).getByText(/below its recommended minimum of \$9\.60/)).toBeTruthy();
    expect(district.calls.some((c) => c.name === "admin.updateFundingPools")).toBe(false);
    await user.click(within(confirm).getByRole("button", { name: "Save allocations" }));

    await waitFor(() => expect(screen.getByTestId("announcer").textContent)
      .toBe("The funding allocations were saved. The safety reserve is $5.00 a month, below the recommended $9.60."));
    const sent = district.calls.find((c) => c.name === "admin.updateFundingPools")!.input as { body: unknown };
    expect(sent.body).toStrictEqual({
      allocations: [{ poolId: "fpl_fk-courses", monthlyAllocationCents: 1200 }, { poolId: "fpl_fk-safety", monthlyAllocationCents: 500 }],
    });
    expect(district.allocationRevisions.at(-1)!.allocations["fpl_fk-courses"]).toBe("12000000000");
    // The screen reloads and the form starts again from what was saved.
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Course AI (US dollars a month)" }) as HTMLInputElement).value).toBe("12.00"));

    // A second change is made over the revision just recorded.
    await setAmount(user, "Personal AI", "6.00");
    await user.click(screen.getByRole("button", { name: "Review allocation changes" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Save allocations" }));
    await waitFor(() => expect(district.allocationRevisions).toHaveLength(2));
    const second = district.calls.filter((c) => c.name === "admin.updateFundingPools").at(-1)!.input as { body: { expectedRevisionId?: string } };
    expect(second.body.expectedRevisionId).toBe("far_fake-1");
  });

  it("never names a person and calls only the budget routes", async () => {
    const district = fakeDistrict({ netEstimate: true });
    const { container } = renderConsole(district.client, "ai-budgets");
    await screen.findByRole("region", { name: "Month-end projection" });
    await screen.findByRole("region", { name: "This month's cost (October 2026)" });
    expect(container.textContent).not.toMatch(/prn_/);
    for (const name of STUDENT_NAMES) expect(container.textContent).not.toContain(name);
    expect(district.calls.every((c) => BUDGET_ROUTES.has(c.name))).toBe(true);
  });
});

describe("budget amounts", () => {
  it("shows sub-cent amounts exactly", () => {
    expect(formatUsdNanoExact("38000")).toBe("$0.000038");
    expect(formatUsdNanoExact("1500000000")).toBe("$1.50");
    expect(formatUsdNanoExact("-250000000")).toBe("-$0.25");
    expect(formatUsdNanoExact("123456789000000")).toBe("$123,456.789");
  });

  it("reads dollars and cents, refusing anything else", () => {
    expect(["12", "12.5", "$1,200.05", " 0.00 "].map(parseDollarsToCents)).toStrictEqual([1200, 1250, 120005, 0]);
    expect(["", "-1", "1.005", "abc", "1000000.01"].map(parseDollarsToCents)).toStrictEqual([undefined, undefined, undefined, undefined, undefined]);
  });
});
